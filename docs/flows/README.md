# FERTO application flows (v4)

These PlantUML sequence diagrams describe the v4 application as implemented.
They are documentation, not proposals.

## Index

1. [Owner identity login and logout](01-owner-identity.puml) — the browser
   sign-in: identity-only (`user-read-private`) PKCE OAuth against Spotify,
   owner-account verification, the FERTO session cookie, and logout. The
   browser never holds a Spotify credential.
2. [Service-token bootstrap](02-service-token-bootstrap.puml) — the local
   `npm run spotify:authorize` helper: PKCE on a loopback redirect, state
   validation, secretless code exchange, account confirmation before storing,
   and the explicit `--local` (.dev.vars) and `--production` (wrangler secret
   put over stdin) destinations.
3. [Scheduled/owner-started rebuild and serialized queue](03-scheduled-rebuild.puml)
   — the Sunday 03:00 UTC cron, authenticated manual start/wake, generation
   lifecycle, and the one-message-at-a-time queue consumer with leases,
   pacing, and retry classification.
4. [Catalogue discovery crawl](04-catalogue-discovery.puml) — the rebuild
   phases from the service token preflight through liked-song seed freezing,
   playlist exclusion freeze, incremental first-credited-artist album and
   single crawl, individual-track enrichment, the safe first shelf, and the
   authoritative final liked-track scan, with pacing and retry behavior.
5. [Recording dedupe and representative selection](05-recording-selection.puml)
   — ISRC-first recording identity, the strict playability gate, and how one
   representative per recording is chosen (earliest release, then artwork,
   then smallest id).
6. [Promotion, quarantine, and the second-low rule](06-promotion.puml) — the
   first-install growing-shelf exception and the normal atomic D1 promotion
   gates: never promote empty, half-overlap floor, first miss quarantined with
   `pending_low`, second completed miss promoted, and retained old snapshots.
7. [Public recommendation](07-public-recommendation.puml) — the read-only
   visitor draw: uniform artist bucket then uniform recording, per-request
   current-track-only exclusion, read-time Never/known filters, and the
   official Spotify embed (no custom playback).
8. [Owner decision — Like](08-owner-like.puml) — save to Spotify first, then
   apply the recording-wide local exclusion across live and staging
   generations; a failed save retains the candidate.
9. [Owner decision — Never Again](09-owner-never.puml) — use the stored ISRC
   identity when available, otherwise the fallback full-track metadata
   lookup, failing closed on transient errors; the exclusion is permanent and
   recording-wide.

Rendering an individual diagram locally requires a PlantUML installation,
for example:

```bash
plantuml docs/flows/04-catalogue-discovery.puml
```

The main implementation references are:

- `scripts/spotify-authorize.mjs` (flows 01–02 context, helper)
- `src/worker.ts` (flows 01, 07, 08, 09)
- `src/rebuild.ts` (flows 03, 04, 06)
- `src/domain.ts` (flows 05, 07)
- `migrations/0009_v4_recordings.sql` (the v4 schema and v3→v4 upgrade)
- `migrations/0010_account_identity_and_recommendation_slots.sql` (immutable
  Spotify account identity and constant-read draw slots)
- `migrations/0011_atomic_recommendation_pool_mutations.sql` (serialized,
  delta-counted slot append/removal transactions)
- `migrations/0012_legacy_never_identity.sql` (legacy exact-id Never aliases,
  lookup index, and safe live-pool rematerialization)
- `migrations/0013_never_identity_checks.sql` (bounded direct resolution for
  exact-id exclusions after Development Mode removed `linked_from`)
- `migrations/0014_restart_rerouted_rebuild.sql` (safe work-queue restart for
  rebuilds that were already active during the identity-gate upgrade)
- `migrations/0015_preserve_preflight_gate.sql` (scope/account preflight
  preservation for jobs interrupted before owner verification)
