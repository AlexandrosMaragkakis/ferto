import type { RefreshMessage } from "../src/rebuild";
import type { SimulationConfig } from "./config";
export type Delivery = { id: string; body: RefreshMessage; createdAt: number; dueAt: number; attempts: number; serial: number };
export type QueueMetricsReport = { sends: number; deliveries: number; duplicates: number; retries: number; expired: number; deadLetters: number; dispatchFailures: number; lostMessages: number; peakBacklog: number };

/** Durable-queue model: fresh sends get fresh retention and retry budgets;
 * redeliveries retain the original enqueue time and increment attempts. */
export class SimulationQueue {
  private heap: Delivery[] = [];
  private serial = 0;
  private failuresLeft: number;
  private lostLeft: number;
  metrics: QueueMetricsReport = { sends: 0, deliveries: 0, duplicates: 0, retries: 0, expired: 0, deadLetters: 0, dispatchFailures: 0, lostMessages: 0, peakBacklog: 0 };
  constructor(private now: () => number, private random: () => number, private config: SimulationConfig) {
    this.failuresLeft = config.dispatchFailures; this.lostLeft = config.lostMessages;
  }
  get size(): number { return this.heap.length; }
  peek(): Delivery | undefined { return this.heap[0]; }
  private before(a: Delivery, b: Delivery): boolean { return a.dueAt < b.dueAt || (a.dueAt === b.dueAt && a.serial < b.serial); }
  push(delivery: Delivery): void {
    this.heap.push(delivery);
    let index = this.heap.length - 1;
    while (index > 0) { const parent = (index - 1) >> 1; if (!this.before(this.heap[index]!, this.heap[parent]!)) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent]!, this.heap[index]!]; index = parent; }
    this.metrics.peakBacklog = Math.max(this.metrics.peakBacklog, this.size);
  }
  pop(): Delivery | undefined {
    const first = this.heap[0]; const last = this.heap.pop();
    if (this.heap.length && last) {
      this.heap[0] = last; let i = 0;
      while (true) { let smallest = i; const left = i * 2 + 1; const right = left + 1;
        if (left < this.size && this.before(this.heap[left]!, this.heap[smallest]!)) smallest = left;
        if (right < this.size && this.before(this.heap[right]!, this.heap[smallest]!)) smallest = right;
        if (smallest === i) break; [this.heap[i], this.heap[smallest]] = [this.heap[smallest]!, this.heap[i]!]; i = smallest;
      }
    }
    return first;
  }
  private enqueue(body: RefreshMessage, delay = 0): Delivery {
    const serial = ++this.serial;
    const delivery = { id: `message-${serial}`, body: structuredClone(body), createdAt: this.now(), dueAt: this.now() + delay * 1000, attempts: 1, serial };
    this.push(delivery);
    return delivery;
  }
  retry(delivery: Delivery, delay: number): void {
    this.metrics.retries += 1;
    if (delivery.attempts >= 9) { this.metrics.deadLetters += 1; return; }
    this.push({ ...delivery, attempts: delivery.attempts + 1, dueAt: this.now() + delay * 1000, serial: ++this.serial });
  }
  expired(delivery: Delivery): boolean {
    if (this.now() - delivery.createdAt < 86_400_000) return false;
    this.metrics.expired += 1; return true;
  }
  private async send(body: RefreshMessage, options?: QueueSendOptions): Promise<QueueSendResponse> {
    const delay = options?.delaySeconds ?? 0;
    if (!Number.isInteger(delay) || delay < 0 || delay > 43_200) throw new Error("Simulated queue delay out of range");
    this.metrics.sends += 1;
    if (this.metrics.sends >= 7 && this.failuresLeft > 0) { this.failuresLeft -= 1; this.metrics.dispatchFailures += 1; throw new Error("Injected queue dispatch failure"); }
    if (this.metrics.sends >= 13 && this.lostLeft > 0) { this.lostLeft -= 1; this.metrics.lostMessages += 1; return this.response(); }
    const original = this.enqueue(body, delay);
    if (this.config.duplicateEvery > 0 && this.metrics.sends % this.config.duplicateEvery === 0) {
      this.metrics.duplicates += 1;
      this.push({ ...original, body: structuredClone(original.body), attempts: 2,
        dueAt: original.dueAt + (1 + Math.floor(this.random() * 300)) * 1000, serial: ++this.serial });
    }
    return this.response();
  }
  private response(): QueueSendResponse { return { metadata: { metrics: { backlogCount: this.size, backlogBytes: this.size * 100 } } }; }
  readonly binding: Queue<RefreshMessage> = {
    send: (body, options) => this.send(body, options),
    sendBatch: async (messages, options) => { for (const message of messages) await this.send(message.body, { delaySeconds: message.delaySeconds ?? options?.delaySeconds }); return this.response(); },
    metrics: async () => ({ backlogCount: this.size, backlogBytes: this.size * 100 }),
  };
}
