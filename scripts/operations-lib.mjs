import { spawn, execFileSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { assertProductionConfig, PRIVATE_CONFIG, readConfig } from "./deployment-config.mjs";

export const projectRoot = resolve(import.meta.dirname, "..");
export const FREE_DATABASE_BYTES = 500_000_000;

export function productionTarget(path = process.env.FERTO_DEPLOY_CONFIG || PRIVATE_CONFIG) {
  const configFile = resolve(path);
  const config = assertProductionConfig(readConfig(configFile));
  return { configFile, config, database: config.d1_databases.find(binding => binding.binding === "DB").database_name };
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error("Use a dedicated owner-only directory (chmod 700) for operation output");
  }
  return realpath(path);
}

export async function privateFile(path, contents) {
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
}

export async function ignoredOutput(path, root = projectRoot) {
  const absolute = resolve(path);
  const check = candidate => {
    const rel = relative(root, candidate);
    if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      let ignored = false;
      try { execFileSync("git", ["check-ignore", "--quiet", "--", rel], { cwd: root, stdio: "ignore" }); ignored = true; } catch { /* Reject public output. */ }
      if (!ignored) throw new Error("Operation output inside the repository must be ignored by Git");
    }
  };
  check(absolute);
  const actual = await privateDirectory(absolute);
  check(actual); // A symlink in a parent must not redirect into a public path.
  return actual;
}

export function gitIdentity(root = projectRoot) {
  try {
    return {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()),
    };
  } catch { return { revision: null, dirty: null }; }
}

/** Raw output can contain expiring signed export URLs; keep it in a private file. */
export async function wrangler(args, { configFile, logFile, root = projectRoot, timeoutMs = 600_000 } = {}) {
  const command = [join(root, "node_modules/wrangler/bin/wrangler.js"), ...args, "--config", configFile, "--env-file", "/dev/null"];
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
  const chunks = [];
  const child = spawn(process.execPath, command, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let size = 0;
  let timedOut = false;
  let spawnFailed = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  const output = [];
  let loggedBytes = 0;
  const collect = chunk => { loggedBytes += chunk.length; if (loggedBytes <= 16 * 1024 * 1024) output.push(chunk); else child.kill("SIGTERM"); };
  child.stdout.on("data", chunk => { size += chunk.length; if (size <= 8 * 1024 * 1024) chunks.push(chunk); else child.kill("SIGTERM"); collect(chunk); });
  child.stderr.on("data", collect);
  const code = await new Promise(resolveCode => {
    child.on("error", () => { spawnFailed = true; resolveCode(-1); });
    child.on("close", resolveCode);
  });
  clearTimeout(timer);
  if (logFile) {
    await appendFile(logFile, Buffer.concat(output), { mode: 0o600 });
    await chmod(logFile, 0o600);
  }
  if (code !== 0 || timedOut || spawnFailed || size > 8 * 1024 * 1024 || loggedBytes > 16 * 1024 * 1024) {
    throw new Error(`Wrangler ${args[0]} did not finish successfully${logFile ? `; inspect the protected log ${logFile}` : ""}`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function wranglerJson(args, options) {
  const text = await wrangler([...args, "--json"], options);
  try { return JSON.parse(text); }
  catch { throw new Error(`Wrangler returned invalid JSON; inspect the protected log ${options.logFile}`); }
}

export function activeDeployment(deployments) {
  if (!Array.isArray(deployments) || !deployments.length) throw new Error("No active Worker deployment could be identified");
  const latest = [...deployments].sort((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
  if (latest.versions?.length !== 1 || latest.versions[0].percentage !== 100) throw new Error("A release requires one active Worker version at 100% traffic");
  return latest;
}

async function accountCredentials(target, logDirectory) {
  let account = process.env.CLOUDFLARE_ACCOUNT_ID || target.config.account_id;
  if (!account) {
    const identity = await wranglerJson(["whoami"], { configFile: target.configFile, logFile: join(logDirectory, "identity.log") });
    const accounts = identity.accounts || [];
    account = accounts.length === 1 ? accounts[0].id : null;
  }
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("Select the Cloudflare account explicitly with CLOUDFLARE_ACCOUNT_ID");
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    // Wrangler's standard local OAuth profile; never print or copy the token.
    const base = process.env.XDG_CONFIG_HOME || (process.platform === "darwin" ? join(homedir(), "Library/Preferences") : join(homedir(), ".config"));
    const paths = [join(base, ".wrangler/config/default.toml"), join(homedir(), ".config/.wrangler/config/default.toml"), join(homedir(), ".wrangler/config/default.toml")];
    for (const file of paths) {
      try { token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(file, "utf8"))?.[1]; } catch { /* Try next standard location. */ }
      if (token) break;
    }
  }
  if (!token) throw new Error("Operational checks need Wrangler OAuth login or a scoped CLOUDFLARE_API_TOKEN");
  return { account, token };
}

export async function dailyD1Usage(target, logDirectory, checkedAt = new Date()) {
  const { account, token } = await accountCredentials(target, logDirectory);
  const date = checkedAt.toISOString().slice(0, 10);
  // No database filter: the Free allowance is shared by every database in the
  // account. A UTC-day aggregate must not be replaced with rolling 24h totals.
  const query = `query DailyD1Usage($accountTag:string!,$start:Date!){viewer{accounts(filter:{accountTag:$accountTag}){
    d1AnalyticsAdaptiveGroups(limit:1,filter:{date_geq:$start,date_leq:$start}){sum{rowsRead rowsWritten}}
  }}}`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: account, start: date } }),
    signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Daily D1 analytics request failed; check Account Analytics Read access"); }
  const result = await response.json();
  const accounts = result.data?.viewer?.accounts;
  const rows = accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if (result.errors?.length || accounts?.length !== 1 || !Array.isArray(rows) || rows.length > 1) throw new Error("Daily D1 analytics could not be confirmed");
  const sum = rows.length ? rows[0]?.sum : { rowsRead: 0, rowsWritten: 0 };
  if (!sum || [sum.rowsRead, sum.rowsWritten].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Daily D1 analytics returned invalid row totals");
  return { date, scope: "account", rowsRead: sum.rowsRead, rowsWritten: sum.rowsWritten,
    freeReadLimit: 5_000_000, freeWriteLimit: 100_000,
    resetAt: new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString() };
}

export function dailyD1Warnings(usage) {
  const warnings = [];
  for (const [kind, amount, limit] of [["reads", usage.rowsRead, usage.freeReadLimit], ["writes", usage.rowsWritten, usage.freeWriteLimit]]) {
    if (amount >= limit * 0.8) warnings.push(`Daily account D1 ${kind}: ${amount.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} (Free allowance). Reset: ${usage.resetAt}. Reduce background work; analytics may lag.`);
  }
  return warnings;
}

export async function queueState(target, logDirectory) {
  const { account, token } = await accountCredentials(target, logDirectory);
  const get = async path => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Cloudflare queue status request failed; check account and Queue read permissions"); }
    const data = await response.json();
    if (!data.success) throw new Error("Cloudflare did not confirm Queue status");
    return data.result;
  };
  const queues = await get(`/queues?name=${encodeURIComponent(target.config.queues.consumers[0].queue)}&per_page=100`);
  const queue = queues.find(q => q.queue_name === target.config.queues.consumers[0].queue);
  if (!queue?.queue_id) throw new Error("The configured Queue could not be identified");
  const result = await get(`/queues/${queue.queue_id}`);
  if (typeof result.settings?.delivery_paused !== "boolean") throw new Error("Queue pause state was not returned");
  return result;
}
