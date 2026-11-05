import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseSmoke } from "./release-smoke.mjs";

const headers = api => ({ "Content-Security-Policy": api ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; script-src 'self'; frame-src https://open.spotify.com",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin", "Strict-Transport-Security": "max-age=31536000", "Permissions-Policy": "microphone=()",
  ...(api ? { "Cache-Control": "no-store", "Content-Type": "application/json" } : {}) });

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "ferto-smoke-")); await mkdir(join(folder, "assets"));
  const assets = { "/": "<title>FERTO</title>", "/app.js": "console.log('release');" };
  const files = {};
  for (const [path, value] of Object.entries(assets)) {
    const file = path === "/" ? "assets/index.html" : "assets" + path;
    await writeFile(join(folder, file), value); files[file] = createHash("sha256").update(value).digest("hex");
  }
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ revision: "a".repeat(40), dirty: false, files }));
  await writeFile(join(folder, "wrangler.jsonc"), JSON.stringify({ name: "ferto", vars: { SPOTIFY_CLIENT_ID: "fixture", OWNER_SPOTIFY_ID: "owner", APP_ORIGIN: "https://ferto.example.com" },
    d1_databases: [{ binding: "DB", database_name: "ferto", database_id: "11111111-1111-4111-8111-111111111111" }], queues: { producers: [{ queue: "ferto-refresh" }], consumers: [{ queue: "ferto-refresh" }] } }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.pathname; calls.push({ path, init });
    if (path in assets) return new Response(assets[path], { headers: headers(false) });
    let status = 401, payload = { error: "owner required" };
    const h = headers(true);
    if (path === "/api/recommendation") { status = 200; payload = { candidateCount: 1, recommendation: { spotify_id: "1234567890123456789012" } }; }
    if (path === "/api/owner/session") { status = 200; payload = { authenticated: false }; h["Set-Cookie"] = "ferto_csrf=fixture-csrf; Path=/; Secure"; }
    if (init.headers.Origin === "https://example.invalid") status = 403;
    if (path === "/api/owner/callback") status = 400;
    return new Response(JSON.stringify(payload), { status, headers: h });
  };
  return { folder, fetchImpl, calls };
}

test("smoke identifies exact assets and probes unauthorized writes without Spotify requests", async () => {
  const f = await fixture();
  try {
    const report = await releaseSmoke({ artifact: f.folder, fetchImpl: f.fetchImpl, attempts: 1 });
    assert.equal(report.assetCount, 2);
    const writes = f.calls.filter(call => call.init.method === "POST");
    assert.equal(writes.length, 4);
    assert.ok(writes.slice(0, 3).every(call => call.init.headers["X-CSRF-Token"] === "fixture-csrf"));
    assert.ok(f.calls.every(call => call.init.redirect === "error"));
  } finally { await rm(f.folder, { recursive: true, force: true }); }
});

for (const kind of ["old assets", "missing headers", "unprotected writes"]) {
  test(`smoke rejects ${kind} even when the site and catalogue return 200`, async () => {
    const f = await fixture();
    try {
      const fetchImpl = async (url, init) => {
        const response = await f.fetchImpl(url, init);
        if (kind === "old assets" && url.pathname === "/app.js") return new Response("older code", { headers: headers(false) });
        if (kind === "missing headers" && url.pathname === "/") response.headers.delete("X-Frame-Options");
        if (kind === "unprotected writes" && init.method === "POST") return new Response("{}", { status: 200, headers: headers(true) });
        return response;
      };
      await assert.rejects(releaseSmoke({ artifact: f.folder, fetchImpl, attempts: 1 }));
    } finally { await rm(f.folder, { recursive: true, force: true }); }
  });
}
