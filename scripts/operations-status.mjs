import { mkdtemp, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FREE_DATABASE_BYTES, activeDeployment, dailyD1Usage, dailyD1Warnings, ignoredOutput, privateFile, productionTarget, projectRoot, queueState, wranglerJson } from "./operations-lib.mjs";
import { listBackups } from "./backup.mjs";

export async function operationsStatus({ configFile, output = join(projectRoot, ".local/operations"), root = projectRoot } = {}) {
  const target = productionTarget(configFile);
  const parent = await ignoredOutput(output, root);
  const directory = await mkdtemp(join(parent, "status-")); await chmod(directory, 0o700);
  const opts = name => ({ configFile: target.configFile, logFile: join(directory, name + ".log"), root });
  const info = await wranglerJson(["d1", "info", target.database], opts("database"));
  const deployment = activeDeployment(await wranglerJson(["deployments", "list"], opts("deployment")));
  const queue = await queueState(target, directory);
  const data = await wranglerJson(["d1", "execute", target.database, "--remote", "--command", "SELECT status,phase,revision,lease_until,retry_at,next_read_at,updated_at,wait_reason FROM rebuild_jobs WHERE singleton=1; SELECT candidate_count,live_bucket_count FROM refresh_state WHERE singleton=1; SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1;"], opts("state"));
  if (!Array.isArray(data) || data.some(row => !row.success)) throw new Error("D1 operational state could not be read");
  const job = data[0].results[0] || null;
  const backups = await listBackups(join(root, "backups/ferto"));
  const warnings = [];
  let dailyUsage = null;
  try { dailyUsage = await dailyD1Usage(target, directory); warnings.push(...dailyD1Warnings(dailyUsage)); }
  catch { warnings.push("Daily account D1 usage could not be read. Check analytics access/rate limits; do not assume daily headroom from database size."); }
  if (queue.settings.delivery_paused) warnings.push("Queue delivery is paused. Inspect the last release before resuming; free messages expire after 24 hours.");
  if (info.database_size >= FREE_DATABASE_BYTES * 0.75) warnings.push("D1 storage is above 75% of the assumed Free per-database limit. Review retained history before the 500 MB cap.");
  if (!backups.length || Date.now() - Date.parse(backups[0].completedAt) > 7 * 86400000) warnings.push("No local backup newer than seven days was found. Run npm run backup.");
  if (job?.status === "failed") warnings.push("The catalogue refresh failed. Review owner history and service-token authorization.");
  const due = job ? Math.max(job.updated_at || 0, job.lease_until || 0, job.retry_at || 0, job.next_read_at || 0) : 0;
  if (job?.status === "active" && Date.now() - due > 20 * 60000) warnings.push("Refresh progress is overdue beyond the watchdog window. Inspect owner history, Queue delivery and errors.");
  const report = { checkedAt: new Date().toISOString(), assumedPlan: "Free", workerVersion: deployment.versions[0].version_id,
    databaseBytes: info.database_size, freeDatabaseLimitBytes: FREE_DATABASE_BYTES, queueDeliveryPaused: queue.settings.delivery_paused,
    catalogue: data[1].results[0] || null, latestMigration: data[2].results[0]?.name, refresh: job,
    latestLocalBackup: backups[0] || null, dailyUsage, warnings };
  await privateFile(join(directory, "status.json"), JSON.stringify(report, null, 2) + "\n");
  return { report, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  operationsStatus({ configFile: values.config }).then(({ report, directory }) => {
    console.log(`Worker ${report.workerVersion}\nD1 ${(report.databaseBytes / 1000000).toFixed(1)} / 500 MB (Free assumption)\nQueue: ${report.queueDeliveryPaused ? "PAUSED" : "delivery enabled"}\nCatalogue: ${report.catalogue?.candidate_count ?? 0} candidates; refresh ${report.refresh?.status || "idle"}`);
    if (report.dailyUsage) console.log(`D1 account today (${report.dailyUsage.date} UTC): ${report.dailyUsage.rowsRead.toLocaleString("en-US")} / 5,000,000 rows read; ${report.dailyUsage.rowsWritten.toLocaleString("en-US")} / 100,000 rows written.`);
    for (const warning of report.warnings) console.log(`Attention: ${warning}`);
    console.log(`Protected report: ${directory}`);
    if (report.warnings.length) process.exitCode = 1;
  }).catch(() => { console.error("Operational check failed. Check Wrangler login, private configuration and the newest protected .local/operations/status-* logs."); process.exitCode = 1; });
}
