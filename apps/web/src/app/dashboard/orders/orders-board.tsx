"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAudio, playChime } from "@/lib/chime";
import { lineUnitCents } from "@/lib/pricing";
import { ChangePickupDialog } from "./change-pickup";
import { reprintOrder, setOrderStatus } from "./actions";

type Status = "new" | "preparing" | "ready" | "completed" | "cancelled";

export type OrderView = {
  id: string;
  orderNumber: number;
  customerName: string | null;
  contactNumber: string | null; // the mobile number the order link was texted to, if the customer asked for it
  publicToken: string | null; // the customer's order page is /orders/<token>
  smsSent: boolean; // the order link text was queued (it goes out when the restaurant confirms the order)
  status: Status;
  createdAt: string;
  pickupAt: string | null; // the pickup time that counts (the restaurant's new time if it changed it); null = as soon as possible
  pickupChanged: boolean; // the restaurant moved it: `originalPickup` is what the customer asked for (null = ASAP)
  originalPickup: string | null;
  pickupHHMM: string | null; // pickupAt as HH:MM in the restaurant's time zone (prefills the change dialog)
  print: "none" | "printing" | "waiting" | "printed" | "failed" | null; // null = no printer configured
  items: {
    id: string;
    name: string;
    quantity: number;
    priceCents: number;
    modifiers: { group: string; option: string; priceDeltaCents: number }[];
    notes: string | null;
  }[];
};

const NEXT: Partial<Record<Status, { to: Status; label: string }>> = {
  new: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
  ready: { to: "completed", label: "Complete" },
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const POLL_MS = 5000;
const POLL_LIVE_MS = 60_000; // safety net while the live connection is up

export function OrdersBoard({ orders, confirmToPrint = false }: { orders: OrderView[]; confirmToPrint?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [soundOn, setSoundOn] = useState(false);
  const [changing, setChanging] = useState<OrderView | null>(null); // the order whose pickup time is being changed
  const audioRef = useRef<AudioContext | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const soundRef = useRef(false);

  function toggleSound() {
    const next = !soundOn;
    if (next) {
      // Must happen inside the click so the browser lets us play audio later.
      audioRef.current ??= createAudio();
      if (!audioRef.current) return toast.error("This browser can't play sound");
      playChime(audioRef.current); // doubles as a "does it work?" test
    }
    setSoundOn(next);
    soundRef.current = next; // browsers re-block audio on reload, so sound always starts off
  }

  // Alert when an order we haven't seen before shows up (never on first load).
  useEffect(() => {
    const seen = seenRef.current;
    if (!seen) {
      seenRef.current = new Set(orders.map((o) => o.id));
      return;
    }
    const fresh = orders.filter((o) => !seen.has(o.id) && o.status === "new");
    orders.forEach((o) => seen.add(o.id));
    if (!fresh.length) return;
    toast.success(
      fresh.length === 1 ? `New order #${fresh[0].orderNumber}` : `${fresh.length} new orders`,
    );
    if (soundRef.current && audioRef.current) playChime(audioRef.current);
  }, [orders]);

  // Live updates: the server pushes an event whenever one of this restaurant's orders changes, and we refetch then.
  // Polling stays as a safety net (slow while the live connection works, fast while it is down).
  const [live, setLive] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer); // a burst of changes (order + its items) becomes one refresh
      timer = setTimeout(() => document.visibilityState === "visible" && router.refresh(), 250);
    };
    const es = new EventSource("/api/dashboard/orders/stream");
    es.addEventListener("ready", () => {
      setLive(true);
      refreshSoon(); // catch anything that changed while we were disconnected
    });
    es.addEventListener("orders", refreshSoon);
    es.onerror = () => setLive(false); // the browser reconnects by itself
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [router]);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && router.refresh();
    const id = setInterval(tick, live ? POLL_LIVE_MS : POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, live]);

  function update(id: string, to: Status) {
    startTransition(async () => {
      const res = await setOrderStatus(id, to);
      if (!res.ok) toast.error("Could not update order");
    });
  }

  function reprint(id: string) {
    startTransition(async () => {
      const res = await reprintOrder(id);
      if (res.ok) toast.success("Reprint sent to the kitchen printer");
      else toast.error(res.error);
    });
  }

  const PRINT_LABEL = {
    none: ["Not printed", "text-muted-foreground"], printing: ["Printing…", "text-warning-text"], waiting: ["Waiting for the printer (offline)", "text-warning-text"],
    printed: ["Printed", "text-success-text"], failed: ["Print failed", "text-destructive-text"],
  } as const;

  const active = orders.filter((o) => o.status !== "completed" && o.status !== "cancelled");
  const past = orders.filter((o) => o.status === "completed" || o.status === "cancelled");

  // one column on a phone, two from tablet width up (cards keep their own height)
  const GRID = "grid grid-cols-1 items-start gap-3 md:grid-cols-2";

  const renderCard = (o: OrderView) => {
    // Print-after-confirmation: the first button of a new order is what sends the ticket to the kitchen printer.
    const next = o.status === "new" && confirmToPrint ? { to: "preparing" as Status, label: "Confirm & Print" } : NEXT[o.status];
    const total = o.items.reduce((s, i) => s + lineUnitCents(i.priceCents, i.modifiers) * i.quantity, 0);
    return (
      // the border is the same colour as the placed-time text in the header (text-muted-foreground), in light and dark; the card the mouse is over gets the accent colour
      <Card key={o.id} className="border-muted-foreground transition-colors hover:border-primary">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            #{o.orderNumber} {o.customerName && <span className="font-normal">· {o.customerName}</span>}
          </CardTitle>
          <span className="text-sm capitalize text-muted-foreground">
            {o.status} · <LocalTime iso={o.createdAt} kind="time" />
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              Pickup:{" "}
              {o.pickupAt ? <LocalTime iso={o.pickupAt} kind="time" /> : <span className="text-primary-text">ASAP</span>}
              {o.pickupChanged && (
                <span className="ml-2 font-normal text-muted-foreground">
                  (changed, was {o.originalPickup ? <LocalTime iso={o.originalPickup} kind="time" /> : "ASAP"})
                </span>
              )}
            </p>
            {(o.status === "new" || o.status === "preparing" || o.status === "ready") && (
              <Button variant="outline" size="xs" disabled={pending} onClick={() => setChanging(o)}>
                Change Pickup Time
              </Button>
            )}
          </div>
          {o.contactNumber && (
            <p className="text-sm text-muted-foreground">
              {o.smsSent
                ? `Order link texted to ${o.contactNumber}`
                : o.status === "new"
                  ? `Customer's number ${o.contactNumber}: they get the order link by text when you confirm`
                  : `Customer's number: ${o.contactNumber}`}
              {o.publicToken && (
                <>
                  {" · "}
                  <a href={`/orders/${o.publicToken}`} target="_blank" rel="noreferrer" className="underline">
                    Customer&apos;s order page
                  </a>
                </>
              )}
            </p>
          )}
          <ul className="space-y-1">
            {o.items.map((i) => (
              <li key={i.id}>
                {i.quantity} × {i.name}
                {i.modifiers.length > 0 && (
                  <div className="text-sm text-muted-foreground">
                    {i.modifiers
                      .map((m) => `${m.option}${m.priceDeltaCents ? ` (+$${(m.priceDeltaCents / 100).toFixed(2)})` : ""}`)
                      .join(" · ")}
                  </div>
                )}
                {i.notes && <span className="text-sm text-muted-foreground"> — {i.notes}</span>}
              </li>
            ))}
          </ul>
          {o.print && (
            <p className="flex items-center gap-3 text-sm">
              <span className={PRINT_LABEL[o.print][1]}>{PRINT_LABEL[o.print][0]}</span>
              <Button variant="outline" size="xs" disabled={pending} onClick={() => reprint(o.id)}>Reprint</Button>
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="font-medium">Total: {money(total)}</span>
            {(next || o.status !== "cancelled") && o.status !== "completed" && (
              <div className="space-x-2">
                {o.status !== "cancelled" && (
                  <ConfirmButton
                    disabled={pending}
                    title={`Cancel order #${o.orderNumber}?`}
                    description="It cannot be reopened. If it was printed, a CANCELLED ticket is sent to the kitchen."
                    confirmLabel="Cancel order"
                    cancelLabel="Keep order"
                    onConfirm={() => update(o.id, "cancelled")}
                  >
                    Cancel
                  </ConfirmButton>
                )}
                {next && (
                  <Button size="sm" disabled={pending} onClick={() => update(o.id, next.to)}>
                    {next.label}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Active orders</h2>
          <div className="flex items-center gap-3">
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={live ? "New orders appear instantly" : "Live connection lost: checking every few seconds"}
            >
              <span className={`size-2 rounded-full ${live ? "bg-green-500" : "bg-amber-500"}`} />
              {live ? "Live" : "Reconnecting…"}
            </span>
            <Button variant={soundOn ? "default" : "outline"} size="sm" onClick={toggleSound}>
              {soundOn ? "Sound on" : "Sound off"}
            </Button>
          </div>
        </div>
        {!soundOn && (
          <p className="text-sm text-muted-foreground">
            Turn sound on to hear a chime for new orders. Keep this tab open.
          </p>
        )}
        {active.length === 0 ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
            No active orders. New phone orders appear here automatically.
          </p>
        ) : (
          <div className={GRID}>{active.map(renderCard)}</div>
        )}
      </section>
      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Recent history</h2>
          <div className={GRID}>{past.map(renderCard)}</div>
        </section>
      )}
      <ChangePickupDialog key={changing?.id ?? "none"} order={changing} onClose={() => setChanging(null)} />
    </div>
  );
}
