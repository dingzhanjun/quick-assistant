// Abuse/cost limits for inbound calls (LAUNCH_PLAN D2). Enforced in /api/agent/calls; the per-call duration
// and silence limits live in the agent (`CALL_*` constants in main.py) and are returned from the same route.
// Both limits can be raised for testing with MAX_CALLS_PER_CALLER_PER_HOUR / MAX_CONCURRENT_CALLS_PER_TENANT.
const num = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const CALL_LIMITS = {
  maxCallsPerCallerPerHour: num("MAX_CALLS_PER_CALLER_PER_HOUR", 5),
  maxConcurrentPerTenant: num("MAX_CONCURRENT_CALLS_PER_TENANT", 3),
  // A call that never reported its end (worker crash) stops counting as active after this long.
  staleAfterMs: 15 * 60 * 1000,
} as const;
