import { describe, it, expect } from "vitest";
import { RecentHistory, RECENT_HISTORY_KEY, RECENT_HISTORY_LIMIT, type RecentTrack, type HistoryStorage } from "../web/src/recent-history";

function track(index: number, recordingId?: string): RecentTrack {
  const id = String(index).padStart(22, "0");
  return { spotify_id: id, recordingId, title: `Track ${index}`, album_name: "Fixture", artists: [{ id: "artist", name: "Artist" }], image_url: null, spotify_url: `https://open.spotify.com/track/${id}` };
}
function storage(): HistoryStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe("recently shown cards", () => {
  it("navigates back/forward without replacing forward history", () => {
    const history = new RecentHistory();
    for (let i = 1; i <= 3; i++) history.append(track(i));
    expect(history.back()?.title).toBe("Track 2");
    expect(history.back()?.title).toBe("Track 1");
    expect(history.back()).toBeNull();
    expect(history.forward()?.title).toBe("Track 2");
    expect(history.forward()?.title).toBe("Track 3");
    expect(history.forward()).toBeNull();
    expect(history.size).toBe(3);
  });
  it("keeps only 20 cards and does not add a consecutive duplicate", () => {
    const history = new RecentHistory();
    for (let i = 1; i <= 22; i++) history.append(track(i));
    history.append({ ...track(22), title: "Updated metadata" });
    expect(history.size).toBe(RECENT_HISTORY_LIMIT);
    expect(history.current?.title).toBe("Updated metadata");
    while (history.canBack) history.back();
    expect(history.current?.title).toBe("Track 3");
    expect(history.position).toBe(1);
  });
  it("purges canonical aliases and upgraded legacy identities after confirmation", () => {
    const history = new RecentHistory();
    const canonical = "a".repeat(64);
    history.append(track(1)); // Old card predating canonical identity enrichment.
    history.append(track(2, canonical));
    history.append(track(3, "b".repeat(64)));
    history.back(); history.back();
    const next = history.removeRecording(history.current!, canonical);
    expect(next?.title).toBe("Track 3");
    expect(history.size).toBe(1);
    expect(history.canBack).toBe(false);
    expect(history.canForward).toBe(false);
  });
  it("leaves a gap after removing the last card so Back can recover an earlier pick", () => {
    const history = new RecentHistory();
    history.append(track(1)); history.append(track(2));
    expect(history.removeRecording(history.current!)).toBeNull();
    expect(history.canBack).toBe(true);
    expect(history.back()?.title).toBe("Track 1");
    expect(history.forward()).toBeNull();
    history.append(track(3)); expect(history.size).toBe(2);
  });
  it("keeps the most recent card reachable after an empty fresh draw", () => {
    const history = new RecentHistory();
    history.append(track(1)); history.deselect();
    expect(history.current).toBeNull();
    expect(history.canBack).toBe(true);
    expect(history.back()?.title).toBe("Track 1");
    expect(history.canBack).toBe(false);
  });
  it("persists the bounded per-tab cursor and confirmed removals", () => {
    const data = storage();
    const history = new RecentHistory(data);
    history.append(track(1)); history.append(track(2)); history.back();
    const restored = new RecentHistory(data);
    expect(restored.current?.title).toBe("Track 1");
    expect(restored.forward()?.title).toBe("Track 2");
    restored.removeRecording(restored.current!);
    const after = new RecentHistory(data);
    expect(after.current).toBeNull(); expect(after.back()?.title).toBe("Track 1");
  });
  it("ignores corrupt/oversized state and sanitizes stored URLs", () => {
    const data = storage();
    for (const raw of ["broken json", "x".repeat(250001), JSON.stringify({ version: 1, items: [track(1)], cursor: 4 }), JSON.stringify({ version: 1, items: [{ ...track(1), spotify_id: "bad" }], cursor: 0 })]) {
      data.setItem(RECENT_HISTORY_KEY, raw);
      expect(new RecentHistory(data).size).toBe(0);
    }
    data.setItem(RECENT_HISTORY_KEY, JSON.stringify({ version: 1, items: [{ ...track(1), spotify_url: "javascript:bad()", image_url: "javascript:bad()" }], cursor: 0 }));
    const item = new RecentHistory(data).current!;
    expect(item.spotify_url).toBe(`https://open.spotify.com/track/${track(1).spotify_id}`);
    expect(item.image_url).toBeNull();
  });
  it("keeps in-memory navigation when storage is blocked or full", () => {
    const fail = () => { throw new Error("Storage unavailable"); };
    const history = new RecentHistory({ getItem: fail, setItem: fail, removeItem: fail });
    history.append(track(1)); history.append(track(2));
    expect(history.back()?.title).toBe("Track 1");
  });
});
