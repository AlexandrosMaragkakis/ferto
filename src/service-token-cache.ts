import { hmacSha256 } from "./security";

export type ServiceToken = { access_token: string; scope: string };
const encoder = new TextEncoder();

async function cacheCredentials(env: Env): Promise<{ cacheKey: string; key: CryptoKey }> {
  // Credential and owner changes invalidate both the key and the cache slot.
  const cacheKey = await hmacSha256(JSON.stringify(["service-token-v1", env.SPOTIFY_CLIENT_ID, env.OWNER_SPOTIFY_ID, env.SPOTIFY_REFRESH_TOKEN]), env.SESSION_SECRET);
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${env.SESSION_SECRET}:${cacheKey}`));
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { cacheKey, key };
}

export async function readServiceToken(env: Env): Promise<ServiceToken | null> {
  const { cacheKey, key } = await cacheCredentials(env);
  const row = await env.DB.prepare("SELECT ciphertext, expires_at FROM service_token_cache WHERE cache_key = ? AND expires_at > ?")
    .bind(cacheKey, Date.now()).first<{ ciphertext: string; expires_at: number }>();
  if (!row) return null;
  try {
    const [iv, encrypted] = JSON.parse(row.ciphertext) as [number[], number[]];
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: encoder.encode(cacheKey) }, key, new Uint8Array(encrypted));
    const token = JSON.parse(new TextDecoder().decode(data)) as ServiceToken & { expires_at: number };
    if (typeof token.access_token !== "string" || !token.access_token || typeof token.scope !== "string"
      || token.expires_at !== row.expires_at || token.expires_at <= Date.now()) return null;
    return { access_token: token.access_token, scope: token.scope };
  } catch {
    return null;
  }
}

export async function writeServiceToken(env: Env, token: ServiceToken, expiresIn: unknown): Promise<void> {
  // Short/unknown lifetimes are deliberately not cached. Leave a minute for
  // a bounded batch to finish before the provider's access token expires.
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 60) return;
  const expiresAt = Date.now() + (Math.min(expiresIn, 3600) - 60) * 1000;
  const { cacheKey, key } = await cacheCredentials(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(cacheKey) }, key,
    encoder.encode(JSON.stringify({ ...token, expires_at: expiresAt })));
  const ciphertext = JSON.stringify([[...iv], [...new Uint8Array(encrypted)]]);
  await env.DB.prepare(`INSERT INTO service_token_cache (cache_key, ciphertext, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET ciphertext = excluded.ciphertext, expires_at = excluded.expires_at`)
    .bind(cacheKey, ciphertext, expiresAt).run();
}

export async function invalidateServiceToken(env: Env): Promise<void> {
  const { cacheKey } = await cacheCredentials(env);
  await env.DB.prepare("DELETE FROM service_token_cache WHERE cache_key = ?").bind(cacheKey).run();
}
