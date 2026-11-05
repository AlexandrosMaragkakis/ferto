import { recordEndpointActivity } from "./operations";
import { JOB_MUTATION_GUARD, jobMutationBindings, type JobMutationGuard } from "./rebuild-guard";

export type ProgressCounter = 'seedArtists' | 'seedArtistsDone' | 'seedScanComplete' | 'likedTracksScanned'
  | 'tracksDiscovered' | 'tracksProcessed' | 'tracksCached' | 'tracksFetched' | 'tracksKnown'
  | 'stagedRecordings' | 'newRecordings' | 'publishedRecordings' | 'publishedArtists' | 'playlists' | 'playlistsDone' | 'playlistTracksScanned';
type Binding = string | number | null;
type Increment = number | { sql: string; bindings: Binding[] };

/** Call before the corresponding cursor/queue mutation in the same D1 batch. */
export function progressStatement(env: Env, job: JobMutationGuard, increments: Partial<Record<ProgressCounter, Increment>>,
  condition = '1', conditionBindings: Binding[] = []): D1PreparedStatement {
  const bindings: Binding[] = [];
  const changes = Object.entries(increments).map(([key, increment]) => {
    const sql = typeof increment === 'number' ? '?' : increment.sql;
    bindings.push(...(typeof increment === 'number' ? [increment] : increment.bindings));
    return `'$.${key}', coalesce(json_extract(progress_json, '$.${key}'), 0) + (${sql})`;
  });
  return env.DB.prepare(`UPDATE rebuild_jobs SET progress_json = json_set(progress_json, ${changes.join(', ')})
    WHERE singleton = 1 AND ${JOB_MUTATION_GUARD} AND (${condition})`)
    .bind(...bindings, ...jobMutationBindings(job), ...conditionBindings);
}

export type RequestEndpoint = 'token' | 'profile' | 'likedTracks' | 'artistAlbums' | 'albumTracks' | 'tracks' | 'playlists' | 'playlistItems' | 'playlistDetails';
export type RequestCounts = { attempts: number; succeeded: number; failed: number; rateLimited: number; lastAttemptAt: number; lastSuccessAt: number };
export type RequestUsage = Partial<Record<RequestEndpoint, RequestCounts>>;

export function requestEndpoint(url: string): RequestEndpoint {
  const path = new URL(url).pathname;
  if (path.endsWith('/api/token')) return 'token';
  if (path === '/v1/me') return 'profile';
  if (path === '/v1/me/tracks') return 'likedTracks';
  if (path === '/v1/me/playlists') return 'playlists';
  if (path.startsWith('/v1/artists/')) return 'artistAlbums';
  if (path.startsWith('/v1/albums/')) return 'albumTracks';
  if (path.startsWith('/v1/tracks/')) return 'tracks';
  return path.endsWith('/items') || path.endsWith('/tracks') ? 'playlistItems' : 'playlistDetails';
}

/** Invocation-scoped counters, flushed once even when a unit fails. */
export async function countedRequest(usage: RequestUsage, endpoint: RequestEndpoint, request: () => Promise<Response>): Promise<Response> {
  const count = usage[endpoint] ??= { attempts: 0, succeeded: 0, failed: 0, rateLimited: 0, lastAttemptAt: 0, lastSuccessAt: 0 };
  count.attempts += 1;
  count.lastAttemptAt = Date.now();
  try {
    const response = await request();
    if (response.ok) { count.succeeded += 1; count.lastSuccessAt = Date.now(); }
    else { count.failed += 1; if (response.status === 429) count.rateLimited += 1; }
    return response;
  } catch (cause) { count.failed += 1; throw cause; }
}

export async function saveRequestUsage(env: Env, generation: string, usage: RequestUsage): Promise<void> {
  const changes: string[] = [];
  const bindings: number[] = [];
  for (const [endpoint, count] of Object.entries(usage)) {
    for (const [key, value] of Object.entries(count)) {
      const path = `$.${endpoint}.${key}`;
      changes.push(`'${path}', ${key.startsWith('last') ? 'max' : ''}(coalesce(json_extract(request_counts_json, '${path}'), 0) ${key.startsWith('last') ? ',' : '+'} ?)`);
      bindings.push(value);
    }
  }
  if (!changes.length) return;
  // A finished unit changes the revision; a replacement generation must never
  // receive an older invocation's counts. No tokens, ids or URLs are stored.
  await env.DB.prepare(`UPDATE rebuild_jobs SET request_counts_json = json_set(request_counts_json, ${changes.join(', ')})
    WHERE singleton = 1 AND generation = ?`).bind(...bindings, generation).run();
  try {
    await recordEndpointActivity(env, generation, usage);
    await env.DB.prepare(`UPDATE refresh_history SET request_counts_json = json_set(request_counts_json, ${changes.join(', ')}),
      progress_json = coalesce((SELECT progress_json FROM rebuild_jobs WHERE generation = ?), progress_json)
      WHERE generation = ?`).bind(...bindings, generation, generation).run();
  } catch { console.error(JSON.stringify({ event: "refresh_activity_not_saved" })); }
}

export function numericProgress(raw: string | null | undefined): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0));
  } catch { return {}; }
}

export function requestUsage(raw: string | null | undefined): RequestUsage {
  const result: RequestUsage = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object') return result;
    for (const endpoint of ['token', 'profile', 'likedTracks', 'artistAlbums', 'albumTracks', 'tracks', 'playlists', 'playlistItems', 'playlistDetails'] as const) {
      const value = (parsed as Record<string, unknown>)[endpoint];
      if (!value || typeof value !== 'object') continue;
      const counts = value as Record<string, unknown>;
      const fields = ['attempts', 'succeeded', 'failed', 'rateLimited', 'lastAttemptAt', 'lastSuccessAt'] as const;
      if (fields.every((field) => typeof counts[field] === 'number' && Number.isFinite(counts[field]) && counts[field] >= 0)) result[endpoint] = counts as RequestCounts;
    }
  } catch { /* Leave malformed telemetry out of owner status. */ }
  return result;
}
