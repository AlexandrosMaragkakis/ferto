import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { activeDeployment, ignoredOutput, privateFile, productionTarget, projectRoot, queueState, wrangler, wranglerJson } from "./operations-lib.mjs";
import { createBackup, verifyBackup } from "./backup.mjs";
import { releaseSmoke } from "./release-smoke.mjs";

function normalizedConfig(value) {
  const copy = structuredClone(value);
  delete copy.main;
  if (copy.assets) delete copy.assets.directory;
  for (const db of copy.d1_databases || []) if (db.binding === "DB") delete db.migrations_dir;
  const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sort(v[key])])) : v;
  return JSON.stringify(sort(copy));
}

async function verifyArtifact(root) {
  const child = spawn(process.execPath, [join(root, "scripts/check-release-artifact.mjs"), "--production"], { cwd: root, stdio: "inherit" });
  const code = await new Promise(resolveCode => { child.on("error", () => resolveCode(-1)); child.on("exit", resolveCode); });
  if (code !== 0) throw new Error("Production artifact validation failed before any remote change");
}

async function drain(milliseconds) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const left = end - Date.now();
    console.log(`Queue deliveries paused; draining previous consumers (${Math.ceil(left / 60000)} minutes remaining).`);
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(left, 30_000)));
  }
}

export function assertPreparedBackup(backup, target, revision, version, now = Date.now()) {
  const age = now - Date.parse(backup.completedAt);
  const database = target.config.d1_databases.find(binding => binding.binding === "DB");
  if (!Number.isFinite(age) || age < -300_000 || age > 60 * 60_000 || backup.database?.id !== database.database_id || backup.database?.name !== database.database_name || backup.origin !== target.config.vars.APP_ORIGIN || backup.workerVersion !== version || backup.source?.revision !== revision || backup.source?.dirty !== false) {
    throw new Error("Prepared backup must be fresh and match this instance, clean revision and current Worker");
  }
}

export async function deployLocal({ configFile, migrate = false, plan = false, backupDirectory, root = projectRoot, dependencies = {} } = {}) {
  const target = productionTarget(configFile);
  const artifact = join(root, ".release");
  const packaged = productionTarget(join(artifact, "wrangler.jsonc"));
  if (normalizedConfig(target.config) !== normalizedConfig(packaged.config)) throw new Error("Private instance settings differ from the packaged target; rebuild the release");
  const manifest = JSON.parse(await readFile(join(artifact, "manifest.json"), "utf8"));
  const hooks = { verify: verifyArtifact, run: wrangler, json: wranglerJson, queue: queueState, backup: createBackup, verifyBackup, smoke: releaseSmoke, drain, ...dependencies };
  await hooks.verify(root);
  const steps = ["Validate clean revision, checksums and instance target", "Read current deployment, Queue and migration ledger; reject unreviewed migrations", "Create and locally verify a private backup", "Pause delivery and drain old consumers for 16 minutes", migrate ? "Apply explicitly reviewed pending migrations" : "Apply no schema changes", "Deploy the exact artifact", "Verify active version, exact assets, headers and authorization", "Resume and confirm Queue delivery"];
  if (plan) return { plan: true, revision: manifest.revision, origin: packaged.config.vars.APP_ORIGIN, steps };
  const parent = await ignoredOutput(join(root, ".local/releases"), root);
  const lock = join(parent, ".lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("A local release lock exists. Inspect the active process and Queue state before removing a stale .local/releases/.lock"); }
  try {
    const directory = await mkdtemp(join(parent, "release-")); await chmod(directory, 0o700);
    await privateFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), revision: manifest.revision }) + "\n");
    const opts = name => ({ configFile: packaged.configFile, logFile: join(directory, name + ".log"), root });
    const previous = activeDeployment(await hooks.json(["deployments", "list"], opts("previous")));
    const initialQueue = await hooks.queue(packaged, directory);
    if (initialQueue.settings.delivery_paused) throw new Error("Queue is already paused; investigate and resume the prior operation before releasing");
    const ledger = await hooks.json(["d1", "execute", target.database, "--remote", "--command", "SELECT name FROM d1_migrations ORDER BY id"], opts("migrations"));
    if (!ledger[0]?.success) throw new Error("Could not verify the remote migration ledger");
    const applied = new Set(ledger[0].results.map(row => row.name));
    const migrationFiles = Object.keys(manifest.files).filter(file => file.startsWith("migrations/") && file.endsWith(".sql")).map(file => file.slice(11)).sort();
    if ([...applied].some(name => !migrationFiles.includes(name))) throw new Error("Remote schema is newer/different than this artifact; do not deploy older code blindly");
    const pending = migrationFiles.filter(name => !applied.has(name));
    if (pending.length && !migrate) throw new Error(`Pending migrations require explicit review and --migrate: ${pending.join(", ")}`);
    let backup;
    if (backupDirectory) {
      const checked = await hooks.verifyBackup(backupDirectory);
      assertPreparedBackup(checked.manifest, target, manifest.revision, previous.versions[0].version_id);
      backup = { ...checked, directory: resolve(backupDirectory) };
    } else backup = await hooks.backup({ configFile: target.configFile, output: join(root, "backups/ferto"), root });
    const receipt = { startedAt: new Date().toISOString(), revision: manifest.revision, previousVersion: previous.versions[0].version_id, backup: backup.directory, pendingMigrations: pending, status: "backup-verified" };
    await privateFile(join(directory, "before.json"), JSON.stringify(receipt, null, 2) + "\n");
    let pauseAttempted = false;
    try {
      pauseAttempted = true;
      await hooks.run(["queues", "pause-delivery", "ferto-refresh"], opts("pause"));
      if (!(await hooks.queue(packaged, directory)).settings.delivery_paused) throw new Error("Queue delivery pause was not confirmed");
      await hooks.drain(16 * 60_000);
      // Packaging or an external deployment may have changed during the drain.
      await hooks.verify(root);
      if (JSON.stringify(JSON.parse(await readFile(join(artifact, "manifest.json"), "utf8"))) !== JSON.stringify(manifest)) throw new Error("Artifact changed while delivery was paused");
      if (normalizedConfig(productionTarget(target.configFile).config) !== normalizedConfig(target.config)) throw new Error("Instance settings changed while delivery was paused");
      if (!(await hooks.queue(packaged, directory)).settings.delivery_paused) throw new Error("Queue was resumed by another operation");
      const beforeDeploy = activeDeployment(await hooks.json(["deployments", "list"], opts("before-deploy")));
      if (beforeDeploy.versions[0].version_id !== receipt.previousVersion) throw new Error("Another Worker release became active during the drain");
      const currentLedger = await hooks.json(["d1", "execute", target.database, "--remote", "--command", "SELECT name FROM d1_migrations ORDER BY id"], opts("migrations-before-deploy"));
      if (!currentLedger[0]?.success || currentLedger[0].results.some(row => !migrationFiles.includes(row.name)) || [...applied].some(name => !currentLedger[0].results.some(row => row.name === name))) throw new Error("Remote migration state changed unexpectedly during the drain");
      if (pending.length) await hooks.run(["d1", "migrations", "apply", target.database, "--remote"], opts("migrate"));
      const output = await hooks.run(["deploy", "--no-bundle", "--tag", `local-${manifest.revision.slice(0, 12)}`, "--message", `Verified local release ${manifest.revision}`], opts("deploy"));
      const version = /Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1];
      if (!version) throw new Error("The deployed version ID was not returned");
      const deployed = activeDeployment(await hooks.json(["deployments", "list"], opts("deployed")));
      if (deployed.versions[0].version_id !== version) throw new Error("Active Worker version differs from the deployment result");
      const smoke = await hooks.smoke({ artifact });
      await privateFile(join(directory, "smoke.json"), JSON.stringify(smoke, null, 2) + "\n");
      if (activeDeployment(await hooks.json(["deployments", "list"], opts("before-resume"))).versions[0].version_id !== version) throw new Error("Active Worker changed during smoke verification");
      await hooks.run(["queues", "resume-delivery", "ferto-refresh"], opts("resume"));
      if ((await hooks.queue(packaged, directory)).settings.delivery_paused) throw new Error("Queue delivery did not resume");
      const result = { ...receipt, status: "complete", version, completedAt: new Date().toISOString() };
      await privateFile(join(directory, "complete.json"), JSON.stringify(result, null, 2) + "\n");
      return { ...result, directory };
    } catch (error) {
      // Re-pause even if the error occurred just after a resume acknowledgement.
      if (pauseAttempted) try { await hooks.run(["queues", "pause-delivery", "ferto-refresh"], opts("failure-pause")); } catch { /* Status must be inspected manually. */ }
      await privateFile(join(directory, "failure.json"), JSON.stringify({ failedAt: new Date().toISOString(), reason: error.message, queueInspectionRequired: true }, null, 2) + "\n").catch(() => {});
      throw new Error(`Release did not complete. Queue pause was requested; inspect status before any resume. Previous version ${receipt.previousVersion}; backup ${backup.directory}; protected logs ${directory}`);
    }
  } finally { await rm(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: "string" }, migrate: { type: "boolean" }, plan: { type: "boolean" } } });
  deployLocal({ configFile: values.config, migrate: values.migrate, plan: values.plan }).then(result => {
    if (result.plan) { console.log(`Release ${result.revision}\nTarget ${result.origin}`); for (const step of result.steps) console.log(`- ${step}`); }
    else console.log(`Release ${result.version} verified; Queue delivery resumed. Receipt: ${result.directory}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
