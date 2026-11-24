export const STORAGE_LIMIT_BYTES = 500_000_000;
export const STORAGE_WARN_BYTES = 375_000_000;
export const STORAGE_PAUSE_BYTES = 400_000_000;
export const STORAGE_RESUME_BYTES = 350_000_000;
export const USAGE_READ_PAUSE = 3_500_000;
export const USAGE_WRITE_PAUSE = 70_000;
export const MAX_PENDING_SAVES = 32;
export const SAVE_LEASE_MS = 120_000;
const DAY_MS = 86_400_000;

export type Capacity = {
  bytes: number | null; checkedAt: number | null; paused: boolean;
  reason: "storage" | "daily_reads" | "daily_writes" | null;
  warning: boolean; limitBytes: number; warningBytes: number; pauseBytes: number; resumeBytes: number;
};
type Measurement = { bytes: number | null; checkedAt: number | null; storagePaused: boolean };
type Usage = { date: string; rowsRead: number; rowsWritten: number; blocked: "daily_reads" | "daily_writes" | null };
export type PendingSave = { trackId: string; recordingKey: string; operation: string; state: "intent" | "confirmed"; updatedAt: number };
type Budget = { expiresAt: number; total: number; clients: Record<string, number> };
export type ControlStore = Pick<SyncKvStorage, "get" | "put" | "delete" | "list">;

/** Pure synchronous state transitions; the DO wraps mutations in transactions.
 * One object coordinates one configured Spotify owner/client, not HTTP work. */
export class StorageControlState {
  constructor(private readonly store: ControlStore) {}

  private usage(now: number): Usage {
    const date = new Date(now).toISOString().slice(0, 10);
    const stored = this.store.get<Usage>("usage");
    return stored?.date === date ? stored : { date, rowsRead: 0, rowsWritten: 0, blocked: null };
  }

  snapshot(now = Date.now()) {
    const measurement = this.store.get<Measurement>("capacity") ?? { bytes: null, checkedAt: null, storagePaused: false };
    const usage = this.usage(now);
    const daily = usage.blocked ?? (usage.rowsRead >= USAGE_READ_PAUSE ? "daily_reads" : usage.rowsWritten >= USAGE_WRITE_PAUSE ? "daily_writes" : null);
    const capacity: Capacity = { bytes: measurement.bytes, checkedAt: measurement.checkedAt,
      paused: measurement.storagePaused || daily !== null, reason: measurement.storagePaused ? "storage" : daily,
      warning: measurement.bytes !== null && measurement.bytes >= STORAGE_WARN_BYTES,
      limitBytes: STORAGE_LIMIT_BYTES, warningBytes: STORAGE_WARN_BYTES, pauseBytes: STORAGE_PAUSE_BYTES, resumeBytes: STORAGE_RESUME_BYTES };
    return { capacity, usage: { ...usage, basis: "this-worker-observed" as const }, pendingSaves: this.saves().filter(row => row.state === "confirmed").length };
  }

  observeCapacity(bytes: number, checkedAt = Date.now()) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid capacity measurement");
    const previous = this.store.get<Measurement>("capacity");
    if (previous?.checkedAt !== null && previous?.checkedAt !== undefined && previous.checkedAt > checkedAt) return this.snapshot();
    const storagePaused = bytes >= STORAGE_PAUSE_BYTES || Boolean(previous?.storagePaused && bytes > STORAGE_RESUME_BYTES);
    this.store.put("capacity", { bytes, checkedAt, storagePaused } satisfies Measurement);
    return this.snapshot();
  }

  noteFailure(kind: "storage" | "daily_reads" | "daily_writes", now = Date.now()) {
    if (kind === "storage") {
      const previous = this.store.get<Measurement>("capacity") ?? { bytes: null, checkedAt: null, storagePaused: false };
      this.store.put("capacity", { ...previous, checkedAt: now, storagePaused: true });
    } else {
      this.store.put("usage", { ...this.usage(now), blocked: kind });
    }
    return this.snapshot(now);
  }

  recordUsage(rowsRead: number, rowsWritten: number, now = Date.now()) {
    if (![rowsRead, rowsWritten].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid database usage");
    if (rowsRead || rowsWritten) {
      const usage = this.usage(now);
      this.store.put("usage", { ...usage, rowsRead: usage.rowsRead + rowsRead, rowsWritten: usage.rowsWritten + rowsWritten });
    }
  }

  admit(kind: "login" | "draw", client: string, now = Date.now()) {
    if (!["login", "draw"].includes(kind) || !/^[a-f0-9]{64}$/.test(client)) throw new Error("Invalid request budget");
    const key = `budget:${kind}`;
    let budget = this.store.get<Budget>(key);
    if (!budget || budget.expiresAt <= now) budget = { expiresAt: now + 60_000, total: 0, clients: {} };
    const count = budget.clients[client] ?? 0;
    if (count >= (kind === "login" ? 5 : 60) || budget.total >= (kind === "login" ? 20 : 600)) return false;
    budget.clients[client] = count + 1; budget.total += 1;
    this.store.put(key, budget);
    return true;
  }

  saves(): PendingSave[] { return [...this.store.list<PendingSave>({ prefix: "save:", limit: MAX_PENDING_SAVES })].map(([, save]) => save); }

  beginSave(trackId: string, recordingKey: string, operation: string, now = Date.now()) {
    if (!/^[A-Za-z0-9]{22}$/.test(trackId) || !/^(isrc:[A-Z0-9]{12}|spotify:[A-Za-z0-9]{22})$/.test(recordingKey)
      || !/^[A-Za-z0-9_-]{20,128}$/.test(operation)) throw new Error("Invalid save intent");
    const previous = this.store.get<PendingSave>(`save:${trackId}`);
    if (previous?.state === "confirmed") return { kind: "confirmed" as const, save: previous };
    if (previous && now - previous.updatedAt < SAVE_LEASE_MS) return { kind: "busy" as const };
    if (!previous && this.saves().length >= MAX_PENDING_SAVES) return { kind: "full" as const };
    const save: PendingSave = { trackId, recordingKey, operation, state: "intent", updatedAt: now };
    this.store.put(`save:${trackId}`, save);
    return { kind: "started" as const, save };
  }

  confirmSave(trackId: string, operation: string, now = Date.now()) {
    const save = this.store.get<PendingSave>(`save:${trackId}`);
    if (!save || save.operation !== operation) throw new Error("Save intent no longer matches");
    this.store.put(`save:${trackId}`, { ...save, state: "confirmed", updatedAt: now } satisfies PendingSave);
  }

  finishSave(trackId: string, operation: string) {
    const save = this.store.get<PendingSave>(`save:${trackId}`);
    if (save?.operation === operation) this.store.delete(`save:${trackId}`);
  }

  // Only unconfirmed abandoned attempts expire. Confirmed saves are retained
  // until their idempotent D1 bookkeeping is reconciled.
  expireIntents(now = Date.now()) {
    for (const save of this.saves()) if (save.state === "intent" && now - save.updatedAt >= DAY_MS) this.store.delete(`save:${save.trackId}`);
  }
}
