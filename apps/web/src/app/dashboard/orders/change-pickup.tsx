"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TimeField } from "@/components/ui/time-field";
import { toast } from "@/lib/toast";
import { changePickupTime } from "./actions";

const pad = (n: number) => String(n).padStart(2, "0");
// A sensible first suggestion for an ASAP order: a quarter of an hour from now.
const suggestion = () => {
  const d = new Date(Date.now() + 15 * 60_000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// "Change Pickup Time": the restaurant moves an order's pickup to a later time today. The customer is texted when they gave
// a number on the call.
export function ChangePickupDialog({
  order, onClose,
}: {
  order: { id: string; orderNumber: number; pickupHHMM: string | null; pickupChanged: boolean; contactNumber: string | null } | null;
  onClose: () => void;
}) {
  const [time, setTime] = useState(order?.pickupHHMM ?? suggestion());
  const [pending, startTransition] = useTransition();

  function save(value: string | null) {
    if (!order) return;
    startTransition(async () => {
      const res = await changePickupTime(order.id, value);
      if (!res.ok) { toast.error(res.error); return; }
      toast.success(value === null ? "Pickup time set back to the original" : res.texted ? "Pickup time changed. The customer was texted." : "Pickup time changed.");
      onClose();
    });
  }

  return (
    <Dialog open={order !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change pickup time{order ? ` for order #${order.orderNumber}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm">New pickup time (today)</span>
            <TimeField value={time} onChange={setTime} ariaLabel="New pickup time" />
          </div>
          <p className="text-sm text-muted-foreground">
            {order?.contactNumber
              ? `The customer is texted the new time (${order.contactNumber}).`
              : "This customer gave no number to text, so they will not be notified: call them if needed."}
          </p>
        </div>
        <DialogFooter>
          {order?.pickupChanged && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => save(null)}>
              Use the original time
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={pending} onClick={() => save(time)}>Save new time</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
