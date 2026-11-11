export type RecentTrack = {
  spotify_id: string;
  recordingId?: string;
  title: string;
  artists: { id: string; name: string }[];
  album_name: string;
  image_url: string | null;
  spotify_url: string;
};
export type HistoryStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export const RECENT_HISTORY_KEY = "ferto-recent-tracks-v1";
export const RECENT_HISTORY_LIMIT = 20;
const MAX_STORED_LENGTH = 250_000;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const key = (track: RecentTrack) => validId(track.recordingId) ? track.recordingId : track.spotify_id;

/** Stored browser data is untrusted; retain only bounded metadata and safe URLs. */
function parseTrack(value: unknown): RecentTrack | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.spotify_id !== "string" || !/^[A-Za-z0-9]{22}$/.test(row.spotify_id)
    || typeof row.title !== "string" || row.title.length > 4096
    || typeof row.album_name !== "string" || row.album_name.length > 4096
    || !Array.isArray(row.artists) || row.artists.length > 100) return null;
  const artists: RecentTrack["artists"] = [];
  for (const item of row.artists) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string" || item.id.length > 256 || item.name.length > 1024) return null;
    artists.push({ id: item.id, name: item.name });
  }
  const image = typeof row.image_url === "string" && row.image_url.length <= 4096
    && !/[\u0000-\u0020\\]/.test(row.image_url) && /^(?:https:\/\/|\/(?!\/))/.test(row.image_url) ? row.image_url : null;
  return { spotify_id: row.spotify_id, recordingId: validId(row.recordingId) ? row.recordingId : undefined,
    title: row.title, artists, album_name: row.album_name, image_url: image,
    spotify_url: `https://open.spotify.com/track/${row.spotify_id}` };
}

export class RecentHistory {
  private items: RecentTrack[] = [];
  // items.length is a gap after removing the last current card: Back remains useful.
  private cursor = -1;
  constructor(private storage: HistoryStorage | null = null) {
    try {
      const raw = storage?.getItem(RECENT_HISTORY_KEY);
      if (!raw || raw.length > MAX_STORED_LENGTH) return;
      const state = JSON.parse(raw) as { version?: unknown; items?: unknown; cursor?: unknown } | null;
      if (state?.version !== 1 || !Array.isArray(state.items) || state.items.length > RECENT_HISTORY_LIMIT
        || !Number.isInteger(state.cursor) || typeof state.cursor !== "number" || state.cursor < -1 || state.cursor > state.items.length) return;
      const parsed = state.items.map(parseTrack);
      if (parsed.some(item => item === null) || (parsed.length && state.cursor < 0)) return;
      this.items = parsed.filter((item): item is RecentTrack => item !== null);
      this.cursor = state.cursor;
    } catch { /* Storage denial/corruption leaves usable in-memory navigation. */ }
  }
  get current(): RecentTrack | null { return this.items[this.cursor] ?? null; }
  get size(): number { return this.items.length; }
  get position(): number { return this.current ? this.cursor + 1 : 0; }
  get canBack(): boolean { return this.items.length > 0 && this.cursor > 0; }
  get canForward(): boolean { return this.cursor >= 0 && this.cursor + 1 < this.items.length; }
  private persist() {
    try {
      const data = JSON.stringify({ version: 1, items: this.items, cursor: this.cursor });
      if (data.length <= MAX_STORED_LENGTH) this.storage?.setItem(RECENT_HISTORY_KEY, data);
      else this.storage?.removeItem(RECENT_HISTORY_KEY);
    } catch { /* Full/disabled storage never prevents browsing. */ }
  }
  append(value: RecentTrack): RecentTrack {
    const item = parseTrack(value);
    if (!item) throw new Error("Invalid recommendation metadata");
    if (this.current?.spotify_id === item.spotify_id) this.items[this.cursor] = item;
    else {
      this.items = this.items.slice(0, this.cursor + 1);
      this.items.push(item);
      if (this.items.length > RECENT_HISTORY_LIMIT) this.items.shift();
      this.cursor = this.items.length - 1;
    }
    this.persist(); return item;
  }
  back(): RecentTrack | null {
    if (!this.canBack) return null;
    this.cursor--; this.persist(); return this.current;
  }
  forward(): RecentTrack | null {
    if (!this.canForward) return null;
    this.cursor++; this.persist(); return this.current;
  }
  deselect(): null {
    // An empty fresh draw has no selected card, but Back can still visit the
    // most recently shown card rather than skipping it or losing the history.
    this.cursor = this.items.length;
    this.persist(); return null;
  }
  removeRecording(track: RecentTrack, confirmedId?: unknown): RecentTrack | null {
    const keys = new Set([key(track)]);
    if (validId(confirmedId)) keys.add(confirmedId);
    const remove = (item: RecentTrack) => item.spotify_id === track.spotify_id || keys.has(key(item));
    const current = this.current;
    const oldCursor = this.cursor;
    let next = -1;
    const retained: RecentTrack[] = [];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (remove(item)) continue;
      if (index > oldCursor && next < 0) next = retained.length;
      retained.push(item);
    }
    this.items = retained;
    this.cursor = current && !remove(current) ? retained.indexOf(current) : next >= 0 ? next : retained.length;
    this.persist(); return this.current;
  }
}
