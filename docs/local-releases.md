# Local releases and operational checks

Development, local backups and manual deployments work from this checkout.
Optional [GitHub CI/CD](ci-cd.md) deploys checked changes from `main` after
configuration/activation; it is disabled by default. Verification remains
credential-free. Before a manual deployment, disable future CI deployments
and let any active production job finish; do not run both paths concurrently.

## Prepare and inspect

Use the pinned Node/npm versions, install dependencies/scanner/browser as in
[development](development.md), commit the reviewed public changes, then:

```bash
FERTO_DEPLOY_CONFIG=wrangler.production.jsonc npm run release:prepare
npm run deploy:local -- --plan
```

The plan is offline: it checks a clean matching revision, Node version,
lockfile, exact artifact checksums, contained deployment paths and matching
private instance settings. It prints the target and ordered actions without
calling Cloudflare or changing the queue. A later edit or target change requires
rebuilding/revalidating; the helper checks again after its drain.

## Update an existing instance

```bash
npm run deploy:local
```

The helper uses the already verified `.release/`; it does not quietly build a
new or dirty revision. It:

1. Reads the active Worker, Queue pause state and migration ledger. It rejects
   already-paused delivery, an older/different schema or unreviewed migrations.
2. Takes and locally restores a full private backup, retaining all older copies.
3. Pauses delivery, confirms the pause and drains old consumers for 16 minutes.
   Keep this terminal/computer running; progress is printed every 30 seconds.
4. Revalidates the artifact/target and remote schema/version before deploying.
5. Deploys the exact Worker/assets, verifies the active Worker UUID at 100%,
   checks every static asset hash plus API authorization/security headers, then
   resumes and confirms delivery. Receipts/logs are private in `.local/releases/`.

Pending migrations are refused by default. Read their SQL and verify that old
and new HTTP/cron code can tolerate the transition before deliberately using:

```bash
npm run deploy:local -- --migrate
```

A Queue pause/drain is a consumer fence, not a universal database-write lock.
Incompatible changes require the [maintenance recovery procedure](backups-and-recovery.md#freeze-application-writes)
and a release-specific migration plan. Do not start owner mutations during an
upgrade. The conservative drain remains useful when changing a previous
consumer's work-queue routing; it does not replace application revision guards.
Cloudflare documents [Queue pausing](https://developers.cloudflare.com/queues/configuration/pause-purge/)
and [consumer limits](https://developers.cloudflare.com/queues/platform/limits/).

## A failed or interrupted release

A backup failure stops before pausing. Once pause has been attempted, a failure
requests that delivery remain paused; it never purges the queue, silently
resumes work or automatically restores D1. Run `npm run ops:status` to establish
the actual pause/version state, then inspect the newest private receipt/logs.
A local release lock prevents overlapping invocations. After a killed process,
inspect `.local/releases/.lock/owner.json` and ensure that process is gone before
removing the stale lock. Keep the terminal/computer available for releases.

Use the saved previous Worker UUID only after checking database compatibility:

```bash
npx wrangler rollback <previous-version-uuid> --config wrangler.production.jsonc --env-file /dev/null
```

A code rollback does not undo migrations or external Spotify changes. For a
compatible rollback, verify the matching old artifact/site before resuming the
queue. For an incompatible/corrupt database, follow the backup/recovery guide.
Once healthy and compatible, explicitly resume and check:

```bash
npx wrangler queues resume-delivery ferto-refresh --config wrangler.production.jsonc --env-file /dev/null
npm run ops:status
```

Do not leave a failed release paused unnoticed: Free Queue retention is 24 hours.
The durable job/watchdog recovers missed messages after resumption, but a pause
still prevents useful queued processing.

## Routine checks and credentials

```bash
npm run ops:status
npm run backup:list
npm run release:smoke -- --artifact /path/to/the/deployed/release/.release
```

Status reports active Worker UUID, D1 size against the assumed Free limit,
Queue pause state, catalogue/job progress and latest default local backup. It
also queries account-wide D1 reads/writes for the current UTC day and prints the
next UTC reset. At 80% of either Free daily allowance it warns; database size
and rolling 24-hour totals do not establish daily headroom. Analytics can lag.
It returns a nonzero status for paused delivery, failed/overdue work, old/missing
backups, storage above 75%, daily reads/writes at or above 80%, or unavailable
daily analytics. A planned Spotify retry is taken into account so
quota waiting is not mistaken for a stalled job. Daily analytics access requires
Account Analytics Read (already included in the CI deployment-token setup).
Reports are private under
`.local/operations/`. It uses standard Wrangler OAuth login, or an explicitly
scoped API token/account supplied by the operator. Multiple accounts require
`CLOUDFLARE_ACCOUNT_ID`; no authentication values are printed.

Check status weekly with backups, after each release and whenever a refresh
appears stuck. The owner panel shows refresh history and observed provider
errors. For sustained errors, inspect the Cloudflare dashboard or use local
`wrangler tail` during investigation. No paid external monitoring is required
or automatically configured.

The owner manages the Spotify service authorization. Re-run
`npm run spotify:authorize -- --production` before its six-month expiry or
after `invalid_grant`, and record the authorization date privately. Browser
owner sign-in is a separate identity-only flow and does not renew that service
token. A fresh service authorization uses the same explicit production target
and scopes described in [self-hosting](self-hosting.md).
Changing `SESSION_SECRET` logs out existing owner sessions; generate/store it
with Wrangler rather than committing it. Backups do not retrieve its value.

For Free-tier planning, D1 documents 5 million rows read and 100,000 rows
written per day (plus account storage limits), and Queues includes 10,000
operations/day. These are account-level allowances; do not treat a single
DB's rolling 24-hour metrics as the current UTC-day account allowance. See
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).
