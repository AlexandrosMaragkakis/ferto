import { describe, expect, it } from 'vitest';
import { progressText, retryText } from '../web/src/refresh-progress';

describe('owner refresh progress copy', () => {
  it('shows completion, cache savings, requests and partial history together', () => {
    const text = progressText({ progress: { seedArtists: 12, seedArtistsDone: 4, seedScanComplete: 1, tracksDiscovered: 200, tracksProcessed: 150, tracksFetched: 40, tracksCached: 100, tracksKnown: 10, stagedRecordings: 35 },
      requests: { tracks: { attempts: 45, succeeded: 40, failed: 5, rateLimited: 2, lastAttemptAt: 1, lastSuccessAt: 1 }, token: { attempts: 1, succeeded: 1, failed: 0, rateLimited: 0, lastAttemptAt: 1, lastSuccessAt: 1 } }, progressPartial: true });
    expect(text).toContain('Artists: 4/12 completed');
    expect(text).toContain('Song checks: 150/200 discovered so far (40 fetched, 100 cached, 10 already known)');
    expect(text).toContain('35 distinct recordings staged');
    expect(text).toContain('45 (5 failed, 2 rate/quota responses); 1 token requests');
    expect(text).toContain('Observed refresh requests:');
    expect(text).toContain('Counts may miss interrupted work');
    expect(text).toContain('remaining Spotify quota is unknown');
    expect(text).toContain('Earlier work is not included');
  });
  it('avoids a completion fraction while seeds are still being discovered', () => {
    expect(progressText({ progress: { seedArtists: 25, likedTracksScanned: 50 } })).toBe('25 artists discovered\n50 liked songs scanned');
    expect(progressText({ progress: { seedArtists: 0, seedScanComplete: 1 } })).toBe('Artists: 0/0 completed');
  });
  it('distinguishes discoveries already public from private staging', () => {
    expect(progressText({ progress: { stagedRecordings: 200, publishedRecordings: 12, publishedArtists: 3 } }))
      .toContain('Available already: 12 new recordings across 3 new artists');
  });
  it('separates provider timing from estimated quota backoff', () => {
    expect(retryText({ retryAt: 181_000, retrySource: 'spotify' }, 1_000)).toBe('Next attempt in 3 min (Spotify requested wait)');
    expect(retryText({ retryAt: 901_000, retrySource: 'backoff', waitReason: 'quota' }, 1_000)).toContain('15 min (estimated backoff; quota reset time unknown)');
    expect(retryText({ retryAfterSeconds: 3600, waitReason: 'upstream' })).not.toContain('quota');
    expect(retryText({ retryAt: 1000 }, 2000)).toContain('Next attempt is due');
  });
});
