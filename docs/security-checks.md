# Publication checks

Install the pinned scanner once, then scan from the repository root:

```bash
npm run secrets:install
npm run check:secrets
```

The installer downloads Gitleaks 8.30.1 from its [official GitHub release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1) and
checks a pinned SHA-256 archive digest before extracting the executable into
ignored `.local/tools`. Linux x64 and macOS x64/arm64 are supported. Other
platforms can supply the same version using `GITLEAKS_BIN`.

The default scan checks tracked files plus untracked, non-ignored candidates,
all reachable Git history, and exact values of credentials present in local
`.dev.vars` or credential environment variables. Only findings' rule names,
file locations and commit/blob IDs are reported. Raw scanner output and
credential values are withheld. Temporary copies and reports are removed
after success or failure.

The scan explicitly uses the pinned scanner's built-in rules and an empty
ignore list. Repository/environment rule overrides and inline allow comments
cannot silently suppress its publication findings.

Before publishing a reviewed commit and release artifact, use:

```bash
npm run check:secrets -- --ref HEAD --artifact .release
node scripts/check-release-artifact.mjs
# For an actual deployment target:
node scripts/check-release-artifact.mjs --production
```

`--ref` scans the specified commit's exact file set and its reachable history.
Without it, edits and newly added files are included. `--list` prints the
candidate file list as well as the result. The release checksum checker also
requires a manifest from a clean checkout of the same revision, Node version
and lockfile. CI runs the commit scan before dependency installation and the
artifact scan before uploading a package; checkout uses full Git history.

Private env/config files, local state, database files, backups, archives,
test/release output, design explorations and local audit/planning notes are
ignored. The publication check also rejects these paths if force-tracked.
Compressed SQL/SQLite exports are rejected even outside the normal backup
folder. Application migrations and the synthetic demo SQL remain public. Keep real
database SQL exports under ignored `backups/`; arbitrary SQL can contain
private data that a credential scanner cannot recognize.

Ignoring or untracking a file does not remove it from earlier commits. Review
historical identifiers, author details and artwork separately before choosing
the publication history. A scanner cannot establish asset rights, identify
all personal data, detect every credential format, or prove that a credential
was never exposed elsewhere. If an actual credential appears in a candidate
or historical commit, revoke/rotate it before publication and review history.

The scanner regression tests use disposable Git repositories and synthetic
credentials (`npm run test:publication`). No production service is contacted.
