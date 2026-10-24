"use client";

import { useTransition } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { deleteJob, retryFailedJobs, retryJob } from "./actions";

type R = { ok: true; count: number } | { ok: false; error: string };

export function JobRowButtons({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<R>, done: string) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) toast.success(done);
      else toast.error(r.error);
    });
  return (
    <div className="mt-1 flex gap-2">
      <Button variant="outline" size="xs" disabled={pending} onClick={() => run(() => retryJob(id), "Back in the queue")}>
        Retry
      </Button>
      <ConfirmButton
        disabled={pending}
        title="Delete this job?"
        description="The message will never be sent."
        confirmLabel="Delete"
        onConfirm={() => run(() => deleteJob(id), "Job deleted")}
      >
        Delete
      </ConfirmButton>
    </div>
  );
}

export function RetryAllButton({ type, count }: { type: "email" | "sms" | null; count: number }) {
  const [pending, startTransition] = useTransition();
  if (!count) return null;
  return (
    <ConfirmButton
      disabled={pending}
      title={`Retry ${count} failed job${count === 1 ? "" : "s"}?`}
      description="They go back in the queue and are sent now (at most 200 at a time)."
      confirmLabel="Retry all"
      onConfirm={() =>
        startTransition(async () => {
          const r = await retryFailedJobs(type);
          if (r.ok) toast.success(`${r.count} job(s) back in the queue`);
          else toast.error(r.error);
        })
      }
    >
      Retry all failed
    </ConfirmButton>
  );
}
