import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { applyCurrentSchema } from "./current-schema";

beforeAll(async () => { await applyCurrentSchema(env.DB); });

it("uses indexed Never lookups for recording key, exact Spotify id and ISRC together", async () => {
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM never_recordings n
    WHERE n.recording_key = ? OR n.spotify_id = ? OR (n.isrc IS NOT NULL AND n.isrc = ?)`)
    .bind("isrc:USABC2100001", "1234567890123456789012", "USABC2100001").all<{ detail: string }>();
  const details = plan.results.map(row => row.detail).join("\n");
  expect(details).toContain("MULTI-INDEX OR");
  expect(details).toContain("never_recordings_isrc");
  expect(details).not.toMatch(/SCAN n\b/);
});
