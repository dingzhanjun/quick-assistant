"use client";

import { useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { saveNotifications, saveTextOrders } from "./actions";

export function Notifications(props: { emails: string; enabled: boolean; ownerEmails: string; textOrders: boolean; textAvailable: boolean }) {
  const [emails, setEmails] = useState(props.emails);
  const [enabled, setEnabled] = useState(props.enabled);
  const [textOrders, setTextOrders] = useState(props.textOrders);
  const [pending, startTransition] = useTransition();

  function saveText(on: boolean) {
    setTextOrders(on);
    startTransition(async () => {
      const res = await saveTextOrders(on);
      if (res.ok) toast.success(on ? "Customers will be offered a text with their order link" : "Customers will not be offered a text");
      else { setTextOrders(!on); toast.error(res.error); }
    });
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveNotifications(emails, enabled);
      if (res.ok) toast.success("Notification settings saved");
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-8">
    <form onSubmit={save} className="space-y-4">
      <div><Switch id="notify" checked={enabled} onCheckedChange={setEnabled} label="Email me when a new phone order comes in" /></div>
      <div className="space-y-2">
        <Label htmlFor="emails">Send to (comma-separated, up to 5)</Label>
        <Input
          id="emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={props.ownerEmails || "kitchen@example.com"}
          disabled={!enabled}
        />
        <p className="text-sm text-muted-foreground">
          Leave blank to use the restaurant owners
          {props.ownerEmails && ` (${props.ownerEmails})`}.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>

    <div className="space-y-2">
      <h3 className="text-lg font-medium">Text messages to customers</h3>
      <Switch id="text-orders" checked={textOrders} disabled={pending} onCheckedChange={saveText} label="After an order, offer to text the customer a link to it" />
      <p className="text-sm text-muted-foreground">
        The phone agent asks whether to text the order to the number they are calling from or another number. The link shows the
        order and its status (received, preparing, ready). Each text is a small cost to the platform.
        {!props.textAvailable && " Texting is not set up on this server yet (the platform admin must configure an SMS provider), so callers are not offered it."}
      </p>
    </div>
    </div>
  );
}
