/** The Node simulator supplies a control-state adapter. Real DO construction
 * requires workerd and is exercised by the Cloudflare integration tests. */
export class DurableObject {
  constructor() { throw new Error("Durable Objects require workerd; use the simulator's control adapter"); }
}
