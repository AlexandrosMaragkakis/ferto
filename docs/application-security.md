# Application security and request limits

FERTO has one configured Spotify owner. Visitors draw from the public local
catalogue; owner writes require a valid session, matching Origin and CSRF
cookie/header. Both Spotify authorization flows use PKCE.

This is the public summary of safeguards implemented during the November 2026
publication review. Detailed audit notes, account metadata and deployment
evidence stay local. The safeguards below are implemented and deployed;
this is a record of controls and validation, rather than a security certification.
Use [SECURITY.md](../SECURITY.md) to report a suspected vulnerability.

Browser sign-in also requires a short-lived, random HttpOnly cookie. Only its
HMAC is stored with the hashed OAuth state and PKCE verifier. The cookie uses
`SameSite=Lax` so Spotify's top-level return navigation can send it, is limited
to the callback path, expires after ten minutes and is Secure on HTTPS.
The callback validates browser binding and consumes the state atomically.
Missing/wrong-browser, expired, replayed and cancelled transactions do not
create a session. Owner sessions retain their seven-day lifetime.

The API awaits route handlers inside its error boundary. Unexpected errors
return generic JSON and logs omit exception bodies and SQL bindings. Like and
Never accept a JSON object with a valid track ID, cap its encoded body at
1 KiB and allow five seconds to read it. Malformed or oversized bodies fail
before Spotify calls or local exclusions.

## Timeouts and recovery

Spotify requests, including response-body reads, have ten-second deadlines.
Rebuild units stop issuing network requests at ninety seconds, leaving thirty
seconds before their two-minute lease ends for persistence and acknowledgement.
Transient failures preserve work and use the existing retry/Queue recovery.
Simultaneous rebuild starts claim one durable job in a transaction; cleanup
and history changes run only for the winning generation.

Browser reads have fifteen-second deadlines and mutations forty seconds.
Public discovery starts independently of owner-session lookup. Failed or
unconfirmed actions retain the current card and restore its controls. A timed
out Spotify save might already have succeeded remotely; the app does not
automatically repeat writes, and the owner can retry the idempotent save.
The local Spotify authorization helper also bounds its token/profile requests.

## Application request budgets

Production uses shared, durable counters in the SQLite-backed `StorageControl`
object, independently of catalogue D1 storage. Client addresses are HMACed
using the session secret; raw addresses are not stored. The object coordinates
one configured Spotify owner/client and does no provider HTTP or catalogue work.

| Route | Per client per minute | Whole instance per minute |
| --- | --- | --- |
| Start owner sign-in | 5 | 20 |
| Draw recommendation | 60 | 600 |

Counters reset after sixty seconds; rejected requests return 429 and
`Retry-After: 60`. A synchronous durable transaction checks the client allowance
and grants global admission before updating the client counter. Throttled clients
cannot spend everyone else's remaining allowance. Each budget stores at most
its admitted clients and resets its map with the next window. Production requests without a client
address share an unknown-client bucket. Local HTTP requests without
Cloudflare's client-address header skip these network-client budgets.

At most 32 unexpired OAuth transactions can exist, enforced in the insertion
transaction. Expiry is indexed. Login and each scheduled tick remove up to 128
expired states; scheduled ticks also remove up to 10,000 legacy expired D1 budget
rows. New request counters do not grow D1. If durable request protection is
unavailable, requests fail closed with a sanitized 503; no per-isolate or
unlimited fallback bypasses the shared budgets.

## Storage exhaustion and provider saves

Storage errors are classified separately from daily row quotas and unrelated SQL
errors. Only fixed messages/codes reach clients. The capacity pause survives
worker eviction/deployment outside D1 and blocks manual, weekly and queued
background expansion. Reads and bounded maintenance remain available where D1
permits them; daily database quotas can also block reads.

Before a Spotify library PUT, an owner-authorized save intent is persisted in
the control object. A confirmed provider write receives a durable receipt before
D1 bookkeeping. If bookkeeping fails, the API returns 202 with `ok:false`,
`spotifySaved:true` and `pending:true`; the browser retains the card and history.
Owner retries and bounded maintenance reconcile confirmed receipts without
repeating Spotify writes. Unknown/timed-out saves are never automatically replayed.
Unconfirmed intents expire after a day; confirmed receipts remain until reconciled.
At most 32 pending saves are retained, with a two-minute per-save lease.

Permanent Never decisions remain authoritative in D1 and are never reported as
saved before their write succeeds. Public draws still check exclusions and skip
confirmed pending saves; lazy pool repair failing for storage does not expose an
excluded recording. See [capacity and recovery](retention.md#capacity-protection-and-recovery).

These are modest controls for a personal instance, not a DDoS perimeter.
Denied traffic still performs a counter query, shared networks share a client
budget, and a determined attacker can exhaust an instance's allowance. There
is no CAPTCHA or external identity service. Add Cloudflare edge rate limiting
if traffic or abuse warrants it, and monitor D1 usage. Losing scheduled cleanup
for a sustained period also needs operator attention.

## Browser policy

Static assets receive security headers from `web/public/_headers`; Worker
responses receive matching protections in code. CSP permits same-origin
scripts/styles, HTTPS artwork and the official `open.spotify.com` frame.
It blocks inline scripts/styles, framing the app, plugins and foreign API
connections. Theme initialization is an external same-origin script; adaptive
colours continue through the CSSOM. Content-type protection, a referrer
policy, restricted browser permissions and HTTPS HSTS are also set.

The [Cloudflare static headers reference](https://developers.cloudflare.com/workers/static-assets/headers/)
explains why static assets and Worker responses need separate configuration.

## Deployment

Apply migration `0022_oauth_browser_binding_and_budgets.sql` before deploying
this Worker, following the [safe upgrade procedure](self-hosting.md#safe-upgrades-after-the-first-deployment).
It adds browser binding, request budgets and expiry indexes. Existing owner
sessions survive; sign-in transactions started on older code must be started
again. Local Worker startup applies pending local migrations automatically.

Automated browser checks run Chromium desktop/mobile with external traffic
blocked and synthetic owner responses. They verify CSP enforcement, public
startup, theme/artwork behavior and action recovery. Real Spotify owner sign-in
and playback under the deployed policy were confirmed working by the owner on
5 November 2026. That confirmation is separate from the automated fixtures.

The operational baseline assumes the Free tier: seven days of D1 Time Travel
plus independently verified local SQL backups. The [backup/recovery guide](backups-and-recovery.md)
and [local release procedure](local-releases.md) cover maintenance, schema
compatibility, exact deployed asset checks and failure-safe Queue handling.
Local restore rehearsals are automated; destructive remote restores are not
performed by the helpers. GitHub verification receives no production credentials.
Optional [CI/CD](ci-cd.md), disabled until configured, isolates deployment in the
production environment and saves encrypted backup/recovery artifacts before
changing the live deployment. Its private decryption key stays local.
