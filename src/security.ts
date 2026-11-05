export const DAY = 24 * 60 * 60 * 1000;

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function hmacSha256(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCookies(header: string | null): Record<string, string> {
  return Object.fromEntries((header ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    try {
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    } catch {
      // A malformed cookie is attacker-controlled input, not a server error.
      return [];
    }
  }));
}

export function cookie(name: string, value: string, secure: boolean, httpOnly = true, maxAge?: number, options: { path?: string; sameSite?: "Strict" | "Lax" } = {}): string {
  return `${name}=${encodeURIComponent(value)}; Path=${options.path ?? "/"}; SameSite=${options.sameSite ?? (secure ? "Strict" : "Lax")}; ${httpOnly ? "HttpOnly; " : ""}${secure ? "Secure; " : ""}${maxAge === undefined ? "" : `Max-Age=${maxAge}; `}`.trim();
}

export function isSameOrigin(request: Request, origin: string): boolean {
  return request.headers.get("Origin") === origin;
}
