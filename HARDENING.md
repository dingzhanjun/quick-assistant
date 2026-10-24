# Pre-launch hardening review

Findings from reading the code and configuration (not from a penetration test). Each item says what is wrong
today, why it matters, and what to do. "Verified" means I checked the code or ran it; "untested" means it
has never been exercised for real.

## Status (updated 2026-10-19)

The numbered findings below are the original review; this table says where each stands now.
✅ done and tested · 🟡 partly done (what is left in the note) · ⬜ not done.

| # | Finding | Status | Now |
|---|---|---|---|
| 1 | Any member can claim a phone number | ✅ | Admin-only; one agent number per restaurant (DB-enforced) |
| 2 | No call limits | 🟡 | Done: 8 min max, silence prompt + hang-up at 30 s, 3 concurrent / restaurant, 5 calls/hour / caller. Open: provider spending alerts (yours) |
| 3 | Prank / duplicate orders | ✅ | Idempotency key, caller number stored (masked in logs), block list |
| 4 | No failure path on save | 🟡 | Retry once, apology, `ALERT:` log. Open: alert to staff beyond the log (needs monitoring) |
| 5 | Dead phone line goes unnoticed | 🟡 | Worker healthcheck + own `AGENT_NAME` supported. Open: uptime monitor and alert channel, the dispatch rule (P1.1) |
| 6 | Orders fail to reach the kitchen | 🟡 | Email job queue with retries and an unacknowledged-order reminder. Open: verified Resend domain; SMS dropped by decision |
| 7 | Legal disclosure | 🟡 | AI disclosure in the greeting. Open: privacy policy and terms pages |
| 8 | No opening hours | ✅ | Per-restaurant hours and time zone; closed message (no "order for later") |
| 9 | No isolation tests | ✅ | Isolation tests in CI and Postgres row-level security |
| 10 | Authentication | 🟡 | Shared rate limits, IP header, pre-registration fix, Google-only admins (optional `PLATFORM_ADMIN_PASSWORD` seeds the first admin on a brand-new system; remove it afterwards), 7-day sessions, audit log. Open: real TOTP two-factor |
| 11 | Roles | ✅ | Owner / staff, invitations |
| 12 | Security headers | ✅ | CSP, HSTS and the rest |
| 13 | Container hygiene | 🟡 | Digests, Action SHAs, Dependabot, Trivy, log rotation, memory limits. Open: the Trivy job has never run on GitHub |
| 14 | Off-site backups | ⬜ | Still manual |
| 15 | Secrets | ⬜ | Rotation, read-only GHCR token, file modes: yours |
| 16 | Personal data | 🟡 | Caller numbers masked in logs and purged after 90 days; log files off by default. Open: LiveKit room names contain the caller number |
| 17 | AI reliability | ✅ | Evals (21 scenarios) with a CI workflow |
| 18 | Order lifecycle | 🟡 | Cancel / change by phone and pickup time done. Open: tax, payment |
| 19 | Load test | 🟡 | Worker call cap, graceful drain, replicas done. Open: the actual load test |
| 20 | Noise / accent testing | ⬜ | Real phones needed |
| 21 | Browser tests | ✅ | Playwright suite (11 tests) in CI |

Never exercised end to end is now: production deployment on the server, the GitHub Actions run (the whole pipeline,
including GHCR push, the Trivy scan, the browser tests and the deploy job), the Cloudflare tunnel, Resend delivery,
production Google sign-in, a real call with several features added since (transfer, hang-up on goodbye, pickup time,
cancel / change), SIP transfers (LiveKit-bought numbers cannot do them), and more than one simultaneous call.


## P0 — fix before real customers call

1. **Any restaurant member can claim any phone number.** `dashboard/settings/actions.ts` only checks that the
   number is unused. Someone can register a number that belongs to another business (or squat on it), so its
   calls reach the wrong menu. *Fix:* only the platform admin (or a provisioning flow that proves ownership)
   attaches numbers; restaurants see theirs read-only.
2. **No limits on call length, silence or volume.** Nothing ends a call except the order finishing (verified in
   `main.py`). A caller can idle or loop for as long as they like; every minute costs LiveKit + speech + LLM.
   *Fix:* maximum call length (e.g. 8–10 min, with a polite goodbye), hang up after N seconds of silence,
   per-caller and per-restaurant concurrency / rate limits, spending alerts at LiveKit, xAI/Deepgram and the LLM.
3. **Prank and duplicate orders.** No idempotency key (verified: none in `orders/route.ts` or `api.py`), the
   caller's number is not stored with the order, and there is no block list. A timed-out request that actually
   succeeded would be re-submitted and create a duplicate. *Fix:* idempotency key per call + cart; store the
   caller number (decide retention first); block list; optional "confirm by callback" for suspicious callers.
4. **The agent has no failure path when saving the order fails.** `submit_order` has no try/except or retry
   (verified). *Fix:* retry once with the same idempotency key; on failure apologise, take a callback number or
   transfer to the restaurant's phone, and raise an alert.
5. **Nothing tells you the phone line is dead.** If the worker crashes or the LiveKit/xAI/Deepgram credentials
   break, callers just hear silence. *Fix:* compose healthcheck on the worker's port 8081, uptime monitor on
   `/api/health` and the worker, alert on error rate, and a restart policy (exists). Give the agent its own
   unique `AGENT_NAME` — a self-hosted `food` agent shares the name today and can steal calls.
6. **Orders can fail to reach the kitchen silently.** New-order alerts are email only and best effort (failures
   are only logged, verified in `notify.ts`); without Resend configured nothing is delivered at all. *Fix:* working
   Resend with a verified domain, retry queue, a second channel (SMS or push), and an alert when an order sits
   unacknowledged for N minutes.
7. **Legal disclosure.** The greeting does not say the caller is talking to an automated assistant, and there is no
   recording notice (verified). Many jurisdictions require disclosure. *Fix:* add the line to the greeting
   (needs your decision on wording), publish a privacy policy and terms, define retention.
8. **No opening hours.** The agent takes orders at 3 a.m. (verified: not implemented). *Fix:* opening hours and
   time zone per restaurant; closed message and optional "order for later".
9. **Cross-tenant isolation has no automated tests.** Every query is scoped by `tenantId` (read through, not
   machine-checked). *Fix:* integration tests that try to read/modify another restaurant's data through every server
   action and API route; consider Postgres row-level security as a second layer.

## P1 — soon after launch

10. **Authentication.** Better Auth rate limiting is on in production by default but loose (100 requests / 10 s) and
    in memory (verified in the library); behind Caddy/Cloudflare the client IP header must be configured, or all users
    share one bucket and attackers can spoof it. Also: pre-registration hijack for ordinary users, no two-factor for
    platform admins, default session lifetime, no audit log.
11. **Roles.** Any member can edit menu, numbers and notification emails (verified: no role check). Add owner / staff
    roles and the invitation flow.
12. **Security headers.** None set (verified in `next.config.ts` and the Caddyfile): add HSTS, CSP,
    `X-Content-Type-Options`, `frame-ancestors`/`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.
13. **Container and supply-chain hygiene.** Floating tags (`postgres:16`, `caddy:2`, `cloudflared:latest`,
    `python:3.12-slim`, `node:22-slim`) and GitHub Actions pinned to version tags, not commit SHAs (verified). Pin
    image digests and action SHAs, add Dependabot and an image scan in CI. Add log rotation (`logging.options.max-size`)
    and memory limits to every service — Docker logs are unbounded today, and a full disk takes the database down.
14. **Backups.** Dumps are verified and restore was tested, but copying them off the server is manual. Automate it and
    do a restore drill from the off-site copy.
15. **Secrets.** One shared `AGENT_API_KEY`; rotate it, scope the GHCR token to read-only packages, keep `.env`
    at mode 600, make sure no key ever reaches a log.
16. **Personal data.** Agent logs, LiveKit room names (`food_<caller number>_…`) and `AGENT_LOG_FILE` contain caller
    numbers; customer names are in orders and emails. Keep the log file off or rotated in production, set retention,
    support deletion requests.
17. **AI reliability.** The DeepSeek flow sometimes defers `add_item` or drops a request. Build the
    repeatable evaluation suite (several scenarios, many runs), track tool-call failures in production, and decide on a
    human fallback phrase and transfer.

## P2 — later

18. Order lifecycle after submit (cancel / change), pickup time and ETA, tax and payment (pay-at-pickup today).
19. Load test: N concurrent calls against one worker (CPU for voice activity detection, memory, LiveKit limits) and
    the web app's database pool.
20. Noise, accents and interruption testing on real phone lines; a QA process using transcripts (with consent).
21. Browser-test the dashboard flows (menu, modifiers, settings) — only server rendering and the API were tested.

## Never exercised end to end (treat as unknown until you do)

Production deployment on the Ubuntu server, the GitHub Actions run (including GHCR push and SSH deploy), the
Cloudflare tunnel, Resend delivery, production Google sign-in, the hang-up on a real phone call (the room-delete call
itself was tested on a real LiveKit room), and more than one simultaneous call.
