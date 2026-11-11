import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { verifyBackup, rehearseSql } from "./backup.mjs";
import { ignoredOutput, privateFile, projectRoot } from "./operations-lib.mjs";

const SCHEMAS = ["0022_oauth_browser_binding_and_budgets.sql", "0023_never_isrc_lookup.sql"];
const CACHE_TABLES = ["spotify_track_cache", "recording_identity_cache", "track_availability", "album_track_pages", "album_availability_pages"];
const quote = name => `"${name.replaceAll('"', '""')}"`;
const category = name => CACHE_TABLES.includes(name) || name.startsWith("playlist_snapshot") ? "cache"
  : ["refresh_history", "operational_activity", "quota_interruptions", "refresh_publications"].includes(name) ? "history"
  : name.startsWith("never_") ? "permanent-exclusions"
  : ["owner_sessions", "oauth_states", "request_budgets", "service_token_cache"].includes(name) ? "authentication-and-request-state"
  : name.startsWith("rebuild_") ? "staging"
  : ["recordings", "recording_generations", "recommendation_slots", "recommendation_buckets"].includes(name) ? "catalogue-and-staging"
  : "schema-and-legacy-state";

/** SELECT-only analysis. The CLI supplies a read-only restored database. */
export function analyzeRetention(db, { asOf = Date.now() } = {}) {
  if (!Number.isSafeInteger(asOf) || !Number.isFinite(new Date(asOf).getTime())) throw new Error("Invalid preview time");
  const schema = db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").get()?.name;
  if (!SCHEMAS.includes(schema)) throw new Error("Unsupported retention schema; expected schema 0022 or 0023");
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  const objects = db.prepare("SELECT name,tbl_name FROM sqlite_schema WHERE type IN ('table','index')").all();
  let pages = null;
  try { pages = new Map(db.prepare("SELECT name,SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all().map(row => [row.name, row.bytes])); }
  catch { /* Some SQLite builds omit dbstat. Unknown bytes must not become zero. */ }
  const generationTables = names.filter(name => db.prepare(`PRAGMA table_info(${quote(name)})`).all().some(column => column.name === "generation"));
  const tables = names.map(name => ({
    name, category: category(name), rows: db.prepare(`SELECT COUNT(*) AS n FROM ${quote(name)}`).get().n,
    localBytes: pages ? objects.filter(object => object.tbl_name === name).reduce((total, object) => total + (pages.get(object.name) ?? 0), 0) : null,
  }));

  const protectedGenerations = new Map();
  const protect = (generation, reason) => {
    if (!generation) return;
    const reasons = protectedGenerations.get(generation) ?? new Set();
    reasons.add(reason); protectedGenerations.set(generation, reasons);
  };
  const live = db.prepare("SELECT live_generation FROM refresh_state WHERE singleton=1").get()?.live_generation;
  protect(live, "live-catalogue");
  for (const row of db.prepare("SELECT generation,status FROM rebuild_jobs").all()) protect(row.generation, `current-job:${row.status}`);
  for (const row of db.prepare("SELECT generation FROM recording_generations").all()) protect(row.generation, "promoted-history-and-stale-card-identities");
  for (const row of db.prepare("SELECT generation,base_generation FROM refresh_history").all()) {
    protect(row.generation, "retained-refresh-history"); protect(row.base_generation, "retained-refresh-baseline");
  }
  for (const row of db.prepare("SELECT DISTINCT generation,live_generation FROM refresh_publications").all()) {
    protect(row.generation, "publication-ledger-source"); protect(row.live_generation, "publication-ledger-target");
  }
  const generations = new Map([...protectedGenerations].map(([generation, reasons]) => [generation, { generation, rowsByTable: {}, retainedReasons: [...reasons] }]));
  for (const table of generationTables) {
    for (const row of db.prepare(`SELECT generation,COUNT(*) AS n FROM ${quote(table)} GROUP BY generation`).all()) {
      if (!row.generation) continue;
      if (!generations.has(row.generation)) generations.set(row.generation, { generation: row.generation, rowsByTable: {}, retainedReasons: [] });
      generations.get(row.generation).rowsByTable[table] = row.n;
    }
  }
  const protectedIds = JSON.stringify([...protectedGenerations.keys()]);
  for (const entry of generations.values()) {
    entry.aliasesRequiringPreservation = db.prepare(`SELECT COUNT(*) AS n FROM recordings r WHERE r.generation=?
      AND NOT EXISTS(SELECT 1 FROM recordings kept WHERE kept.generation IN(SELECT value FROM json_each(?))
        AND kept.spotify_id=r.spotify_id AND kept.recording_key=r.recording_key)`).get(entry.generation, protectedIds).n;
    if (!entry.retainedReasons.length && entry.aliasesRequiringPreservation) entry.retainedReasons.push("unique-stale-card-identities-require-preservation");
    entry.cleanupCandidate = entry.retainedReasons.length === 0;
  }
  const expiredCaches = CACHE_TABLES.map(table => {
    const extra = table === "album_availability_pages"
      ? " AND NOT EXISTS(SELECT 1 FROM album_track_pages p WHERE p.context=c.context AND p.album_id=c.album_id AND p.cursor=c.cursor AND p.expires_at>?)" : "";
    const args = extra ? [asOf, asOf] : [asOf];
    const expired = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE expires_at<=?`).get(asOf).n;
    const eligible = db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} c WHERE c.expires_at<=?${extra}`).get(...args).n;
    return { table, expiredRows: expired, candidateRows: eligible, retainedExpiredRows: expired - eligible,
      rule: extra ? "Keep expired availability markers while their album discovery page is fresh; removing them can change refresh behavior." : "Expired TTL rows are cache misses; identity authorities are retained separately." };
  });
  return {
    schema, asOf: new Date(asOf).toISOString(),
    storage: { basis: "Restored local SQLite table and index pages, not Cloudflare physical storage, billable reads, or guaranteed reclaimed bytes.",
      localPageBytes: pages ? [...pages.values()].reduce((sum, bytes) => sum + bytes, 0) : null, tables },
    generations: [...generations.values()].sort((a, b) => a.generation.localeCompare(b.generation)), expiredCaches,
    alwaysRetained: ["never_recordings", "never_tracks", "never_identity_checks", "recording_generations", "playlist_snapshots", "playlist_snapshot_pages", "d1_migrations", "owner_sessions", "oauth_states", "service_token_cache", "request_budgets"],
    policy: "Preview only. Retain all promoted generations, current jobs (including failed), history/ledger references and unique Spotify-id/recording-key aliases. Only unreferenced abandoned work whose aliases survive in protected generations is eligible. No deletion SQL or apply mode is provided.",
  };
}

export function compareRetention(previous, current) {
  const old = new Map(previous.storage.tables.map(table => [table.name, table]));
  return { from: previous.asOf, to: current.asOf, tables: current.storage.tables.map(table => ({
    name: table.name, rowsBefore: old.get(table.name)?.rows ?? 0, rowsAfter: table.rows,
    rowDelta: table.rows - (old.get(table.name)?.rows ?? 0),
    localByteDelta: table.localBytes !== null && old.get(table.name)?.localBytes !== null && old.has(table.name) ? table.localBytes - old.get(table.name).localBytes : null,
  })), generationsBefore: previous.generations.length, generationsAfter: current.generations.length };
}

export async function previewRetention({ backup, compare, asOf = Date.now(), output = join(projectRoot, ".local/retention"), root = projectRoot } = {}) {
  if (!backup) throw new Error("Use --backup with a completed verified backup directory");
  const current = await verifyBackup(backup);
  const earlier = compare ? await verifyBackup(compare) : null;
  if (earlier && (earlier.manifest.database.id !== current.manifest.database.id || earlier.manifest.completedAt > current.manifest.completedAt)) throw new Error("Compare backups must belong to the same database in chronological order");
  const parent = await ignoredOutput(output, root);
  const directory = await mkdtemp(join(parent, "preview-"));
  const analyze = async (folder, checked, label) => {
    const work = join(directory, label); await mkdir(work, { mode: 0o700 });
    try {
      const file = join(work, "snapshot.sqlite");
      const archive = await readFile(join(folder, "database.sql.gz"));
      const hash = bytes => createHash("sha256").update(bytes).digest("hex");
      if (archive.length !== checked.manifest.archive.bytes || hash(archive) !== checked.manifest.archive.sha256) throw new Error("Backup changed after verification");
      const sql = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
      if (sql.length !== checked.manifest.sql.bytes || hash(sql) !== checked.manifest.sql.sha256) throw new Error("Backup SQL changed after verification");
      const restored = await rehearseSql(sql.toString("utf8"), file);
      if (JSON.stringify(restored) !== JSON.stringify(checked.verification)) throw new Error("Restored preview differs from its verified backup");
      const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
      try {
        return { snapshot: { completedAt: checked.manifest.completedAt, revision: checked.manifest.source?.revision ?? null,
          cloudflareDatabaseBytes: checked.manifest.database.info?.database_size ?? null },
        ...analyzeRetention(db, { asOf }) };
      } finally { db.close(); }
    } finally { await rm(work, { recursive: true, force: true }); }
  };
  const report = { format: 1, mode: "preview", inputModified: false, current: await analyze(backup, current, "current") };
  if (earlier) {
    const previous = await analyze(compare, earlier, "previous");
    report.previous = previous;
    report.growth = compareRetention(previous, report.current);
    report.growth.from = earlier.manifest.completedAt; report.growth.to = current.manifest.completedAt;
  }
  await privateFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return { directory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const { values } = parseArgs({ options: { backup: { type: "string" }, compare: { type: "string" }, at: { type: "string" }, output: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) console.log("Usage: npm run retention:preview -- --backup <verified-backup> [--compare <older-backup>] [--at <ISO-time>] [--output <private-directory>]\nOffline preview only: no provider calls, input data changes, deletion SQL or apply mode.");
    else {
      const { directory, report } = await previewRetention({ backup: values.backup, compare: values.compare, asOf: values.at ? Date.parse(values.at) : Date.now(), output: values.output });
      console.log(`Retention preview saved privately: ${directory}/report.json\nExpired cache candidates: ${report.current.expiredCaches.reduce((sum, item) => sum + item.candidateRows, 0)} rows. Abandoned generation candidates: ${report.current.generations.filter(item => item.cleanupCandidate).length}. No data deleted.`);
    }
  } catch { console.error("Retention preview could not complete. Check backup integrity, schema 0022/0023, chronological comparison, time and private output permissions. Only preview options are supported; there is no apply mode."); process.exitCode = 1; }
}
