import { spawn } from "node:child_process";
import { configPath } from "./deployment-config.mjs";

const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", [
  "wrangler", ...process.argv.slice(2), "--config", configPath({ local: true }),
], { stdio: "inherit", env: process.env });
child.on("error", () => { console.error("Could not start local Wrangler"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
