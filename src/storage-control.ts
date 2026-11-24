import { DurableObject } from "cloudflare:workers";
import { StorageControlState } from "./storage-control-state";

/** Small durable coordination state, independent of catalogue D1 storage.
 * No provider requests, catalogue data or raw client addresses enter this DO. */
export class StorageControl extends DurableObject<Env> {
  private readonly state: StorageControlState;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.state = new StorageControlState(ctx.storage.kv); }
  async snapshot() { return this.state.snapshot(); }
  async observeCapacity(bytes: number, checkedAt: number) { return this.ctx.storage.transactionSync(() => this.state.observeCapacity(bytes, checkedAt)); }
  async noteFailure(kind: "storage" | "daily_reads" | "daily_writes") { return this.ctx.storage.transactionSync(() => this.state.noteFailure(kind)); }
  async recordUsage(read: number, written: number) { this.ctx.storage.transactionSync(() => this.state.recordUsage(read, written)); }
  async admit(kind: "login" | "draw", client: string) { return this.ctx.storage.transactionSync(() => this.state.admit(kind, client)); }
  async saves() { return this.state.saves(); }
  async beginSave(track: string, key: string, operation: string) { return this.ctx.storage.transactionSync(() => this.state.beginSave(track, key, operation)); }
  async confirmSave(track: string, operation: string) { this.ctx.storage.transactionSync(() => this.state.confirmSave(track, operation)); }
  async finishSave(track: string, operation: string) { this.ctx.storage.transactionSync(() => this.state.finishSave(track, operation)); }
  async expireIntents() { this.ctx.storage.transactionSync(() => this.state.expireIntents()); }
}
