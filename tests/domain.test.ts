import { describe, expect, it } from "vitest";
import { compareRepresentatives, isStrictlyPlayable, knownRecordingKey, likeOperationOrder, normalizeIsrc, ownerSessionMatches, pickRepresentative, recordingKey, Recording, releaseSortKey, selectRecording, toRecording } from "../src/domain";

const trackId = "1234567890123456789012";
const artistId = "zyxwvutsrqponmlkjihgfe";

const fullTrack = (overrides: Record<string, unknown> = {}) => ({
  id: trackId,
  uri: `spotify:track:${trackId}`,
  name: "Song",
  is_playable: true,
  artists: [{ id: artistId, name: "Primary" }, { id: "aaaaaaaaaaaaaaaaaaaaa", name: "Featured" }],
  album: { name: "Album", release_date: "2020-05-01", images: [{ url: "https://i.scdn.co/image" }] },
  external_ids: { isrc: "US-ABC-21-00001" },
  external_urls: { spotify: `https://open.spotify.com/track/${trackId}` },
  ...overrides,
});

const recording = (overrides: Partial<Recording> = {}): Recording => ({
  recording_key: "isrc:USABC2100001",
  spotify_id: trackId,
  isrc: "USABC2100001",
  title: "Song",
  album_name: "Album",
  release_date: "2020-05-01",
  image_url: "https://i.scdn.co/image",
  spotify_url: `https://open.spotify.com/track/${trackId}`,
  artists: [{ id: artistId, name: "Primary" }],
  bucket_artist_id: artistId,
  ...overrides,
});

describe("recording identity", () => {
  it("normalizes hyphenated ISRCs to one canonical form and rejects junk", () => {
    expect(normalizeIsrc("US-ABC-21-00001")).toBe("USABC2100001");
    expect(normalizeIsrc("us abc 21 00001")).toBe("USABC2100001");
    expect(normalizeIsrc("USABC2100001")).toBe("USABC2100001");
    expect(normalizeIsrc("US-ABC-21-0000")).toBeNull();
    expect(normalizeIsrc("not-an-isrc!")).toBeNull();
    expect(normalizeIsrc("123456789012")).toBe("123456789012");
    expect(normalizeIsrc(null)).toBeNull();
  });

  it("prefers the ISRC identity and falls back to the exact Spotify id", () => {
    expect(recordingKey("USABC2100001", trackId)).toBe("isrc:USABC2100001");
    expect(recordingKey(null, trackId)).toBe(`spotify:${trackId}`);
    expect(recordingKey(undefined, trackId)).toBe(`spotify:${trackId}`);
    // An unconfirmed (empty) ISRC is no identity at all: fall back to the id.
    expect(recordingKey("", trackId)).toBe(`spotify:${trackId}`);
  });

  it("orders partial release dates consistently, treating unknown dates as latest", () => {
    expect(["2019", "2019-12", "2019-12-31", "2020", null].map(releaseSortKey)).toEqual(["2019", "2019-12", "2019-12-31", "2020", "9999"]);
    // The sort keys must actually order: every earlier form is strictly smaller,
    // and unknown (null or malformed) sorts after every concrete date.
    const ascending = ["1999-12-31", "2019", "2019-12", "2019-12-31", "2020"];
    for (let i = 1; i < ascending.length; i += 1) {
      expect(releaseSortKey(ascending[i - 1])! < releaseSortKey(ascending[i])!, `expected ${ascending[i - 1]} < ${ascending[i]}`).toBe(true);
    }
    for (const date of ascending) {
      expect(releaseSortKey(date)! < releaseSortKey(null)).toBe(true);
      expect(releaseSortKey(date)! < releaseSortKey("2020-13-99")).toBe(true);
    }
  });

  it("rejects impossible calendar dates as unknown", () => {
    expect(releaseSortKey("2020-13-01")).toBe("9999");
    expect(releaseSortKey("2020-00-01")).toBe("9999");
    expect(releaseSortKey("2020-13-99")).toBe("9999");
    expect(releaseSortKey("2020-01-00")).toBe("9999");
    expect(releaseSortKey("2019-02-29")).toBe("9999");
    expect(releaseSortKey("2020-02-29")).toBe("2020-02-29");
    expect(releaseSortKey("2020-02-30")).toBe("9999");
    expect(releaseSortKey("2020-04-31")).toBe("9999");
    expect(releaseSortKey("1900-02-29")).toBe("9999");
    expect(releaseSortKey("2000-02-29")).toBe("2000-02-29");
    expect(releaseSortKey("2020-4-1")).toBe("9999");
    expect(releaseSortKey("next friday")).toBe("9999");
  });
});

describe("one representative per recording", () => {
  it("prefers the earliest release, then artwork, then the smaller Spotify id", () => {
    const earliest = recording({ release_date: "2019" });
    const later = recording({ release_date: "2019-12" });
    expect(compareRepresentatives(earliest, later)).toBeLessThan(0);
    expect(compareRepresentatives(later, earliest)).toBeGreaterThan(0);
    // Same date: artwork beats the bare cover even though its Spotify id is larger.
    const bare = recording({ release_date: "2019", image_url: null, spotify_id: "0000000000000000000000" });
    const illustrated = recording({ release_date: "2019", image_url: "https://i.scdn.co/image", spotify_id: "9999999999999999999999" });
    expect(pickRepresentative([bare, illustrated])).toMatchObject({ spotify_id: "9999999999999999999999" });
    // Same date and artwork: smaller Spotify id wins.
    expect(pickRepresentative([recording({ spotify_id: "b" }), recording({ spotify_id: "a" })])).toMatchObject({ spotify_id: "a" });
    // Unknown or malformed dates lose against any concrete date.
    expect(pickRepresentative([recording({ release_date: null }), earliest])).toMatchObject({ release_date: "2019" });
    expect(pickRepresentative([recording({ release_date: "2020-13-99" }), earliest])).toMatchObject({ release_date: "2019" });
    // When no date is known anywhere, artwork still breaks the tie.
    const unknownBare = recording({ release_date: null, image_url: null, spotify_id: "0000000000000000000000" });
    const unknownIllustrated = recording({ release_date: null, image_url: "https://i.scdn.co/image", spotify_id: "9999999999999999999999" });
    expect(pickRepresentative([unknownBare, unknownIllustrated])).toMatchObject({ spotify_id: "9999999999999999999999" });
    expect(pickRepresentative([])).toBeUndefined();
  });
});

describe("strict owner-market playability", () => {
  it("requires Spotify to affirm is_playable and rejects local or incomplete tracks", () => {
    expect(isStrictlyPlayable(fullTrack())).toBe(true);
    expect(isStrictlyPlayable(fullTrack({ is_playable: undefined }))).toBe(false);
    expect(isStrictlyPlayable(fullTrack({ is_playable: false }))).toBe(false);
    expect(isStrictlyPlayable(fullTrack({ is_local: true }))).toBe(false);
  });

  it("maps an enriched track to a recording with ordered credits and bucket artist", () => {
    const row = toRecording(fullTrack(), artistId);
    expect(row).toMatchObject({ recording_key: "isrc:USABC2100001", spotify_id: trackId, bucket_artist_id: artistId });
    expect(row?.artists).toEqual([{ id: artistId, name: "Primary" }, { id: "aaaaaaaaaaaaaaaaaaaaa", name: "Featured" }]);
    expect(toRecording(fullTrack({ is_playable: false }), artistId)).toBeNull();
    expect(toRecording(fullTrack({ album: { name: "" } }), artistId)).toBeNull();
    expect(toRecording(fullTrack({ external_urls: {} }), artistId)).toBeNull();
    expect(toRecording(fullTrack({ artists: [] }), artistId)).toBeNull();
    expect(toRecording(fullTrack({ id: "short" }), artistId)).toBeNull();
    // A track without a confirmed ISRC keeps its exact-id identity.
    expect(toRecording(fullTrack({ external_ids: {} }), artistId)).toMatchObject({ recording_key: `spotify:${trackId}`, isrc: null });
  });

  it("derives known-track keys with the same identity function", () => {
    expect(knownRecordingKey(fullTrack())).toBe("isrc:USABC2100001");
    expect(knownRecordingKey(fullTrack({ external_ids: {} }))).toBe(`spotify:${trackId}`);
    expect(knownRecordingKey(fullTrack({ is_local: true }))).toBeNull();
    expect(knownRecordingKey(fullTrack({ id: "junk" }))).toBeNull();
  });
});

describe("uniform artist-bucket recommendation", () => {
  const rows = [
    { bucket_artist_id: "a", id: 1 },
    { bucket_artist_id: "a", id: 2 },
    { bucket_artist_id: "a", id: 3 },
    { bucket_artist_id: "b", id: 4 },
  ];
  it("picks an artist bucket uniformly, then a recording inside it", () => {
    expect(selectRecording(rows, () => 0)).toMatchObject({ bucket_artist_id: "a", id: 1 });
    expect(selectRecording(rows, () => 0.99)).toMatchObject({ bucket_artist_id: "b", id: 4 });
    // Bucket chosen, then the last row inside that bucket.
    expect(selectRecording(rows, () => 0.5)).toMatchObject({ bucket_artist_id: "b", id: 4 });
    expect(selectRecording([], () => 0.5)).toBeUndefined();
  });
  it("keeps every recording of a bucket reachable regardless of bucket size", () => {
    const seen = new Set(rows.filter((row) => row.bucket_artist_id === "a").map((row) => row.id));
    // The three-track bucket is reachable through its own uniform draw.
    expect(selectRecording([{ bucket_artist_id: "a", id: 1 }], () => 0.9)).toMatchObject({ id: 1 });
    expect(seen.size).toBe(3);
  });
});

describe("owner boundaries", () => {
  it("rejects a visitor or an owner session for a different Spotify account", () => {
    expect(ownerSessionMatches(undefined, "configured-owner")).toBe(false);
    expect(ownerSessionMatches("another-user", "configured-owner")).toBe(false);
    expect(ownerSessionMatches("configured-owner", "configured-owner")).toBe(true);
  });

  it("only excludes a recording after the Spotify save sequencing succeeds", () => {
    expect(likeOperationOrder(false)).toEqual(["spotify-save"]);
    expect(likeOperationOrder(true)).toEqual(["spotify-save", "exclude-recording"]);
  });
});
