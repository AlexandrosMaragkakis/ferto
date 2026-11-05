export type Credit = { id: string; name: string };

/** One recommendable recording. Identity is ISRC-first, Spotify-id fallback. */
export type Recording = {
  recording_key: string;
  spotify_id: string;
  isrc: string | null;
  title: string;
  album_name: string;
  release_date: string | null;
  image_url: string | null;
  spotify_url: string;
  /** Ordered credits; the first entry is the primary artist. */
  artists: Credit[];
  /** Seed artist whose catalogue crawl contributed this recording. */
  bucket_artist_id: string;
};

type SpotifyArtistShape = { id?: unknown; name?: unknown };
type SpotifyTrackShape = {
  id?: unknown;
  uri?: unknown;
  name?: unknown;
  artists?: SpotifyArtistShape[] | null;
  album?: { name?: unknown } | null;
  external_ids?: { isrc?: unknown } | null;
  external_urls?: { spotify?: unknown } | null;
  is_local?: unknown;
  is_playable?: unknown;
  restrictions?: unknown;
};

const TRACK_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

/** ISRCs arrive hyphenated and mixed-case; store one canonical uppercase form. */
export function normalizeIsrc(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.toUpperCase().replaceAll("-", "").replaceAll(" ", "");
  return /^[A-Z0-9]{12}$/.test(normalized) ? normalized : null;
}

/** Recording identity: normalized ISRC when confirmed, otherwise exact Spotify id. */
export function recordingKey(isrc: string | null | undefined, spotifyId: string): string {
  return isrc ? `isrc:${isrc}` : `spotify:${spotifyId}`;
}

export function isTrackId(value: unknown): value is string {
  return typeof value === "string" && TRACK_ID_PATTERN.test(value);
}

const RELEASE_DATE_PATTERN = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Partial release dates order consistently lexicographically:
 * "2019" < "2019-12" < "2019-12-31" < "2020". Missing or malformed dates sort
 * as the latest possible release so known dates win representative selection.
 */
export function releaseSortKey(releaseDate: string | null | undefined): string {
  if (typeof releaseDate !== "string") return "9999";
  const match = RELEASE_DATE_PATTERN.exec(releaseDate);
  if (!match) return "9999";
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  if (month < 1 || month > 12) return "9999";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maxDay ? releaseDate : "9999";
}

export function compareRepresentatives(a: Recording, b: Recording): number {
  const byRelease = releaseSortKey(a.release_date).localeCompare(releaseSortKey(b.release_date));
  if (byRelease !== 0) return byRelease;
  const byArtwork = Number(b.image_url !== null) - Number(a.image_url !== null);
  if (byArtwork !== 0) return byArtwork;
  return a.spotify_id.localeCompare(b.spotify_id);
}

export function pickRepresentative(rows: Recording[]): Recording | undefined {
  return rows.length ? rows.reduce((best, row) => (compareRepresentatives(row, best) < 0 ? row : best)) : undefined;
}

export function parseCredits(artists: SpotifyTrackShape["artists"]): Credit[] {
  const credits: Credit[] = [];
  for (const artist of artists ?? []) {
    if (typeof artist?.id === "string" && artist.id && typeof artist.name === "string" && artist.name && !credits.some((credit) => credit.id === artist.id)) credits.push({ id: artist.id, name: artist.name });
  }
  return credits;
}

/** Strict market playability: Spotify must affirm is_playable in the owner market. */
export function isStrictlyPlayable(track: SpotifyTrackShape): boolean {
  return track.is_playable === true && track.is_local !== true && !track.restrictions;
}

type EnrichedTrack = SpotifyTrackShape & {
  uri?: unknown;
  album?: { name?: unknown; release_date?: unknown; images?: { url?: unknown }[] | null } | null;
};

/** Convert one fully enriched Spotify track into a candidate recording row. */
export function toRecording(track: EnrichedTrack, bucketArtistId: string): Recording | null {
  if (!isTrackId(track.id) || typeof track.uri !== "string" || !track.uri) return null;
  if (typeof track.name !== "string" || !track.name) return null;
  if (typeof track.album?.name !== "string" || !track.album.name) return null;
  if (typeof track.external_urls?.spotify !== "string" || !track.external_urls.spotify) return null;
  if (!isStrictlyPlayable(track)) return null;
  const artists = parseCredits(track.artists);
  if (!artists.length) return null;
  const isrc = normalizeIsrc(track.external_ids?.isrc);
  return {
    recording_key: recordingKey(isrc, track.id),
    spotify_id: track.id,
    isrc,
    title: track.name,
    album_name: track.album.name,
    release_date: typeof track.album.release_date === "string" ? track.album.release_date : null,
    image_url: typeof track.album.images?.[0]?.url === "string" ? track.album.images[0].url : null,
    spotify_url: track.external_urls.spotify,
    artists,
    bucket_artist_id: bucketArtistId,
  };
}

/** Recording identity of an already-known (liked/playlist) track item. */
export function knownRecordingKey(track: SpotifyTrackShape): string | null {
  if (!isTrackId(track.id)) return null;
  if (track.is_local === true) return null;
  return recordingKey(normalizeIsrc(track.external_ids?.isrc), track.id);
}

export type BucketedRow = { bucket_artist_id: string };

/**
 * Uniform artist-bucket choice, then uniform recording inside the bucket.
 * Deliberately unweighted: no popularity, similarity, or genre logic.
 */
export function selectRecording<T extends BucketedRow>(rows: T[], random: () => number = Math.random): T | undefined {
  if (!rows.length) return undefined;
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const list = buckets.get(row.bucket_artist_id);
    if (list) list.push(row);
    else buckets.set(row.bucket_artist_id, [row]);
  }
  const keys = [...buckets.keys()];
  const bucketKey = keys[Math.floor(random() * keys.length)];
  const bucket = buckets.get(bucketKey)!;
  return bucket[Math.floor(random() * bucket.length)];
}

export function ownerSessionMatches(storedAccountId: string | undefined, configuredAccountId: string): boolean {
  return storedAccountId === configuredAccountId;
}

/** The successful Spotify save must precede any local exclusion. */
export function likeOperationOrder(spotifySaveSucceeded: boolean): readonly string[] {
  return spotifySaveSucceeded ? ["spotify-save", "exclude-recording"] : ["spotify-save"];
}
