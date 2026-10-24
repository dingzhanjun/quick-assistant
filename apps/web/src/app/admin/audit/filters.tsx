"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

// The audit log filters. A plain GET form (the URL is the state, so a filtered view can be bookmarked); the React Suite
// pickers keep their value in state and mirror it into hidden inputs for the submit.
export function AuditFilters(props: {
  tenants: { id: string; name: string }[];
  actionGroups: string[];
  actions: { key: string; label: string }[];
  initial: { tenant: string; action: string; actor: string; q: string; from: string; to: string };
  total: number;
}) {
  const [tenant, setTenant] = useState(props.initial.tenant);
  const [action, setAction] = useState(props.initial.action);
  const [from, setFrom] = useState(props.initial.from);
  const [to, setTo] = useState(props.initial.to);

  return (
    <form className="grid gap-2 sm:grid-cols-3" method="get">
      <Select
        searchable
        ariaLabel="Restaurant"
        width="100%"
        value={tenant}
        onChange={setTenant}
        options={[
          { label: "All restaurants", value: "" },
          { label: "Platform-level (no restaurant)", value: "none" },
          ...props.tenants.map((t) => ({ label: t.name, value: t.id })),
        ]}
      />
      <input type="hidden" name="tenant" value={tenant} />
      <Select
        searchable
        ariaLabel="Action"
        width="100%"
        value={action}
        onChange={setAction}
        options={[
          { label: "All actions", value: "" },
          ...props.actionGroups.map((g) => ({ label: `${g}.* (all)`, value: `${g}.*` })),
          ...props.actions.map((a) => ({ label: `${a.key}: ${a.label}`, value: a.key })),
        ]}
      />
      <input type="hidden" name="action" value={action} />
      <Input name="actor" defaultValue={props.initial.actor} placeholder="Who (email)" />
      <Input name="q" defaultValue={props.initial.q} placeholder="Search summary / id" />
      <DateField name="from" ariaLabel="From date" placeholder="From date" value={from} onChange={setFrom} />
      <DateField name="to" ariaLabel="To date" placeholder="To date" value={to} onChange={setTo} />
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm">Filter</Button>
        <Link href="/admin/audit" className={buttonVariants({ size: "sm", variant: "ghost" })}>Clear</Link>
        <span className="ml-auto self-center text-sm text-muted-foreground">{props.total} entries</span>
      </div>
    </form>
  );
}
