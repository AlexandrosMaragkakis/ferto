import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the public demo starts without credentials, serves picks and keeps owner access closed", { timeout: 60_000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "ferto-demo-check-"));
  let server;
  const output = [];
  try {
    await readFile(join(root, "dist/index.html")); // Build before this check.
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const config = JSON.parse(await readFile(join(root, "wrangler.jsonc"), "utf8"));
    config.main = join(root, "src/worker.ts");
    config.assets.directory = join(root, "dist");
    config.d1_databases[0].migrations_dir = join(root, "migrations");
    const configFile = join(folder, "wrangler.jsonc");
    await writeFile(configFile, JSON.stringify(config));
    // Exercise the actual demo script in an isolated cwd. Preparation is done
    // explicitly below, so npm's normal predemo cannot reset a developer's DB.
    await writeFile(join(folder, "package.json"), JSON.stringify({ private: true, scripts: { demo: pkg.scripts.demo } }));
    const state = join(folder, ".wrangler/demo-state");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "LANG", "TMPDIR"].includes(key)));
    env.PATH = [join(root, "node_modules/.bin"), dirname(process.execPath), env.PATH].join(delimiter);
    env.CI = "1";
    env.XDG_CONFIG_HOME = join(folder, "config");
    await mkdir(env.XDG_CONFIG_HOME);
    const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
    async function prepare(args) {
      const child = spawn(process.execPath, [wrangler, ...args, "--local", "--config", configFile, "--persist-to", state, "--env-file", "/dev/null"], {
        cwd: folder, env, signal: t.signal, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => output.push(String(chunk)));
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      const [code] = await once(child, "exit");
      assert.equal(code, 0, output.join("").slice(-3000));
    }
    await prepare(["d1", "migrations", "apply", "ferto"]);
    await prepare(["d1", "execute", "ferto", "--file", join(root, "scripts/demo-catalogue.sql")]);
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    const origin = `http://127.0.0.1:${port}`;
    env.FERTO_DEMO_PORT = String(port);
    output.length = 0;
    server = spawn("npm", ["run", "demo"], {
      cwd: folder, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => output.push(String(chunk)));
    server.stderr.on("data", (chunk) => output.push(String(chunk)));
    const request = (path) => fetch(new URL(path, origin), { signal: AbortSignal.any([t.signal, AbortSignal.timeout(1500)]) });
    let response;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { response = await request("/api/recommendation"); break; } catch {
        if (server.exitCode !== null || t.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, output.join("").slice(0, 3000));
    assert.equal(response.status, 200, output.join("").slice(-3000));
    const first = await response.json();
    assert.equal(first.candidateCount, 3);
    assert.ok(first.recommendation?.spotify_id);
    const next = await (await request(`/api/recommendation?exclude=${first.recommendation.spotify_id}`)).json();
    assert.notEqual(next.recommendation.spotify_id, first.recommendation.spotify_id);
    assert.equal((await (await request("/api/owner/session")).json()).authenticated, false);
    assert.equal((await request("/api/owner/history")).status, 401);
    assert.match(await (await request("/")).text(), /FERTO/);
  } finally {
    if (server) {
      const exited = server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : once(server, "exit");
      try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
      await exited;
    }
    await rm(folder, { recursive: true, force: true });
  }
});
