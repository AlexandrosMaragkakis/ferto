import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { configPath, readConfig } from "./deployment-config.mjs";

const selectedConfig = configPath();
const config = readConfig(selectedConfig);

await rm(".release", { recursive: true, force: true });
await mkdir(".release", { recursive: true });
const child = spawn("npx", ["wrangler", "deploy", "--dry-run", "--config", selectedConfig, "--env-file", "/dev/null", "--outdir", ".release/worker"], {
  stdio: "inherit", env: { ...process.env, XDG_CONFIG_HOME: "/tmp/ferto-wrangler" },
});
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
if (code !== 0) throw new Error(`Worker packaging failed: ${code}`);
await cp("dist", ".release/assets", { recursive: true });
await cp("migrations", ".release/migrations", { recursive: true });
await cp("LICENSE", ".release/LICENSE");
await cp("THIRD_PARTY_NOTICES.md", ".release/THIRD_PARTY_NOTICES.md");
config.main = "worker/worker.js";
config.assets.directory = "./assets";
await writeFile(".release/wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");
const files = {};
async function hashFiles(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) await hashFiles(path);
    else files[path.slice('.release/'.length)] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
}
await hashFiles(".release");
await writeFile(".release/manifest.json", JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  node: process.version, lockfile: createHash("sha256").update(await readFile("package-lock.json")).digest("hex"), files,
}, null, 2) + "\n");
process.stdout.write("Release artifact: .release/ (Worker, assets, migrations, config and SHA-256 manifest)\n");
