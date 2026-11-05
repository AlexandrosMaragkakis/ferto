export type Scenario = "smoke" | "quota" | "chaos" | "soak" | "warm";
export type SimulationConfig = {
  scenario: Scenario;
  seed: number;
  artists: number;
  initialLiveArtists: number;
  albumsPerArtist: number;
  prolificArtistAlbums: number;
  scheduler: "fair" | "serial";
  tracksPerAlbum: number;
  playlists: number;
  runs: number;
  betweenRunsSeconds: number;
  trackQuota: number;
  catalogueQuota: number;
  sharedQuota: number;
  quotaWindowSeconds: number;
  retryAfter: "seconds" | "date" | "missing";
  rollingLimit: number;
  rollingWindowSeconds: number;
  duplicateEvery: number;
  crashes: number;
  dispatchFailures: number;
  lostMessages: number;
  apiFaults: boolean;
  availabilityChanges: boolean;
  maxDeliveries: number;
  maxVirtualDays: number;
  maxStatements: number;
  maxExternalRequests: number;
};

const defaults: SimulationConfig = {
  scenario: "smoke", seed: 42, artists: 12, initialLiveArtists: 0, albumsPerArtist: 2, prolificArtistAlbums: 0, scheduler: "fair", tracksPerAlbum: 8, playlists: 4,
  runs: 1, betweenRunsSeconds: 3600, trackQuota: 100_000, catalogueQuota: 100_000, sharedQuota: 0,
  quotaWindowSeconds: 86_400, retryAfter: "seconds", rollingLimit: 0, rollingWindowSeconds: 30,
  duplicateEvery: 0, crashes: 0, dispatchFailures: 0, lostMessages: 0, apiFaults: false, availabilityChanges: false,
  maxDeliveries: 200_000, maxVirtualDays: 366, maxStatements: 50, maxExternalRequests: 50,
};
export const SCENARIOS: Record<Scenario, Partial<SimulationConfig>> = {
  smoke: {},
  quota: { artists: 40, trackQuota: 40, catalogueQuota: 80, quotaWindowSeconds: 172_800 },
  chaos: { artists: 40, trackQuota: 40, catalogueQuota: 100, quotaWindowSeconds: 7200,
    retryAfter: "missing", rollingLimit: 12, duplicateEvery: 11, crashes: 2,
    dispatchFailures: 1, lostMessages: 1, apiFaults: true },
  soak: { artists: 1600, trackQuota: 500, catalogueQuota: 5000, rollingLimit: 20,
    duplicateEvery: 97, crashes: 3, dispatchFailures: 1, lostMessages: 1, apiFaults: true },
  warm: { artists: 40, runs: 2 },
};

export function simulationConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  const scenario = overrides.scenario ?? "smoke";
  if (!Object.hasOwn(SCENARIOS, scenario)) throw new Error(`Unknown scenario: ${String(scenario)}`);
  const config = { ...defaults, ...SCENARIOS[scenario], ...overrides };
  const positive = ["artists", "albumsPerArtist", "tracksPerAlbum", "playlists", "runs", "trackQuota", "catalogueQuota", "quotaWindowSeconds", "rollingWindowSeconds", "maxDeliveries", "maxVirtualDays", "maxStatements", "maxExternalRequests"] as const;
  for (const key of positive) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  for (const key of ["sharedQuota", "initialLiveArtists", "prolificArtistAlbums", "seed", "betweenRunsSeconds", "rollingLimit", "duplicateEvery", "crashes", "dispatchFailures", "lostMessages"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new Error(`${key} must be a nonnegative integer`);
  }
  if (config.initialLiveArtists > config.artists) throw new Error("initialLiveArtists cannot exceed artists");
  if (config.playlists < 4 || config.tracksPerAlbum < 6) throw new Error("Fixtures require at least 4 playlists and 6 tracks per album");
  if ((config.artists * config.albumsPerArtist + config.prolificArtistAlbums) * config.tracksPerAlbum > 1_000_000) throw new Error("Limit the generated fixture to one million track appearances");
  if (config.playlists > 10_000 || config.quotaWindowSeconds > 864_000_000 || config.betweenRunsSeconds > 864_000_000) throw new Error("Playlist/time bounds are too large");
  if (config.runs > 20 || config.crashes > 100 || config.maxDeliveries > 2_000_000 || config.maxVirtualDays > 10_000) throw new Error("Simulation bounds are too large");
  if (!["seconds", "date", "missing"].includes(config.retryAfter)) throw new Error("retryAfter must be seconds, date or missing");
  if (!["fair", "serial"].includes(config.scheduler)) throw new Error("Unknown scheduler");
  if (typeof config.apiFaults !== "boolean") throw new Error("apiFaults must be a boolean");
  if (typeof config.availabilityChanges !== "boolean") throw new Error("availabilityChanges must be a boolean");
  if (config.availabilityChanges && (config.tracksPerAlbum < 8 || config.albumsPerArtist < 2)) throw new Error("availabilityChanges needs at least two albums and eight tracks per album");
  return config;
}

export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = Math.imul(value ^ value >>> 15, 1 | value);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}
