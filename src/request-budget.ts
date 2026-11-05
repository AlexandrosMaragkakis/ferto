import { hmacSha256, randomToken } from "./security";

/** Shared D1 counters, never per-isolate memory. Raw client IPs are not stored. */
export async function requestBudget(request: Request, env: Env, kind: "login" | "draw"): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  // Local/demo requests have no Cloudflare client address. Production always
  // has a global budget, including subrequests without a client address.
  if (!ip && !env.APP_ORIGIN.startsWith("https://")) return true;
  const timestamp = Date.now();
  const period = 60_000;
  const globalKey = `${kind}:global`;
  const clientKey = `${kind}:${await hmacSha256(ip ?? "unknown-client", env.SESSION_SECRET)}`;
  const clientLimit = kind === "login" ? 5 : 60;
  const admission = randomToken();
  // One transaction checks the client first, admits against the global
  // allowance, then updates that client only if this call won admission.
  // A throttled client cannot spend everyone else's remaining allowance;
  // a globally denied client cannot create an unbounded set of new rows.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO request_budgets (budget_key, requests, expires_at, admission_id)
      SELECT ?, 1, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM request_budgets WHERE budget_key = ? AND expires_at > ? AND requests >= ?)
      ON CONFLICT(budget_key) DO UPDATE SET
        requests = CASE WHEN expires_at <= ? THEN 1 ELSE requests + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END,
        admission_id = excluded.admission_id
      WHERE expires_at <= ? OR requests < ?`)
      .bind(globalKey, timestamp + period, admission, clientKey, timestamp, clientLimit,
        timestamp, timestamp, timestamp, kind === "login" ? 20 : 600),
    env.DB.prepare(`INSERT INTO request_budgets (budget_key, requests, expires_at)
      SELECT ?, 1, ? WHERE EXISTS (
        SELECT 1 FROM request_budgets WHERE budget_key = ? AND admission_id = ?)
      ON CONFLICT(budget_key) DO UPDATE SET
        requests = CASE WHEN expires_at <= ? THEN 1 ELSE requests + 1 END,
        expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
      WHERE expires_at <= ? OR requests < ?`)
      .bind(clientKey, timestamp + period, globalKey, admission, timestamp, timestamp, timestamp, clientLimit),
  ]);
  return Boolean(results[1].meta.changes);
}

export async function cleanupRequestState(env: Env): Promise<void> {
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at <= ? ORDER BY expires_at LIMIT 128)").bind(timestamp),
    env.DB.prepare("DELETE FROM request_budgets WHERE budget_key IN (SELECT budget_key FROM request_budgets WHERE expires_at <= ? ORDER BY expires_at LIMIT 10000)").bind(timestamp),
  ]);
}
