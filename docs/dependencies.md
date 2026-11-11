# Development toolchain

FERTO uses Node 24 LTS. Run `nvm install` or, when already installed, `nvm use`
from this checkout before installing dependencies or preparing a release.
The checked-in `.nvmrc` selects Node 24.22.2, which includes npm 11.19.1.
`package.json` records the supported Node/npm ranges and package manager.

The toolchain reviewed on 11 November 2026 is:

| Component | Locked version |
| --- | --- |
| Node / npm | 24.22.2 / 11.19.1 |
| Vite | 8.3.6 |
| Vitest | 5.1.0 |
| Cloudflare Vitest plugin | 1.6.0 |
| Wrangler | 4.158.0 |
| Workers types | 5.20261107.1 |
| Node types | 24.19.2 |
| TypeScript | 7.0.2 |
| Playwright | 1.65.0 |

Cloudflare renamed the old `@cloudflare/vitest-pool-workers` package to
`@cloudflare/vitest-plugin` and deprecated the old package. The Vite import and
TypeScript test declarations use the maintained replacement. It supplies the
current compatible Miniflare/Workerd stack without dependency overrides.
See the [Cloudflare testing documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/).

The old global `sharp: 0.35.4` override has been removed. The resolved tree uses
sharp 0.35.5, undici 7.30.1, source-map-js 1.2.2 and Zod 4.6.6. These address
the advisories found in the earlier tree. There are no overrides or accepted
advisory exceptions in this snapshot. Node was also advanced within its LTS
major to include the intervening security fixes. See the [Node release notes](https://nodejs.org/en/blog/release/v24.22.2).

## Updating and checking

Use the committed lockfile for normal installs:

```bash
nvm install
npm ci
npm run audit:dependencies
npm run secrets:install
npm run release:prepare
```

For a deliberate update, review upstream peer dependencies, package renames
and migration notes before changing the manifest. Keep the Cloudflare plugin,
Wrangler, Workers types, Vite and Vitest compatible. Review the lockfile diff,
including native platform packages, registry sources and integrity hashes.
Regenerate Worker types after changing Wrangler, then run verification from a
fresh checkout with no instance configuration or production credentials.

`npm run audit:dependencies` checks the entire dependency tree, including
development tooling, and fails on moderate-or-higher reported advisories.
Both verification/candidate workflows run it after `npm ci`, without
production credentials. A new finding needs a
reviewed fix or a specific documented assessment; avoid blanket audit bypasses
and unreviewed `npm audit fix --force` changes.

The reviewed tree reports zero npm advisories. FERTO has no declared production
npm dependencies; its build/test/development tools still run code on developer
machines and in CI. A clean npm audit is a snapshot of reported advisories,
not a guarantee about every dependency or platform vulnerability.

## Update proposals

[Dependabot configuration](../.github/dependabot.yml) requests npm version
updates weekly on Monday at 09:00 Europe/Athens and GitHub Actions updates
monthly. Npm minor/patch changes are grouped so the compatible toolchain can
be reviewed together; major changes remain separate. Open proposals are capped
at five for npm and three for Actions. See GitHub's
[options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Major `@types/node` proposals are ignored so declarations stay aligned with the
supported Node 24 runtime. Review that rule alongside `.nvmrc` and `engines`
when deliberately upgrading Node; minor/patch declaration updates continue.

These are proposals for review, with no automatic merge or deployment. The
ordinary check workflow runs without Cloudflare credentials. Confirm the
repository's Dependabot alerts/security-update settings when it is created;
checking in this file does not establish that those settings are active.

Review Node/npm support and update `.nvmrc`, `engines` and `packageManager`
together when needed. The pinned Gitleaks version and archive checksums in
the scanner installer also need deliberate review; Dependabot does not update
those strings. Keep action references pinned to full commit SHAs.
