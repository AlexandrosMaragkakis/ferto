import { isTrackId, knownRecordingKey } from "./domain";
import { sha256 } from "./security";
import { JOB_MUTATION_GUARD, jobMutationBindings, type JobMutationGuard } from "./rebuild-guard";

export const PLAYLIST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ALBUM_PAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export type KnownTrack = { id: string; key: string };

export function catalogueContext(env: Env, market: string | null): Promise<string> {
  return sha256(JSON.stringify([env.SPOTIFY_CLIENT_ID, env.OWNER_SPOTIFY_ID, market ?? ""]));
}

export function knownTracks(tracks: unknown[]): KnownTrack[] {
  const mappings: KnownTrack[] = [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") continue;
    const value = track as Parameters<typeof knownRecordingKey>[0] & { linked_from?: { id?: unknown } | null };
    const key = knownRecordingKey(value);
    if (!key || !isTrackId(value.id)) continue;
    mappings.push({ id: value.id, key });
    if (isTrackId(value.linked_from?.id)) mappings.push({ id: value.linked_from.id, key });
  }
  return mappings;
}

export function knownTrackStatements(env: Env, job: JobMutationGuard, mappings: KnownTrack[]): D1PreparedStatement[] {
  if (!mappings.length) return [];
  const values = JSON.stringify(mappings);
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key)
      SELECT ?, json_extract(value, '$.key') FROM json_each(?) WHERE ${JOB_MUTATION_GUARD}`)
      .bind(job.generation, values, ...jobMutationBindings(job)),
    env.DB.prepare(`INSERT OR IGNORE INTO rebuild_known_tracks (generation, spotify_id, recording_key)
      SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.key') FROM json_each(?) WHERE ${JOB_MUTATION_GUARD}`)
      .bind(job.generation, values, ...jobMutationBindings(job)),
    publishedKnownStatement(env, job, mappings.map(mapping => mapping.key)),
  ];
}

/** A later liked scan or learned alias must also exclude an early public copy,
 * including when the final replacement is quarantined. Public draws compact
 * such slots lazily through their existing recording-wide exclusion check. */
function publishedKnownStatement(env: Env, job: JobMutationGuard, keys: string[]): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO rebuild_known_recordings(generation,recording_key)
    SELECT p.live_generation,p.recording_key FROM refresh_publications p
    WHERE p.generation=? AND p.recording_key IN (SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM rebuild_known_recordings k WHERE k.generation=p.generation AND k.recording_key=p.recording_key)
      AND ${JOB_MUTATION_GUARD}`)
    .bind(job.generation, JSON.stringify([...new Set(keys)]), ...jobMutationBindings(job));
}

/** Missing canonical identity must still be enriched, even for an exact known id. */
export async function unknownTrackIds(env: Env, generation: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`SELECT DISTINCT value AS id FROM json_each(?)
    WHERE NOT EXISTS (SELECT 1 FROM rebuild_known_tracks k
      WHERE k.generation = ? AND k.spotify_id = value AND k.recording_key LIKE 'isrc:%')
    AND NOT EXISTS (SELECT 1 FROM never_recordings n WHERE n.spotify_id = value AND n.isrc IS NOT NULL)`)
    .bind(JSON.stringify(ids), generation).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export function knownIdentityStatements(env: Env, job: JobMutationGuard, identities: { spotifyId: string; isrc: string }[]): D1PreparedStatement[] {
  if (!identities.length) return [];
  // Strengthen id-only known exclusions before staging any equivalent version.
  return [env.DB.prepare(`INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key)
    SELECT ?, 'isrc:' || json_extract(i.value, '$.isrc') FROM json_each(?) i
    WHERE EXISTS (SELECT 1 FROM rebuild_known_tracks k WHERE k.generation = ? AND k.spotify_id = json_extract(i.value, '$.spotifyId'))
      AND ${JOB_MUTATION_GUARD}`)
    .bind(job.generation, JSON.stringify(identities), job.generation, ...jobMutationBindings(job)),
    publishedKnownStatement(env, job, identities.map(identity => `isrc:${identity.isrc}`))];
}

export async function readPlaylistPage(env: Env, context: string, playlist: string, snapshot: string, after: string | null): Promise<{
  mappings: KnownTrack[]; pageKey: string; hasNext: boolean;
} | null> {
  const rows = await env.DB.prepare(`SELECT page_key, tracks_json FROM playlist_snapshot_pages
    WHERE context = ? AND spotify_id = ? AND snapshot_id = ? AND page_key > ? ORDER BY page_key LIMIT 2`)
    .bind(context, playlist, snapshot, after ?? "").all<{ page_key: string; tracks_json: string }>();
  const row = rows.results[0];
  if (!row) return null;
  const values = JSON.parse(row.tracks_json) as unknown;
  if (!Array.isArray(values) || !values.every((entry) => entry && typeof entry === "object" && isTrackId(entry.id)
    && typeof entry.key === "string" && /^(?:isrc:[A-Z0-9]{12}|spotify:[A-Za-z0-9]{22})$/.test(entry.key))) throw new Error("Invalid cached playlist page");
  return { mappings: values, pageKey: row.page_key, hasNext: rows.results.length > 1 };
}

export function playlistPageStatement(env: Env, job: JobMutationGuard, context: string, playlist: string, snapshot: string, pageKey: string, mappings: KnownTrack[]): D1PreparedStatement {
  // One cached JSON page, rather than an indexed row per track. Reuse is also
  // paged, so even a huge playlist cannot consume a day's D1 writes in one unit.
  return env.DB.prepare(`INSERT INTO playlist_snapshot_pages (context, spotify_id, snapshot_id, page_key, tracks_json)
    SELECT ?, ?, ?, ?, ? WHERE ${JOB_MUTATION_GUARD}
    ON CONFLICT(context, spotify_id, snapshot_id, page_key) DO UPDATE SET tracks_json = excluded.tracks_json`)
    .bind(context, playlist, snapshot, pageKey, JSON.stringify(mappings), ...jobMutationBindings(job));
}

export async function readAlbumPage(env: Env, context: string, album: string, cursor: string): Promise<{ ids: string[]; next: string | null } | null> {
  const row = await env.DB.prepare(`SELECT track_ids_json, next_cursor FROM album_track_pages
    WHERE context = ? AND album_id = ? AND cursor = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM album_availability_pages a WHERE a.context = album_track_pages.context
        AND a.album_id = album_track_pages.album_id AND a.cursor = album_track_pages.cursor AND a.expires_at <= ?)`)
    .bind(context, album, cursor, Date.now(), Date.now()).first<{ track_ids_json: string; next_cursor: string | null }>();
  if (!row) return null;
  try {
    const ids = JSON.parse(row.track_ids_json) as unknown;
    if (!Array.isArray(ids) || !ids.every(isTrackId) || (row.next_cursor !== null && !row.next_cursor.startsWith("https://api.spotify.com/"))) return null;
    return { ids, next: row.next_cursor };
  } catch { return null; }
}

/** Simplified album tracks supply availability, never a guessed recording identity. */
export function albumAvailabilityStatements(env: Env, job: JobMutationGuard & { market: string | null }, context: string,
  album: string, cursor: string, tracks: unknown[]): D1PreparedStatement[] {
  const values = tracks.flatMap((track) => {
    if (!track || typeof track !== "object") return [];
    const value = track as { id?: unknown; is_playable?: unknown; is_local?: unknown; restrictions?: unknown; linked_from?: { id?: unknown } };
    if (!isTrackId(value.id) || typeof value.is_playable !== "boolean") return [];
    return [{ id: isTrackId(value.linked_from?.id) ? value.linked_from.id : value.id, returnedId: value.id,
      availability: { is_playable: value.is_playable && !value.restrictions, is_local: value.is_local === true } }];
  });
  const expires = Date.now() + AVAILABILITY_TTL_MS;
  return [env.DB.prepare(`INSERT INTO track_availability(owner_account_id, market, spotify_id, returned_id, availability_json, expires_at)
    SELECT ?, ?, json_extract(value, '$.id'), json_extract(value, '$.returnedId'), json_extract(value, '$.availability'), ?
    FROM json_each(?) WHERE ${JOB_MUTATION_GUARD}
    ON CONFLICT(owner_account_id, market, spotify_id) DO UPDATE SET returned_id=excluded.returned_id,
      availability_json=excluded.availability_json, expires_at=excluded.expires_at`)
    .bind(env.OWNER_SPOTIFY_ID, job.market ?? "", expires, JSON.stringify(values), ...jobMutationBindings(job)),
  env.DB.prepare(`INSERT INTO album_availability_pages(context, album_id, cursor, expires_at)
    SELECT ?, ?, ?, ? WHERE ${JOB_MUTATION_GUARD}
    ON CONFLICT(context, album_id, cursor) DO UPDATE SET expires_at=excluded.expires_at`)
    .bind(context, album, cursor, expires, ...jobMutationBindings(job))];
}

export function albumPageStatement(env: Env, job: JobMutationGuard, context: string, album: string, cursor: string, ids: string[], next: string | null): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO album_track_pages (context, album_id, cursor, track_ids_json, next_cursor, expires_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${JOB_MUTATION_GUARD}
    ON CONFLICT(context, album_id, cursor) DO UPDATE SET track_ids_json = excluded.track_ids_json,
      next_cursor = excluded.next_cursor, expires_at = excluded.expires_at`)
    .bind(context, album, cursor, JSON.stringify(ids), next, Date.now() + ALBUM_PAGE_TTL_MS, ...jobMutationBindings(job));
}
