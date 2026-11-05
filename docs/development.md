# Development, demo and verification

Use Node 24.22.2 and npm 11.19.1 from [.nvmrc](../.nvmrc). With nvm installed,
run `nvm install` and `nvm use` before `npm ci`. No instance credentials are
needed for the demo, tests or default build. See [contributing](../CONTRIBUTING.md)
for change and pull-request guidance. Commands target Linux/macOS or a Linux
shell under WSL.

## Instant local demo

To see the complete Worker, D1-backed API, built frontend, artwork, and Spotify
embeds immediately:

```bash
npm ci
npm run demo
```

Open <http://127.0.0.1:8787>. The command builds the app, migrates a dedicated
local D1 database, resets it to three real public Spotify recordings, and serves
the production assets through the Worker. It needs no Spotify credentials and
does not contact Spotify's API. Owner-only actions remain unavailable, while
public Next and playback through Spotify's embed work normally.

The interface opens in dark mode and remembers the light/dark preference.
Artwork supplies the surrounding ambient colour and control palette as songs
change; Spotify's embedded player keeps its own appearance. Colour extraction
runs in the browser and caches up to 64 artwork colours locally, without extra
Spotify API requests or database writes. Missing artwork or blocked pixel
access falls back to a neutral palette.

The demo is deliberately isolated at `.wrangler/demo-state`. It never opens the
normal `.wrangler/state` database and every D1 command includes both `--local`
and `--persist-to .wrangler/demo-state`, so it cannot touch remote D1. Re-running
`npm run demo` resets only that demo catalogue. Stop it with Ctrl-C.

The demo supplies a fixed public `demo-only` session-key setting so local
request hashing works without instance credentials. It keeps the placeholder
Spotify settings and has no owner sessions. Real instances use their own
random session secret through the [self-hosting setup](self-hosting.md).
If port 8787 is busy, use `FERTO_DEMO_PORT=8788 npm run demo`; the listener and
local origin change together.

## Local refresh simulator

Run the production refresh state machine against a synthetic Spotify API and
an isolated SQLite database, with virtual quota resets and Queue deliveries:

```bash
npm run simulate -- --scenario chaos
npm run simulate -- --scenario soak   # 1,600 artists
npm run simulate -- --scenario warm   # compare two refreshes
```

Requires the supported Node 24 toolchain above. Reports go to `simulation-results/`. Quotas are explicit
simulation inputs, not measured Spotify limits. The runner checks the exact
expected catalogue, permanent exclusions, cache reuse, progress accounting,
resource budgets, and recovery from injected crashes and provider failures.
See [simulation/README.md](../simulation/README.md) for configuration, reports and
model limitations. It uses synthetic credentials and does not access live
Spotify/Cloudflare or `.wrangler` state.

## Browser checks and releases

Full operational verification also needs GnuPG (`gpg`) and `tar` for real
encrypted-backup recovery checks. Install GnuPG with your OS package manager
if needed. These tools do not connect to Cloudflare or require credentials in tests.

```bash
nvm install
npm ci
npm run secrets:install
npx playwright install --with-deps chromium
npm run verify
```

`verify` checks server, browser and browser-test TypeScript projects, runs the
Worker, simulator and operational tests, builds assets, runs desktop/mobile Chromium checks
against an isolated migrated local Worker, and dry-runs the deployment.
Browser checks block external Spotify/artwork traffic and use synthetic owner
responses for authenticated UI scenarios. They also exercise real public API
and unauthorized owner requests. No live credentials or databases are used.

Verification also runs `npm run test:demo` against the actual demo command in
a temporary folder, with no env file or provider credentials. It migrates and
seeds isolated D1 state, checks recommendations and Next, and verifies that
owner access remains unavailable. Run `npm run build` first when invoking this
demo check on its own. It never resets your regular demo database.

`release:prepare` runs verification and creates `.release/`: bundled Worker,
assets, migrations, MIT license, third-party notices, deploy configuration and a SHA-256 manifest tied to the
Git revision, Node version and dependency lockfile. Dirty local checkouts may
be packaged for inspection, but deployment rejects dirty manifests. GitHub
[checks](../.github/workflows/checks.yml) builds this artifact on pushes and PRs.
The manual [reviewed release workflow](../.github/workflows/release.yml) reuses
the same verification. An optional separate production job deploys from `main`
only after [CI/CD setup and activation](ci-cd.md), including encrypted backups;
verification itself receives no production credentials. The
[local release procedure](local-releases.md) remains available as a fallback.

A local production package uses
`FERTO_DEPLOY_CONFIG=wrangler.production.jsonc npm run release:prepare`.
An unset `FERTO_DEPLOY_CONFIG` packages the generic template for checks; the
production artifact checker rejects that template before any delivery pause.

Both workflows scan Git history and the exact release artifact with a pinned,
checksum-verified Gitleaks version. See [publication safeguards](security-checks.md)
for local checks and their limits.

See [development dependencies](dependencies.md) for the supported runtime,
Cloudflare test-plugin migration, audit checks and dependency-update procedure.

See [refresh engine measurements](refresh-engine.md) for cache policy,
coverage benchmarks, early-publication assessment and operational metrics.

## Checks

```bash
npm test
npm run test:simulator
npm run typecheck
npm run build
npm run worker:check
```

## Flow diagrams

Sequence diagrams for every flow described above live in
[docs/flows/README.md](flows/README.md).

## Stack

- Vite frontend
- Cloudflare Worker API
- Cloudflare D1 database and Queue
- Spotify Web API (no Web Playback SDK)
