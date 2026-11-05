export const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-src https://open.spotify.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), autoplay=(self "https://open.spotify.com"), encrypted-media=(self "https://open.spotify.com"), fullscreen=(self "https://open.spotify.com"), clipboard-write=(self "https://open.spotify.com"), picture-in-picture=(self "https://open.spotify.com")';

export function secureResponse(response: Response, request: Request, origin: string): Response {
  const result = new Response(response.body, response);
  result.headers.set("Content-Security-Policy", new URL(request.url).pathname.startsWith("/api/")
    ? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" : HTML_CSP);
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("X-Frame-Options", "DENY");
  result.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  result.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  if (origin.startsWith("https://")) result.headers.set("Strict-Transport-Security", "max-age=31536000");
  if (new URL(request.url).pathname.startsWith("/api/")) result.headers.set("Cache-Control", "no-store");
  return result;
}

export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function jsonObject(request: Request, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const maxBytes = 1024;
  if (Number(request.headers.get("Content-Length")) > maxBytes) throw new RequestError("request body too large", 413);
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError("application/json required", 415);
  }
  if (!request.body) throw new RequestError("JSON object required", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new RequestError("request body timed out", 408)); void reader.cancel().catch(() => {}); }, timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RequestError("request body too large", 413);
      }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RequestError("valid JSON object required", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError("JSON object required", 400);
  return value as Record<string, unknown>;
}
