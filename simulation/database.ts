import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export class SimulatedCrash extends Error {}
export type DatabaseMetrics = { statements: number; rowsReturned: number; rowsChanged: number; maxStatementsPerInvocation: number; limitViolations: number };

/** SQLite executes the production SQL. This adapter models the D1 methods the
 * app uses, transactions, binding limits and a configurable invocation budget.
 * rowsReturned/rowsChanged are NOT Cloudflare scanned/indexed/billable rows. */
export class SimulationDatabase {
  private sqlite: DatabaseSync;
  private crashAfter: number | null = null;
  private invocationStatements = 0;
  private inInvocation = false;
  crashed = false;
  metrics: DatabaseMetrics = { statements: 0, rowsReturned: 0, rowsChanged: 0, maxStatementsPerInvocation: 0, limitViolations: 0 };
  private readonly statements = new WeakMap<D1PreparedStatement, { sql: string; bindings: SQLInputValue[] }>();

  constructor(readonly path: string, readonly statementLimit = 50) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
  }
  close(): void { this.sqlite.close(); }
  reopen(): void {
    this.sqlite.close();
    this.sqlite = new DatabaseSync(this.path);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    this.crashed = false;
    this.crashAfter = null;
  }
  migrate(sql: string): void { this.sqlite.exec(sql); }
  inspect<T>(sql: string, ...bindings: SQLInputValue[]): T[] { return this.sqlite.prepare(sql).all(...bindings) as T[]; }
  seed(sql: string, ...bindings: SQLInputValue[]): void { this.sqlite.prepare(sql).run(...bindings); }
  beginInvocation(crashAfter: number | null = null): void {
    this.inInvocation = true; this.invocationStatements = 0; this.crashAfter = crashAfter;
  }
  endInvocation(): number {
    this.inInvocation = false;
    this.metrics.maxStatementsPerInvocation = Math.max(this.metrics.maxStatementsPerInvocation, this.invocationStatements);
    return this.invocationStatements;
  }
  private execute<T>(sql: string, bindings: SQLInputValue[]): D1Result<T> {
    if (this.crashed) throw new SimulatedCrash("Invocation was terminated");
    if (this.inInvocation) {
      this.invocationStatements += 1;
      this.metrics.statements += 1;
      if (this.crashAfter !== null && this.invocationStatements === this.crashAfter) {
        this.crashed = true;
        throw new SimulatedCrash("Injected process termination");
      }
      if (this.invocationStatements > this.statementLimit) {
        this.metrics.limitViolations += 1;
        throw new Error("Simulated D1 statement budget exceeded");
      }
    }
    const before = Number(this.sqlite.prepare("SELECT total_changes() AS value").get()!.value);
    const rows = this.sqlite.prepare(sql).all(...bindings);
    const changes = Number(this.sqlite.prepare("SELECT total_changes() AS value").get()!.value) - before;
    if (this.inInvocation) { this.metrics.rowsReturned += rows.length; this.metrics.rowsChanged += changes; }
    return { success: true, results: rows as T[], meta: { duration: 0, size_after: 0, rows_read: rows.length,
      rows_written: changes, last_row_id: Number(this.sqlite.prepare("SELECT last_insert_rowid() AS value").get()!.value), changed_db: changes > 0, changes } };
  }
  private prepare(sql: string, bindings: SQLInputValue[] = []): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind: (...values: unknown[]) => {
        if (values.length > 100) throw new Error("D1 binding limit exceeded");
        const validated = values.map((value): SQLInputValue => {
          if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
          if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          if (value instanceof ArrayBuffer) return new Uint8Array(value);
          throw new Error("Unsupported D1 binding value");
        });
        return this.prepare(sql, validated);
      },
      first: async <T>(column?: string): Promise<T | null> => {
        const row = this.execute<Record<string, unknown>>(sql, bindings).results[0];
        if (!row) return null;
        if (column !== undefined && !(column in row)) throw new Error(`D1 column not found: ${column}`);
        return (column === undefined ? row : row[column]) as T;
      },
      run: async <T>() => this.execute<T>(sql, bindings),
      all: async <T>() => this.execute<T>(sql, bindings),
      raw: async () => { throw new Error("raw() is outside the simulator's D1 adapter; add explicit support before using it"); },
    };
    this.statements.set(statement, { sql, bindings });
    return statement;
  }
  readonly binding: D1Database = {
    prepare: (sql) => this.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const writesBefore = this.metrics.rowsChanged;
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const prepared = this.statements.get(statement);
          if (!prepared) throw new Error("Statement belongs to a different database");
          return this.execute<T>(prepared.sql, prepared.bindings);
        });
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        this.metrics.rowsChanged = writesBefore;
        throw error;
      }
    },
    exec: async () => { throw new Error("Use migrate() for simulator setup; runtime D1 exec() is not modeled"); },
    dump: async () => { throw new Error("D1 dump() is not modeled"); },
    withSession: () => { throw new Error("D1 read replication and sessions are not modeled"); },
  };
}
