#!/usr/bin/env node
/**
 * FERTO service-token authorization helper.
 *
 * Obtains a Spotify refresh token for the configured owner account using a
 * local PKCE loopback flow — no client secret is used, exchanged, or stored.
 * This is the *service* token the Worker uses for weekly catalogue rebuilds
 * and Like saves. It is completely separate from the identity-only browser
 * sign-in (user-read-private): this script never receives or writes the
 * browser identity token, and it never requests playback scopes.
 *
 * Destinations (exactly one is required):
 *   --local       rewrite only the SPOTIFY_REFRESH_TOKEN entry in the ignored
 *                 .dev.vars file, preserving every other line and mode 0600.
 *   --production  pipe the token to `npx wrangler secret put
 *                 SPOTIFY_REFRESH_TOKEN` through child stdin (argv array,
 *                 no shell).
 *
 * The refresh token is never printed. Any failure stores nothing.
 */

/** The exact v4 service scope set. Playback scopes must never appear here. */
export const SERVICE_SCOPES = [
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-private",
];

export const REFRESH_TOKEN_KEY = "SPOTIFY_REFRESH_TOKEN";
export const DEFAULT_PORT = 8931;
const CALLBACK_PATH = "/callback";
const AUTHORIZE_ENDPOINT = "https://accounts.spotify.com/authorize";
const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const ME_ENDPOINT = "https://api.spotify.com/v1/me";
/** How long the browser gets to complete the OAuth round-trip. */
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function scopeString() {
  return SERVICE_SCOPES.join(" ");
}

/** URL-safe base64 without padding (RFC 7636 / RFC 4648 §5). */
export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Cryptographically random URL-safe secret (43 chars for the default 32 bytes). */
export function randomSecret(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** S256 PKCE code challenge derived from a verifier. */
export async function deriveChallenge(codeVerifier) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64url(new Uint8Array(digest));
}

/** Constant-time string comparison (safe for state checks). */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) ?? 0) ^ (b.charCodeAt(index) ?? 0);
  }
  return diff === 0;
}

export function buildAuthorizeUrl({ clientId, redirectUri, codeChallenge, state }) {
  const url = new URL(AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("scope", scopeString());
  url.searchParams.set("state", state);
  return url;
}

/** Required service scopes absent from the granted-scope list. */
export function missingScopes(granted) {
  const grantedSet = new Set(String(granted ?? "").split(/[+\s]+/).filter(Boolean));
  return SERVICE_SCOPES.filter((scope) => !grantedSet.has(scope));
}

/**
 * Validate the loopback OAuth callback. Returns { ok: true, code } or
 * { ok: false, reason }. The state must match the generated one exactly.
 */
export function validateCallback(callbackUrl, expectedState) {
  const url = callbackUrl instanceof URL ? callbackUrl : new URL(String(callbackUrl));
  const error = url.searchParams.get("error");
  if (error) return { ok: false, reason: `Spotify reported an authorization error: ${error}` };
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return { ok: false, reason: "the callback is missing an authorization code" };
  if (!expectedState || !state || !safeEqual(state, expectedState)) {
    return { ok: false, reason: "state mismatch — the callback looks forged, stale, or replayed" };
  }
  return { ok: true, code };
}

/** Minimal KEY=VALUE parsing for .dev.vars (comments and blanks skipped). */
export function parseDevVars(content) {
  const values = {};
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

/**
 * Replace (or append) only the SPOTIFY_REFRESH_TOKEN entry, preserving every
 * other byte of the file. Refuses tokens containing anything that could break
 * the line format.
 */
export function updateDevVarsContent(content, refreshToken) {
  const token = String(refreshToken ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error("refusing to write a refresh token containing unexpected characters");
  }
  const entry = `${REFRESH_TOKEN_KEY}=${token}`;
  // Match the whole KEY=VALUE up to (but not including) the line terminator.
  // No `$` anchor: the trailing `\r` of a CRLF file must stay out of match[0]
  // so `line.slice(match[0].length)` can re-attach it (see below).
  const pattern = /^(\s*SPOTIFY_REFRESH_TOKEN\s*=)[^\r\n]*/;
  const lines = String(content ?? "").split("\n");
  let replaced = false;
  const updated = lines.map((line) => {
    const match = pattern.exec(line);
    if (!match) return line;
    replaced = true;
    // Preserve whatever terminated the line (a trailing \r in CRLF files).
    return `${match[1]}${token}${line.slice(match[0].length)}`;
  });
  if (replaced) return updated.join("\n");
  if (!content) return `${entry}\n`;
  return content.endsWith("\n") ? `${content}${entry}\n` : `${content}\n${entry}\n`;
}

export function parseArgs(argv) {
  const options = {
    help: false,
    local: false,
    production: false,
    yes: false,
    port: DEFAULT_PORT,
    devVarsPath: ".dev.vars",
    configPath: undefined,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--production") options.production = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port value (expected 0-65535)`);
      options.port = port;
    } else if (arg.startsWith("--dev-vars=")) options.devVarsPath = arg.slice("--dev-vars=".length);
    else if (arg === "--dev-vars") options.devVarsPath = value();
    else if (arg === "--config") options.configPath = value();
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/** Exactly one destination must be chosen. */
export function destinationOf(options) {
  if (options.local === options.production) {
    throw new Error("choose exactly one destination: --local (ignored .dev.vars) or --production (wrangler secret)");
  }
  return options.local ? "local" : "production";
}

function printHelp() {
  console.log(`FERTO service-token authorization helper

Obtains a Spotify refresh token for the configured owner account via a local
PKCE loopback flow. This service token powers the Worker's weekly catalogue
rebuilds and Like saves. It is separate from the identity-only browser
sign-in (user-read-private) and never requests playback scopes.

Usage:
  npm run spotify:authorize -- --local
  npm run spotify:authorize -- --production
  node scripts/spotify-authorize.mjs --local [--port 8931] [--dev-vars .dev.vars] [--yes]

Destinations (exactly one):
  --local         Update only the SPOTIFY_REFRESH_TOKEN entry in the ignored
                  .dev.vars file. Other entries are preserved; the file is
                  rewritten atomically with mode 0600.
  --production    Pipe the refresh token to
                  \`npx wrangler secret put SPOTIFY_REFRESH_TOKEN\`
                  through child stdin, with an argv array and no shell.

Options:
  --port <n>      Loopback port for the OAuth callback (default ${DEFAULT_PORT}; 0 = random).
  --dev-vars <p>  Path to the local vars file (default: .dev.vars).
  --config <p>    Production instance config (default: FERTO_DEPLOY_CONFIG or wrangler.production.jsonc).
  --yes, -y       Skip the confirmation prompt after showing the identity.
  -h, --help      Show this help.

Scopes requested (exactly these, nothing else):
  ${scopeString()}

Requirements:
  * SPOTIFY_CLIENT_ID is set in .dev.vars (or exported).
  * OWNER_SPOTIFY_ID is Spotify's immutable account_id. If it is blank, the
    helper shows the authenticated account_id and stores nothing so you can
    configure it and rerun safely.
  * The Spotify app allows the loopback redirect URI:
      http://127.0.0.1:${DEFAULT_PORT}/callback
    (adjust the port if you use --port).

Safety:
  * PKCE only — no client secret is used, stored, or requested.
  * The refresh token is never printed and never touches argv.
  * The browser identity token is never written.
  * The authenticated Spotify account_id is shown and must match OWNER_SPOTIFY_ID
    before anything is stored; any failure writes nothing.`);
}

function fail(message) {
  throw new Error(message);
}

function sanitizeTokenError(payload) {
  const description = payload?.error_description ?? payload?.error ?? "unknown token-endpoint error";
  return String(description).slice(0, 300);
}

async function loadConfig(devVarsPath) {
  const { readFile } = await import("node:fs/promises");
  let raw = "";
  try {
    raw = await readFile(devVarsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const vars = parseDevVars(raw);
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || vars.SPOTIFY_CLIENT_ID || "",
    ownerId: process.env.OWNER_SPOTIFY_ID || vars.OWNER_SPOTIFY_ID || "",
    fileExists: raw !== "",
  };
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family: system-ui, sans-serif; padding: 2rem;"><h1>${title}</h1><p>${body}</p></body></html>`;
}

/**
 * Await the OAuth callback on the loopback `server`. Returns `{ promise, cancel }`.
 * The promise resolves with `{ code }` for the first valid callback and rejects
 * — never resolves — on a provider error, a missing code, a forged or replayed
 * state, or the timeout. `cancel(reason)` settles the wait (closing the server
 * and clearing the timer) for callers that must give up before the promise is
 * awaited, e.g. when `listen` itself failed, so no timer lingers and no
 * rejection can go unhandled.
 */
export function waitForCallback(server, expectedState, timeoutMs = CALLBACK_TIMEOUT_MS) {
  let finish = () => {};
  let rejectCallback = () => {};
  const promise = new Promise((resolve, reject) => {
    rejectCallback = reject;
    let settled = false;
    finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      settle(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("timed out waiting for the OAuth callback in the browser")),
      timeoutMs,
    );
    server.on("request", (request, response) => {
      let url;
      try {
        url = new URL(request.url ?? "/", "http://127.0.0.1");
      } catch {
        response.statusCode = 400;
        response.end(page("FERTO", "Malformed callback request."));
        return;
      }
      const host = String(request.headers.host ?? "");
      if (url.pathname !== CALLBACK_PATH || !host.startsWith("127.0.0.1:")) {
        response.statusCode = 404;
        response.end(page("FERTO", "This local server only handles the Spotify OAuth callback."));
        return;
      }
      if (settled) {
        response.statusCode = 403;
        response.end(page("FERTO", "This authorization request was already completed."));
        return;
      }
      const verdict = validateCallback(url, expectedState);
      if (verdict.ok) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page("FERTO authorized", "Spotify responded. You can close this tab and return to your terminal."));
        finish(resolve, { code: verdict.code });
      } else {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page("FERTO authorization failed", "Return to your terminal for the reason."));
        finish(reject, new Error(verdict.reason));
      }
    });
  });
  return { promise, cancel: (reason) => finish(rejectCallback, reason) };
}

async function openBrowser(url) {
  const { spawn } = await import("node:child_process");
  const commands = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start"] : ["xdg-open"];
  await new Promise((resolve) => {
    const child = spawn(commands[0], [...commands.slice(1), url], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => resolve(true));
    child.once("close", () => resolve(true));
  });
}

async function exchangeCode({ code, redirectUri, clientId, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) fail(`Spotify rejected the token exchange (HTTP ${response.status}): ${sanitizeTokenError(payload)}`);
  if (typeof payload?.refresh_token !== "string" || !payload.refresh_token) {
    fail("Spotify did not return a refresh token; nothing was stored");
  }
  const missing = missingScopes(payload.scope);
  if (missing.length > 0) fail(`the granted token is missing required scopes: ${missing.join(", ")}`);
  return { refreshToken: payload.refresh_token, accessToken: payload.access_token };
}

async function fetchIdentity(accessToken) {
  const response = await fetch(ME_ENDPOINT, { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${accessToken}` } });
  const profile = await response.json().catch(() => null);
  if (!response.ok || typeof profile?.account_id !== "string" || !profile.account_id) {
    fail(`could not read Spotify's immutable account identity (HTTP ${response.status})`);
  }
  return profile;
}

async function confirm(destination, options, devVarsPath) {
  if (options.yes) return true;
  const readline = await import("node:readline/promises");
  const prompts = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = destination === "local"
    ? `Update ${REFRESH_TOKEN_KEY} in ${devVarsPath} (other entries preserved)? [y/N] `
    : `Pipe the refresh token to \`npx wrangler secret put ${REFRESH_TOKEN_KEY}\` for the production Worker? [y/N] `;
  const answer = await prompts.question(question);
  prompts.close();
  return /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * Atomically rewrite the local vars file: the new token is written to a
 * sibling temporary file, hardened to mode 0600, then renamed over the
 * destination. If the write, the chmod, or the rename fails, the token-bearing
 * temporary file is removed best-effort (a failed cleanup must not mask the
 * storage error) and the original file is left untouched.
 */
export async function storeLocal(devVarsPath, refreshToken, deps = {}) {
  const fs = deps.fs ?? (await import("node:fs/promises"));
  const { readFile, writeFile, chmod, rename, rm } = fs;
  const existing = await readFile(devVarsPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const updated = updateDevVarsContent(existing, refreshToken);
  const temporary = `${devVarsPath}.tmp-${Date.now()}-${process.pid}`;
  try {
    await writeFile(temporary, updated, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, devVarsPath);
  } catch (error) {
    // The temporary file carries the new refresh token: never leave it behind
    // on a failed write/chmod/rename, and never touch the original on error.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await chmod(devVarsPath, 0o600);
  console.log(existing ? `Updated ${REFRESH_TOKEN_KEY} in ${devVarsPath} (mode 0600); all other entries are unchanged.` : `Created ${devVarsPath} with ${REFRESH_TOKEN_KEY} (mode 0600). Copy the remaining v4 bindings from .dev.vars.example.`);
}

/**
 * Store the token as a production Worker secret by piping it to the stdin of
 * `npx wrangler secret put SPOTIFY_REFRESH_TOKEN` (argv array, no shell).
 *
 * The child's `error` and `close` listeners are attached in the same tick the
 * child exists — before anything is awaited. A fast npx/wrangler child can
 * exit while the token is still flushing to stdin, and `close` is emitted at
 * most once: attaching that listener after an await can miss the event and
 * wait forever. Exactly one terminal event settles the wait; a spawn `error`
 * wins over a trailing `close`, and a stdin EPIPE is merely observed (never
 * fatal) because the child's exit status decides the outcome.
 */
export async function storeProduction(refreshToken, deps = {}) {
  const spawnChild = deps.spawn ?? (await import("node:child_process")).spawn;
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["wrangler", "secret", "put", REFRESH_TOKEN_KEY, "--config", deps.configPath ?? "wrangler.production.jsonc"];
  const child = spawnChild(command, args, { stdio: ["pipe", "inherit", "inherit"] });
  // Pipe the token through the child's stdin only — never argv, never a shell.
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal }));
    // Observed from the start so an EPIPE (the child exited before reading
    // all of stdin) can never become an unhandled error; the exit code decides.
    child.stdin.once("error", () => {});
    child.stdin.end(refreshToken);
  });
  if (outcome.error) {
    fail(`could not run \`${command} wrangler secret put\`: ${outcome.error.message}; the secret was not stored`);
  }
  if (outcome.code !== 0) {
    const signal = outcome.signal ? ` (signal ${outcome.signal})` : "";
    fail(`wrangler secret put exited with code ${outcome.code}${signal}; the secret was not confirmed stored`);
  }
  console.log(`Stored ${REFRESH_TOKEN_KEY} as a production Worker secret via wrangler.`);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const destination = destinationOf(options);
  const { clientId, ownerId, fileExists } = await loadConfig(options.devVarsPath);
  let productionConfigPath;
  if (destination === "production") {
    const { assertProductionConfig, readConfig, PRIVATE_CONFIG } = await import("./deployment-config.mjs");
    productionConfigPath = options.configPath || process.env.FERTO_DEPLOY_CONFIG || PRIVATE_CONFIG;
    const production = assertProductionConfig(readConfig(productionConfigPath));
    if (production.vars.SPOTIFY_CLIENT_ID !== clientId || production.vars.OWNER_SPOTIFY_ID !== ownerId) {
      fail("local Spotify client/owner settings differ from the selected production instance; nothing was stored");
    }
    console.log(`Production target: ${production.vars.APP_ORIGIN} (${productionConfigPath})`);
  }
  if (!clientId) fail(`SPOTIFY_CLIENT_ID is not configured — set it in ${options.devVarsPath} or the environment`);
  if (destination === "local" && !fileExists) {
    console.log(`Note: ${options.devVarsPath} does not exist yet — it will be created with mode 0600.`);
  }

  const codeVerifier = randomSecret();
  const state = randomSecret();
  const codeChallenge = await deriveChallenge(codeVerifier);

  const { createServer } = await import("node:http");
  const server = createServer();
  // Attach the callback handler before listening so an early callback cannot
  // slip past the listener.
  const callback = waitForCallback(server, state);
  // run() awaits callback.promise below; this guard covers paths that bail out
  // before that await (a failed listen) so the cancelled wait can never
  // surface as an unhandled rejection.
  callback.promise.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    // Cancel the wait so its timeout cannot keep the process alive or reject
    // unhandled after we already gave up.
    callback.cancel(new Error(`the loopback server could not listen on 127.0.0.1:${options.port} (${error?.message ?? error})`));
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, codeChallenge, state });

  console.log(ownerId ? `Service-token authorization for the FERTO owner account (${ownerId})` : "FERTO owner account-id discovery (nothing will be stored)");
  console.log(`Requesting exactly these scopes: ${scopeString()}`);
  console.log(`\nOpen this URL in the browser where you are signed in as the owner:\n\n  ${authorizeUrl.href}\n`);
  void openBrowser(authorizeUrl.href).then((opened) => {
    if (!opened) console.log("(Could not open a browser automatically — copy the URL above manually.)");
  });

  const { code } = await callback.promise;
  const { refreshToken, accessToken } = await exchangeCode({ code, redirectUri, clientId, codeVerifier });
  const profile = await fetchIdentity(accessToken);
  console.log(`\nAuthenticated Spotify account: ${profile.display_name ? `${profile.display_name} — ` : ""}account_id ${profile.account_id}${profile.id ? `; user id ${profile.id}` : ""}${profile.country ? ` (${profile.country})` : ""}`);
  if (!ownerId) {
    fail(`OWNER_SPOTIFY_ID is not configured; set it to ${profile.account_id} and rerun — nothing was stored`);
  }
  if (profile.account_id !== ownerId) {
    fail(`this Spotify account (${profile.account_id}) is not the configured FERTO owner (${ownerId}); nothing was stored`);
  }

  if (!(await confirm(destination, options, options.devVarsPath))) {
    console.log("Aborted — nothing was written.");
    return;
  }
  if (destination === "local") await storeLocal(options.devVarsPath, refreshToken);
  else await storeProduction(refreshToken, { configPath: productionConfigPath });
  console.log("Done. The refresh token itself was never printed.");
}

const invokedAsScript = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string"
  && import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}`;

if (invokedAsScript) {
  run().catch((error) => {
    console.error(`\nspotify-authorize: ${error?.message ?? error}\nNothing was stored. Run with --help for usage.`);
    process.exitCode = 1;
  });
}
