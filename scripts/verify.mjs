import { spawn } from "node:child_process";

for (const [script, args] of [
  ["build", []], ["test", ["--testTimeout=60000", "--hookTimeout=60000"]],
  ["test:simulator", []], ["test:release", []], ["test:publication", []], ["test:operations", []], ["test:demo", []], ["test:browser", []], ["worker:check", []],
]) {
  const child = spawn("npm", ["run", script, ...(args.length ? ["--", ...args] : [])], {
    stdio: "inherit", env: { ...process.env, FERTO_BROWSER_SKIP_BUILD: "1" },
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  if (code !== 0) { process.exitCode = typeof code === "number" ? code : 1; break; }
}
