import { removeFromRecommendationPool } from "./rebuild";
import { storageControl, recordStorageFailure } from "./capacity";
import type { PendingSave } from "./storage-control-state";

type ResolvedRecording = {
  recordingKey: string | null;
  liveGeneration: string | null;
  liveRecordingKey: string | null;
  activeGeneration: string | null;
  activeRecordingKey: string | null;
};

export async function resolveRecording(env: Env, trackId: string): Promise<ResolvedRecording> {
  // A card can remain open while a rebuild promotes a different representative
  // of the same recording. Search retained history as well as current state and
  // prefer an ISRC identity, while retaining exact live/staging aliases so a
  // migrated spotify:<id> row disappears immediately after an ISRC upgrade.
  const row = await env.DB.prepare(
    `SELECT
       (SELECT live_generation FROM refresh_state WHERE singleton = 1) AS live_generation,
       (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active') AS active_generation,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
        ORDER BY CASE WHEN r.recording_key LIKE 'isrc:%' THEN 0 ELSE 1 END,
                 CASE WHEN r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1) THEN 0 ELSE 1 END
        LIMIT 1) AS recording_key,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
          AND r.generation = (SELECT live_generation FROM refresh_state WHERE singleton = 1)
        LIMIT 1) AS live_recording_key,
       (SELECT r.recording_key FROM recordings r
        WHERE r.spotify_id = ?
          AND r.generation = (SELECT generation FROM rebuild_jobs WHERE singleton = 1 AND status = 'active')
        LIMIT 1) AS active_recording_key`,
  ).bind(trackId, trackId, trackId).first<{ recording_key: string | null; live_generation: string | null; live_recording_key: string | null; active_generation: string | null; active_recording_key: string | null }>();
  return {
    recordingKey: row?.recording_key ?? null,
    liveGeneration: row?.live_generation ?? null,
    liveRecordingKey: row?.live_recording_key ?? null,
    activeGeneration: row?.active_generation ?? null,
    activeRecordingKey: row?.active_recording_key ?? null,
  };
}

export async function applyConfirmedSave(env: Env, trackId: string, key: string): Promise<string> {
  // Re-read destinations in one SQL snapshot after Spotify confirms the save.
  // Across promotion this yields either old-live + active-staging, or the new
  // live generation; it can never observe old-live + no active generation.
  const destinations = await resolveRecording(env, trackId);
  if (destinations.recordingKey?.startsWith("isrc:")) key = destinations.recordingKey;
  const live = destinations.liveGeneration;
  const active = destinations.activeGeneration;
  const statements = [];
  if (live) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(live, key));
  if (live && destinations.liveRecordingKey && destinations.liveRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(live, destinations.liveRecordingKey));
  if (active && active !== live) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(active, key));
  if (active && active !== live && destinations.activeRecordingKey && destinations.activeRecordingKey !== key) statements.push(env.DB.prepare("INSERT OR IGNORE INTO rebuild_known_recordings (generation, recording_key) VALUES (?, ?)").bind(active, destinations.activeRecordingKey));
  if (statements.length) await env.DB.batch(statements);
  if (live) await removeFromRecommendationPool(env, live, destinations.liveRecordingKey ?? key);
  // If promotion linearized after the destination snapshot, this generation is
  // live now; compacting it also repairs counts before the owner request ends.
  if (active && active !== live) await removeFromRecommendationPool(env, active, destinations.activeRecordingKey ?? key);
  return key;
}

/** A confirmed provider write is reconciled without issuing another Spotify
 * mutation. The receipt survives D1 errors, restarts and catalogue promotion. */
export async function completeSave(env: Env, trackId: string, key: string, operation: string): Promise<Response | string> {
  try {
    const canonical = await applyConfirmedSave(env, trackId, key);
    await storageControl(env).finishSave(trackId, operation);
    return canonical;
  } catch (cause) {
    try { await recordStorageFailure(env, cause); } catch { /* Receipt stays durable. */ }
    console.error(JSON.stringify({ event: "spotify_save_reconciliation_pending" }));
    return Response.json({ ok: false, spotifySaved: true, pending: true,
      error: "Saved to Spotify. FERTO will finish updating this song when storage is available. You can safely retry Add." },
    { status: 202, headers: { "Cache-Control": "no-store" } });
  }
}

export async function reconcilePendingSaves(env: Env): Promise<void> {
  const control = storageControl(env);
  await control.expireIntents();
  const pending: PendingSave[] = (await control.saves()).filter(save => save.state === "confirmed").slice(0, 4);
  for (const save of pending) {
    const result = await completeSave(env, save.trackId, save.recordingKey, save.operation);
    if (result instanceof Response) break; // Don't spend a failing database's allowance repeatedly.
  }
}

