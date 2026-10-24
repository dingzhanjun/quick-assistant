import { createListenClient } from "@/db";

// Live updates for the orders board. A database trigger runs pg_notify('orders_changed', <tenant id>) whenever an
// order is created, changed or deleted (by the phone agent, the dashboard, a script: any writer). Each web process
// keeps ONE LISTEN connection and fans the notification out to the browsers of that restaurant, so it works with any
// number of web replicas and never leaks one restaurant's activity to another.
type Listener = () => void;

export class ChannelHub {
  constructor(private channel: string) {}
  private listeners = new Map<string, Set<Listener>>();
  private started = false;

  subscribe(tenantId: string, fn: Listener): () => void {
    let set = this.listeners.get(tenantId);
    if (!set) this.listeners.set(tenantId, (set = new Set()));
    set.add(fn);
    void this.start();
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(tenantId);
    };
  }

  emit(tenantId: string) {
    for (const fn of this.listeners.get(tenantId) ?? []) {
      try {
        fn();
      } catch (e) {
        console.error("[hub] listener failed", e);
      }
    }
  }

  // Starts the single LISTEN connection (postgres.js reconnects and re-listens by itself). If it cannot start, the
  // board falls back to polling, so a failure here is logged, never fatal.
  private async start() {
    if (this.started) return;
    this.started = true;
    try {
      await createListenClient().listen(this.channel, (tenantId) => this.emit(tenantId));
    } catch (e) {
      this.started = false;
      console.error("[hub] LISTEN failed; boards fall back to polling", e);
    }
  }

  get subscriberCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const g = globalThis as unknown as { __ordersHub?: ChannelHub; __printHub?: ChannelHub };
export const ordersHub = (g.__ordersHub ??= new ChannelHub("orders_changed"));
// Wakes the print agents' long-poll when a ticket is queued for a restaurant (trigger in migration 0018).
export const printHub = (g.__printHub ??= new ChannelHub("print_jobs"));
