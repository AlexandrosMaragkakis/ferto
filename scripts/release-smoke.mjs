import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertProductionConfig, readConfig } from "./deployment-config.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const expect = (condition, message) => { if (!condition) throw new Error(message); };

async function bodyBytes(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error("Smoke response exceeded its expected size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function securityHeaders(response, api = false) {
  for (const [key, expected] of Object.entries({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin" })) {
    expect(response.headers.get(key) === expected, `Missing or incorrect ${key}`);
  }
  const csp = response.headers.get("content-security-policy") || "";
  expect(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && csp.includes("base-uri 'none'"), "Missing CSP protection");
  expect(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"), "Unexpected permissive CSP");
  if (!api) expect(csp.includes("script-src 'self'") && csp.includes("frame-src https://open.spotify.com"), "Incorrect page CSP");
  expect(response.headers.get("strict-transport-security")?.includes("max-age=31536000"), "Missing HTTPS HSTS");
  expect(response.headers.get("permissions-policy")?.includes("microphone=()"), "Missing browser permissions policy");
  if (api) {
    expect(response.headers.get("cache-control") === "no-store", "API responses must not be cached");
    expect(response.headers.get("content-type")?.includes("application/json"), "API did not return JSON");
  }
}

export async function releaseSmoke({ artifact = ".release", fetchImpl = fetch, attempts = 3, retryMs = 2000 } = {}) {
  const folder = resolve(artifact);
  const config = assertProductionConfig(readConfig(join(folder, "wrangler.jsonc")));
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  expect(/^[a-f0-9]{40}$/.test(manifest.revision) && manifest.dirty === false, "Smoke checks need a clean release manifest");
  const origin = config.vars.APP_ORIGIN;
  const checks = [];
  const request = async (path, init = {}) => {
    const url = new URL(path, origin);
    url.searchParams.set("release_check", `${manifest.revision.slice(0, 12)}-${Date.now()}`);
    return fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "Cache-Control": "no-cache", ...init.headers } });
  };
  for (const [file, expected] of Object.entries(manifest.files)) {
    expect(!file.startsWith("/") && !file.includes("\\") && !file.split("/").includes(".."), "Unsafe manifest path");
    if (!file.startsWith("assets/") || ["assets/_headers", "assets/_redirects"].includes(file)) continue;
    expect(/^[a-f0-9]{64}$/.test(expected), "Invalid asset checksum");
    const local = join(folder, file); const info = await lstat(local);
    expect(info.isFile() && !info.isSymbolicLink(), "Asset must be a regular file");
    const bytes = await readFile(local); expect(sha(bytes) === expected, `Local asset changed: ${file}`);
    const path = file === "assets/index.html" ? "/" : "/" + file.slice(7).split("/").map(encodeURIComponent).join("/");
    let matched = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await request(path);
        expect(response.status === 200, `Asset returned HTTP ${response.status}: ${path}`);
        const actual = await bodyBytes(response, bytes.length + 1);
        if (sha(actual) === expected) { securityHeaders(response); matched = true; break; }
      } catch { /* Retry bounded propagation/network failures, never accept mismatches. */ }
      if (attempt + 1 < attempts) await new Promise(resolveWait => setTimeout(resolveWait, retryMs));
    }
    expect(matched, `Deployed asset differs from the release: ${path}`);
    checks.push({ path, checksum: "match", headers: "pass" });
  }
  expect(checks.some(check => check.path === "/") && checks.length > 1, "Release is missing its homepage or static assets");
  const json = async (path, status, init) => {
    const response = await request(path, init);
    expect(response.status === status, `Unexpected HTTP ${response.status} for ${path}; expected ${status}`);
    securityHeaders(response, true);
    let payload;
    try { payload = JSON.parse((await bodyBytes(response, 131072)).toString("utf8")); }
    catch { throw new Error(`Invalid JSON response for ${path}`); }
    checks.push({ path, method: init?.method || "GET", status });
    return { response, payload };
  };
  const { payload } = await json("/api/recommendation", 200);
  expect(Number.isInteger(payload.candidateCount) && payload.candidateCount >= 0 && "recommendation" in payload, "Invalid public catalogue response");
  expect(payload.recommendation === null || /^[a-zA-Z0-9]{22}$/.test(payload.recommendation?.spotify_id), "Invalid public track identifier");
  const session = await json("/api/owner/session", 200);
  expect(session.payload.authenticated === false, "Anonymous smoke check unexpectedly authenticated");
  const csrf = session.response.headers.getSetCookie().map(value => /^ferto_csrf=([^;]+)/.exec(value)?.[1]).find(Boolean);
  expect(csrf && /^[a-zA-Z0-9_-]+$/.test(csrf), "Missing anonymous CSRF cookie");
  for (const path of ["/api/owner/history", "/api/owner/refresh"]) await json(path, 401);
  for (const path of ["/api/owner/like", "/api/owner/never-again", "/api/owner/refresh"]) {
    await json(path, 401, { method: "POST", headers: { Origin: origin, Cookie: `ferto_csrf=${csrf}`, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: "{}" });
  }
  await json("/api/owner/like", 403, { method: "POST", headers: { Origin: "https://example.invalid", "Content-Type": "application/json" }, body: "{}" });
  await json("/api/owner/callback", 400);
  return { revision: manifest.revision, origin, assetCount: checks.filter(check => check.checksum).length, candidateCount: payload.candidateCount, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { artifact: { type: "string" } } });
  releaseSmoke({ artifact: values.artifact }).then(report => console.log(`Release ${report.revision.slice(0, 12)} verified: ${report.assetCount} exact asset hashes, API security headers and anonymous authorization/CSRF checks. No Spotify writes.`))
    .catch(() => { console.error("Release smoke checks failed. Keep Queue delivery paused during a release and investigate the deployed version, assets, headers and authorization."); process.exitCode = 1; });
}
