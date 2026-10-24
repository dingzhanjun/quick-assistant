# Launch plan

Turns the findings in `HARDENING.md` (and the open items in `TODO.md`) into an ordered plan. Work is grouped
into phases; a phase should be finished before the next starts, and **no real restaurant should be connected
until the Phase 1 and Phase 2 gates pass.**

- **Owner:** *Claude* = I implement and test it; *You* = needs your account, decision or a real phone;
  *Both* = I build it, you verify it.
- **Size** is a rough effort guess, not a promise: **S** under half a day, **M** about a day, **L** several days.
- **Done when** is the check that proves the item works. Where it says "test", the test goes into the repo
  (agent tests run in CI via `uv run python -m pytest`).
- Item ids (`H1`…) match the numbering in `HARDENING.md`.

## Phase 0 — Decisions (you; before any work that depends on them)

Recommended defaults are in *italics*; tell me yes/no/changes and I will build to them.

| # | Decision | Recommended default |
|---|---|---|
| D1 ✅ | Greeting disclosure and recording notice (H7) | *"Thanks for calling {name}. This is an automated ordering assistant."* then the question what they would like to order; calls are **not** recorded and transcripts are not stored (say so only while true). Needs a legal check for your regions. |
| D2 ✅ | Call limits (H2) | *8 min maximum; after 20 s of silence ask "are you still there?", hang up after 30 s; 3 simultaneous calls per restaurant; 5 calls/hour per caller number.* |
| D3 ✅ | Who may attach phone numbers (H1) | *Platform admin only; restaurants see theirs read-only.* |
| D4 ✅ | What happens when saving an order fails (H4) | *Retry once, then apologise, take a callback number and alert staff; add call transfer to the restaurant's phone later.* |
| D5 ✅ | Second notification channel (H6) | *SMS (provider to choose: Twilio / Telnyx / LiveKit) in addition to email and the dashboard chime.* (Later built as texts to the CUSTOMER: order link, pickup change, cancellation; see `docs/SYSTEM_SETUP.md` section 8b. The restaurant-side SMS alert is still not built.) |
| D6 ✅ | Data retention (H16) | *Caller numbers 90 days, agent logs 14 days, orders kept while the restaurant is a customer. Needs legal advice.* |
| D7 ✅ | Behaviour when closed (H8) | *Politely say the opening hours and hang up; no pre-orders yet.* |
| D8 ✅ | Phone line layout | *This app gets its own LiveKit agent name (e.g. `order-agent`) and its own number/dispatch rule, separate from the self-hosted `food` agent.* |
| D9 | Production voice stack | *Decide after Phase 2's real-phone comparison of Grok realtime vs Deepgram + LLM (delay, tool-call reliability, cost).* |

## Phase 1 — Make the phone line safe (cost, abuse, correctness)

Gate: a stranger cannot run up your bills, hijack a number, create duplicate orders, or leave the caller in silence.

| Id | Task | Owner | Size | Depends on | Done when |
|---|---|---|---|---|---|
| P1.1 | Separate agent name and line: `AGENT_NAME=order-agent`, new dispatch rule for the new number, stop the shared `food` collision (H5, D8) | Both | S | D8 | `lk sip dispatch list` shows a rule for our number naming our agent; a call reaches only our worker while the `food` worker is running |
| P1.2 ✅ | Phone numbers attached only by platform admin; restaurants read-only (H1) | Claude | S | D3 | test: a restaurant member cannot add or move a number; admin can |
| P1.3 ✅ | Call limits: max duration with goodbye, silence prompt + hang-up, per-restaurant concurrency (H2) | Claude | M | D2 ✅ | test with scripted/fake clock; real call: idle 30 s is hung up, a long call ends at the limit |
| P1.4 ✅ | Per-caller rate limit and block list; store caller number on the order (H3) | Claude | M | D2, D6 | test: 6th call in an hour is refused politely; blocked number is refused |
| P1.5 ✅ | Order idempotency key (call id + cart hash) in the agent and `/api/agent/orders` (H3) | Claude | S | — | test: submitting the same key twice returns the same order number, one row |
| P1.6 ✅ | Failure path: retry once with the same key, then apologise / callback number / alert (H4) | Claude | M | P1.5, D4 | test: API down → no crash, caller told, alert logged; API back → single order |
| P1.7 | Provider spending alerts and caps (LiveKit, xAI/Deepgram, LLM) | You | S | — | alerts configured; budget screenshots recorded in `DEPLOY.md` notes |
| P1.8 | Real call test: hang-up after goodbye, number format, both modes | You | S | P1.1 | recorded results; log file shows `call started … hanging up … call ended` |

## Phase 2 — Reliability and visibility (know when it breaks)

Gate: if the worker dies, an order fails to notify, or a restaurant is closed, someone is told and the caller hears something sensible.

| Id | Task | Owner | Size | Depends on | Done when |
|---|---|---|---|---|---|
| P2.1 | Worker healthcheck in compose (port 8081), uptime monitor for `/api/health` and the worker, alert channel (H5) | Both | M | — | stopping the worker raises an alert within 2 min |
| P2.2 | Error tracking (Sentry or similar) for web and agent | Both | S | account | a thrown test error appears in the dashboard |
| P2.3 | Resend with verified domain; retry queue for new-order emails; "unacknowledged order" alert (H6) | Both | M | domain | test: failed send is retried and then alerts; order acknowledged clears it |
| P2.4 ~~dropped~~ | Second notification channel (H6) | Both | M | D5 | SMS arrives within seconds of a test order |
| P2.5 ✅ | Opening hours and time zone per restaurant; agent refuses when closed (H8) | Claude | M | D7 | test: closed → polite message and hang-up; open → normal |
| P2.6 ✅ (+ row-level security built) | Tenant isolation tests for every server action and API route; evaluate Postgres row-level security (H9) | Claude | M | — | CI test fails if a route returns/changes another restaurant's data |
| P2.7 | Real-phone comparison: Grok realtime vs pipeline (delay, tool calls, cost) and pick one (D9) | You | M | P1.8 | short written comparison and a decision |

## Phase 3 — Platform hardening

Gate: the web app and server meet a reasonable baseline for a public SaaS.

| Id | Task | Owner | Size | Depends on | Done when |
|---|---|---|---|---|---|
| P3.1 ✅ | Auth: rate limits with the correct client-IP header behind Caddy/Cloudflare; fix pre-registration hijack; admin two-factor; session lifetime (H10) | Claude | M | — | test: 11th sign-in attempt in the window is refused; admin cannot sign in without 2FA |
| P3.2 ✅ | Roles (owner / staff) and invitations (H11) | Claude | L | — | test: staff cannot change numbers, notification emails or delete the menu |
| P3.3 ✅ | Security headers: HSTS, CSP, `X-Content-Type-Options`, frame-ancestors, referrer/permissions policy (H12) | Claude | S | — | securityheaders.com-style scan shows no missing headers |
| P3.4 ✅ | Containers: pin image digests and Action SHAs, Dependabot, image scan in CI, log rotation, memory limits (H13) | Claude | M | — | CI fails on a high-severity finding; `docker inspect` shows limits and log options |
| P3.5 | Off-site backups automated + restore drill from the off-site copy (H14) | Both | M | storage account | a restore into a scratch database succeeds from the off-site file |
| P3.6 | Secrets: rotate `AGENT_API_KEY`, read-only GHCR token, `.env` mode 600, confirm no key in logs (H15) | Both | S | — | checklist signed off in `DEPLOY.md` |

## Phase 4 — Compliance and quality

Gate: legally and operationally ready for strangers' phone calls.

| Id | Task | Owner | Size | Depends on | Done when |
|---|---|---|---|---|---|
| P4.1 | AI disclosure in the greeting; privacy policy and terms published; retention enforced (H7, H16) | Both | M | D1, D6 | greeting says it; pages live; a job deletes data past retention |
| P4.2 ✅ | Repeatable AI evaluation suite (many runs each) and a pass-rate threshold in CI (H17) | Claude | L | — | CI reports tool-call and order-accuracy rates; below threshold fails |
| P4.3 ✅ | Browser tests for dashboard flows (menu, modifiers, settings, orders) (H21) | Claude | M | — | CI end-to-end run passes |
| P4.4 | Load test: concurrent calls on one worker and the database pool (H19) | Both | M | P2.7 | documented safe concurrency; worker `load_threshold` set accordingly |
| P4.5 | Noise / accent / interruption test matrix on real phones (H20) | You | M | P2.7 | filled-in matrix with failures turned into issues |

## Phase 5 — Rehearsal and go-live

| Id | Task | Owner | Size | Depends on | Done when |
|---|---|---|---|---|---|
| P5.1 | Full dry run on the Ubuntu server: DNS, Caddy or tunnel, GHCR pull, deploy job, migrations, backup, Resend, production Google sign-in | Both | M | Phases 1–3 | a fresh clone deploys from zero by following `DEPLOY.md` only |
| P5.2 | Rollback drill (previous SHA) and restore drill | Both | S | P5.1 | both work, times recorded |
| P5.3 | Soft launch with **one** friendly restaurant, daily review of orders, logs and bills for the first week | You | — | P5.2, gates below | no P0 incidents for 7 days |
| P5.4 | Go / no-go review against the gate list below | Both | S | P5.3 | all boxes ticked |

## Go-live gate (all must be true)

- [ ] Phase 1 gate: limits, number ownership, idempotency, failure path, spending alerts
- [ ] Phase 2 gate: monitoring and alerts, reliable order notification, opening hours, isolation tests
- [ ] Phase 3 items P3.1, P3.3, P3.5, P3.6 done (others may follow within the first month)
- [ ] D1 disclosure in the greeting; privacy policy and terms published (P4.1)
- [ ] Rehearsal and rollback drills passed (P5.1, P5.2)
- [ ] A real phone call has succeeded on the production number

## Progress

Built to the recommended defaults (Phase 0 not yet confirmed): P1.2–P1.6 are implemented and tested (agent tests in `apps/agent/tests/test_call_guard.py`; routes smoke-tested against the local DB). Still open in Phase 1: P1.1 (needs your LiveKit dispatch rule and `AGENT_NAME=order-agent`), P1.7 and P1.8 (you). Phase 2 so far: P2.5 (opening hours) and P2.6 (isolation tests, run in CI against Postgres) done; P2.1's container healthcheck is added (uptime monitor + alert channel still need your choice of service). P2.2 needs a Sentry account, P2.3 needs your Resend domain, P2.4 needs decision D5. Not yet built: staff alert beyond the `ALERT:` log line (needs P2.1/P2.2), retention purge of `calls` (P4.1).

Phase 3 so far: P3.1–P3.4 built. Differences from the plan: admin "two-factor" is implemented as Google-only sign-in for admins (turn on 2-step verification on those Google accounts); the Trivy job has never run on GitHub and may flag existing dependency issues on its first run. P3.5 (off-site storage account) and P3.6 (secret rotation) need you.

P4.2: built and run on both Grok realtime (the production mode) and the DeepSeek pipeline: 14 scenarios x 3 runs each, 100%, text only (no audio, so speech recognition still need the P2.7/P4.5 phone tests). CI wiring needs `XAI_API_KEY` (and a caller-LLM key) as GitHub secrets. Decisions: D5 SMS skipped (P2.4 dropped; email + dashboard chime only), D6 retention accepted (purge built: `retention` service, tested on the local DB; not yet run on the server), D8 separate `order-agent` line accepted (P1.1 is yours to set up in LiveKit).

Added on request: audit log (all actions recorded, platform-admin viewer at `/admin/audit`); see `CLAUDE.md`.

Scaling work added after the plan (see CLAUDE.md): worker call cap + drain, live orders board, shared rate limits, menu cache, email job queue with retries and the unacknowledged-order alert, and Postgres row-level security.

## Suggested order of work

1. You answer Phase 0 (a single message with yes/no on each default is enough).
2. I do P1.1–P1.6 (about a week of focused work), you do P1.7 and P1.8 as soon as P1.1 is in.
3. Phase 2, with P2.7 (your phone comparison) running in parallel.
4. Phase 3 and Phase 4 in parallel where independent.
5. Phase 5.

## Risks to watch

- **Voice provider changes** (Grok realtime, LiveKit phone numbers, DeepSeek behaviour) can shift quality or price; keep the pipeline mode working as a fallback.
- **Costs scale with minutes**; P1.3, P1.4 and P1.7 exist for this reason, and call limits should be tuned once real usage is known.
- **Legal requirements vary by region** (disclosure, recording, retention, consumer-protection rules for phone ordering); the defaults above are not legal advice.
