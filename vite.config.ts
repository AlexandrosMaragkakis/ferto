import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";

// Sharing crawlers read HTML without JavaScript. Only the public origin is
// taken from the selected instance config; no credentials enter the bundle.
const instance = JSON.parse(readFileSync(process.env.FERTO_DEPLOY_CONFIG || "wrangler.jsonc", "utf8"));
const origin = new URL(instance.vars.APP_ORIGIN);
if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== instance.vars.APP_ORIGIN) {
  throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash");
}
const htmlOrigin = origin.origin.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export default defineConfig({
  plugins: [{
    name: "ferto-page-metadata",
    transformIndexHtml: (html) => html.replaceAll("__FERTO_PUBLIC_ORIGIN__", htmlOrigin),
  }, cloudflareTest({
    wrangler: { configPath: "../wrangler.jsonc" },
    // Keep tests deterministic and independent of an ignored developer
    // .dev.vars file (or its absence in CI).
    miniflare: {
      bindings: {
        SPOTIFY_CLIENT_ID: "test-client-id",
        OWNER_SPOTIFY_ID: "test-owner-id",
        APP_ORIGIN: "http://127.0.0.1:5173",
        SPOTIFY_REFRESH_TOKEN: "test-refresh-token",
        SESSION_SECRET: "test-session-secret",
      },
    },
  })],
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { include: ["../tests/**/*.test.ts"] }
});
