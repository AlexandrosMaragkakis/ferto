import { describe, expect, it } from "vitest";
import readmeIntro from "../README.md?raw";
import selfHosting from "../docs/self-hosting.md?raw";
import operations from "../docs/operations.md?raw";
import development from "../docs/development.md?raw";
import localReleases from "../docs/local-releases.md?raw";
import backupsAndRecovery from "../docs/backups-and-recovery.md?raw";
import flowsIndex from "../docs/flows/README.md?raw";
import devVarsExample from "../.dev.vars.example?raw";
import packageJsonRaw from "../package.json?raw";
import ownerIdentity from "../docs/flows/01-owner-identity.puml?raw";
import serviceToken from "../docs/flows/02-service-token-bootstrap.puml?raw";
import scheduledRebuild from "../docs/flows/03-scheduled-rebuild.puml?raw";
import catalogueDiscovery from "../docs/flows/04-catalogue-discovery.puml?raw";
import recordingSelection from "../docs/flows/05-recording-selection.puml?raw";
import promotion from "../docs/flows/06-promotion.puml?raw";
import publicRecommendation from "../docs/flows/07-public-recommendation.puml?raw";
import ownerLike from "../docs/flows/08-owner-like.puml?raw";
import ownerNever from "../docs/flows/09-owner-never.puml?raw";

const readme = [readmeIntro, selfHosting, operations, development, localReleases, backupsAndRecovery].join("\n");

const SERVICE_SCOPES = [
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-private",
];

const diagrams = {
  "01-owner-identity": ownerIdentity,
  "02-service-token-bootstrap": serviceToken,
  "03-scheduled-rebuild": scheduledRebuild,
  "04-catalogue-discovery": catalogueDiscovery,
  "05-recording-selection": recordingSelection,
  "06-promotion": promotion,
  "07-public-recommendation": publicRecommendation,
  "08-owner-like": ownerLike,
  "09-owner-never": ownerNever,
};

const PLAYBACK_SCOPE_TOKENS = ["user-modify-playback", "user-read-playback-state", "user-read-currently-playing", "app-remote-control", "streaming"];

describe("v4 dev vars example", () => {
  it("declares exactly the v4 bindings, with only the two runtime secrets", () => {
    const keys = [...devVarsExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]).sort();
    expect(keys).toEqual(["APP_ORIGIN", "OWNER_SPOTIFY_ID", "SESSION_SECRET", "SPOTIFY_CLIENT_ID", "SPOTIFY_REFRESH_TOKEN"]);
  });

  it("declares no Spotify client or playback secret", () => {
    expect(devVarsExample).not.toMatch(/^SPOTIFY_CLIENT_SECRET=/m);
    const bindingLines = devVarsExample.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).join("\n");
    for (const forbidden of PLAYBACK_SCOPE_TOKENS) {
      expect(bindingLines.toLowerCase()).not.toContain(forbidden);
    }
    expect(devVarsExample).not.toMatch(/^[A-Z][A-Z0-9_]*(PLAYBACK|PLAYER)[A-Z0-9_]*=/m);
  });
});

describe("package scripts", () => {
  it("exposes the service-token helper", () => {
    const scripts = JSON.parse(packageJsonRaw).scripts as Record<string, string>;
    expect(scripts["spotify:authorize"]).toContain("scripts/spotify-authorize.mjs");
  });

  it("keeps the check commands the README documents", () => {
    const scripts = JSON.parse(packageJsonRaw).scripts as Record<string, string>;
    for (const name of ["test", "typecheck", "build", "worker:check", "db:migrate:local", "dev", "dev:worker"]) {
      expect(scripts[name], `missing npm script ${name}`).toBeTruthy();
    }
  });
});

describe("Setup and operations documentation", () => {
  // Wrap-tolerant: markdown line breaks must not break the prose lock.
  const prose = readme.replace(/\s+/g, " ");

  it("documents the service-token helper and both destinations", () => {
    expect(prose).toContain("npm run spotify:authorize -- --local");
    expect(prose).toContain("npm run spotify:authorize -- --production");
    expect(prose).toContain("wrangler secret put SPOTIFY_REFRESH_TOKEN");
    expect(prose).toContain("without a client secret");
    expect(prose).toContain("never prints the refresh token");
    expect(prose).toContain("both redirect URIs");
    expect(readme).toContain("http://127.0.0.1:8931/callback");
    expect(readme).toContain("http://127.0.0.1:5173/api/owner/callback");
  });

  it("lists exactly the five service scopes with no playback scope", () => {
    for (const scope of SERVICE_SCOPES) expect(readme).toContain(`- \`${scope}\``);
    for (const forbidden of PLAYBACK_SCOPE_TOKENS) {
      expect(readme.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("describes the two-token model and identity-only browser sign-in", () => {
    expect(prose).toContain("Service token");
    expect(prose).toContain("Browser identity sign-in");
    expect(readme).toContain("user-read-private");
    expect(prose).toContain("FERTO session cookie");
    expect(prose).toContain("immutable `account_id`");
  });

  it("documents PKCE end to end and requires no Spotify client secret", () => {
    expect(readme).not.toContain("SPOTIFY_CLIENT_SECRET");
    expect(prose).toContain("without a client secret");
    expect(prose).toContain("There is no Spotify client secret");
  });

  it("documents the weekly schedule, serialized queue, and promotion safety", () => {
    expect(prose).toContain("Sunday");
    expect(prose).toContain("03:00 UTC");
    expect(readme).toContain("0 3 * * SUN");
    expect(prose).toContain("one message, one batch, and one concurrency");
    expect(prose).toContain("atomic D1 batch");
    expect(prose).toContain("never promotes");
    expect(prose).toContain("quarantined");
    expect(readme).toContain("pending_low");
    expect(prose).toContain("retained");
  });

  it("documents owner decisions, public read-only, manual refresh, and no-playback posture", () => {
    expect(prose).toContain("start a rebuild immediately");
    expect(readme).toContain("POST /api/owner/refresh");
    expect(prose).toContain("Public read-only");
    expect(prose).toContain("saves to Spotify first");
    expect(prose).toContain("fails closed");
    expect(prose).toContain("official Spotify compact embed");
    expect(prose).toContain("no playback token, secret, or custom player");
    expect(prose).toContain("Public playlists that the owner merely follows are intentionally not counted");
  });

  it("documents the safe v3-to-v4 migration and that no deploy happens", () => {
    expect(readme).toContain("0009_v4_recordings.sql");
    expect(readme).toContain("0010_account_identity_and_recommendation_slots.sql");
    expect(readme).toContain("0011_atomic_recommendation_pool_mutations.sql");
    expect(readme).toContain("0012_legacy_never_identity.sql");
    expect(readme).toContain("0013_never_identity_checks.sql");
    expect(readme).toContain("0014_restart_rerouted_rebuild.sql");
    expect(readme).toContain("0015_preserve_preflight_gate.sql");
    expect(prose).toContain("Legacy Never identity gate");
    expect(readme).toContain("Rebuild cost is workload-dependent");
    expect(prose).toContain("preserved");
    expect(prose).toContain("never goes empty");
    expect(prose).toContain("Build and test commands do not deploy");
    expect(readme).toContain("--dry-run");
  });

  it("documents a drained Queue fence for production schema upgrades", () => {
    expect(readme).toContain("wrangler queues pause-delivery ferto-refresh");
    expect(readme).toContain("Confirm delivery is PAUSED");
    expect(prose).toContain("wait 16 minutes");
    expect(readme).toContain("wrangler queues resume-delivery ferto-refresh");
    expect(prose).toContain("Do not purge the queue");
    expect(prose).toContain("revision-guards every bootstrap publication");
  });

  it("documents the local run and check commands", () => {
    for (const command of ["npm run db:migrate:local", "npm run dev:worker", "npm run dev", "npm test", "npm run typecheck", "npm run build", "npm run worker:check"]) {
      expect(readme).toContain(command);
    }
    expect(readme).toContain("http://127.0.0.1:5173");
  });
});

describe("flow diagram index", () => {
  it("indexes every v4 diagram file", () => {
    for (const fileName of Object.keys(diagrams)) {
      expect(flowsIndex, `index is missing ${fileName}.puml`).toContain(`${fileName}.puml`);
    }
    expect(flowsIndex).toContain("Sunday 03:00 UTC");
  });
});

describe("flow diagram content", () => {
  it("01 owner identity: PKCE identity-only login, owner check, logout", () => {
    expect(ownerIdentity).toContain("user-read-private");
    expect(ownerIdentity).toContain("OWNER_SPOTIFY_ID");
    expect(ownerIdentity).toContain("S256");
    expect(ownerIdentity).toContain("Logout");
    expect(ownerIdentity).toContain("never receives a Spotify credential");
    expect(ownerIdentity).toContain("immutable account_id");
  });

  it("02 service-token bootstrap: loopback PKCE, state validation, no secret, both destinations", () => {
    expect(serviceToken).toContain("127.0.0.1");
    expect(serviceToken).toContain("no client_secret");
    expect(serviceToken).toContain("constant-time");
    expect(serviceToken).toContain("SPOTIFY_REFRESH_TOKEN");
    expect(serviceToken).toContain("child stdin");
    expect(serviceToken).toContain("mode 0600");
    expect(serviceToken).toContain("never printed");
    expect(serviceToken).toContain("immutable account_id");
    for (const scope of SERVICE_SCOPES) expect(serviceToken).toContain(scope);
    for (const forbidden of PLAYBACK_SCOPE_TOKENS) {
      expect(serviceToken.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("03 scheduled rebuild: Sunday 03:00 UTC cron and serialized consumer", () => {
    expect(scheduledRebuild).toContain("0 3 * * SUN");
    expect(scheduledRebuild).toContain("*/15 * * * *");
    expect(scheduledRebuild).toContain("03:00 UTC");
    expect(scheduledRebuild).toContain("max_concurrency=1");
    expect(scheduledRebuild).toContain("max_batch_size=1");
    expect(scheduledRebuild).toContain("lease");
    expect(scheduledRebuild).toContain("30s");
    expect(scheduledRebuild).toContain("429");
    expect(scheduledRebuild).toContain("Retry-After");
    expect(scheduledRebuild).toContain("5 attempts");
    expect(scheduledRebuild).toContain("POST /api/owner/refresh");
    expect(scheduledRebuild).toContain("QUOTA_EXCEEDED");
  });

  it("04 catalogue discovery: liked seeds, first credited artist albums+singles, playlists, pacing", () => {
    expect(catalogueDiscovery).toContain("/v1/me/tracks");
    expect(catalogueDiscovery).toContain("first credited artist");
    expect(catalogueDiscovery).toContain("include_groups=album,single");
    expect(catalogueDiscovery).toContain("/v1/me/playlists");
    expect(catalogueDiscovery).toContain("OWNER_SPOTIFY_ID");
    expect(catalogueDiscovery).toContain("30 seconds");
    expect(catalogueDiscovery).toContain("exponential backoff");
    expect(catalogueDiscovery).toContain("/v1/tracks/{id}");
    expect(catalogueDiscovery).toContain("collaborative");
    expect(catalogueDiscovery).toContain("growing live shelf");
    expect(catalogueDiscovery).toContain("mutable user id");
  });

  it("05 recording selection: ISRC identity and representative ordering", () => {
    expect(recordingSelection).toContain("isrc:");
    expect(recordingSelection).toContain("spotify:{id}");
    expect(recordingSelection).toContain("earliest release date");
    expect(recordingSelection).toContain("artwork");
    expect(recordingSelection).toContain("strictly playable");
    expect(recordingSelection).toContain("bucket_artist_id");
    expect(recordingSelection).toContain("/v1/tracks/{id}");
  });

  it("06 promotion: gates, quarantine, second-low, retained snapshots", () => {
    expect(promotion).toContain("empty");
    expect(promotion).toContain("half");
    expect(promotion).toContain("quarantined");
    expect(promotion).toContain("pending_low");
    expect(promotion).toContain("second-low rule");
    expect(promotion).toContain("Atomic D1 batch");
    expect(promotion).toContain("recording_generations");
    expect(promotion).toContain("Fresh-install bootstrap exception");
  });

  it("07 public recommendation: uniform buckets, per-request exclusion, read-only", () => {
    expect(publicRecommendation).toContain("uniformly");
    expect(publicRecommendation).toContain("bucket_artist_id");
    expect(publicRecommendation).toContain("exclude");
    expect(publicRecommendation).toContain("for this request only");
    expect(publicRecommendation).toContain("read-only");
    expect(publicRecommendation).toContain("never_recordings");
    expect(publicRecommendation).toContain("rebuild_known_recordings");
    expect(publicRecommendation).toContain("no ISRC");
    expect(publicRecommendation).toContain("never runs COUNT, DISTINCT");
    expect(publicRecommendation).toContain("track_slot");
  });

  it("08 Like: Spotify first, recording-wide exclusion, failure retention", () => {
    expect(ownerLike).toContain("saved to Spotify first");
    expect(ownerLike).toContain("rebuild_known_recordings");
    expect(ownerLike).toContain("recording-wide");
    expect(ownerLike).toContain("retained");
    expect(ownerLike).toContain("502");
    expect(ownerLike).toContain("user-library-modify");
    expect(ownerLike).toContain("/v1/me/library");
  });

  it("09 Never: fallback lookup and fail-closed", () => {
    expect(ownerNever).toContain("isrc:");
    expect(ownerNever).toContain("/v1/tracks/{trackId}");
    expect(ownerNever).toContain("404");
    expect(ownerNever).toContain("fail closed");
    expect(ownerNever).toContain("never_recordings");
    expect(ownerNever).toContain("recording-wide and permanent");
  });

  it("every diagram is a balanced PlantUML sequence file", () => {
    for (const [name, source] of Object.entries(diagrams)) {
      expect(source.startsWith("@startuml"), `${name} must start with @startuml`).toBe(true);
      expect(source.trimEnd().endsWith("@enduml"), `${name} must end with @enduml`).toBe(true);
      const starts = [...source.matchAll(/^\s*@startuml/gm)].length;
      const ends = [...source.matchAll(/^\s*@enduml/gm)].length;
      expect(starts, `${name} has ${starts} @startuml`).toBe(1);
      expect(ends, `${name} has ${ends} @enduml`).toBe(1);
      expect(source).toMatch(/^\s*(actor|boundary|control|database|participant|queue)\s/m);
    }
  });
});
