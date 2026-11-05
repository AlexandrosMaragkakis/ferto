# Contributing

FERTO is a small personal project built around one Spotify owner and public
discovery. Keep changes focused. Discuss larger changes, especially the
account model or discovery rules, in an issue before doing substantial work.

## Work locally

Use the Node/npm versions in [.nvmrc](.nvmrc) and [package.json](package.json).
Start with the credential-free demo:

```bash
npm ci
npm run demo
```

See [development](docs/development.md) for isolation details, the simulator,
browser checks and packaging. Use synthetic recordings/accounts for tests;
live Spotify or Cloudflare credentials are not required for verification.

For code changes, install the pinned scanner and browser, then verify:

```bash
npm run secrets:install
npx playwright install --with-deps chromium
npm run verify
npm run check:secrets
```

Add or update tests for behavior changes. For documentation-only changes,
check links and command examples and run the affected documentation checks.
Keep the existing TypeScript style, artwork-driven colours and accessible
controls. Review [dependency guidance](docs/dependencies.md) before updating
the toolchain or lockfile.

## Send a change

Describe the problem, the resulting behavior and the checks you ran. Include a
before/after image for visible UI changes, using fictional data or artwork you
have permission to share. Keep credentials, personal library data, database
exports, private instance configuration and generated test/release output out
of the commit. [Publication checks](docs/security-checks.md) explain the scanner
and its limits.

Report suspected vulnerabilities through [SECURITY.md](SECURITY.md). For normal
bugs, include the browser, steps to reproduce and a redacted error message.

Contributions of original code, documentation and FERTO assets are accepted
under the [MIT License](LICENSE). Record the source and terms of any third-party
material in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
