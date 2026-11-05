# Instance configuration

The checked-in `wrangler.jsonc` is a reusable template. Its all-zero D1 ID and
Spotify placeholders are intentional. No running instance's credentials are
needed to build, test or try the app.

| Mode | Configuration | Credentials and data |
| --- | --- | --- |
| Demo (`npm run demo`) | Public template | Synthetic catalogue, no env file, isolated `.wrangler/demo-state` |
| Local Spotify (`npm run dev:worker`) | `FERTO_DEPLOY_CONFIG`, otherwise private instance file if present, otherwise public template | Ignored `.dev.vars`, local D1 only |
| Checks / default release package | Public template | Synthetic test settings; packaging ignores `.dev.vars` |
| Production | Explicit ignored instance configuration | Cloudflare Worker secrets and remote D1 |

`npm run db:migrate:local` selects the same configuration as `dev:worker`.
An existing private configuration preserves its D1 storage identity. A fresh
checkout can use the public template with local `.dev.vars` overrides. The
Vite frontend remains at port 5173; its API proxy targets the local Worker.

Create production resources and copy their non-secret settings into the
environment for `npm run config:production`, as shown in the [self-hosting guide](self-hosting.md#deploying).
The command validates the origin and D1 ID and creates `wrangler.production.jsonc`
with mode 0600. It refuses to overwrite an existing file. Edit that ignored file
when settings change; keep application/binding changes in the public template
and apply corresponding changes to your private file.
The generated files use strict JSON despite the `.jsonc` extension; retain
that format when editing settings so packaging and validation can read them.

The default resources are Worker/D1 `ferto` and Queue `ferto-refresh`.
Worker and Queue names stay fixed in the operational helpers. D1 is selected
through the `DB` binding, so recovery can intentionally use a replacement
`database_name` and UUID without renaming the Worker/Queue. Keep those settings
in the ignored instance file; generic checks/demo continue using the template.

Use `--config wrangler.production.jsonc` for remote Wrangler commands. The
Spotify service-token helper's `--production` mode defaults to that file,
accepts `--config <path>` or `FERTO_DEPLOY_CONFIG`, and checks that its client
and owner match the local authorization settings before opening a browser.
It pipes the token through stdin; credentials never belong in command arguments.

Set `FERTO_DEPLOY_CONFIG=wrangler.production.jsonc` when preparing a production
release. This selection is explicit: default packaging uses the public template
even when a private file exists. `check-release-artifact.mjs --production`
rejects placeholder configuration before any delivery pause or deployment.

The Vite build uses the same selection for the page's canonical URL and absolute
social-preview image URL. Set `FERTO_DEPLOY_CONFIG` for `npm run build` too when
building assets for your instance. Only `APP_ORIGIN` enters this metadata;
credentials are never needed. Rebuild the assets if the public origin changes.

GitHub verification packages the generic template without production settings
or Cloudflare credentials. Optional [CI/CD](ci-cd.md), disabled by default, adds
a separate production job with a scoped token, private instance settings and
an encryption public key in the GitHub production environment. Runtime
`SESSION_SECRET` and `SPOTIFY_REFRESH_TOKEN` stay directly in Cloudflare; local
authorization files, backup private keys and exports remain ignored.

See Cloudflare's references for [configuration and local variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
and [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).

## Local development and releases after publishing the code

Keep using the same local checkout for development and instance updates after
adding a GitHub remote. Commits and pushes publish source changes. After CI/CD
activation, merging into `main` also triggers a checked production deployment;
other branches and PRs run verification only. Manual local deployment remains available.

Run `npm run dev:worker` and `npm run dev` in separate terminals for local
development. Keep `.dev.vars`, `wrangler.production.jsonc` and `.wrangler` data
locally; they remain outside Git. Your existing instance settings select the
same Cloudflare resources when you prepare a production update:

```bash
FERTO_DEPLOY_CONFIG=wrangler.production.jsonc npm run release:prepare
```

Use a clean committed revision for the final artifact, then follow the
[safe upgrade procedure](self-hosting.md#safe-upgrades-after-the-first-deployment)
for queue draining, reviewed migrations and deployment with `npm run deploy:local`. Publishing the source does not
require moving deployments to GitHub Actions or creating a new instance.

See [backups and recovery](backups-and-recovery.md) for private exports, local verification, replacement-database recovery and the optional weekly timer.
