import { chmod, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ignoredOutput, privateFile, productionTarget, projectRoot } from "./operations-lib.mjs";

export async function prepareRecovery({ configFile, root = projectRoot } = {}) {
  const target = productionTarget(configFile);
  const parent = await ignoredOutput(join(root, ".local/recovery"), root);
  const directory = await mkdtemp(join(parent, "maintenance-")); await chmod(directory, 0o700);
  const config = structuredClone(target.config);
  config.main = join(root, "ops/maintenance-worker.mjs");
  delete config.assets; // Every request reaches maintenance; no frontend build is needed.
  config.triggers = { crons: [] };
  for (const db of config.d1_databases) if (db.binding === "DB") db.migrations_dir = join(root, "migrations");
  const output = join(directory, "wrangler.jsonc");
  await privateFile(output, JSON.stringify(config, null, 2) + "\n");
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  prepareRecovery({ configFile: values.config }).then(output => console.log(`Maintenance configuration prepared: ${output}\nNo deployment or database change performed. Follow docs/backups-and-recovery.md before using it.`))
    .catch(() => { console.error("Could not prepare the private recovery configuration. Check the selected instance settings."); process.exitCode = 1; });
}
