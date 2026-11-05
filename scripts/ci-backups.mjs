import { parseArgs } from "node:util";
import { createBackupKey, fetchCiBackup, restoreEncryptedBackup } from "./backup-encryption.mjs";

process.umask(0o077);
const [command, ...args] = process.argv.slice(2);
const { values } = parseArgs({ args, options: { run: { type: "string" }, repo: { type: "string" }, file: { type: "string" }, "key-home": { type: "string" } } });
try {
  if (command === "keys") {
    const result = await createBackupKey();
    console.log(`Backup encryption key ready. Public recipient: ${result.recipient}\nPrivate keyring/recovery export stays local: ${result.home}`);
  } else if (command === "fetch" || command === "restore") {
    if (command === "restore" && !values.file) throw new Error("Use --file <downloaded-backup.gpg>");
    const result = command === "fetch" ? await fetchCiBackup({ runId: values.run, repository: values.repo, keyHome: values["key-home"] }) : await restoreEncryptedBackup(values.file, { keyHome: values["key-home"] });
    console.log(`CI backup decrypted and locally restored/verified: ${result.directory}`);
  } else throw new Error("Usage: npm run backup:keys | npm run backup:fetch -- --run <id> [--repo owner/repository] | npm run backup:restore -- --file <backup.gpg>");
} catch (error) { console.error(error.message); process.exitCode = 1; }
