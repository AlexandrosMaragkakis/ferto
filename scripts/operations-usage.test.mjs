import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyD1Usage, dailyD1Warnings, queueState } from "./operations-lib.mjs";

const account = "a".repeat(32);
const target = { config: { account_id: account, queues: { consumers: [{ queue: "ferto-refresh" }] } } };
function credentials(t) {
  const old = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  process.env.CLOUDFLARE_API_TOKEN = "fixture-token";
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  t.after(() => {
    for (const [name, value] of [["CLOUDFLARE_API_TOKEN", old.token], ["CLOUDFLARE_ACCOUNT_ID", old.account]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}
const payload = rows => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: rows }] } }, errors: null });

test("daily D1 usage aggregates the account's UTC day, independently of local timezone and database", async t => {
  credentials(t);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, { accountTag: account, start: "2026-11-06" });
    assert.ok(!body.query.includes("databaseId"));
    return Response.json(payload([{ sum: { rowsRead: 4_500_000, rowsWritten: 12_000 } }]));
  });
  const usage = await dailyD1Usage(target, "/unused", new Date("2026-11-07T01:30:00+02:00"));
  assert.deepEqual(usage, { date: "2026-11-06", scope: "account", rowsRead: 4_500_000, rowsWritten: 12_000,
    freeReadLimit: 5_000_000, freeWriteLimit: 100_000, resetAt: "2026-11-07T00:00:00.000Z" });
});

test("an available empty dataset means zero usage", async t => {
  credentials(t);
  t.mock.method(globalThis, "fetch", async () => Response.json(payload([])));
  assert.equal((await dailyD1Usage(target, "/unused")).rowsRead, 0);
});

test("denied, rate-limited and malformed analytics are never presented as zero headroom usage", async t => {
  credentials(t);
  const bodies = [{ errors: [{ message: "private provider response" }] }, { data: null },
    payload([{ sum: { rowsRead: -1, rowsWritten: 0 } }]), payload([{ sum: { rowsRead: 1 } }])];
  for (const body of bodies) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(dailyD1Usage(target, "/unused"), error => {
      assert.ok(!error.message.includes("private provider response"));
      assert.ok(!error.message.includes("fixture-token"));
      return true;
    });
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () => new Response("private provider response", { status: 429 }));
  await assert.rejects(dailyD1Usage(target, "/unused"), /Daily D1 analytics request failed/);
});

test("warnings cover read and write headroom at 80% and above the Free caps", () => {
  const usage = { rowsRead: 3_999_999, rowsWritten: 79_999, freeReadLimit: 5_000_000, freeWriteLimit: 100_000, resetAt: "2026-11-07T00:00:00.000Z" };
  assert.deepEqual(dailyD1Warnings(usage), []);
  assert.equal(dailyD1Warnings({ ...usage, rowsRead: 4_000_000 })[0].includes("4,000,000 / 5,000,000"), true);
  assert.equal(dailyD1Warnings({ ...usage, rowsRead: 5_500_000, rowsWritten: 100_000 }).length, 2);
});

test("Queue status still uses an explicitly scoped account without account-list permissions", async t => {
  credentials(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    return Response.json({ success: true, result: calls.length === 1
      ? [{ queue_id: "fixture-queue", queue_name: "ferto-refresh" }]
      : { settings: { delivery_paused: false } } });
  });
  assert.equal((await queueState(target, "/unused")).settings.delivery_paused, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/queues`)));
});
