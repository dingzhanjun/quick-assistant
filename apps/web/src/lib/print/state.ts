// What the orders board shows for an order's kitchen ticket. Client-safe, no imports.
export type PrintState = "none" | "printing" | "waiting" | "printed" | "failed";

export type JobForState = {
  status: string; // pending | leased | done | failed
  createdAt: Date;
  // Could this ticket still be printed some day? False when its printer is switched off or its print agent was revoked: nobody
  // will ever collect it.
  deliverable: boolean;
  // Is its print agent talking to the server right now (seen in the last ~90 s)? An old Pi that was replaced but never revoked is
  // not: its tickets wait for ever.
  online: boolean;
};

// Looks at the tickets of ONE order.
//  - a ticket on its way to a printer that is reachable now            -> "printing"
//  - otherwise the newest ticket that was settled (printed / failed)   -> "printed" or "failed"
//    (so tickets stuck on an old, offline or revoked printer cannot hide that the real printer printed)
//  - only tickets waiting for an offline printer, nothing settled      -> "waiting"
//  - nothing relevant (or only tickets for a revoked / switched-off printer) -> "none"
export function printStateOf(jobs: JobForState[]): PrintState {
  const waiting = (j: JobForState) => j.status === "pending" || j.status === "leased";
  if (jobs.some((j) => waiting(j) && j.deliverable && j.online)) return "printing";
  const settled = jobs.filter((j) => !waiting(j));
  if (settled.length) {
    const newest = [...settled].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return newest.status === "failed" ? "failed" : "printed";
  }
  return jobs.some((j) => waiting(j) && j.deliverable) ? "waiting" : "none";
}
