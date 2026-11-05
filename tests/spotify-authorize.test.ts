import { describe, expect, it, vi } from "vitest";
import helperSource from "../scripts/spotify-authorize.mjs?raw";
import {
  SERVICE_SCOPES,
  base64url,
  buildAuthorizeUrl,
  deriveChallenge,
  destinationOf,
  missingScopes,
  parseArgs,
  parseDevVars,
  randomSecret,
  safeEqual,
  scopeString,
  storeLocal,
  storeProduction,
  updateDevVarsContent,
  validateCallback,
} from "../scripts/spotify-authorize.mjs";

const EXPECTED_SCOPES = [
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-private",
];

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("service-token scope contract", () => {
  it("requests exactly the five v4 service scopes", () => {
    expect([...SERVICE_SCOPES].sort()).toEqual([...EXPECTED_SCOPES].sort());
    expect(scopeString()).toBe(EXPECTED_SCOPES.join(" "));
  });

  it("never carries a playback or streaming scope", () => {
    for (const scope of SERVICE_SCOPES) {
      expect(scope.toLowerCase()).not.toMatch(/playback|streaming|connect|remote/);
    }
  });

  it("reports required scopes missing from a granted set", () => {
    expect(missingScopes(scopeString())).toEqual([]);
    expect(missingScopes("user-library-read user-read-private")).toEqual([
      "user-library-modify",
      "playlist-read-private",
      "playlist-read-collaborative",
    ]);
    // Spotify sometimes separates scopes with "+".
    expect(missingScopes(EXPECTED_SCOPES.join("+"))).toEqual([]);
    expect(missingScopes(null)).toEqual(EXPECTED_SCOPES);
  });
});

describe("immutable owner identity", () => {
  it("links the configured owner with profile.account_id, never mutable profile.id", () => {
    expect(helperSource).toContain("profile.account_id !== ownerId");
    expect(helperSource).not.toContain("profile.id !== ownerId");
    expect(helperSource).toContain("OWNER_SPOTIFY_ID is not configured; set it to");
  });
});

describe("secure PKCE materials", () => {
  it("encodes URL-safe base64 without padding", () => {
    expect(base64url(new Uint8Array([251, 255, 190]))).toBe("-_--");
    expect(base64url(new Uint8Array(32))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates 43-character verifier and state secrets that differ per call", () => {
    const first = randomSecret();
    const second = randomSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("derives the RFC 7636 S256 challenge from the verifier", async () => {
    // Reference vector from RFC 7636 appendix B.
    expect(await deriveChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const manual = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    expect(await deriveChallenge(verifier)).toBe(manual);
  });

  it("compares state strings without early exit semantics changing results", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual(undefined, "abc")).toBe(false);
  });
});

describe("authorize URL", () => {
  const url = buildAuthorizeUrl({
    clientId: "test-client-id",
    redirectUri: "http://127.0.0.1:8931/callback",
    codeChallenge: "challenge-placeholder",
    state: "state-placeholder",
  });

  it("targets the Spotify authorize endpoint with PKCE and the exact scope set", () => {
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-placeholder");
    expect(url.searchParams.get("state")).toBe("state-placeholder");
    expect(url.searchParams.get("scope")).toBe(scopeString());
  });

  it("uses a loopback redirect and carries no secret material", () => {
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8931/callback");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    const parameters = [...url.searchParams.keys()];
    expect(parameters).not.toContain("client_secret");
    expect(parameters).not.toContain("code_verifier");
    expect(url.href).not.toContain("secret");
  });
});

describe("loopback callback validation", () => {
  it("accepts a matching state and returns the code", () => {
    expect(validateCallback("http://127.0.0.1:8931/callback?code=abc&state=xyz", "xyz")).toEqual({ ok: true, code: "abc" });
  });

  it("rejects a state mismatch, a missing code, and provider errors", () => {
    expect(validateCallback("http://127.0.0.1:8931/callback?code=abc&state=attacker", "xyz").ok).toBe(false);
    expect(validateCallback("http://127.0.0.1:8931/callback?state=xyz", "xyz").ok).toBe(false);
    const denied = validateCallback("http://127.0.0.1:8931/callback?error=access_denied&state=xyz", "xyz");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toContain("access_denied");
    expect(validateCallback("http://127.0.0.1:8931/callback?code=abc", "").ok).toBe(false);
  });
});

describe(".dev.vars handling", () => {
  it("parses key/value entries and skips comments and blanks", () => {
    expect(parseDevVars("# comment\nSPOTIFY_CLIENT_ID=abc\n\nOWNER_SPOTIFY_ID = def\n")).toEqual({
      SPOTIFY_CLIENT_ID: "abc",
      OWNER_SPOTIFY_ID: "def",
    });
    expect(parseDevVars("")).toEqual({});
  });

  it("replaces only the SPOTIFY_REFRESH_TOKEN entry and preserves other lines byte-for-byte", () => {
    const before = [
      "# Copy to .dev.vars and fill locally. Do not commit .dev.vars.",
      "SPOTIFY_CLIENT_ID=client",
      "OWNER_SPOTIFY_ID=owner",
      "APP_ORIGIN=http://127.0.0.1:5173",
      "SPOTIFY_REFRESH_TOKEN=old-value",
      "SESSION_SECRET=keep-me",
      "",
    ].join("\n");
    const after = updateDevVarsContent(before, "new-value");
    expect(after).toBe(before.replace("old-value", "new-value"));
    // Indented or padded existing entries are still replaced wholesale.
    expect(updateDevVarsContent("SPOTIFY_REFRESH_TOKEN = old", "new")).toBe("SPOTIFY_REFRESH_TOKEN =new");
  });

  it("replaces the entry in a CRLF file without leaving a stale token", () => {
    const crlf = "SPOTIFY_CLIENT_ID=client\r\nSPOTIFY_REFRESH_TOKEN=old-token\r\nSESSION_SECRET=keep-me\r\n";
    const after = updateDevVarsContent(crlf, "new-token");
    expect(after).toBe("SPOTIFY_CLIENT_ID=client\r\nSPOTIFY_REFRESH_TOKEN=new-token\r\nSESSION_SECRET=keep-me\r\n");
    expect(after).not.toContain("old-token");
  });

  it("appends the entry when missing and creates a file from nothing", () => {
    const existing = "SPOTIFY_CLIENT_ID=client\nSESSION_SECRET=keep-me";
    expect(updateDevVarsContent(existing, "token-1")).toBe(`${existing}\nSPOTIFY_REFRESH_TOKEN=token-1\n`);
    expect(updateDevVarsContent("", "token-2")).toBe("SPOTIFY_REFRESH_TOKEN=token-2\n");
    expect(updateDevVarsContent(null, "token-3")).toBe("SPOTIFY_REFRESH_TOKEN=token-3\n");
    expect(updateDevVarsContent("SPOTIFY_CLIENT_ID=client\n", "token-4")).toBe("SPOTIFY_CLIENT_ID=client\nSPOTIFY_REFRESH_TOKEN=token-4\n");
  });

  it("refuses tokens that could break the line format", () => {
    expect(() => updateDevVarsContent("SPOTIFY_REFRESH_TOKEN=old", "line\nbreak")).toThrow();
    expect(() => updateDevVarsContent("SPOTIFY_REFRESH_TOKEN=old", "with space")).toThrow();
    expect(() => updateDevVarsContent("SPOTIFY_REFRESH_TOKEN=old", "")).toThrow();
  });
});

describe("CLI parsing", () => {
  it("parses destinations, port, dev-vars path, and confirmation bypass", () => {
    expect(parseArgs(["--local"])).toMatchObject({ local: true, production: false, port: 8931, devVarsPath: ".dev.vars" });
    expect(parseArgs(["--production", "--yes"])).toMatchObject({ production: true, yes: true });
    expect(parseArgs(["--local", "--port", "0", "--dev-vars", "/tmp/vars"])).toMatchObject({ port: 0, devVarsPath: "/tmp/vars" });
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
    expect(parseArgs(["--dev-vars=/tmp/other"])).toMatchObject({ devVarsPath: "/tmp/other" });
    expect(parseArgs(["--production", "--config", "wrangler.test.local.jsonc"])).toMatchObject({ configPath: "wrangler.test.local.jsonc" });
  });

  it("rejects unknown options, bad ports, and missing values", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown option");
    expect(() => parseArgs(["--local", "--port", "70000"])).toThrow("invalid --port");
    expect(() => parseArgs(["--port"])).toThrow("requires a value");
    expect(() => parseArgs(["--dev-vars"])).toThrow("requires a value");
  });

  it("requires exactly one destination", () => {
    expect(destinationOf({ local: true, production: false })).toBe("local");
    expect(destinationOf({ local: false, production: true })).toBe("production");
    expect(() => destinationOf({ local: false, production: false })).toThrow("exactly one destination");
    expect(() => destinationOf({ local: true, production: true })).toThrow("exactly one destination");
  });
});

describe("storage destinations (static source lock)", () => {
  it("pipes the token to the wrangler child's stdin — no shell, never argv", () => {
    // The production destination must actually write the token to the piped
    // stdin of `npx wrangler secret put SPOTIFY_REFRESH_TOKEN`.
    expect(helperSource).toContain('["wrangler", "secret", "put", REFRESH_TOKEN_KEY, "--config"');
    expect(helperSource).toContain('stdio: ["pipe", "inherit", "inherit"]');
    expect(helperSource).toContain("child.stdin.end(refreshToken");
    expect(helperSource).not.toContain("shell: true");
    expect(helperSource).not.toMatch(/spawn\w*\(\s*[`"']/);
    // The refresh token never reaches a command line or a print statement.
    expect(helperSource).not.toMatch(/console\.\w+\([^)]*refreshToken/);
  });

  it("stores locally with an atomic mode-0600 rewrite", () => {
    expect(helperSource).toContain("writeFile(temporary, updated, { mode: 0o600 })");
    expect(helperSource).toContain("rename(temporary, devVarsPath)");
    expect(helperSource).toContain("chmod(devVarsPath, 0o600)");
  });
});

type Listener = (...args: unknown[]) => void;

/** Minimal emitter stand-in so the fakes run inside the workerd test pool. */
function createEventSource() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, listener: Listener): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    once(event: string, listener: Listener): void {
      const onceListener: Listener = (...args) => {
        const remaining = (listeners.get(event) ?? []).filter((entry) => entry !== onceListener);
        if (remaining.length > 0) listeners.set(event, remaining);
        else listeners.delete(event);
        listener(...args);
      };
      listeners.set(event, [...(listeners.get(event) ?? []), onceListener]);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
  };
}

interface FakeChild {
  command: string;
  args: string[];
  options: { stdio: string[] } & Record<string, unknown>;
  stdin: {
    once(event: string, listener: Listener): void;
    emit(event: string, ...args: unknown[]): void;
    end(chunk?: string, callback?: () => void): void;
    /** Deliver the pending `end` callback (the stdin flush completed). */
    flushEnd(): void;
    payload(): string | undefined;
  };
  on(event: string, listener: Listener): void;
  once(event: string, listener: Listener): void;
  emit(event: string, ...args: unknown[]): void;
}

function createFakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = (command: string, args: string[], options: { stdio: string[] } & Record<string, unknown>): FakeChild => {
    const events = createEventSource();
    const stdinEvents = createEventSource();
    let payload: string | undefined;
    let endCallback: (() => void) | undefined;
    const child: FakeChild = {
      command,
      args,
      options,
      stdin: {
        ...stdinEvents,
        end: (chunk?: string, callback?: () => void) => {
          payload = chunk;
          endCallback = callback;
        },
        flushEnd: () => {
          const callback = endCallback;
          endCallback = undefined;
          callback?.();
        },
        payload: () => payload,
      },
      ...events,
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

interface FakeFsCall {
  op: string;
  args: unknown[];
}

function createFakeFs(dest: string, existing: string, failAt?: "writeFile" | "chmodTemp" | "rename") {
  const calls: FakeFsCall[] = [];
  const files = new Map<string, { content: string; mode?: number }>([[dest, { content: existing }]]);
  const fs = {
    async readFile(path: string): Promise<string> {
      const file = files.get(path);
      if (!file) throw Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: "ENOENT" });
      return file.content;
    },
    async writeFile(path: string, data: string, options: { mode: number }): Promise<void> {
      calls.push({ op: "writeFile", args: [path, data, options] });
      if (failAt === "writeFile") throw new Error("EIO: simulated temporary-file write failure");
      files.set(path, { content: data, mode: options.mode });
    },
    async chmod(path: string, mode: number): Promise<void> {
      calls.push({ op: "chmod", args: [path, mode] });
      if (failAt === "chmodTemp" && path !== dest) throw new Error("EPERM: simulated temporary-file chmod failure");
      const file = files.get(path);
      if (file) file.mode = mode;
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push({ op: "rename", args: [from, to] });
      if (failAt === "rename") throw new Error("EIO: simulated rename failure");
      const file = files.get(from);
      if (file) {
        files.set(to, file);
        files.delete(from);
      }
    },
    async rm(path: string, options?: { force?: boolean }): Promise<void> {
      calls.push({ op: "rm", args: [path, options] });
      if (!files.has(path) && !options?.force) throw Object.assign(new Error(`ENOENT: no such file: ${path}`), { code: "ENOENT" });
      files.delete(path);
    },
  };
  return { fs, calls, files };
}

describe("production secret storage (in-process fake child)", () => {
  const TOKEN = "fake-refresh-token-never-printed";

  it("resolves when a fast child closes during the stdin flush, piping the token only through stdin", async () => {
    const fake = createFakeSpawn();
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const pending = storeProduction(TOKEN, { spawn: fake.spawn, configPath: "wrangler.test.local.jsonc" });
    const child = fake.children[0];
    // argv array with piped stdin and inherited output; no shell; the token
    // never appears on the command line.
    expect(child.command).toBe(process.platform === "win32" ? "npx.cmd" : "npx");
    expect(child.args).toEqual(["wrangler", "secret", "put", "SPOTIFY_REFRESH_TOKEN", "--config", "wrangler.test.local.jsonc"]);
    expect(child.args).not.toContain(TOKEN);
    expect(child.options.stdio).toEqual(["pipe", "inherit", "inherit"]);
    expect("shell" in child.options).toBe(false);
    // Regression: the stdin end callback settles the helper's first await and
    // `close` fires synchronously right after it — before the helper's
    // continuation runs. A close listener attached only after that await
    // misses the once-only event and the later wait hangs forever.
    child.stdin.flushEnd();
    child.emit("close", 0, null);
    try {
      await expect(pending).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
    expect(child.stdin.payload()).toBe(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("rejects a nonzero exit without hanging when the child dies before reading stdin", async () => {
    const fake = createFakeSpawn();
    const pending = storeProduction(TOKEN, { spawn: fake.spawn });
    const child = fake.children[0];
    child.stdin.emit("error", new Error("write EPIPE"));
    child.emit("close", 1, null);
    let rejected: string | undefined;
    try {
      await pending;
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toBeDefined();
    expect(rejected).toContain("exited with code 1");
    expect(rejected).not.toContain(TOKEN);
  });

  it("rejects a spawn failure without waiting for a close that never comes", async () => {
    const fake = createFakeSpawn();
    const pending = storeProduction(TOKEN, { spawn: fake.spawn });
    const child = fake.children[0];
    child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    // A trailing close must not double-settle or change the verdict.
    child.emit("close", -2, null);
    let rejected: string | undefined;
    try {
      await pending;
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toContain("could not run");
    expect(rejected).toContain("spawn ENOENT");
    expect(rejected).not.toContain(TOKEN);
  });

  it("rejects a signal exit with the code and signal in the message", async () => {
    const fake = createFakeSpawn();
    const pending = storeProduction(TOKEN, { spawn: fake.spawn });
    const child = fake.children[0];
    child.stdin.flushEnd();
    child.emit("close", null, "SIGTERM");
    let rejected: string | undefined;
    try {
      await pending;
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toContain("exited with code null");
    expect(rejected).toContain("signal SIGTERM");
  });
});

describe("local storage paths (in-process fake fs)", () => {
  const DEST = "test.dev.vars";
  const EXISTING = "SPOTIFY_CLIENT_ID=client\nSPOTIFY_REFRESH_TOKEN=old-token\nSESSION_SECRET=keep-me\n";
  const NEW_TOKEN = "new-fake-token-never-printed";

  it("performs the atomic mode-0600 rewrite on success and prints no token", async () => {
    const { fs, calls, files } = createFakeFs(DEST, EXISTING);
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await storeLocal(DEST, NEW_TOKEN, { fs });
    } finally {
      log.mockRestore();
    }
    expect(files.get(DEST)?.content).toBe(updateDevVarsContent(EXISTING, NEW_TOKEN));
    expect(files.get(DEST)?.mode).toBe(0o600);
    expect(calls.map((call) => call.op)).toEqual(["writeFile", "chmod", "rename", "chmod"]);
    expect([...files.keys()]).toEqual([DEST]);
    expect(logs.join("\n")).not.toContain(NEW_TOKEN);
  });

  it.each([
    ["writeFile", /simulated temporary-file write failure/],
    ["chmodTemp", /simulated temporary-file chmod failure/],
    ["rename", /simulated rename failure/],
  ] as const)("removes the token-bearing temporary file when %s fails and preserves the destination", async (failAt, message) => {
    const { fs, calls, files } = createFakeFs(DEST, EXISTING, failAt);
    let rejected: string | undefined;
    try {
      await storeLocal(DEST, NEW_TOKEN, { fs });
    } catch (error) {
      rejected = (error as Error).message;
    }
    expect(rejected).toMatch(message);
    const rmCalls = calls.filter((call) => call.op === "rm");
    expect(rmCalls).toHaveLength(1);
    const removedPath = String(rmCalls[0]?.args[0]);
    expect(removedPath.startsWith(`${DEST}.tmp-`)).toBe(true);
    expect(rmCalls[0]?.args[1]).toEqual({ force: true });
    // No token-bearing file survives and the destination keeps its old bytes.
    expect([...files.keys()].filter((path) => path !== DEST)).toEqual([]);
    expect(files.get(DEST)?.content).toBe(EXISTING);
    if (failAt !== "rename") expect(calls.some((call) => call.op === "rename")).toBe(false);
  });
});
