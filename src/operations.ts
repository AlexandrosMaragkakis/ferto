import { numericProgress, requestUsage, type RequestUsage } from "./rebuild-progress";

export type DatabaseUsage = { queries: number; rowsRead: number; rowsWritten: number };

/** Keep the binding's real metadata, including rows scanned and index writes.
 * first() normally discards metadata, so implement it through one all() call.
 * Telemetry writes use the original binding and are excluded from these totals. */
export function observeDatabase(database: D1Database): { database: D1Database; usage: DatabaseUsage } {
  const usage: DatabaseUsage = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const capture = <T>(result: D1Result<T>) => {
    usage.queries += 1;
    usage.rowsRead += result.meta.rows_read ?? 0;
    usage.rowsWritten += result.meta.rows_written ?? 0;
    return result;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async <T>() => capture(await statement.all<T>()),
      run: async <T>() => capture(await statement.run<T>()),
      first: async <T>(column?: string): Promise<T | null> => {
        const row = capture(await statement.all<Record<string, unknown>>()).results[0];
        if (!row) return null;
        if (column !== undefined && !(column in row)) throw new Error("D1 column not found");
        return (column === undefined ? row : row[column]) as T;
      },
      raw: statement.raw.bind(statement),
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const observed = new Proxy(database, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (property === "batch") return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> =>
      (await target.batch<T>(statements.map((statement) => originals.get(statement) ?? statement))).map(capture);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database: observed, usage };
}

const hourAt = () => Math.floor(Date.now() / 3600000) * 3600000;
export async function recordEndpointActivity(env: Env, generation: string, usage: RequestUsage): Promise<void> {
  const changes: string[] = [];
  const bindings: number[] = [];
  for (const [endpoint, count] of Object.entries(usage)) for (const [field, amount] of Object.entries(count)) {
    const path = `$.${endpoint}.${field}`;
    changes.push(`'${path}', ${field.startsWith('last') ? 'max' : ''}(coalesce(json_extract(requests_json, '${path}'), 0) ${field.startsWith('last') ? ',' : '+'} ?)`);
    bindings.push(amount);
  }
  if (!changes.length) return;
  await env.DB.prepare(`INSERT INTO operational_activity(hour,scope,generation,requests_json) VALUES (?,'refresh',?,?)
    ON CONFLICT(hour,scope,generation) DO UPDATE SET requests_json=json_set(requests_json,${changes.join(',')})`)
    .bind(hourAt(), generation, JSON.stringify(usage), ...bindings).run();
}

export async function observedInvocation<T>(env: Env, scope: string, generation: string, operation: (observed: Env) => Promise<T>): Promise<T> {
  const observed = observeDatabase(env.DB);
  try { return await operation({ ...env, DB: observed.database }); }
  finally {
    const { queries, rowsRead, rowsWritten } = observed.usage;
    let totalQueries = queries; let totalRead = rowsRead; let totalWritten = rowsWritten;
    // Public requests log real row usage without adding a database write per
    // visitor. Refresh activity is retained in compact hourly aggregates.
    if (scope === "refresh" && queries) {
      try {
        const metrics = await env.DB.batch([
          env.DB.prepare(`INSERT INTO operational_activity(hour,scope,generation,queries,rows_read,rows_written,observations)
            VALUES (?,'refresh',?,?,?,?,1) ON CONFLICT(hour,scope,generation) DO UPDATE SET
            queries=queries+excluded.queries, rows_read=rows_read+excluded.rows_read,
            rows_written=rows_written+excluded.rows_written, observations=observations+1`)
            .bind(hourAt(), generation, queries, rowsRead, rowsWritten),
          env.DB.prepare(`UPDATE refresh_history SET db_queries=db_queries+?,rows_read=rows_read+?,rows_written=rows_written+?
            ,progress_json=coalesce((SELECT progress_json FROM rebuild_jobs WHERE generation=?),progress_json)
            WHERE generation=?`).bind(queries, rowsRead, rowsWritten, generation, generation),
        ]);
        for (const result of metrics) {
          totalQueries += 1; totalRead += result.meta.rows_read ?? 0; totalWritten += result.meta.rows_written ?? 0;
        }
      } catch { console.error(JSON.stringify({ event: "database_usage_not_saved", scope })); }
    }
    console.log(JSON.stringify({ event: "database_usage", scope, generation: generation || undefined,
      basis: "binding-response-meta", queries: totalQueries, rows_read: totalRead, rows_written: totalWritten,
      includesFinalMetricWrites: true }));
  }
}

export async function operationalHistory(env: Env) {
  const [history, activity, interruptions] = await Promise.all([
    env.DB.prepare("SELECT * FROM refresh_history ORDER BY started_at DESC LIMIT 30").all<{
      generation: string; started_at: number; finished_at: number | null; outcome: string; error: string | null; db_queries: number; progress_json: string; request_counts_json: string; rows_read: number; rows_written: number;
    }>(),
    env.DB.prepare("SELECT * FROM operational_activity WHERE hour >= ? ORDER BY hour DESC LIMIT 720")
      .bind(hourAt() - 30 * 86400000).all<{ hour: number; scope: string; generation: string; requests_json: string; queries: number; rows_read: number; rows_written: number }>(),
    env.DB.prepare("SELECT * FROM quota_interruptions ORDER BY occurred_at DESC LIMIT 100").all<{
      generation: string; revision: number; occurred_at: number; endpoint: string | null;
      reason: string; retry_at: number; retry_source: string;
    }>(),
  ]);
  return { observationBasis: "observed", databaseBasis: "binding-response-meta", databaseScope: "refresh-queue", rowMetricWritesExcluded: true,
    history: history.results.map(({ progress_json, request_counts_json, ...row }) => {
      const progress = numericProgress(progress_json); const requests = requestUsage(request_counts_json);
      const attempts = Object.entries(requests).filter(([key]) => key !== "token").reduce((total, [, value]) => total + value.attempts, 0);
      return { ...row, progress, requests,
        discoveriesPerRequest: attempts && ["promoted", "quarantined", "empty"].includes(row.outcome) ? (progress.newRecordings ?? 0) / attempts : null,
        stagedPerRequest: attempts ? (progress.stagedRecordings ?? 0) / attempts : null };
    }),
    activity: activity.results.map(({ requests_json, ...row }) => ({ ...row, requests: requestUsage(requests_json) })),
    interruptions: interruptions.results };
}

export type OperationalHistory = Awaited<ReturnType<typeof operationalHistory>>;
