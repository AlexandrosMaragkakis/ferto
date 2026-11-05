import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { DatabaseSync, constants } from "node:sqlite";
import { activeDeployment, gitIdentity, ignoredOutput, privateDirectory, privateFile, productionTarget, projectRoot, wrangler, wranglerJson } from "./operations-lib.mjs";

const MAX_SQL_BYTES = 512 * 1024 * 1024;
const requiredTables = ["d1_migrations", "recordings", "refresh_state", "owner_sessions", "never_recordings", "oauth_states", "request_budgets", "rebuild_jobs", "recommendation_slots", "recommendation_buckets"];
const hash = data => createHash("sha256").update(data).digest("hex");
export async function hashFile(file) {
  const sum = createHash("sha256");
  for await (const chunk of createReadStream(file)) sum.update(chunk);
  return sum.digest("hex");
}

/** Local restore rehearsal only. No remote restore or provider calls exist here. */
export async function rehearseSql(sql, databaseFile) {
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) throw new Error("SQL exceeds the local verification memory limit (512 MiB)");
  await privateFile(databaseFile, "");
  const db = new DatabaseSync(databaseFile, { enableForeignKeyConstraints: false, allowExtension: false });
  try {
    db.enableDefensive(true);
    db.setAuthorizer((action, arg1, arg2) => {
      if ([constants.SQLITE_ATTACH, constants.SQLITE_DETACH].includes(action)) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_FUNCTION && ["load_extension", "readfile", "writefile"].includes(String(arg2).toLowerCase())) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_PRAGMA && !["defer_foreign_keys", "foreign_keys", "quick_check", "foreign_key_check"].includes(String(arg1).toLowerCase())) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.exec(`BEGIN;\n${sql}\nCOMMIT;`);
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new Error("Restored database integrity check failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored database has foreign key violations");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    if (requiredTables.some(table => !tables.includes(table))) throw new Error("Backup is missing required FERTO tables");
    const counts = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get().n]));
    const migration = db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").get()?.name;
    const state = db.prepare("SELECT live_generation, candidate_count, live_bucket_count FROM refresh_state WHERE singleton=1").get();
    if (state?.live_generation) {
      const slots = db.prepare("SELECT COUNT(*) AS n FROM recommendation_slots WHERE generation=?").get(state.live_generation).n;
      const buckets = db.prepare("SELECT COUNT(*) AS n FROM recommendation_buckets WHERE generation=?").get(state.live_generation).n;
      if (slots !== state.candidate_count || buckets !== state.live_bucket_count) throw new Error("Restored catalogue counts do not match its recommendation pool");
    }
    return { integrity: "ok", foreignKeys: "ok", tableCounts: counts, latestMigration: migration, candidateCount: state?.candidate_count ?? 0 };
  } finally { db.close(); }
}

export async function verifyBackup(directory, { allowPartial = false } = {}) {
  const folder = await privateDirectory(resolve(directory));
  if (basename(folder).startsWith(".partial-") && !allowPartial) throw new Error("Incomplete backup folders are not completed backups");
  for (const file of ["manifest.json", "database.sql.gz"]) {
    const info = await lstat(join(folder, file));
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Backup files must be regular owner-only files");
  }
  const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
  if (manifest.format !== 1 || manifest.status !== "complete" || !manifest.archive?.sha256) throw new Error("This is not a completed FERTO backup");
  const archive = join(folder, "database.sql.gz");
  if ((await stat(archive)).size !== manifest.archive.bytes || await hashFile(archive) !== manifest.archive.sha256) throw new Error("Backup archive checksum mismatch");
  const work = await mkdtemp(join(folder, ".verify-"));
  await chmod(work, 0o700);
  try {
    const chunks = []; let bytes = 0;
    const stream = createReadStream(archive).pipe(createGunzip());
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_SQL_BYTES) { stream.destroy(); throw new Error("Backup exceeds the local verification memory limit (512 MiB)"); }
      chunks.push(chunk);
    }
    const sql = Buffer.concat(chunks);
    if (bytes !== manifest.sql.bytes || hash(sql) !== manifest.sql.sha256) throw new Error("Decompressed SQL checksum mismatch");
    const result = await rehearseSql(sql.toString("utf8"), join(work, "restored.sqlite"));
    if (JSON.stringify(result) !== JSON.stringify(manifest.verification)) throw new Error("Restored database differs from its recorded verification");
    return { manifest, verification: result };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function createBackup({ configFile, output = join(projectRoot, "backups/ferto"), root = projectRoot, runner = wrangler, jsonRunner = wranglerJson } = {}) {
  const target = productionTarget(configFile);
  const parent = await ignoredOutput(output, root);
  const folder = await mkdtemp(join(parent, ".partial-"));
  await chmod(folder, 0o700);
  const run = (args, name) => runner(args, { configFile: target.configFile, logFile: join(folder, name + ".log"), root });
  const json = (args, name) => jsonRunner(args, { configFile: target.configFile, logFile: join(folder, name + ".log"), root });
  try {
    const startedAt = new Date().toISOString();
    const databaseInfo = await json(["d1", "info", target.database], "database-info");
    const bookmarkBefore = await json(["d1", "time-travel", "info", target.database], "bookmark-before");
    const deployment = activeDeployment(await json(["deployments", "list"], "deployment"));
    const sqlFile = join(folder, "database.sql");
    await privateFile(sqlFile, "");
    await run(["d1", "export", target.database, "--remote", "--skip-confirmation", "--output", sqlFile], "export");
    await chmod(sqlFile, 0o600);
    const sqlInfo = await stat(sqlFile);
    if (!sqlInfo.size || sqlInfo.size > MAX_SQL_BYTES) throw new Error("Export is empty or exceeds the supported local verification size (512 MiB)");
    const sql = await readFile(sqlFile);
    const sqlite = join(folder, "restore-check.sqlite");
    const verification = await rehearseSql(sql.toString("utf8"), sqlite);
    await rm(sqlite);
    const archive = join(folder, "database.sql.gz");
    await pipeline(createReadStream(sqlFile), createGzip({ level: 6 }), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    const bookmarkAfter = await json(["d1", "time-travel", "info", target.database], "bookmark-after");
    // These bookmarks bracket the export; neither is claimed as its exact snapshot.
    const manifest = {
      format: 1, status: "complete", startedAt, completedAt: new Date().toISOString(),
      database: { name: target.database, id: target.config.d1_databases.find(b => b.binding === "DB").database_id, info: databaseInfo },
      origin: target.config.vars.APP_ORIGIN, source: gitIdentity(root),
      workerVersion: deployment.versions[0].version_id, bookmarks: { before: bookmarkBefore, after: bookmarkAfter },
      sql: { bytes: sql.length, sha256: hash(sql) },
      archive: { file: "database.sql.gz", bytes: (await stat(archive)).size, sha256: await hashFile(archive) }, verification,
    };
    await privateFile(join(folder, "instance.json"), JSON.stringify({ name: target.config.name, vars: target.config.vars, d1_databases: target.config.d1_databases, queues: target.config.queues, triggers: target.config.triggers }, null, 2) + "\n");
    await privateFile(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verifyBackup(folder, { allowPartial: true }); // Verify compressed bytes before publishing completion.
    await rm(sqlFile);
    const final = join(parent, `${startedAt.replaceAll(/[:.]/g, "-")}-${folder.split(".partial-").at(-1)}`);
    await rename(folder, final);
    return { directory: final, manifest };
  } catch {
    // Keep incomplete exports/logs for investigation; never remove earlier backups.
    throw new Error(`Backup did not complete; incomplete data and protected logs remain in ${folder}. Existing backups were retained.`);
  }
}

export async function listBackups(output = join(projectRoot, "backups/ferto")) {
  const entries = await readdir(output, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    try {
      const manifest = JSON.parse(await readFile(join(output, entry.name, "manifest.json"), "utf8"));
      if (manifest.format === 1 && manifest.status === "complete") result.push({ directory: join(output, entry.name), completedAt: manifest.completedAt, bytes: manifest.archive.bytes });
    } catch { /* Incomplete/unknown folders are not good backups. */ }
  }
  return result.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, backup: { type: "string" }, help: { type: "boolean" } }, allowPositionals: true });
  const action = positionals[0] || "create";
  if (values.help) { console.log("Usage: npm run backup [-- --config <private-config> --output <private-directory>]\n       npm run backup:verify -- --backup <backup-directory>\n       npm run backup:list\nExports briefly block D1 queries. No automatic deletion or remote restore. Runtime credential files are not copied."); return; }
  if (positionals.length > 1) throw new Error("Unexpected backup arguments");
  if (action === "verify") {
    if (!values.backup) throw new Error("Specify --backup <directory>");
    const result = await verifyBackup(values.backup);
    console.log(`Backup verified locally: ${result.verification.candidateCount} candidates; SQLite integrity and checksums passed.`);
  } else if (action === "list") {
    const backups = await listBackups(values.output);
    for (const backup of backups) console.log(`${backup.completedAt}  ${(backup.bytes / 1048576).toFixed(1)} MiB  ${backup.directory}`);
    if (!backups.length) console.log("No completed backups found.");
  } else if (action === "create") {
    console.log("Creating a private local backup. The export briefly blocks D1 requests; older backups are retained.");
    const result = await createBackup({ configFile: values.config, output: values.output });
    console.log(`Verified backup saved: ${result.directory}\nCompressed SQL: ${(result.manifest.archive.bytes / 1048576).toFixed(1)} MiB; ${result.manifest.verification.candidateCount} candidates. No old backups were deleted.`);
  } else throw new Error("Use create, verify or list");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(error.message.startsWith("Backup did not complete;") ? error.message : "Backup operation failed. Run with --help; inspect the newest protected .partial backup folder if creation had started. No recovery or old-backup deletion was performed.");
  process.exitCode = 1;
});
