import { env } from "cloudflare:workers";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { beforeEach } from "vitest";

// Match the existing explicit D1 fixture isolation for durable control state.
beforeEach(async () => {
  for (const id of await listDurableObjectIds(env.STORAGE_CONTROL)) {
    await runInDurableObject(env.STORAGE_CONTROL.get(id), (_instance, state) => state.storage.deleteAll());
  }
});
