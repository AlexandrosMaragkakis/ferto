import type { SimulationConfig } from "./config";
export const OWNER_ACCOUNT = "simulator-owner-account";
export const OWNER_PROFILE = "simulator-owner-profile";
export const SCOPES = "user-library-read user-library-modify playlist-read-private playlist-read-collaborative user-read-private";
export const spotifyId = (kind: string, value: number) => `${kind}${String(value).padStart(21, "0")}`;
type Artist = { id: string; name: string };
export type FixtureTrack = { requestedId: string; canonical: string; artistIndex: number; albumIndex: number; position: number;
  playable: boolean; unavailable: boolean; body: { id: string; uri: string; name: string; artists: Artist[];
    album: { name: string; release_date: string; images: { url: string }[] }; external_ids: { isrc: string };
    external_urls: { spotify: string }; is_playable: boolean; is_local: boolean } };
export type FixturePlaylist = { id: string; owner: { id: string }; collaborative: boolean; snapshot_id: string; items: FixtureTrack[]; disappeared: boolean };

export class SyntheticCatalogue {
  readonly artists: Artist[] = [];
  readonly albums = new Map<string, { id: string; name: string; images: { url: string }[]; tracks: FixtureTrack[] }>();
  readonly artistAlbums = new Map<string, string[]>();
  readonly tracks = new Map<string, FixtureTrack>();
  readonly likes: FixtureTrack[] = [];
  readonly playlists: FixturePlaylist[] = [];
  readonly never: { track: FixtureTrack; resolved: boolean }[] = [];
  readonly knownKeys = new Set<string>();
  readonly neverKeys = new Set<string>();
  readonly expected = new Map<string, FixtureTrack>();
  readonly appearances: number;
  constructor(readonly config: SimulationConfig) {
    this.appearances = (config.artists * config.albumsPerArtist + config.prolificArtistAlbums) * config.tracksPerAlbum;
    for (let p = 0; p < config.playlists; p++) this.playlists.push({ id: spotifyId("p", p), snapshot_id: `snapshot-${p}-v1`,
      owner: { id: p % 4 === 0 || p % 4 === 3 ? OWNER_PROFILE : "someone-else" }, collaborative: p % 4 === 1,
      items: [], disappeared: config.apiFaults && p === 3 });
    let trackOffset = 0;
    for (let a = 0; a < config.artists; a++) {
      const artist = { id: spotifyId("a", a), name: `Artist ${a + 1}` }; this.artists.push(artist);
      const albumIds: string[] = [];
      const albumsForArtist = config.albumsPerArtist + (a === 0 ? config.prolificArtistAlbums : 0);
      const artistTrackOffset = trackOffset;
      for (let b = 0; b < albumsForArtist; b++) {
        const index = this.albums.size;
        const album = { id: spotifyId("b", index), name: `Album ${a + 1}.${b + 1}`, images: [{ url: `https://images.invalid/${index}` }], tracks: [] as FixtureTrack[] };
        albumIds.push(album.id); this.albums.set(album.id, album);
        for (let t = 0; t < config.tracksPerAlbum; t++) {
          const ordinal = trackOffset++;
          // The first five positions recur as different Spotify releases of
          // the same recording. Later positions are unique to the album.
          const canonicalOrdinal = t < 5 ? artistTrackOffset + t : ordinal;
          const canonical = `USSIM${String(canonicalOrdinal).padStart(7, "0")}`;
          const requestedId = spotifyId("t", ordinal);
          const returnedId = a % 7 === 0 && b === 0 && t === config.tracksPerAlbum - 1 ? spotifyId("r", ordinal) : requestedId;
          const playable = !(a % 11 === 0 && b === albumsForArtist - 1 && t === config.tracksPerAlbum - 1);
          const unavailable = config.apiFaults && a % 17 === 0 && b === 0 && t === 5;
          const track: FixtureTrack = { requestedId, canonical, artistIndex: a, albumIndex: b, position: t, playable, unavailable,
            body: { id: returnedId, uri: `spotify:track:${returnedId}`, name: `Song ${ordinal + 1}`, artists: [artist],
              album: { name: album.name, release_date: `${2000 + b}-01-01`, images: album.images },
              external_ids: { isrc: canonical }, external_urls: { spotify: `https://open.spotify.com/track/${returnedId}` },
              is_playable: playable, is_local: false } };
          album.tracks.push(track); this.tracks.set(requestedId, track);
          if (returnedId !== requestedId) this.tracks.set(returnedId, track);
        }
      }
      this.artistAlbums.set(artist.id, albumIds);
      const first = this.albums.get(albumIds[0]!)!.tracks;
      this.likes.push(first[0]!); this.knownKeys.add(`isrc:${first[0]!.canonical}`);
      if (a % 5 === 0) { this.never.push({ track: first[1]!, resolved: a % 10 === 0 }); this.neverKeys.add(`isrc:${first[1]!.canonical}`); }
      const group = Math.floor(a / Math.max(1, Math.ceil(config.artists / Math.max(1, Math.floor(config.playlists / 4))))) * 4;
      for (let kind = 0; kind < 3; kind++) {
        const playlist = this.playlists[group + kind] ?? this.playlists[kind]!;
        const track = first[kind + 2]!; playlist.items.push(track);
        if (kind < 2) this.knownKeys.add(`isrc:${track.canonical}`);
      }
    }
    // A playlist containing already-liked songs disappears after its first
    // page in fault scenarios. The independent expected exclusion set remains
    // knowable even when later pages become unavailable.
    this.playlists[3]!.items.push(...this.likes.filter((track) => track.artistIndex % 2 === 1));
    this.deriveExpected();
  }
  private deriveExpected() {
    this.expected.clear();
    // Independent oracle: operate on generated fixture facts, never production
    // conversion/filter/promotion functions. Fixture dates already sort by album.
    for (const album of this.albums.values()) for (const track of album.tracks) {
      const key = `isrc:${track.canonical}`;
      if (track.playable && !track.unavailable && !this.knownKeys.has(key) && !this.neverKeys.has(key) && !this.expected.has(key)) this.expected.set(key, track);
    }
  }
  changeAvailability() {
    const playable = [...this.expected.values()].find((track) => track.position === 5)!;
    const unavailable = [...this.tracks.values()].find((track) => !track.playable)!;
    playable.playable = false; playable.body.is_playable = false;
    unavailable.playable = true; unavailable.body.is_playable = true;
    const relinked = [...this.expected.values()].find((track) => track.position >= 6 && track !== playable)!;
    const id = spotifyId("x", relinked.artistIndex * this.config.tracksPerAlbum + relinked.position);
    relinked.body.id = id; relinked.body.uri = `spotify:track:${id}`;
    relinked.body.external_urls.spotify = `https://open.spotify.com/track/${id}`;
    this.deriveExpected();
  }
  knownShape(track: FixtureTrack, idOnly = false) {
    return { id: track.requestedId, artists: track.body.artists, ...(idOnly ? {} : { external_ids: track.body.external_ids }) };
  }
}
