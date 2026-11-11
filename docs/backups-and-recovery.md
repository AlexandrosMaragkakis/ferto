# Backups and recovery on the free tier

Run commands from the repository root with the Node version in `.nvmrc`.
This plan uses the existing Cloudflare login and local disk, with no extra
subscription, R2 bucket or hosted scheduler. Optional [CI/CD](ci-cd.md) adds a
separate scoped deployment credential and encrypted runner backups; the local
commands here continue to use the existing Wrangler login.

## Plan and limits

Assume Workers/D1/Queues **Free**, as requested. D1's documented recovery
window is **7 days**, with **500 MB per database** and **5 GB per account**.
See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
D1 automatically maintains its short recovery history; local SQL exports give
an independent copy that can be kept longer. A saved bookmark does not extend
the seven-day window.

- Make a local backup **weekly** and **before every deployment or schema change**.
  The local release helper makes its own verified backup before pausing delivery.
- Keep at least the **latest 12 successful backups**, plus a known-good copy
  before a substantial schema change. Review disk usage monthly. The helper
  never deletes old backups automatically; failed attempts do not replace good ones.
- Copy verified backup folders to another existing device or encrypted drive
  when available. A copy only on this computer does not protect against losing
  this computer. Use the original Git source/release revision to recover code.
- Retain promoted catalogue generations for now. Check storage monthly with
  `npm run ops:status`; it flags 75% of the Free per-database limit. Review
  schema-aware history cleanup before reaching the cap. No catalogue rows are
  deleted by these operational scripts.

Use the [retention analysis and dry-run preview](retention.md) to inspect table
and generation growth from verified backups before defining a deletion policy.

## Create and verify a backup

```bash
npm run backup
npm run backup:list
npm run backup:verify -- --backup backups/ferto/<completed-backup-folder>
```

The default target is the ignored `wrangler.production.jsonc`, or the explicit
`FERTO_DEPLOY_CONFIG` selection. Override it with `--config <private-file>`.
The public all-zero database template is rejected. An existing migrated FERTO
instance and a current Wrangler login are required:

```bash
npx wrangler login
npm run backup -- --output /absolute/path/to/private-ferto-backups
```

The output directory must be dedicated and owner-only. Inside this repository
it must also be ignored by Git. Default output is `backups/ferto/`, with unique
UTC timestamped directories, mode 0700; files are mode 0600. Compressed SQL
exports are also ignored/blocked if accidentally copied elsewhere in the repo.

Each completed folder has:

- `database.sql.gz`: full exported schema and data, with SHA-256 hashes for the
  compressed archive and original SQL recorded in `manifest.json`.
- `manifest.json`: database metadata, active Worker version, local revision and
  dirty-state flag, timestamps, surrounding Time Travel bookmarks, migration
  and local restore-check results. Bookmarks bracket the export; neither is
  claimed as the exact timestamp of the exported snapshot.
- `instance.json`: the non-secret instance identifiers/resource settings needed
  to reconstruct configuration. It is private because it identifies your instance.
- Protected Wrangler logs for diagnosis. Export logs can contain a short-lived
  signed download link and must stay private too.

Before reporting success, the helper restores the SQL into a disposable local
SQLite database, checks integrity/foreign keys, required tables and catalogue
counts, compresses it, then independently verifies and restores the compressed
copy. Temporary SQL/SQLite files are removed after success. Verification is
local and works without Cloudflare credentials. It supports up to 512 MiB of
uncompressed SQL; an oversized or failed export remains incomplete and never
counts as a verified backup.

D1 exports **temporarily block database requests**. Run them at a quiet moment;
see [Cloudflare's export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations).
Folders beginning `.partial-` are failed/incomplete attempts, not good backups.
Inspect their private logs and keep older completed copies until recovery is certain.

Exports contain private catalogue/exclusion data, owner sessions, OAuth state
and the encrypted short-lived Spotify token cache. They are not encrypted
by gzip or file permissions. Keep them on protected storage, never in Git,
unencrypted GitHub artifacts, issues or screenshots. Optional CI/CD encrypts
its backup before storing an artifact; its private key stays local. The local
backup helper does not copy `.dev.vars`,
Wrangler login files, or retrieve Cloudflare's runtime secret values. Restoring
code/configuration still requires access to the account and valid credentials;
Spotify tokens can be obtained again with the authorization helper.

## Optional weekly automation from this computer

Examples for a free Linux user timer are in
[the service template](../ops/systemd/ferto-backup.service.example) and
[the timer template](../ops/systemd/ferto-backup.timer.example). They are
provided for activation; no timer is installed by running a manual backup.
Replace the absolute repository and Node executable paths, then install the
files as `~/.config/systemd/user/ferto-backup.service` and `ferto-backup.timer`:

```bash
systemctl --user daemon-reload
systemctl --user enable --now ferto-backup.timer
systemctl --user list-timers ferto-backup.timer
journalctl --user -u ferto-backup.service
```

The template runs Sunday at 20:00 Europe/Athens, with up to five minutes of
jitter. `Persistent=true` catches a missed run when the user timer next starts;
it cannot make a powered-off computer back up. Refresh the Node path when
changing installed runtimes and check for stale backups with `ops:status`.
For macOS or another scheduler, invoke the same command from this checkout.

## Recover intentionally

The scripts above never restore a remote database. A database restore discards
changes after the selected point; it does not undo Spotify library changes.
Use a planned maintenance window and inspect the target before proceeding.

### Freeze application writes

Record the current/previous Worker UUID and a fresh Time Travel bookmark in
private notes. Keep a verified export if the database is still readable. Then:

```bash
npx wrangler queues pause-delivery ferto-refresh --config wrangler.production.jsonc --env-file /dev/null
npm run recovery:prepare
# Use the generated PRIVATE configuration path printed by that command:
npx wrangler deploy --config .local/recovery/maintenance-<id>/wrangler.jsonc --env-file /dev/null
# Confirm the site returns 503; wait 16 minutes for old consumers/handlers.
```

Preparation only writes a private configuration; it deploys nothing. The
maintenance Worker returns 503 for every request, disables new cron triggers,
never uses D1 and retries any delivered Queue messages. The original instance
file stays unchanged. This is stronger than a Queue pause alone: pausing does
not stop owner HTTP requests, cron producers or already-running handlers.

Keep delivery paused throughout recovery. Free Queue messages expire after
24 hours even while paused; durable rebuild progress lives in D1 and the
normal watchdog can repair missed wakes after service is restored.

### Recent mistake: D1 Time Travel

Within the Free seven-day window, use the chosen bookmark:

```bash
npx wrangler d1 time-travel restore DB --bookmark <chosen-bookmark> --config wrangler.production.jsonc --env-file /dev/null
```

This overwrites the database in place and cancels in-flight queries. Record the
undo bookmark returned by Cloudflare before doing anything else. See
[Time Travel recovery](https://developers.cloudflare.com/d1/reference/time-travel/).
The bookmark saved before recovery is another reference point; a failed or
unwanted restore must be assessed before trying to undo it.

### Older loss: restore an exported SQL backup

Verify the backup locally, then create an **empty replacement database** in
the same account. Check the Free database-count/storage and daily-write
allowances before importing; a full restore can consume substantial writes.
Do not import a full schema on top of the existing live database.

```bash
npm run backup:verify -- --backup backups/ferto/<chosen-folder>
npx wrangler d1 create ferto-recovery-YYYYMMDD
# Privately copy the instance config; set DB's new database_name and database_id.
gunzip -c backups/ferto/<chosen-folder>/database.sql.gz > backups/recovery.sql
npx wrangler d1 execute DB --remote --config <private-replacement-config> --env-file /dev/null --file backups/recovery.sql
```

Use `umask 077` before creating the uncompressed file. Inspect migration/table
counts in the replacement and keep the old database until recovery is verified.
When ready, put its name and UUID in the ignored production configuration and
rebuild a compatible artifact. The helpers select D1 through the DB binding;
the Worker and Queue names stay `ferto` / `ferto-refresh`.

If CI/CD is configured, update the production `FERTO_INSTANCE_CONFIG` database
fields too before re-enabling it, so a later release cannot select the old database.

### Restore compatible application code

Check the restored migration ledger against the intended code. An old database
may need reviewed additive migrations before newer code can use it. Prepare a
clean verified production artifact for the selected target/revision. While
still in maintenance with delivery paused, use the explicit recovery sequence:

```bash
node scripts/check-release-artifact.mjs --production
npx wrangler deploy --no-bundle --config .release/wrangler.jsonc --env-file /dev/null
npm run release:smoke
npx wrangler queues resume-delivery ferto-refresh --config .release/wrangler.jsonc --env-file /dev/null
npm run ops:status
```

Verify the reported active Worker UUID too, then check owner sign-in and the
catalogue. If any check fails, keep delivery paused and use the saved version,
backup and private operation logs to investigate. No automatic database rollback
runs. A normal `deploy:local` deliberately refuses an already-paused queue; this
manual recovery sequence makes the maintenance transition explicit.

For credential incidents, rotate the affected provider/session credentials and
clear restored cached authentication state as part of the incident response.
Restoring old data alone does not revoke credentials. The remote destructive
restore/import procedures are documented, not exercised against the live app;
the completed automated rehearsal is an actual local restore of the exported data.
