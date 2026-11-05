import { fetchWithDeadline } from "./request";

/**
 * Refresh the service token created by scripts/spotify-authorize.mjs.
 *
 * That helper uses Authorization Code with PKCE, so Spotify requires the
 * public client id in the form body and no HTTP Basic client-secret header.
 * Callers deliberately parse errors themselves because the rebuild state
 * machine and interactive owner actions have different retry semantics.
 */
export function refreshSpotifyAccessToken(env: Env, refreshToken: string, timeoutMs = 10_000): Promise<Response> {
  return fetchWithDeadline("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.SPOTIFY_CLIENT_ID,
    }),
  }, timeoutMs);
}
