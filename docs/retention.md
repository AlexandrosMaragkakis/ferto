# Database retention analysis and preview

FERTO retains public catalogue generations because owner actions resolve an
old card's Spotify id through that history. This guide defines a conservative
cleanup preview; it does not introduce deletion or scheduled pruning.

## Inspect a verified backup

```bash
npm run retention:preview -- --backup backups/ferto/<completed-backup>
# Compare growth against an older backup of the same database:
npm run retention:preview -- --backup backups/ferto/<newer> --compare backups/ferto/<older>
```

The command verifies checksums, restores the SQL locally, checks integrity and
foreign keys, and analyzes a read-only copy. It makes no provider requests and
does not change input data. Reports are owner-only files under ignored
`.local/retention/preview-*/report.json`. Restored working databases are removed.
Use `--at <ISO-time>` for repeatable expiry evaluation and `--output` for another
private ignored directory. There is no `--apply` option or generated deletion SQL.

The preview supports schemas `0022_oauth_browser_binding_and_budgets.sql` and
`0023_never_isrc_lookup.sql`; the latter only adds the Never ISRC index. This
allows comparison with a pre-index backup. Other schema changes require
reviewing the rules before enabling analysis of that version.

## What the report means

- Table counts and generation breakdowns separate cache, catalogue/staging,
  refresh history, exclusions, authentication and legacy state.
- Local page estimates include each table's indexes when SQLite exposes
  `dbstat`; unavailable estimates are `null`, never an invented zero.
- These are restored SQLite estimates, not Cloudflare physical storage,
  billable row counts or guaranteed space savings after a hypothetical cleanup.
  Cloudflare's recorded database size is labelled separately with the backup
  snapshot time. It is not a new live measurement.
- Comparison requires chronological backups from the same database. Row and
  local-byte deltas describe the snapshots, not a forecast of future growth.
- Reports can reveal library size and generation identifiers. Keep real reports
  private; use synthetic fixtures for public examples and pull requests.

## Preservation rules

All live and promoted generations, current jobs including failed jobs,
refresh-history baselines and publication-ledger references are retained.
Promoted history cannot be assigned an arbitrary age limit while stale-card
identity resolution depends on it. A future compact alias store could change
that policy, but would require its own migration and correctness work.

Unreferenced abandoned work is a candidate only when every Spotify-id and
recording-key mapping already survives in a protected generation. A unique
mapping retains the entire abandoned generation. This also protects different
canonical keys for the same Spotify id. The preview reports reasons and row
counts per generation/table; it does not execute any removal.

Never decisions, their legacy identities/checks, schema history, playlist
snapshots/pages and authentication/request state are always retained by this
tool. Existing application maintenance remains responsible for its own bounded
operational-history and session/request cleanup.

Expired full-track, recording-identity, track-availability and album-discovery
cache rows can be counted as candidates because normal reads enforce their
TTL. Expired album-availability markers are retained while a matching album
discovery page is fresh: removing that marker alone can change refresh behavior.
Cache eviction would mean future misses/provider work; counts do not promise
that all candidates should be removed immediately.

Before any future implementation of deletion, use a fresh verified backup,
revalidate these preservation rules on the current schema, bound remote reads
and writes, and verify stale-card decisions and catalogue integrity. Actual
deletion and automatic pruning are outside this preview's scope. See
[backups and recovery](backups-and-recovery.md) for the existing safeguards.
