import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { assertProductionConfig, readConfig } from "./deployment-config.mjs";
const manifest = JSON.parse(await readFile(".release/manifest.json", "utf8"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (manifest.revision !== revision || manifest.dirty || execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Release must match a clean, verified checkout");
const lock = createHash("sha256").update(await readFile("package-lock.json")).digest("hex");
if (manifest.lockfile !== lock || manifest.node !== process.version) throw new Error("Release dependency lockfile or Node version differs");
const actualFiles = [];
async function list(folder, prefix = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("Release artifact contains a symbolic link");
    if (entry.isDirectory()) await list(`${folder}/${entry.name}`, `${path}/`);
    else if (path !== "manifest.json") actualFiles.push(path);
  }
}
await list(".release");
if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error("Release artifact contains missing or unexpected files");
for (const [path, expected] of Object.entries(manifest.files)) {
  if (path.includes("..") || path.startsWith("/")) throw new Error("Invalid artifact path");
  const actual = createHash("sha256").update(await readFile(`.release/${path}`)).digest("hex");
  if (actual !== expected) throw new Error(`Artifact checksum mismatch: ${path}`);
}
if (process.argv.includes("--production")) {
  const config = assertProductionConfig(readConfig(".release/wrangler.jsonc"));
  if (!["worker/worker.js", "assets/index.html", "wrangler.jsonc"].every(file => file in manifest.files) || !Object.keys(manifest.files).some(file => file.startsWith("migrations/") && file.endsWith(".sql"))) throw new Error("Production artifact is missing Worker, homepage, configuration or migrations");
  if (resolve(".release", config.main) !== resolve(".release/worker/worker.js") || resolve(".release", config.assets.directory) !== resolve(".release/assets")) throw new Error("Production config must deploy the verified Worker and assets inside the artifact");
  const db = config.d1_databases.find(binding => binding.binding === "DB");
  if (resolve(".release", db.migrations_dir || "migrations") !== resolve(".release/migrations")) throw new Error("Production migrations must come from the verified artifact");
}
process.stdout.write("Release revision and all artifact checksums match.\n");
