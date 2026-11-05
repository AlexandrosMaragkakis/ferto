# GitHub checks and deployment

Keep developing in your local checkout. Once configured, the normal flow is:

**local branch → push / pull request → checks → merge into `main` → backup → deployment → live checks.**

Production deployment is **disabled by default**. Publishing or forking the
repository does not connect a Cloudflare account. Local development, backups
and [manual deployment](local-releases.md) remain available.

## What runs

[Verify and deploy](../.github/workflows/checks.yml) runs on pushes and pull
requests. Its Verify job has read-only repository access and no production
environment or Cloudflare credentials. It checks secrets/history, dependencies,
TypeScript, application/simulator/operational/browser tests and the real demo,
then packages a generic artifact. Generic artifacts and browser failure output
expire after three days.

The separate production job runs only after verification succeeds, for a push
to `main` in the explicitly configured repository with deployment enabled.
It uses the production environment and receives the Cloudflare token only in
the backup and deployment steps. PRs, forks and other branches cannot deploy.
The [Reviewed release](../.github/workflows/release.yml) workflow reuses the
same checks and safeguards for a manual release; select `main`.

Production jobs share one concurrency group and do not cancel a release in
progress. GitHub may replace/reorder pending jobs, so the helper rejects a run
whose revision is no longer the current `main` before starting a new deployment.
A merge during an already-started pause/drain does not interrupt that release;
a subsequent eligible run updates it afterward. See
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## One-time setup

Use the repository's Node version, GnuPG (`gpg`) and `tar`. Create a dedicated
local backup key before enabling deployment:

```bash
npm run backup:keys
```

This creates an ignored owner-only `.local/backup-key/` keyring, its public
`recipient.asc` and `recovery-private-key.asc`. Repeating the command preserves
the existing key. The private key/export is unencrypted locally and protected
by filesystem permissions; keep an additional protected copy on another
existing device/encrypted drive. GitHub receives **only the public key**.
Losing the private key makes encrypted CI backups unrecoverable.

Configure these **repository variables**:

| Variable | Value |
| --- | --- |
| `FERTO_DEPLOY_REPOSITORY` | Exact `owner/repository` that may deploy |
| `FERTO_CD_ENABLED` | `false` until setup is verified, then `true` |

Create a `production` GitHub environment, restricted to `main`, with these
**environment secrets**:

| Secret | Contents |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Dedicated token scoped to the intended account and required Worker/D1/Queue operations |
| `FERTO_INSTANCE_CONFIG` | JSON with exactly `accountId`, `databaseId`, `databaseName`, `spotifyClientId`, `ownerSpotifyId`, `origin` |
| `FERTO_BACKUP_PUBLIC_KEY` | Contents of the local public `recipient.asc` |

Use the actual existing instance identifiers. Never add `SESSION_SECRET`,
Spotify refresh credentials or a private decryption key to that JSON. Spotify
runtime secrets stay on Cloudflare. Configure required verification checks for
merges into `main`; do not require another reviewer's approval for a one-person
project. Keep the initial push separate from enabling deployment.

Cloudflare explains authentication in its
[GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
Use [GitHub environment secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets),
never workflow YAML or command arguments, for credentials. Check the target and
recover a test encrypted backup locally before changing `FERTO_CD_ENABLED` to `true`.

## Backup before deployment

The job downloads the exact generic artifact produced by Verify. After checking
its clean revision, lockfile, Node version and hashes, it replaces only the
instance configuration and the four canonical/social URL references in the
homepage. It records the prior hashes and verifies the targeted artifact again.
Worker JavaScript, other assets and migration SQL are reused without rebuilding.
The targeted configuration/artifact is not uploaded as a public build artifact.

Before pausing the Queue, the job exports D1, restores/checks it locally and
encrypts the SQL archive, manifest and instance settings with GnuPG. It uploads
only `backup.gpg`, downloads the saved artifact and checks its exact hash/size.
An upload/download/check failure stops before a new delivery pause or deployment.
The deploy helper re-verifies SQL and checks that the backup matches the current
instance, Worker and clean revision, with a maximum age of one hour.

The artifact is named `ferto-backup-<run-id>-<attempt>` and expires after
**14 days**. It is encrypted because public-repository artifacts can be
downloaded by readers. The runner disk disappears after the job and does
not count as retained backup storage. Download copies locally after releases
or during your weekly maintenance:

```bash
npm run backup:fetch -- --run <workflow-run-id>
# With an explicit repository:
npm run backup:fetch -- --run <workflow-run-id> --repo owner/repository
# Or decrypt an already downloaded ciphertext:
npm run backup:restore -- --file /path/to/backup.gpg
```

The fetch helper uses your GitHub CLI login, selects the latest retained backup
attempt, decrypts with the local key, rejects unexpected archive members, and
restores/verifies SQL before completing a new ignored `backups/ferto/` folder.
It never overwrites/deletes older backups. Keep the existing weekly/local
retention policy: at least 12 successful copies plus pre-migration milestones.
CI artifact expiry is separate from local retention. No new paid storage is
provisioned; monitor GitHub storage allowances if usage grows.

## Deployment, migrations and failures

After a saved backup is confirmed, deployment uses the same Queue pause,
16-minute drain, artifact/schema/Worker revalidation, exact deployment, live
asset/header/authorization checks and confirmed resume as the local helper.
The website normally keeps serving during a routine release. A Queue fence is
not a database-write lock; avoid simultaneous owner mutations during upgrades.

Pending migrations stop ordinary automatic deployment before a new pause.
Review compatibility and use **Actions → Reviewed release → Run workflow**
on `main`, with `apply_migrations` selected for compatible changes.
Incompatible changes need the [maintenance recovery procedure](backups-and-recovery.md#freeze-application-writes)
and a specific migration plan. Code rollback does not reverse SQL or Spotify changes.

Failures after a pause request keep delivery paused for investigation. A killed
or timed-out job can also leave it paused; cancellation is not automatic recovery.
Check the failed step and run `npm run ops:status` locally. When available, the job
saves encrypted private receipts/logs, including failed-export diagnostics,
as `ferto-operations-<run-id>-<attempt>`,
also with 14-day retention. To inspect that artifact locally:

```bash
umask 077
gpg --homedir .local/backup-key --output .local/operations.tar --decrypt /path/to/operations.gpg
tar --list --file .local/operations.tar
```

Inspect/extract only in a private local recovery directory. Raw Wrangler/export
logs are not printed or uploaded as public artifacts. Keep the Queue paused
until code/schema compatibility and live checks are established, then follow
the [explicit recovery/resume instructions](local-releases.md#a-failed-or-interrupted-release).
Remote destructive database recovery is never automatic.

Do not overlap a local deployment with a CI deployment. Before local emergency
work, disable future CI deployment (`FERTO_CD_ENABLED=false`) and let any active
production job finish, then inspect version/Queue state. GitHub concurrency and
the local filesystem lock do not provide a distributed lock between computers.
Restore the flag after recovery is complete. Cloudflare token rotation and
Spotify service reauthorization remain separate owner tasks.
