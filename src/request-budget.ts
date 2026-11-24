import { hmacSha256 } from "./security";
import { storageControl } from "./capacity";
import { RequestError } from "./http-security";

/** Shared durable counters outside catalogue D1. Raw IPs are never persisted. */
export async function requestBudget(request: Request, env: Env, kind: "login" | "draw"): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  // Local/demo requests have no Cloudflare client address. Production always
  // has a global budget, including subrequests without a client address.
  if (!ip && !env.APP_ORIGIN.startsWith("https://")) return true;
  const client = await hmacSha256(ip ?? "unknown-client", env.SESSION_SECRET);
  try { return await storageControl(env).admit(kind, client); }
  catch { throw new RequestError("Request protection is temporarily unavailable. Please try again shortly.", 503); }
}

export async function cleanupRequestState(env: Env): Promise<void> {
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at <= ? ORDER BY expires_at LIMIT 128)").bind(timestamp),
    env.DB.prepare("DELETE FROM request_budgets WHERE budget_key IN (SELECT budget_key FROM request_budgets WHERE expires_at <= ? ORDER BY expires_at LIMIT 10000)").bind(timestamp),
  ]);
}
