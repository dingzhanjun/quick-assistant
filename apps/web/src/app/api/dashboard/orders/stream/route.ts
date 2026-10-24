import { ordersHub } from "@/lib/order-events";
import { resolveTenant } from "@/lib/tenant";

const HEARTBEAT_MS = 20_000; // proxies (Cloudflare, Caddy) close idle streams; a comment line keeps this one open
const MAX_LIFETIME_MS = 30 * 60_000; // then the browser reconnects: bounds leaked connections and re-checks the login

// Server-sent events for the signed-in user's restaurant: an "orders" event whenever one of ITS orders changes.
export async function GET(req: Request) {
  const t = await resolveTenant();
  if (!t.ok) return new Response("unauthorized", { status: 401 });

  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send("retry: 3000\n\nevent: ready\ndata: {}\n\n");
      const unsubscribe = ordersHub.subscribe(t.tenantId, () => send("event: orders\ndata: {}\n\n"));
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      const lifetime = setTimeout(() => {
        cleanup();
        try {
          controller.close();
        } catch {}
      }, MAX_LIFETIME_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        cleanup = () => {};
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // nginx-style proxies: do not buffer
    },
  });
}
