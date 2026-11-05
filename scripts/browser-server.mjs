import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const folder = await mkdtemp(join(tmpdir(), "ferto-browser-"));
const env = { ...process.env, XDG_CONFIG_HOME: join(folder, "config") };
delete env.CLOUDFLARE_API_TOKEN; delete env.CLOUDFLARE_API_KEY;
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
let server;
async function run(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  if (code !== 0) throw new Error(`${command} exited ${code}`);
}
const clean = async () => { server?.kill("SIGTERM"); await rm(folder, { recursive: true, force: true }); };
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void clean().finally(() => process.exit(0)); });
try {
  if (process.env.FERTO_BROWSER_SKIP_BUILD !== "1") await run("npm", ["run", "build"]);
  const state = join(folder, "state");
  const shared = ["--local", "--persist-to", state, "--env-file", "/dev/null"];
  await run(process.execPath, [wrangler, "d1", "migrations", "apply", "ferto", ...shared]);
  await run(process.execPath, [wrangler, "d1", "execute", "ferto", ...shared, "--file", "scripts/demo-catalogue.sql"]);
  server = spawn(process.execPath, [wrangler, "dev", ...shared, "--ip", "127.0.0.1", "--port", "8789",
    "--var", "APP_ORIGIN:http://127.0.0.1:8789", "--var", "SPOTIFY_REFRESH_TOKEN:browser-fixture-token",
    "--var", "SESSION_SECRET:browser-fixture-secret", "--var", "SPOTIFY_CLIENT_ID:browser-fixture-client",
    "--var", "OWNER_SPOTIFY_ID:browser-fixture-owner"], { cwd: root, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { server.on("error", reject); server.on("exit", resolve); });
  if (code !== 0) throw new Error(`Browser fixture server exited ${code}`);
} finally { await clean(); }
