import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeSync } from "node:fs";
import { simulationConfig, type SimulationConfig } from "./config";
import { runSimulation } from "./engine";

export const HELP = `FERTO refresh simulator (local synthetic data; Node.js 24+)

npm run simulate -- [options]
  --scenario smoke|quota|chaos|soak|warm   Preset (default: smoke)
  --artists N                            Number of seed artists
  --initial-live-artists N               Start with an existing partial catalogue
  --shared-quota N                       Model one quota bucket for all data endpoints (0 disables)
  --albums N                             Albums per artist
  --tracks N                             Tracks per album (minimum 6)
  --playlists N                          Playlists (minimum 4)
  --quota N                              Track metadata calls per quota window
  --catalogue-quota N                    Other API calls per quota window
  --window-seconds N                     Quota window length
  --retry-after seconds|date|missing      Quota response header mode
  --rolling-limit N                      Calls per rolling window (0 disables)
  --seed N                               Reproducible delivery jitter
  --runs N                               Successive refreshes of the same DB
  --between-runs-seconds N                Time advanced between refreshes
  --max-days N                           Virtual-time bound per run
  --max-deliveries N                     Total delivery bound
  --config path.json                     Override preset with a JSON object
  --report path.json                     JSON report (default: simulation-results/<scenario>-<seed>.json)
  --trace path.jsonl                     Optional trace of every delivery/cron
  --help                                Show this help

The clock jumps to the next event. No live Spotify/Cloudflare calls are made.
A failed invariant or unfinished refresh exits nonzero and writes diagnostics.
Quota assumptions describe the fake API only; they are not real Spotify limits.
`;
const FLAGS: Record<string, keyof SimulationConfig> = {
  "--artists": "artists", "--initial-live-artists": "initialLiveArtists", "--albums": "albumsPerArtist", "--tracks": "tracksPerAlbum", "--playlists": "playlists",
  "--quota": "trackQuota", "--catalogue-quota": "catalogueQuota", "--shared-quota": "sharedQuota", "--window-seconds": "quotaWindowSeconds",
  "--rolling-limit": "rollingLimit", "--seed": "seed", "--runs": "runs", "--between-runs-seconds": "betweenRunsSeconds",
  "--max-days": "maxVirtualDays", "--max-deliveries": "maxDeliveries", "--retry-after": "retryAfter", "--scenario": "scenario",
};

export async function main(args: string[], root: string): Promise<void> {
  if (args.includes("--help")) { process.stdout.write(HELP); return; }
  const cli: Record<string, string | number> = {};
  let configPath: string | undefined; let reportPath: string | undefined; let tracePath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!; const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--config") configPath = resolve(value);
    else if (flag === "--report") reportPath = resolve(value);
    else if (flag === "--trace") tracePath = resolve(value);
    else if (FLAGS[flag]) cli[FLAGS[flag]] = ["--scenario", "--retry-after"].includes(flag) ? value : Number(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  let file: Partial<SimulationConfig> = {};
  if (configPath) {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config must be a JSON object");
    const allowed = new Set(Object.keys(simulationConfig()));
    for (const key of Object.keys(parsed)) if (!allowed.has(key)) throw new Error(`Unknown config property: ${key}`);
    file = parsed as Partial<SimulationConfig>;
  }
  const config = simulationConfig({ ...file, ...cli });
  reportPath ??= resolve(root, "simulation-results", `${config.scenario}-${config.seed}.json`);
  if (tracePath === reportPath || configPath === reportPath || (tracePath && tracePath === configPath)) throw new Error("Config, report and trace paths must differ");
  const trace = tracePath ? (await mkdir(dirname(tracePath), { recursive: true }), await open(tracePath, "w")) : undefined;
  process.stdout.write(`FERTO ${config.scenario}: ${config.artists} artists, ${config.albumsPerArtist} albums each, ${config.tracksPerAlbum} tracks per album; seed ${config.seed}\n`);
  try {
    let deliveries = 0;
    const report = await runSimulation(config, { root, onEvent: (event) => {
      if (trace) writeSync(trace.fd, JSON.stringify(event) + "\n");
      if (++deliveries % 1000 === 0) process.stdout.write(`  ${deliveries} events; virtual ${event.at}; ${event.phase}\n`);
    } });
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(`${report.passed ? "PASS" : "FAIL"}: ${report.virtualDays.toFixed(2)} virtual days in ${report.wallSeconds.toFixed(2)} real seconds\n`);
    for (const run of report.runs) process.stdout.write(`  Run ${run.run}: ${run.artistsCompleted}/${config.artists} artists, ${run.candidates}/${run.expectedCandidates} expected recordings, ${run.requestAttempts} HTTP attempts\n`);
    process.stdout.write(`  Quota responses: ${Object.values(report.api.endpoints).reduce((sum, item) => sum + item.quota, 0)}; rolling 429s: ${Object.values(report.api.endpoints).reduce((sum, item) => sum + item.rateLimited, 0)}; recovered crashes: ${report.injectedCrashes}\n  Watchdog: ${report.watchdogWakes} recovery wakes in ${report.watchdogTicks} maintenance ticks\n`);
    process.stdout.write(`  Maximum statements/invocation: ${report.database.maxStatementsPerInvocation}; HTTP attempts/invocation: ${report.api.maxRequestsPerInvocation}\n  Report: ${reportPath}\n`);
    if (report.failure) process.stderr.write(report.failure + "\n");
    if (!report.passed) process.exitCode = 1;
  } finally { await trace?.close(); }
}
