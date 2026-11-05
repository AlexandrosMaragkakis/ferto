import type { RequestUsage } from "../../src/rebuild-progress";

export type ProgressSnapshot = {
  progress?: Record<string, number>;
  requests?: RequestUsage;
  requestCountBasis?: 'observed';
  progressPartial?: boolean;
  progressSinceAt?: number | null;
};

export function progressText(snapshot: ProgressSnapshot): string {
  const progress = snapshot.progress ?? {};
  const parts: string[] = [];
  const number = (key: string) => (progress[key] ?? 0).toLocaleString('en-GB');
  if (progress.seedScanComplete) parts.push(`Artists: ${number('seedArtistsDone')}/${number('seedArtists')} completed`);
  else if (progress.seedArtists !== undefined) parts.push(`${number('seedArtists')} artists discovered`);
  if (progress.likedTracksScanned !== undefined) parts.push(`${number('likedTracksScanned')} liked songs scanned`);
  if (progress.playlists !== undefined) parts.push(`Playlists: ${number('playlistsDone')}/${number('playlists')} completed`);
  if (progress.playlistTracksScanned !== undefined) parts.push(`${number('playlistTracksScanned')} playlist items checked`);
  if (progress.tracksDiscovered !== undefined || progress.tracksProcessed !== undefined) {
    parts.push(`Song checks: ${number('tracksProcessed')}/${number('tracksDiscovered')} discovered so far (${number('tracksFetched')} fetched, ${number('tracksCached')} cached, ${number('tracksKnown')} already known)`);
  }
  if (progress.stagedRecordings !== undefined) parts.push(`${number('stagedRecordings')} distinct recordings staged`);
  if (progress.publishedRecordings !== undefined) parts.push(`Available already: ${number('publishedRecordings')} new recordings across ${number('publishedArtists')} new artists`);
  const entries = Object.entries(snapshot.requests ?? {});
  const dataEntries = entries.filter(([endpoint]) => endpoint !== 'token');
  if (entries.length) {
    const attempts = dataEntries.reduce((sum, [, counts]) => sum + counts.attempts, 0);
    const failures = dataEntries.reduce((sum, [, counts]) => sum + counts.failed, 0);
    const limited = dataEntries.reduce((sum, [, counts]) => sum + counts.rateLimited, 0);
    const tokens = snapshot.requests?.token?.attempts ?? 0;
    parts.push(`Observed refresh requests: ${attempts.toLocaleString('en-GB')} (${failures} failed, ${limited} rate/quota responses); ${tokens} token requests`);
    parts.push('Counts may miss interrupted work and exclude other activity; remaining Spotify quota is unknown');
  }
  if (snapshot.progressPartial) parts.push('Earlier work is not included in all counts');
  return parts.join('\n');
}

export function retryText(snapshot: { retryAt?: number; retryAfterSeconds?: number; retrySource?: 'spotify' | 'backoff'; waitReason?: 'quota' | 'rate_limit' | 'upstream' }, currentTime = Date.now()): string {
  const seconds = snapshot.retryAt ? Math.max(0, Math.ceil((snapshot.retryAt - currentTime) / 1000)) : snapshot.retryAfterSeconds ?? 0;
  const minutes = Math.ceil(seconds / 60);
  const duration = seconds < 60 ? `${seconds}s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60} min`;
  const source = snapshot.retrySource === 'spotify' ? 'Spotify requested wait' : `estimated backoff${snapshot.waitReason === 'quota' ? '; quota reset time unknown' : ''}`;
  if (snapshot.retryAt && seconds === 0) return 'Next attempt is due; waiting for the worker';
  return `Next attempt in ${duration} (${source})`;
}
