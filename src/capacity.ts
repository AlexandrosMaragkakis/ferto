import { storageFailure } from "./storage-failure";
export type { Capacity } from "./storage-control-state";
export const CAPACITY_CHECK_MS = 5 * 60_000;

export function storageControl(env: Env) {
  return env.STORAGE_CONTROL.getByName(JSON.stringify([env.SPOTIFY_CLIENT_ID, env.OWNER_SPOTIFY_ID]));
}

/** Use D1's supported response metadata: one constant query, no catalogue scan. */
export async function checkCapacity(env: Env, force = false) {
  const control = storageControl(env);
  const before = await control.snapshot();
  if (!force && before.capacity.checkedAt !== null && Date.now() - before.capacity.checkedAt < CAPACITY_CHECK_MS) return before;
  try {
    const result = await env.DB.prepare("SELECT 1 AS capacity_probe").all();
    if (before.capacity.reason === "storage" && result.meta.size_after <= before.capacity.resumeBytes) {
      // A read alone cannot prove that the account permits writes again.
      // Use one bounded, rolled-together insert/delete in the legacy budget
      // table; no probe row survives and no provider mutation is involved.
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO request_budgets(budget_key,requests,expires_at) VALUES ('capacity:probe',1,?)").bind(Date.now() + 60_000),
        env.DB.prepare("DELETE FROM request_budgets WHERE budget_key='capacity:probe'"),
      ]);
    }
    return await control.observeCapacity(result.meta.size_after, Date.now());
  } catch (cause) {
    const kind = storageFailure(cause);
    if (kind) return control.noteFailure(kind);
    throw cause;
  }
}

export async function recordStorageFailure(env: Env, cause: unknown) {
  const kind = storageFailure(cause);
  if (kind) await storageControl(env).noteFailure(kind);
  return kind;
}
