# Self-hosting FERTO

Set up one Spotify owner and run locally or deploy your own Cloudflare instance.
Run the commands below from the repository root.
For a credential-free preview, start with the [local demo](../README.md#try-it-locally).

## What you need for your Spotify library

- Node.js 24.22.2 (see `.nvmrc`) and npm 11.19.1
- A Spotify app (dashboard → create app) for the client id.
  Spotify Development Mode requires the app owner to have Spotify Premium.
- A Cloudflare account for the Worker, D1, and Queue (local development needs
  none of this beyond wrangler's local mode)

## Real first-time setup

```bash
npm ci
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Fill in `.dev.vars`:

| Variable | Meaning |
| --- | --- |
| `SPOTIFY_CLIENT_ID` | Your Spotify app's client id |
| `OWNER_SPOTIFY_ID` | Spotify's immutable `account_id` from `GET /me` (not the mutable profile `id`) |
| `APP_ORIGIN` | `http://127.0.0.1:5173` locally |
| `SPOTIFY_REFRESH_TOKEN` | The service token — generate it with the helper below |
| `SESSION_SECRET` | At least 32 random characters |

There is no Spotify client secret: both authorization flows use PKCE with the
public client id. Custom playback was removed, so there is no playback secret
either.

## Spotify setup

In your Spotify app settings, add both redirect URIs:

```text
http://127.0.0.1:5173/api/owner/callback   # browser identity sign-in
http://127.0.0.1:8931/callback             # service-token helper (loopback)
```

(The helper port changes if you pass `--port`; register whatever you use.)

### The two tokens — and why they are different

**Service token** — used only by the Worker backend for the weekly catalogue
rebuild and Like saves. It is obtained locally with a PKCE loopback flow and
exactly these scopes:

- `user-library-read`
- `user-library-modify`
- `playlist-read-private`
- `playlist-read-collaborative`
- `user-read-private`

Generate and store it with the helper:

```bash
npm run spotify:authorize -- --local        # rewrite SPOTIFY_REFRESH_TOKEN in .dev.vars
npm run spotify:authorize -- --production   # pipe it to npx wrangler secret put SPOTIFY_REFRESH_TOKEN
```

The helper:

- generates the PKCE verifier/challenge and state securely,
- receives the OAuth callback on a loopback `127.0.0.1` server,
- validates state and rejects mismatches, replays, and provider errors,
- exchanges the code **without a client secret**,
- fetches and shows the authenticated Spotify account's immutable `account_id`,
  and refuses to store anything unless it matches `OWNER_SPOTIFY_ID`,
- `--local` rewrites only the `SPOTIFY_REFRESH_TOKEN` entry in the ignored
  `.dev.vars` (other entries preserved, mode `0600`, atomic write),
- `--production` spawns `npx wrangler secret put SPOTIFY_REFRESH_TOKEN` with
  an argv array — no shell — and pipes the token through the child's stdin,
- never prints the refresh token, never writes the browser identity token,
  and never requests playback scopes.

If you do not know the immutable id yet, leave `OWNER_SPOTIFY_ID` blank and run
the helper once. It will show the authenticated `account_id` and store nothing.
Put that value in `.dev.vars` (and later `wrangler.production.jsonc`) and rerun. Spotify
distinguishes this stable account-linking value from the mutable user `id`;
FERTO retains the latter only inside an active rebuild to recognize playlists
owned by the service-token user. Spotify documents the distinction in the
[current-profile reference](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile).

Run `npm run spotify:authorize -- --help` for all options.

Spotify refresh tokens issued to Developer Dashboard apps expire six months
after authorization. Refreshing an access token does not extend that deadline.
Before expiry—or after Spotify returns `invalid_grant`—run the helper again and
replace the local or production `SPOTIFY_REFRESH_TOKEN`. Successful
reauthorization starts a new six-month lifetime. See Spotify's
[refresh-token documentation](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens)
and [Development Mode limits](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

**Browser identity sign-in** — the owner signs into the site in the browser
with an identity-only authorization (`user-read-private`, PKCE). The Worker
exchanges the code with the one-time PKCE verifier and the public client id;
the short-lived access token is then used inside the Worker callback solely to
verify the profile's immutable `account_id` is `OWNER_SPOTIFY_ID`. The browser receives only a FERTO
session cookie and never holds any Spotify credential. The service token above
is a separate token the browser flow never sees.

Keep `.dev.vars` local; it is ignored by Git.

See [application security](application-security.md) for browser-bound
sign-in, request limits, network deadlines and the required migration `0022`.

## Run locally with your Spotify library

```bash
npm run db:migrate:local   # apply D1 migrations to the local database
npm run build
npm run dev:worker         # terminal 1: the Worker API on 127.0.0.1:8787
npm run dev                # terminal 2: the web app on 127.0.0.1:5173
```

`npm run dev:worker` applies pending local D1 migrations automatically before
starting Wrangler. The explicit migration command remains useful when you want
to update the local database without starting the Worker.

Open <http://127.0.0.1:5173>. Visitors can draw recommendations immediately
once a shelf exists; the owner gets Like/Never buttons and a rebuild status
panel after signing in. The owner can start an idle rebuild or restart a failed
one immediately with `POST /api/owner/refresh` from that panel; an active
rebuild remains single-instance.

## Deploying

**Build and test commands do not deploy.** Optional [GitHub CI/CD](ci-cd.md)
adds a separate production job after verification, disabled until configured.
`npm run worker:check` is a `wrangler deploy --dry-run` validation only.
The following first-instance setup steps are manual operator actions; none
are run by tests or the demo.

1. Authenticate Wrangler and provision the named resources:

   ```bash
   npx wrangler login
   npx wrangler d1 create ferto
   npx wrangler queues create ferto-refresh
   ```

   Keep the returned D1 `database_id` for the next step. The checked-in
   `wrangler.jsonc` is a credential-free template; instance settings go in the
   ignored `wrangler.production.jsonc`.

2. Create an instance configuration from these non-secret settings:

   - `SPOTIFY_CLIENT_ID` — the Spotify app client id;
   - `OWNER_SPOTIFY_ID` — the single privileged Spotify immutable `account_id`;
   - `APP_ORIGIN` — the exact HTTPS Worker origin, normally
     `https://ferto.<your-workers-subdomain>.workers.dev`.

   ```bash
   FERTO_DATABASE_ID=your-d1-uuid \
   SPOTIFY_CLIENT_ID=your-client-id \
   OWNER_SPOTIFY_ID=your-account-id \
   APP_ORIGIN=https://ferto.your-subdomain.workers.dev \
   npm run config:production
   ```

   This refuses to overwrite an existing instance file. Keep the Worker name
   `ferto` and Queue name `ferto-refresh`. The default D1 name is `ferto`;
   recovery may deliberately replace the `DB` binding's name and UUID. See [configuration](configuration.md).

   Add `${APP_ORIGIN}/api/owner/callback` to the Spotify app's redirect URIs.
   Keep the loopback helper redirect as well.

3. Apply the schema, build, and make the initial deployment:

   ```bash
   npx wrangler d1 migrations apply ferto --remote --config wrangler.production.jsonc
   FERTO_DEPLOY_CONFIG=wrangler.production.jsonc npm run build
   npm run worker:check
   npx wrangler deploy --config wrangler.production.jsonc
   ```

4. Store both Worker secrets. Generate `SESSION_SECRET` with at least 32
   cryptographically random characters; never put either value in
   `wrangler.jsonc` or Git.

   ```bash
   npx wrangler secret put SESSION_SECRET --config wrangler.production.jsonc
   npm run spotify:authorize -- --production
   ```

   The helper's production mode securely supplies `SPOTIFY_REFRESH_TOKEN` to
   `wrangler secret put` over child stdin. Re-run the final command whenever the
   six-month Spotify refresh token is approaching expiry.

5. Deploy with `--config wrangler.production.jsonc` after changing instance
   settings. Runtime secrets stay in Cloudflare; do not add them to repository
   files. Optional GitHub deployment uses a separately scoped production token;
   it does not need the Spotify runtime credentials in GitHub.
   After the first setup, use the [local release helper](local-releases.md),
   including its backup and migration review, for subsequent updates.

### Safe upgrades after the first deployment

Use the [local release helper](local-releases.md) for verified updates and
[backups/recovery](backups-and-recovery.md) for the Free-tier policy. The manual
sequence below explains the underlying Queue fence; take a verified backup
before running its mutation steps. It is not a complete database-write lock.

D1 migrations that reroute an active rebuild must not race an invocation of the
previous Queue consumer. Pausing delivery prevents new deliveries but does not
cancel one already in flight. For an existing production instance, validate the
build first, then use this maintenance sequence:

```bash
FERTO_DEPLOY_CONFIG=wrangler.production.jsonc npm run release:prepare
node scripts/check-release-artifact.mjs --production
npm run backup

npx wrangler queues pause-delivery ferto-refresh --config .release/wrangler.jsonc --env-file /dev/null
npm run ops:status -- --config .release/wrangler.jsonc
# Confirm delivery is PAUSED, then wait 16 minutes. Status exits 1 for a pause.
# Recheck the artifact, active version and reviewed migration compatibility.
node scripts/check-release-artifact.mjs --production
npx wrangler d1 migrations apply DB --remote --config .release/wrangler.jsonc --env-file /dev/null
npx wrangler deploy --no-bundle --config .release/wrangler.jsonc --env-file /dev/null
npm run release:smoke
npx wrangler queues resume-delivery ferto-refresh --config .release/wrangler.jsonc --env-file /dev/null
npm run ops:status
```

Cloudflare currently limits Queue consumers on Free and Paid plans to 15
minutes of wall-clock execution, including network waits, so the 16-minute
drain is a conservative fence for an invocation that started just before the
pause. Keep producers running: messages remain stored while delivery is paused.
If either migration or deployment fails, leave delivery paused, repair the
failure, and resume only after the new Worker is healthy. Do not purge the
queue. See Cloudflare's documentation for [pausing Queue
delivery](https://developers.cloudflare.com/queues/configuration/pause-purge/),
[Queue consumer limits](https://developers.cloudflare.com/queues/platform/limits/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

The Worker also revision-guards every bootstrap publication, incremental live
pool append, final promotion, and systemic failure transaction. This is the
runtime backstop for a job replaced between its Spotify read and D1 write; the
pause-and-drain sequence remains necessary when upgrading from older code that
does not yet contain those guards.

## Migrations (including v3 → v4)

Apply migrations locally with `npm run db:migrate:local` (operators use
`wrangler d1 migrations apply ferto --remote --config wrangler.production.jsonc`). The v4 migration
(`0009_v4_recordings.sql`) is safe to run on a live v3 database:

- existing live candidates are preserved and keep serving as a retained
  `legacy-live` generation keyed by their exact Spotify ids,
- every existing Never-again exclusion is preserved as a recording-wide
  `never_recordings` row,
- an in-flight v3 refresh job and its staging rows are discarded — the next
  weekly rebuild replaces them with a fresh v4 generation,
- the public shelf never goes empty during the migration.

The follow-up `0010_account_identity_and_recommendation_slots.sql` switches
sessions to Spotify's immutable `account_id`, invalidates old mutable-id
sessions/jobs safely, and backfills dense recommendation slots for the current
live shelf. Those slots keep every public draw to a constant number of D1 row
reads instead of scanning the catalogue, which is important on D1 Free.

`0011_atomic_recommendation_pool_mutations.sql` serializes slot appends and
compaction inside D1 transactions. Concurrent Like, Never, and lazy stale-row
cleanup cannot double-decrement counters or leave holes, and bootstrap growth
uses exact insert deltas instead of repeatedly counting the growing catalogue.

`0012_legacy_never_identity.sql` indexes exact-id exclusions, learns canonical
ISRC aliases for legacy Never rows whenever that identity is available, and
rematerializes the current dense shelf. A v3 Never decision therefore remains
permanent when v4 upgrades the same track from `spotify:<id>` to `isrc:<ISRC>`.

`0013_never_identity_checks.sql` adds a bounded pre-discovery phase required by
Spotify's 2026 Development Mode shape, where `linked_from` is no longer
returned. FERTO directly looks up each unresolved exact Never id, connects the
requested id to the returned ISRC even when Spotify substitutes another
market-playable id, and retries unresolved 403/404/no-ISRC rows on later weekly
rebuilds. Any rebuild already active during the upgrade is safely rerouted
through this phase before discovery resumes.

`0014_restart_rerouted_rebuild.sql` safely restarts the private work queues of
an in-flight job rerouted by `0013`, preventing a previously catalogued seed
from stranding its remaining release/enrichment work. Already staged recording
rows and any live bootstrap shelf remain intact.

`0015_preserve_preflight_gate.sql` keeps any job that had not yet verified its
Spotify scopes/account behind preflight during that restart; only jobs with a
durable verified owner id proceed directly to Never identity resolution.

`0016_resumable_quota_and_track_cache.sql` adds durable wait reasons and a
bounded track metadata cache, keyed by owner account, market, and requested
Spotify id. It preserves existing jobs, cursors, exclusions, and live slots.
After deployment, an owner refresh or the weekly tick resumes a quota-failed
or exhausted 5xx/network job left by the previous version without deleting its
staging or work queues; permanent failures still start a fresh generation.
The cache retains the requested id through market relinking and never extends expiry on a hit.
Expired entries are removed when a fresh rebuild starts.

`0017_incremental_discovery.sql` adds encrypted service-token reuse, exact-id
known-track mappings, versioned playlist exclusions, cached album discovery
pages, and adaptive pacing. It preserves an active rebuild's generation,
cursors, leases, cooldowns, staging, and live shelf. Existing playlist queue
rows without snapshot metadata finish normally; snapshot reuse becomes
available after a complete scan under the new code.

`0021_progressive_artist_publication.sql` adds a bounded artist working set and
a publication ledger. It preserves active cursors, retry deadlines, exclusions
and live slots. Completed artists can append new eligible recordings to the
existing shelf while the rest of the rebuild continues; the ledger preserves
the original similarity baseline and final discovery counts.
