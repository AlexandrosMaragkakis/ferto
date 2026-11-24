// All four tables already have an expires_at index. Keep the limit small:
// DELETE also writes the table's primary-key and expiry indexes on D1.
export const CACHE_CLEANUP_BATCH_SIZE = 32;
const CACHE_TABLES = ["spotify_track_cache", "recording_identity_cache", "track_availability", "album_track_pages"] as const;

/** Expiry is rechecked inside each DELETE, so a concurrent cache refresh cannot
 * be erased by an earlier candidate read. The batch is atomic and never touches
 * catalogue generations, permanent identities or album-availability markers. */
export async function cleanupExpiredCaches(env: Pick<Env, "DB">, timestamp = Date.now()) {
  const results = await env.DB.batch(CACHE_TABLES.map(table => env.DB.prepare(
    `DELETE FROM ${table} WHERE rowid IN (
       SELECT rowid FROM ${table} WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
     )`,
  ).bind(timestamp, CACHE_CLEANUP_BATCH_SIZE)));
  const report = {
    deleted: results.map((result, index) => ({ table: CACHE_TABLES[index], rows: result.meta.changes })),
    rowsRead: results.reduce((sum, result) => sum + result.meta.rows_read, 0),
    rowsWritten: results.reduce((sum, result) => sum + result.meta.rows_written, 0),
  };
  console.log(JSON.stringify({ event: "expired_cache_cleanup", ...report }));
  return report;
}
