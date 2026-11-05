// Wrangler can generate configured vars/bindings but intentionally cannot infer secrets.
interface Env {
  SPOTIFY_REFRESH_TOKEN: string;
  SESSION_SECRET: string;
}
declare namespace Cloudflare {
  interface Env {
    SPOTIFY_REFRESH_TOKEN: string;
    SESSION_SECRET: string;
  }
}

// Raw source imports used by the worker integration tests (the repo's sql and
// jsonc raw declarations live in tests/sql.d.ts).
declare module "*.d.ts?raw" { const raw: string; export default raw; }
declare module "*.ts?raw" { const raw: string; export default raw; }
