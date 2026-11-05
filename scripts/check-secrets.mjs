import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const version = "8.30.1";
const binary = resolve(import.meta.dirname, "../.local/tools/gitleaks");
const hashes = {
  // Digests published with the official v8.30.1 GitHub release assets.
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
};
const git = args => execFileSync("git", args, { maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const temporary = mkdtempSync(join(tmpdir(), "ferto-secrets-"));
chmodSync(temporary, 0o700);

async function install() {
  const platform = `${process.platform}_${process.arch}`;
  const expected = hashes[platform];
  if (!expected) throw new Error("Pinned Gitleaks installer supports Linux x64 and macOS x64/arm64");
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Gitleaks download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Gitleaks archive checksum mismatch");
  const archive = join(temporary, "gitleaks.tar.gz");
  writeFileSync(archive, bytes, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archive, "-C", temporary, "gitleaks"]);
  mkdirSync(dirname(binary), { recursive: true });
  chmodSync(join(temporary, "gitleaks"), 0o755);
  // Copy across filesystems through a sibling staging file before rename.
  const staging = `${binary}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, readFileSync(join(temporary, "gitleaks")), { flag: "wx", mode: 0o755 });
    renameSync(staging, binary);
  } finally { rmSync(staging, { force: true }); }
  console.log(`Installed Gitleaks ${version} after SHA-256 verification.`);
}

function forbidden(path) {
  if (/^\.dev\.vars\.example$|^\.env\.example$/.test(path)) return false;
  return /(^|\/)(\.dev\.vars[^/]*|\.env(?:\.[^/]*)?|\.wrangler|\.local|\.release|node_modules|backups|output|test-results|playwright-report)(\/|$)/.test(path)
    || /(^|\/)wrangler\.(?:production|.*\.local)\.jsonc$/.test(path)
    || /\.(?:sqlite(?:3|-wal|-shm)?|db(?:-wal|-shm)?|dump|pem|key|asc|gpg|log|zip|tar\.gz|(?:sql|sqlite3?|db)\.gz)$/i.test(path)
    || /(^|\/)(?:backup|export)[^/]*\.sql$/i.test(path)
    || /^(?:reference-ui\.png|initial_prompt\.md)$|^(?:\.agents|\.vscode|\.idea)\/|^docs\/(?:publication-|d1-baseline-|ferto-name-check-)/.test(path);
}

function knownSecrets() {
  const values = [];
  // Provider tokens can be opaque: supplement Gitleaks with exact local values.
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)$/.test(key) && value?.length >= 12) values.push(value);
  }
  if (existsSync(".dev.vars")) {
    for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)$/.test(match[1])) {
        const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
        if (value.length >= 12) values.push(value);
      }
    }
  }
  return [...new Set(values)].map(value => Buffer.from(value));
}

async function scan(args) {
  let ref, artifact, listOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--list") listOnly = true;
    else if (["--ref", "--artifact"].includes(args[index])) {
      const option = args[index], value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
      if (option === "--ref") ref = git(["rev-parse", "--verify", `${value}^{commit}`]).toString().trim();
      else artifact = resolve(value);
    } else throw new Error("Usage: npm run check:secrets -- [--ref HEAD] [--artifact .release] [--list]");
  }
  const root = git(["rev-parse", "--show-toplevel"]).toString().trim();
  if (resolve(root) !== process.cwd()) throw new Error("Run the publication check from the repository root");
  const files = [...new Set(git(ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean))].sort();
  const findings = [];
  const secrets = knownSecrets();
  const inspect = (bytes, label) => { if (secrets.some(secret => bytes.includes(secret))) findings.push(`Known local credential: ${label}`); };
  const candidate = join(temporary, "candidate");
  mkdirSync(candidate);
  let count = 0;
  for (const file of files) {
    let bytes;
    if (forbidden(file)) { findings.push(`Private/generated path in publication: ${file}`); continue; }
    if (ref) {
      const entry = git(["ls-tree", ref, "--", file]).toString();
      if (entry.startsWith("120000") || entry.startsWith("160000")) { findings.push(`Unsupported link/submodule: ${file}`); continue; }
      bytes = git(["show", `${ref}:${file}`]);
    } else {
      if (!existsSync(file)) continue;
      if (!lstatSync(file).isFile()) { findings.push(`Unsupported link/non-file: ${file}`); continue; }
      bytes = readFileSync(file);
    }
    count++;
    inspect(bytes, file);
    const target = join(candidate, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    if (listOnly) console.log(file);
  }
  // Scan all reachable blobs, including credentials deleted from the current tree.
  if (secrets.length) {
    const objects = git(["rev-list", "--objects", ref || "--all"]).toString().trim().split("\n");
    for (const object of objects) {
      if (!object) continue;
      const [oid] = object.split(" ");
      if (git(["cat-file", "-t", oid]).toString().trim() === "blob") inspect(git(["cat-file", "blob", oid]), `history blob ${oid}`);
    }
  }
  const scanner = process.env.GITLEAKS_BIN || binary;
  const checked = spawnSync(scanner, ["version"], { encoding: "utf8" });
  if (checked.status !== 0 || checked.stdout.trim() !== version) throw new Error(`Gitleaks ${version} is required; run npm run secrets:install`);
  const rules = join(temporary, "rules.toml"), ignore = join(temporary, ".gitleaksignore");
  writeFileSync(rules, "[extend]\nuseDefault = true\n", { mode: 0o600 });
  writeFileSync(ignore, "", { mode: 0o600 });
  function gitleaks(mode, path, extra = []) {
    const report = join(temporary, "report.json");
    rmSync(report, { force: true });
    const result = spawnSync(scanner, [mode, path, "--no-banner", "--redact=100", "--config", rules, "--gitleaks-ignore-path", ignore, "--ignore-gitleaks-allow", "--report-format=json", `--report-path=${report}`, ...extra], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (![0, 1].includes(result.status)) throw new Error(`Gitleaks ${mode} could not finish; no clean result was recorded`);
    const entries = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) || [] : [];
    if (result.status === 1 && entries.length === 0) throw new Error("Gitleaks failed without a usable report");
    // Never forward the scanner's raw output, match text or secret fields.
    for (const entry of entries) findings.push(`Gitleaks ${entry.RuleID}: ${entry.File}:${entry.StartLine}${entry.Commit ? ` (${entry.Commit})` : ""}`);
  }
  gitleaks("git", ".", [`--log-opts=${ref || "--all"}`]);
  gitleaks("dir", candidate);
  if (artifact) {
    function walk(folder) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) findings.push(`Unsupported artifact entry: ${relative(artifact, path)}`);
        else if (entry.isDirectory()) walk(path);
        else inspect(readFileSync(path), `artifact/${relative(artifact, path)}`);
      }
    }
    if (!lstatSync(artifact).isDirectory() || lstatSync(artifact).isSymbolicLink()) throw new Error("Artifact must be a directory, not a symbolic link");
    walk(artifact);
    if (!findings.some(finding => finding.startsWith("Unsupported artifact"))) gitleaks("dir", artifact);
  }
  if (findings.length) {
    for (const finding of [...new Set(findings)]) console.error(finding);
    throw new Error("Publication scan failed; credential values have been withheld");
  }
  console.log(`Secret check passed: ${count} candidate files, ${ref ? `history through ${ref}` : "all reachable history"}${artifact ? ", release artifact" : ""}.`);
}

try {
  const args = process.argv.slice(2);
  if (args.join(" ") === "--install") await install();
  else await scan(args);
} catch (error) {
  // Child-process failures can carry matched content; report only our own errors.
  console.error(error?.status !== undefined || error?.code || error instanceof SyntaxError ? "Publication check could not finish (Git/filesystem/tool error)." : error.message);
  process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
