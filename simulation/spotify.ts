import type { RequestEndpoint } from "../src/rebuild-progress";
import { OWNER_ACCOUNT, OWNER_PROFILE, SCOPES, SyntheticCatalogue } from "./catalogue";
import type { SimulationConfig } from "./config";
export type ApiEndpointMetrics = { attempts: number; succeeded: number; failed: number; quota: number; rateLimited: number; unauthorized: number; unavailable: number; network: number };
export type ApiMetrics = { endpoints: Partial<Record<RequestEndpoint, ApiEndpointMetrics>>; maxRequestsPerInvocation: number;
  limitViolations: number; earlyRequests: number; unexpectedRequests: number; quotaWindowResets: number;
  injected503: number; injectedNetwork: number; injectedExpiry: number; disappearedPlaylists: number; snapshotChanges: number };
function endpointFor(url: URL): RequestEndpoint {
  if (url.origin === "https://accounts.spotify.com") return "token";
  if (url.pathname === "/v1/me") return "profile";
  if (url.pathname === "/v1/me/tracks") return "likedTracks";
  if (url.pathname === "/v1/me/playlists") return "playlists";
  if (/^\/v1\/artists\/[^/]+\/albums$/.test(url.pathname)) return "artistAlbums";
  if (/^\/v1\/albums\/[^/]+\/tracks$/.test(url.pathname)) return "albumTracks";
  if (/^\/v1\/tracks\/[^/]+$/.test(url.pathname)) return "tracks";
  return /\/(items|tracks)$/.test(url.pathname) ? "playlistItems" : "playlistDetails";
}
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const failure = (status: number, reason?: string, headers: HeadersInit = {}) => json({ error: { status, message: `Synthetic Spotify ${status}`, ...(reason ? { reason } : {}) } }, status, headers);

/** All HTTP is intercepted. The capacities/windows below are synthetic inputs,
 * never inferred Spotify limits. No real credentials or network are used. */
export class SyntheticSpotify {
  readonly metrics: ApiMetrics = { endpoints: {}, maxRequestsPerInvocation: 0, limitViolations: 0, earlyRequests: 0,
    unexpectedRequests: 0, quotaWindowResets: 0, injected503: 0, injectedNetwork: 0, injectedExpiry: 0, disappearedPlaylists: 0, snapshotChanges: 0 };
  private tokenNumber = 0;
  private tokens = new Map<string, number>();
  private ordinal = 0;
  private disappearingStarted = new Set<string>();
  private invocation = 0;
  private invocationRequests = 0;
  private rolling: number[] = [];
  private buckets = new Map<string, { period: number; used: number }>();
  private reportedUntil = 0;
  private reportedInvocation = 0;
  readonly errors: { at: number; endpoint: RequestEndpoint; status: number; reason: string }[] = [];
  constructor(readonly catalogue: SyntheticCatalogue, private config: SimulationConfig, private now: () => number, private epoch: number) {}
  beginInvocation(): void { this.invocation += 1; this.invocationRequests = 0; }
  endInvocation(): void { this.metrics.maxRequestsPerInvocation = Math.max(this.metrics.maxRequestsPerInvocation, this.invocationRequests); }
  private counts(endpoint: RequestEndpoint): ApiEndpointMetrics {
    return this.metrics.endpoints[endpoint] ??= { attempts: 0, succeeded: 0, failed: 0, quota: 0, rateLimited: 0, unauthorized: 0, unavailable: 0, network: 0 };
  }
  private error(endpoint: RequestEndpoint, status: number, reason: string): void {
    this.errors.push({ at: this.now(), endpoint, status, reason });
    if (this.errors.length > 100) this.errors.shift();
  }
  private rateResponse(endpoint: RequestEndpoint, seconds: number, quota: boolean): Response {
    const mode = quota ? this.config.retryAfter : "seconds";
    const headers: Record<string, string> = mode === "missing" ? {} : { "Retry-After": mode === "date"
      ? new Date(this.now() + seconds * 1000).toUTCString() : String(seconds) };
    if (mode !== "missing") { this.reportedUntil = Math.max(this.reportedUntil, this.now() + seconds * 1000); this.reportedInvocation = this.invocation; }
    this.counts(endpoint)[quota ? "quota" : "rateLimited"] += 1;
    this.error(endpoint, 429, quota ? "QUOTA_EXCEEDED" : "rolling rate limit");
    return failure(429, quota ? "QUOTA_EXCEEDED" : undefined, headers);
  }
  private page<T>(url: URL, items: T[]): Response {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid synthetic pagination cursor");
    const next = new URL(url); next.searchParams.set("offset", String(offset + limit));
    return json({ items: items.slice(offset, offset + limit), next: offset + limit < items.length ? next.toString() : null });
  }
  private route(url: URL): Response {
    const path = url.pathname;
    if (path === "/v1/me") return json({ id: OWNER_PROFILE, account_id: OWNER_ACCOUNT, country: "GR" });
    if (path === "/v1/me/tracks") return this.page(url, this.catalogue.likes.map((track) => ({ track: this.catalogue.knownShape(track, track.artistIndex % 7 === 0) })));
    if (path === "/v1/me/playlists") return this.page(url, this.catalogue.playlists.map(({ id, owner, collaborative, snapshot_id }) => ({ id, owner, collaborative, snapshot_id })));
    const artist = /^\/v1\/artists\/([^/]+)\/albums$/.exec(path);
    if (artist) {
      const albums = this.catalogue.artistAlbums.get(artist[1]!); if (!albums) return failure(404);
      return this.page(url, albums.map((id) => { const album = this.catalogue.albums.get(id)!; return { id: album.id, name: album.name, images: album.images }; }));
    }
    const album = /^\/v1\/albums\/([^/]+)\/tracks$/.exec(path);
    if (album) { const source = this.catalogue.albums.get(album[1]!); if (!source) return failure(404);
      return this.page(url, source.tracks.map((track) => ({ id: track.body.id, artists: track.body.artists, is_playable: track.playable, is_local: false, ...(track.body.id !== track.requestedId ? { linked_from: { id: track.requestedId } } : {}) }))); }
    const track = /^\/v1\/tracks\/([^/]+)$/.exec(path);
    if (track) { const source = this.catalogue.tracks.get(track[1]!); if (!source || source.unavailable) return failure(404); return json(source.body); }
    const playlist = /^\/v1\/playlists\/([^/]+)(?:\/(items|tracks))?$/.exec(path);
    if (playlist) {
      const source = this.catalogue.playlists.find((item) => item.id === playlist[1]); if (!source) return failure(404);
      if (source.owner.id !== OWNER_PROFILE && !source.collaborative) { this.metrics.unexpectedRequests += 1; throw new Error("App attempted to crawl an unrelated playlist"); }
      if (source.disappeared) {
        if (!playlist[2] || this.disappearingStarted.has(source.id) || Number(url.searchParams.get("offset") ?? 0) > 0) {
          this.metrics.disappearedPlaylists += 1; return failure(404);
        }
        this.disappearingStarted.add(source.id);
      }
      if (!playlist[2]) return json({ snapshot_id: source.snapshot_id });
      const response = this.page(url, source.items.map((item) => ({ item: this.catalogue.knownShape(item) })));
      if (this.config.apiFaults && source.id === this.catalogue.playlists[0]!.id && this.metrics.snapshotChanges === 0) {
        source.snapshot_id += "-edited"; this.metrics.snapshotChanges += 1;
      }
      return response;
    }
    this.metrics.unexpectedRequests += 1; throw new Error(`Unhandled synthetic Spotify route: ${path}`);
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    if (!((url.origin === "https://accounts.spotify.com" && url.pathname === "/api/token" && method === "POST")
      || (url.origin === "https://api.spotify.com" && method === "GET"))) {
      this.metrics.unexpectedRequests += 1; throw new Error("Simulator blocked an unexpected outbound request");
    }
    const endpoint = endpointFor(url);
    const count = this.counts(endpoint); count.attempts += 1; this.invocationRequests += 1;
    if (this.invocationRequests > this.config.maxExternalRequests) { this.metrics.limitViolations += 1; throw new Error("Simulated external request budget exceeded"); }
    let response: Response;
    if (endpoint === "token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("refresh_token") !== "simulator-refresh-token" || body.get("client_id") !== "simulator-client") {
        this.metrics.unexpectedRequests += 1; throw new Error("Simulator only accepts its synthetic credentials");
      }
      const token = `simulator-access-${++this.tokenNumber}`; this.tokens.set(token, this.now() + 3600_000);
      response = json({ access_token: token, scope: SCOPES, expires_in: 3600 });
    } else {
      this.ordinal += 1;
      if (this.now() < this.reportedUntil && this.reportedInvocation !== this.invocation) this.metrics.earlyRequests += 1;
      const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : {}));
      const token = (headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      if (this.config.apiFaults && this.ordinal === 25) { this.tokens.delete(token); this.metrics.injectedExpiry += 1; }
      if ((this.tokens.get(token) ?? 0) <= this.now()) { count.unauthorized += 1; response = failure(401); }
      else if (this.config.apiFaults && this.ordinal === 23) {
        count.failed += 1; count.network += 1; this.metrics.injectedNetwork += 1; this.error(endpoint, 0, "network disconnect");
        throw new TypeError("Injected network disconnect");
      } else if (this.config.apiFaults && this.ordinal >= 5 && this.ordinal <= 10) {
        this.metrics.injected503 += 1; this.error(endpoint, 503, "injected outage"); response = failure(503);
      } else {
        const key = this.config.sharedQuota ? "shared" : endpoint === "tracks" ? "metadata" : "catalogue";
        const capacity = this.config.sharedQuota || (endpoint === "tracks" ? this.config.trackQuota : this.config.catalogueQuota);
        const periodMs = this.config.quotaWindowSeconds * 1000;
        const period = Math.floor((this.now() - this.epoch) / periodMs);
        let bucket = this.buckets.get(key);
        if (!bucket || bucket.period !== period) {
          if (bucket) this.metrics.quotaWindowResets += 1;
          bucket = { period, used: 0 }; this.buckets.set(key, bucket);
        }
        const rollingMs = this.config.rollingWindowSeconds * 1000;
        this.rolling = this.rolling.filter((at) => at > this.now() - rollingMs);
        if (bucket.used >= capacity) response = this.rateResponse(endpoint, Math.max(1, Math.ceil((this.epoch + (period + 1) * periodMs - this.now()) / 1000)), true);
        else if (this.config.rollingLimit > 0 && this.rolling.length >= this.config.rollingLimit) {
          response = this.rateResponse(endpoint, Math.max(1, Math.ceil((this.rolling[0]! + rollingMs - this.now()) / 1000)), false);
        } else { bucket.used += 1; this.rolling.push(this.now()); response = this.route(url); }
      }
    }
    if (response.ok) count.succeeded += 1;
    else { count.failed += 1; if (response.status === 403 || response.status === 404) count.unavailable += 1; }
    return response;
  };
}
