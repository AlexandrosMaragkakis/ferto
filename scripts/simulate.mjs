import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("FERTO simulator requires Node.js 24 or newer (node:sqlite).\n");
  process.exitCode = 1;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const folder = await mkdtemp(join(tmpdir(), "ferto-simulator-build-"));
  const selfTest = process.argv[2] === "--test";
  try {
    // Explicit configFile:false and envDir:false keep the app's Wrangler plugin,
    // local credentials, production bindings and output directory uninvolved.
    await build({ configFile: false, envDir: false, root, logLevel: "error",
      build: { ssr: resolve(root, "simulation", selfTest ? "simulator.test.ts" : "cli.ts"), outDir: folder,
        emptyOutDir: true, rollupOptions: { output: { entryFileNames: "runner.mjs" } } } });
    const entry = await import(pathToFileURL(join(folder, "runner.mjs")).href);
    await entry.main(selfTest ? [] : process.argv.slice(2), root);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
