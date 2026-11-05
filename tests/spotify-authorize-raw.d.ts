// The service-token helper is plain Node ESM. The workerd test pool only
// imports its pure WebCrypto/PKCE/parsing helpers — the storage tests inject
// their own spawn/fs fakes, so no Node built-in is ever loaded there — and
// this narrow ambient declaration keeps `tsc --noEmit` happy without enabling
// allowJs for the whole project.
declare module "*.mjs" {
  export const SERVICE_SCOPES: string[];
  export const REFRESH_TOKEN_KEY: string;
  export const DEFAULT_PORT: number;
  export function scopeString(): string;
  export function base64url(bytes: Uint8Array): string;
  export function randomSecret(byteLength?: number): string;
  export function deriveChallenge(codeVerifier: string): Promise<string>;
  export function safeEqual(a: unknown, b: unknown): boolean;
  export function buildAuthorizeUrl(init: { clientId: string; redirectUri: string; codeChallenge: string; state: string }): URL;
  export function missingScopes(granted: string | null | undefined): string[];
  export function validateCallback(callbackUrl: URL | string, expectedState: string): { ok: true; code: string } | { ok: false; reason: string };
  export function parseDevVars(content: string | null | undefined): Record<string, string>;
  export function updateDevVarsContent(content: string | null | undefined, refreshToken: string): string;
  export function parseArgs(argv: string[]): { help: boolean; local: boolean; production: boolean; yes: boolean; port: number; devVarsPath: string; configPath?: string };
  export function destinationOf(options: { local: boolean; production: boolean }): "local" | "production";
  export interface HelperChildStream {
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    end(chunk?: string, callback?: () => void): unknown;
  }
  export interface HelperChild {
    once(event: string, listener: (...args: unknown[]) => void): unknown;
    stdin: HelperChildStream;
  }
  export type HelperSpawn = (command: string, args: string[], options: { stdio: string[] } & Record<string, unknown>) => HelperChild;
  export interface HelperFs {
    readFile(path: string, encoding: string): Promise<string>;
    writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    rm(path: string, options?: { force?: boolean }): Promise<void>;
  }
  export function storeLocal(devVarsPath: string, refreshToken: string, deps?: { fs?: HelperFs }): Promise<void>;
  export function storeProduction(refreshToken: string, deps?: { spawn?: HelperSpawn; configPath?: string }): Promise<void>;
}

declare module "*.mjs?raw" {
  const source: string;
  export default source;
}
