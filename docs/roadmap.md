# Development roadmap

Resolved **11 November 2026**. All four checkpoints are complete; checked items
record the delivered work and each checkpoint lists its completion gate.

These followed the completed publication and CI/CD setup.
Keep FERTO's single-owner model, public discovery, artwork-driven interface
and official Spotify player. Work within the existing no-payment setup.

## 1. Improve CI reliability

**Outcome:** temporary browser-install failures recover within a bounded time,
and persistent failures stop verification promptly.

- [x] Select and pin a supported Ubuntu runner version, recording the choice.
- [x] Give browser dependency installation an explicit step timeout and bounded
  retries with useful failure logs. Use the recent Ubuntu package mirror
  timeouts as the failure case to address.
- [x] Confirm transient failures can recover and persistent failures stop before
  deployment. Keep all verification, artifact, backup and Queue safeguards.
- [x] Update the [CI/CD guide](ci-cd.md) with the resulting behavior.

**Done when:** hosted Verify passes, retry/failure behavior is checked, and
browser setup has a documented upper time bound. The required production
Queue drain remains unchanged.

**Validation:** [PR #9](https://github.com/AlexandrosMaragkakis/ferto/pull/9)
merged after both hosted Verify jobs passed. Follow-up
[PR #11](https://github.com/AlexandrosMaragkakis/ferto/pull/11) corrected the
privilege boundary after a hosted timeout exposed a surviving APT process.
All six installer checks passed on the hosted runner, including termination
of a root-owned child; full verification passed.

## 2. Plan database retention

**Outcome:** understand storage growth and preview cleanup before introducing
any deletion policy.

- [x] Use a verified backup to report growth by table and catalogue generation,
  distinguishing live data, staging, caches and retained history. Label local
  storage estimates separately from Cloudflare's live measurements.
- [x] Define which expired caches and obsolete generations could be removed.
  Preserve permanent Never identities, live/active generations, reference
  integrity and the aliases/history needed to handle stale cards.
- [x] Add a dry-run cleanup preview with candidate counts and explanations of
  what would be retained. This checkpoint delivers analysis and a preview;
  applying deletions or enabling automatic pruning is separate work.
- [x] Check the preview against synthetic fixtures and a verified backup, and
  update [backups and recovery](backups-and-recovery.md).

**Done when:** storage growth is explained and the preview identifies cleanup
candidates without modifying its input or breaking the preservation rules.

**Validation:** full local verification and five retention regression checks
passed. Two verified backups were compared, covering schemas 0022 and 0023;
table/generation growth and expiry candidates were reported privately. See
[retention policy and usage](retention.md).

## 3. Publish the first GitHub release

**Outcome:** a versioned release that readers can identify, verify and self-host.

- [x] Confirm `0.1.0` is the intended package version and `v0.1.0` is available.
  Select the exact verified `main` revision after checkpoints 1 and 2.
- [x] Write concise release notes covering the app, local demo, single-owner
  setup, deployment/recovery tooling and known limitations.
- [x] Create the version tag and GitHub release. If attaching a release package,
  use the verified generic artifact and its checksum manifest; keep instance
  configuration, credentials, backups and operational logs private.
- [x] Check the tag/revision, artifact hashes, secret scans and release links.

**Done when:** the published release identifies the verified commit, its notes
match the shipped behavior, and any downloadable package passes validation.

**Validation:** [v0.1.0](https://github.com/AlexandrosMaragkakis/ferto/releases/tag/v0.1.0)
identifies verified revision `f35ba7b`. The public generic archive was scanned,
downloaded again and checked against its SHA-256 checksum and all 48 manifest
entries. Private instance files and operational evidence remain outside it.

## 4. Add recently shown tracks

**Outcome:** recover an accidental skip with a small Back control.

- [x] Keep a bounded, per-tab history of shown cards in the browser.
  Back visits an earlier card; Next moves forward through saved cards before
  requesting a fresh recommendation at the end of the history.
- [x] Reuse card metadata and keep the title, artwork, surrounding theme and
  official Spotify embed in sync while navigating.
- [x] Remove affected recordings from this history after a confirmed Add or
  Never action. Preserve the current card and retry behavior after an
  unconfirmed action; keep server authorization and stale-card validation.
- [x] Make the control accessible on keyboard, screen readers and mobile.
  Check navigation boundaries, the history limit, action outcomes, loading
  failures and delayed artwork/player events.
- [x] Update the relevant [operations](operations.md) and development guidance.

**Done when:** Back/Next navigation works within the documented history bound,
owner decisions remain authoritative, and desktop/mobile browser checks pass.

**Validation:** full verification passed, including seven history-model tests,
server checks for stable opaque identities and authoritative action responses,
and 54 desktop/mobile browser checks. The UI checks cover cached navigation,
the 20-card limit, reload/storage denial, confirmed alias removal, unconfirmed
and expired actions, pending/failed draws and late artwork events. Fictional
before/after desktop/mobile captures and the 320px width review are linked from
[development](development.md#browser-checks-and-releases).

## Working practice

Keep each checkpoint in focused branches and pull requests. Use the checks in
[Contributing](../CONTRIBUTING.md) and [Development](development.md), scaled to
the change, and record validation when checking an item off. Continue to use
the existing backup and release safeguards for production changes.
