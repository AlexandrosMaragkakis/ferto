import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { applyCurrentSchema } from "./current-schema";
import { hmacSha256 } from "../src/security";
import { cleanupRequestState } from "../src/request-budget";
import { fetchWithDeadline } from "../src/request";
import { HTML_CSP, PERMISSIONS_POLICY, jsonObject } from "../src/http-security";
import staticHeaders from "../web/public/_headers?raw";

const origin = env.APP_ORIGIN;
const post = (path: string, cookie = "ferto_csrf=csrf", body = "{}", extra: HeadersInit = {}) => new Request(`${origin}${path}`, {
  method: "POST", headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...extra }, body,
});
async function begin() {
  const response = await worker.fetch(post("/api/owner/login"), env);
  expect(response.status).toBe(200);
  const body = await response.json<{ authorizeUrl: string }>();
  return { state: new URL(body.authorizeUrl).searchParams.get("state")!, cookie: response.headers.get("Set-Cookie")!.split(";")[0], response };
}
function callback(state: string, cookie?: string, params = "code=test-code") {
  return new Request(`${origin}/api/owner/callback?${params}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}
async function ownerCookie() {
  const raw = "security-test-session";
  await env.DB.prepare("INSERT INTO owner_sessions (session_hash, spotify_account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await hmacSha256(raw, env.SESSION_SECRET), env.OWNER_SPOTIFY_ID, Date.now() + 60000, Date.now()).run();
  return `ferto_session=${raw}; ferto_csrf=csrf`;
}
const count = async (table: "oauth_states" | "owner_sessions") => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("publication security regressions", () => {
  beforeAll(() => applyCurrentSchema(env.DB));
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.batch([env.DB.prepare("DELETE FROM oauth_states"), env.DB.prepare("DELETE FROM owner_sessions"), env.DB.prepare("DELETE FROM request_budgets")]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("requires the initiating browser and does not consume state on a mismatch", async () => {
    const pending = await begin();
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    for (const cookie of [undefined, `ferto_oauth=${"x".repeat(43)}`]) {
      expect((await worker.fetch(callback(pending.state, cookie), env)).status).toBe(400);
      expect(await count("oauth_states")).toBe(1);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture-access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ account_id: env.OWNER_SPOTIFY_ID })));
    const response = await worker.fetch(callback(pending.state, pending.cookie), env);
    expect(response.status).toBe(302);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await count("owner_sessions")).toBe(1);
  });

  it("consumes a valid transaction atomically across simultaneous callbacks and replay", async () => {
    const pending = await begin();
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "fixture-access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ account_id: env.OWNER_SPOTIFY_ID })));
    vi.stubGlobal("fetch", fetchSpy);
    const responses = await Promise.all([worker.fetch(callback(pending.state, pending.cookie), env), worker.fetch(callback(pending.state, pending.cookie), env)]);
    expect(responses.map(response => response.status).sort()).toEqual([302, 400]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await count("oauth_states")).toBe(0);
    expect(await count("owner_sessions")).toBe(1);
    expect((await worker.fetch(callback(pending.state, pending.cookie), env)).status).toBe(400);
  });

  it("consumes cancellation without contacting Spotify and clears the browser cookie", async () => {
    const pending = await begin(), fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const response = await worker.fetch(callback(pending.state, pending.cookie, "error=access_denied"), env);
    expect(response.status).toBe(400);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await count("oauth_states")).toBe(0);
    expect(await count("owner_sessions")).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects expired transactions without exchanging a code", async () => {
    const pending = await begin();
    await env.DB.prepare("UPDATE oauth_states SET expires_at = 1").run();
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    expect((await worker.fetch(callback(pending.state, pending.cookie), env)).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a Secure HttpOnly Lax callback cookie for HTTPS sign-in", async () => {
    const testEnv = { ...env, APP_ORIGIN: "https://music.example.com" };
    const request = new Request(`${testEnv.APP_ORIGIN}/api/owner/login`, { method: "POST", headers: { Origin: testEnv.APP_ORIGIN, Cookie: "ferto_csrf=csrf", "X-CSRF-Token": "csrf" } });
    const response = await worker.fetch(request, testEnv);
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/api/owner/callback"); expect(cookie).toContain("Max-Age=600");
  });

  it("caps outstanding OAuth transactions across concurrent callers", async () => {
    const responses = await Promise.all(Array.from({ length: 40 }, () => worker.fetch(post("/api/owner/login"), env)));
    expect(responses.filter(response => response.status === 200)).toHaveLength(32);
    expect(responses.filter(response => response.status === 429)).toHaveLength(8);
    expect(await count("oauth_states")).toBe(32);
  });

  it("throttles OAuth by client without storing the raw client address", async () => {
    for (let attempt = 0; attempt < 5; attempt++) expect((await worker.fetch(post("/api/owner/login", undefined, "{}", { "CF-Connecting-IP": "192.0.2.17" }), env)).status).toBe(200);
    const response = await worker.fetch(post("/api/owner/login", undefined, "{}", { "CF-Connecting-IP": "192.0.2.17" }), env);
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60");
    expect(await count("oauth_states")).toBe(5);
    const keys = await env.DB.prepare("SELECT budget_key FROM request_budgets").all();
    expect(JSON.stringify(keys)).not.toContain("192.0.2.17");
    expect(await env.DB.prepare("SELECT requests FROM request_budgets WHERE budget_key = 'login:global'").first()).toEqual({ requests: 5 });
  });

  it("throttles public draws and permits them again after the budget expires", async () => {
    const draw = () => worker.fetch(new Request(`${origin}/api/recommendation`, { headers: { "CF-Connecting-IP": "192.0.2.22" } }), env);
    for (let attempt = 0; attempt < 60; attempt++) expect((await draw()).status).toBe(200);
    const blocked = await draw(); expect(blocked.status).toBe(429); expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await env.DB.prepare("SELECT requests FROM request_budgets WHERE budget_key = 'draw:global'").first()).toEqual({ requests: 60 });
    await env.DB.prepare("UPDATE request_budgets SET expires_at = 1").run();
    expect((await draw()).status).toBe(200);
  });

  it("bounds expiry cleanup and preserves unexpired transactions", async () => {
    await begin();
    await env.DB.batch(Array.from({ length: 140 }, (_, id) => env.DB.prepare("INSERT INTO oauth_states (state_hash,code_verifier,expires_at) VALUES (?, 'old', 1)").bind(`old-${id}`)));
    await cleanupRequestState(env);
    expect(await count("oauth_states")).toBe(13);
    await cleanupRequestState(env);
    expect(await count("oauth_states")).toBe(1);
  });

  it("sanitizes asynchronous database failures and applies API headers on errors", async () => {
    const errorLog = vi.fn();
    vi.stubGlobal("console", { ...console, log: () => {}, error: errorLog });
    const database = new Proxy(env.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => new Proxy(target.prepare(sql), { get(statement, member) {
        if (member === "first" || member === "all") return async () => { throw new Error("sensitive-database-detail"); };
        const value = Reflect.get(statement, member); return typeof value === "function" ? value.bind(statement) : value;
      } });
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await worker.fetch(new Request(`${origin}/api/recommendation`), { ...env, DB: database });
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "request failed" });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(errorLog).toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive-database-detail");
  });

  it("rejects malformed, non-object and oversized mutation bodies before Spotify or exclusions", async () => {
    const cookie = await ownerCookie(), fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    for (const body of ["null", "[]", "42", '"text"', "true", "{", "{}", '{"trackId":"short"}']) {
      expect((await worker.fetch(post("/api/owner/never-again", cookie, body), env)).status).toBe(400);
    }
    expect((await worker.fetch(post("/api/owner/like", cookie, JSON.stringify({ trackId: "x".repeat(2000) })), env)).status).toBe(413);
    expect((await worker.fetch(post("/api/owner/like", cookie, "{}", { "Content-Length": "99999" }), env)).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM never_recordings").first()).toEqual({ n: 0 });
  });

  it("shares tested HTML headers with the static asset policy and protects API responses", async () => {
    expect(staticHeaders).toContain(`Content-Security-Policy: ${HTML_CSP}`);
    expect(staticHeaders).toContain(`Permissions-Policy: ${PERMISSIONS_POLICY}`);
    const response = await worker.fetch(new Request(`${origin}/api/owner/session`), env);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("bounds a stalled request-body stream and checks streamed byte size", async () => {
    const headers = { "Content-Type": "application/json" };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() { cancelled = true; } });
    await expect(jsonObject(new Request(`${origin}/api/owner/like`, { method: "POST", headers, body }), 10)).rejects.toMatchObject({ status: 408 });
    expect(cancelled).toBe(true);
    const large = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); controller.close(); } });
    await expect(jsonObject(new Request(`${origin}/api/owner/like`, { method: "POST", headers: { ...headers, "Content-Length": "1" }, body: large }))).rejects.toMatchObject({ status: 413 });
  });

  it("bounds a hung network request and supplies a body-read deadline signal", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }));
    await expect(fetchWithDeadline("https://example.invalid", {}, 10)).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => { signal = init.signal; return Promise.resolve(new Response("{}")); }));
    await fetchWithDeadline("https://example.invalid", {}, 10);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(true);
  });
});
