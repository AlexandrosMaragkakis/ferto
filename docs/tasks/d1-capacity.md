# D1 storage capacity

**Status:** Open for discussion. Planning has not started.

**Raised:** 24 November 2026.

## Concern

The repository and deployment check recorded D1 usage of 122.7 MB against the
currently assumed 500 MB Free per-database limit. This is a dated observation,
not a live reading.

Keep open the task of ensuring FERTO continues to behave safely and preserves
its data if the database approaches or reaches its storage limit. The app is
currently working; this concerns eventual storage exhaustion.

## Existing coverage

- [`npm run ops:status`](../../scripts/operations-status.mjs) reports database
  size and warns at 75% of the assumed limit.
- The [retention preview](../retention.md) analyzes verified backups and
  identifies cleanup candidates. It does not apply deletions or enable
  automatic pruning.
- Existing [refresh maintenance](../../src/rebuild.ts) and
  [request-state cleanup](../../src/request-budget.ts) remove some expired or
  obsolete data. Promoted catalogue generations remain retained for stale-card
  identity resolution.
- [Backups and recovery](../backups-and-recovery.md) document storage monitoring,
  backup procedures and the need to review retention before reaching the cap.

These provide partial coverage. No specific handling or tests for a database
reaching its storage cap were found in the current implementation; safe
end-to-end behavior in that condition remains unverified.

## Discussion state

Leave this task open for further discussion. No solution, implementation plan,
retention policy, schema change or deployment change is proposed or approved
by this note.
