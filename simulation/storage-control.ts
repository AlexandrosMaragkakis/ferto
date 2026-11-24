import { StorageControlState, type ControlStore } from "../src/storage-control-state";

export function simulatedStorageControl(): Env["STORAGE_CONTROL"] {
  const values = new Map<string, unknown>();
  const store: ControlStore = {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: (key: string) => values.delete(key),
    list: <T>(options?: { prefix?: string; limit?: number }) => new Map([...values]
      .filter(([key]) => key.startsWith(options?.prefix ?? "")).sort(([a], [b]) => a.localeCompare(b)).slice(0, options?.limit ?? Infinity)) as Map<string, T>,
  };
  const state = new StorageControlState(store);
  const client = {
    snapshot: async () => state.snapshot(), observeCapacity: async (bytes: number, time: number) => state.observeCapacity(bytes, time),
    noteFailure: async (kind: "storage" | "daily_reads" | "daily_writes") => state.noteFailure(kind),
    recordUsage: async (read: number, written: number) => state.recordUsage(read, written),
    admit: async (kind: "login" | "draw", key: string) => state.admit(kind, key),
    saves: async () => state.saves(), beginSave: async (track: string, key: string, operation: string) => state.beginSave(track, key, operation),
    confirmSave: async (track: string, operation: string) => state.confirmSave(track, operation),
    finishSave: async (track: string, operation: string) => state.finishSave(track, operation), expireIntents: async () => state.expireIntents(),
  };
  // The simulator models the RPC methods used by the app, not namespace IDs,
  // routing or serialization. Integration tests exercise the actual binding.
  return new Proxy({} as Env["STORAGE_CONTROL"], { get(_target, property) {
    if (property === "getByName") return () => client;
    throw new Error("The simulator models only the storage-control RPC route");
  } });
}
