import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRIVATE_CONFIG = "wrangler.production.jsonc";

// Packaging uses the public template unless an instance is explicitly selected.
// Local development keeps an existing private instance's D1 storage identity.
export function configPath({ local = false } = {}) {
  return process.env.FERTO_DEPLOY_CONFIG || (local && existsSync(PRIVATE_CONFIG) ? PRIVATE_CONFIG : "wrangler.jsonc");
}

export function readConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function assertProductionConfig(config) {
  const required = [config.vars?.SPOTIFY_CLIENT_ID, config.vars?.OWNER_SPOTIFY_ID, config.vars?.APP_ORIGIN];
  if (required.some(value => typeof value !== "string" || !value.trim() || value.startsWith("REPLACE_WITH_"))) {
    throw new Error("Production configuration needs SPOTIFY_CLIENT_ID, OWNER_SPOTIFY_ID and APP_ORIGIN");
  }
  const origin = new URL(config.vars.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== config.vars.APP_ORIGIN || ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("Production APP_ORIGIN must be a public HTTPS origin with no path or trailing slash");
  }
  const db = config.d1_databases?.find(binding => binding.binding === "DB");
  if (!db || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db.database_id) || db.database_id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Production configuration needs the actual D1 database ID");
  }
  // Worker/Queue names stay fixed; the DB binding may select a recovery database.
  if (typeof db.database_name !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(db.database_name)) throw new Error("Production configuration needs a valid D1 database name");
  if (config.name !== "ferto" || config.queues?.producers?.[0]?.queue !== "ferto-refresh" || config.queues?.consumers?.[0]?.queue !== "ferto-refresh") {
    throw new Error("Worker and Queue names must match ferto / ferto-refresh in the operational scripts");
  }
  if (Object.keys(config.vars).some(key => !["SPOTIFY_CLIENT_ID", "OWNER_SPOTIFY_ID", "APP_ORIGIN"].includes(key))) {
    throw new Error("Only the three public instance settings belong in vars; store credentials as Worker secrets");
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(" ") !== "--init") throw new Error("Usage: node scripts/deployment-config.mjs --init");
  const config = readConfig("wrangler.jsonc");
  config.d1_databases[0].database_id = process.env.FERTO_DATABASE_ID;
  for (const key of ["SPOTIFY_CLIENT_ID", "OWNER_SPOTIFY_ID", "APP_ORIGIN"]) config.vars[key] = process.env[key];
  assertProductionConfig(config);
  writeFileSync(PRIVATE_CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Created ignored ${PRIVATE_CONFIG}; no credentials were written.`);
}
