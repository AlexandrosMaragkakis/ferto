import { isTrackId } from "./domain";

const DAY_MS = 24 * 60 * 60 * 1000;
// Full responses expire daily. Stable metadata alone never proves playability.
const TRACK_CACHE_TTL_MS = DAY_MS;
const IDENTITY_CACHE_TTL_MS = 30 * DAY_MS;
// Only metadata needed for recording selection, playability, and identity.
const TRACK_FIELDS = ["id", "uri", "name", "artists", "album", "external_ids", "external_urls", "is_local", "is_playable", "linked_from", "restrictions"];

export async function readTrackCache(env: Env, market: string | null, ids: string[]): Promise<Map<string, unknown>> {
  const cached = new Map<string, unknown>();
  if (!ids.length) return cached;
  const rows = await env.DB.prepare(
    `WITH requested AS (SELECT value AS id FROM json_each(?))
     SELECT spotify_id, track_json, NULL AS availability, expires_at AS fresh_until, 0 AS priority FROM spotify_track_cache c
     WHERE owner_account_id = ? AND market = ? AND spotify_id IN (SELECT id FROM requested) AND expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM track_availability a WHERE a.owner_account_id=c.owner_account_id
         AND a.market=c.market AND a.spotify_id=c.spotify_id AND a.expires_at>c.expires_at
         AND a.returned_id <> CASE WHEN json_valid(c.track_json) THEN json_extract(c.track_json,'$.id') END)
     UNION ALL
     SELECT i.spotify_id, i.track_json, a.availability_json AS availability, a.expires_at AS fresh_until, 1 AS priority
     FROM recording_identity_cache i JOIN track_availability a
       ON a.owner_account_id = i.owner_account_id AND a.market = i.market AND a.spotify_id = i.spotify_id
       AND a.returned_id = CASE WHEN json_valid(i.track_json) THEN json_extract(i.track_json, '$.id') END
     WHERE i.owner_account_id = ? AND i.market = ? AND i.spotify_id IN (SELECT id FROM requested)
       AND i.expires_at > ? AND a.expires_at > ? ORDER BY fresh_until DESC, priority`,
  ).bind(JSON.stringify(ids), env.OWNER_SPOTIFY_ID, market ?? "", Date.now(), env.OWNER_SPOTIFY_ID, market ?? "", Date.now(), Date.now())
    .all<{ spotify_id: string; track_json: string; availability: string | null }>();
  for (const row of rows.results) {
    try {
      const track = JSON.parse(row.track_json) as { id?: unknown } | null;
      if (track && isTrackId(track.id) && !cached.has(row.spotify_id)) {
        const availability = row.availability ? JSON.parse(row.availability) : null;
        cached.set(row.spotify_id, availability ? { ...track, ...availability } : track);
      }
    } catch {
      // Corrupt cache entries are misses, never permanent track exclusions.
    }
  }
  return cached;
}

export async function writeTrackCache(env: Env, market: string | null, entries: { id: string; track: unknown }[]): Promise<void> {
  const values = entries.flatMap(({ id, track }) => {
    if (!track || typeof track !== "object" || !isTrackId((track as { id?: unknown }).id)) return [];
    const metadata = Object.fromEntries(Object.entries(track).filter(([key]) => TRACK_FIELDS.includes(key)));
    const identity = Object.fromEntries(Object.entries(metadata).filter(([key]) => !["is_playable", "is_local", "linked_from", "restrictions"].includes(key)));
    return [{ id, track: metadata, identity, expiresAt: Date.now() + TRACK_CACHE_TTL_MS }];
  });
  if (!values.length) return;
  // One statement for the entire bounded batch, including partial successes.
  // Cache hits never extend expiry or consume Spotify quota.
  await env.DB.batch([env.DB.prepare(
    `INSERT INTO spotify_track_cache (owner_account_id, market, spotify_id, track_json, expires_at)
     SELECT ?, ?, json_extract(value, '$.id'), json_extract(value, '$.track'), json_extract(value, '$.expiresAt') FROM json_each(?) WHERE 1
     ON CONFLICT(owner_account_id, market, spotify_id)
     DO UPDATE SET track_json = excluded.track_json, expires_at = excluded.expires_at`,
  ).bind(env.OWNER_SPOTIFY_ID, market ?? "", JSON.stringify(values)), env.DB.prepare(
    `INSERT INTO recording_identity_cache(owner_account_id, market, spotify_id, track_json, expires_at)
     SELECT ?, ?, json_extract(value, '$.id'), json_extract(value, '$.identity'), ? FROM json_each(?) WHERE 1
     ON CONFLICT(owner_account_id, market, spotify_id) DO UPDATE SET track_json=excluded.track_json, expires_at=excluded.expires_at`
  ).bind(env.OWNER_SPOTIFY_ID, market ?? "", Date.now() + IDENTITY_CACHE_TTL_MS, JSON.stringify(values))]);
}
