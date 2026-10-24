# TODO

> The ordered launch plan (phases, owners, acceptance checks and the go-live gate) is in `LAUNCH_PLAN.md`; the security/reliability findings behind it are in `HARDENING.md`. This file is the general backlog.

Rough priority within each section: top = sooner. Items marked **(launch)** should be done before real customers use it.

## Added since the last revision
- [ ] Privacy policy and terms pages (the greeting already says it is an automated assistant)
- [ ] Real SIP trunk (Twilio/Telnyx) for the restaurant number so SIP transfers work; the LiveKit-bought number cannot
- [ ] Load test one worker, then set `AGENT_MAX_CALLS` from the result (LAUNCH_PLAN P4.4)
- [x] Copy the menu from another restaurant the owner also owns (multi-location chains: one restaurant per location, one number each)
- [ ] Restaurant groups with a LINKED menu (change a price once, every location follows; per-location sold-out, hours and price overrides) and group-level reports
- [ ] One shared phone number for several locations (the agent would ask which location; needs groups first)
- [ ] Billing and per-restaurant usage metering
- [ ] Orders history page (older orders beyond the board's last 50)
- [x] Texts to the customer: the order link when the restaurant confirms, a changed pickup time, a cancellation (built; Twilio and Plivo not yet tried with real accounts)
- [ ] **(launch, if texting)** Choose an SMS provider, register US sending (A2P 10DLC or toll-free verification), set `SMS_PROVIDER` and keys, send a real test text
- [ ] Optional: print a "PICKUP CHANGED" ticket automatically when the pickup time is changed (today staff press Reprint)
- [x] Dedicated `worker` service for emails/texts, `/api/health/worker`, and an admin queue page with failed jobs, retry and delete
- [ ] SMS delivery receipts (provider webhooks) so a text the carrier blocked shows up, not only ones the provider rejected
- [ ] Optional: throttle sends per provider (concurrency / rate) if a burst ever hits a provider limit
- [ ] Optional: admin page to choose the SMS provider and send a test text (today it is environment variables only)
- [x] `PLATFORM_ADMIN_PASSWORD` seeds the first admin on a brand-new system (remove it once Google sign-in works)

## Setup still pending
- [ ] First real phone call to `+14155550100` (registered to Demo Pizza locally): confirm the logged `participant attributes` show the dialed number, the Grok voice works over the phone line, and a cloud-hosted LiveKit agent also named `food` (if any) isn't intercepting calls (upgrade `lk` to >=2.6.3 to run `lk agent list`)
- [ ] Create Google OAuth client, fill `GOOGLE_CLIENT_ID/SECRET`, test Google sign-in + `/admin` as a signed-in admin (none of the signed-in UI has been exercised in a browser yet)
- [ ] Fill `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`, `DEEPGRAM_API_KEY` (covers both speech-to-text and text-to-speech), then run the voice test in console mode (`uv run python -m order_agent.main console`)
- [ ] Real LiveKit project + SIP trunk (Twilio/Telnyx) + dispatch rule so inbound calls start the agent; confirm the dialed-number attribute name (`sip.trunkPhoneNumber`) against a real call

## Auth & accounts
- [x] Restaurant switcher for users in multiple restaurants (done)
- [x] Forgot / reset password flow (done; email delivery still depends on Resend setup below)
- [x] Sign-out button (done in dashboard and admin nav; no fuller user menu yet)
- [ ] **(launch)** Real email delivery: set up Resend (or similar), verified sending domain, SPF/DKIM; test the verification email
- [x] Close the pre-registration hole for ordinary users (someone registers a stranger's email with a password before the owner signs in with Google) — e.g. don't auto-link unverified accounts, or delete unverified accounts on Google link  (done)
- [x] Invite staff to a restaurant (Better Auth organization invitations) and owner vs. staff permissions  (done: owner / staff, invitations)
- [x] Rate limiting on auth endpoints and on `/api/agent/*`  (done: shared in the database; agent calls are limited per caller and per restaurant)
- [ ] Block a suspended restaurant's own dashboard (currently only the phone agent is blocked)

## Notifications
- [x] Email to the restaurant on new orders (done; SMS/push still open)
- [x] Sound alert + toast on the orders page for new orders (done; sound must be switched on per page load; no browser/push notification for closed tabs yet)
- [x] Order confirmation to the customer by SMS (done: the agent asks for the number; texts go out on confirm / pickup change / cancel)
- [ ] Platform-admin alerts (agent errors, failed calls, new signups)

## Orders
- [x] Replace 5s polling with push (SSE + Postgres LISTEN/NOTIFY)  (done: live board over server-sent events)
- [x] Pickup time (as soon as possible, or a time today) and caller number on orders (done)
- [ ] Order type (pickup vs. delivery)
- [ ] Printable kitchen ticket / receipt
- [ ] Order history page with search and date filters (board only shows last 50)

## Menu & restaurant settings
- [x] Modifiers: reusable option groups with required/optional, max picks, and per-option price (done; see CLAUDE.md)
- [ ] Modifier extras: per-option quantity, percentage pricing, availability by time, drag-to-reorder
- [x] Browser-test the modifier editor UI (only the pages' server rendering, the API and the agent were tested)  (done: Playwright covers creating a group)
- [ ] Categories, modifiers/options (size, toppings), and per-item prep time — the agent needs structured modifiers, not just free-text notes
- [x] Opening hours; agent says "we're closed" outside them  (done)
- [ ] Per-restaurant agent settings: greeting, voice, tone, upsell rules
- [ ] Replace the browser `confirm()` on menu delete with a proper dialog
- [ ] Menu import (CSV) for onboarding

## Voice agent
- [x] Big menus: `search_menu` tool with fuzzy matching, names-only overview in the prompt (done; threshold via `MENU_SEARCH_THRESHOLD`)
- [ ] If menus ever reach the thousands: move search server-side (Postgres `pg_trgm`, then `pgvector` embeddings); today it is in memory in the agent and the whole menu is fetched per call
- [ ] Measure search quality on a real 150-dish menu with real speech-recognition output (the tests use a synthetic menu and typed mistakes)
- [ ] Try `VOICE_MODE=grok` (needs `XAI_API_KEY`): check hearing/speaking, delay, tool calling, cost (a search result suggested ~$0.08/min bundled, unverified)
- [x] **(launch)** Human fallback: transfer to the restaurant's real phone when the agent is stuck or the caller asks  (done: keypad 0 / "human agent"; needs a SIP trunk that allows transfers, LiveKit-bought numbers cannot)
- [ ] **(launch)** Call recording / transcript consent wording and legal review (varies by region)
- [ ] Call logs: duration, transcript, outcome, linked order
- [ ] Per-call cost tracking (telephony, STT, LLM, TTS) per tenant — feeds billing
- [ ] Platform-admin setting for STT / TTS providers (LLM is already configurable)
- [ ] Optional per-tenant LLM override
- [ ] Measure latency and ordering accuracy: OpenAI vs. DeepSeek (never tested with real audio)
- [x] Tool polish (item names, `remove_item`, clear after submit, reject empty/unknown items)
- [x] Phone-style prompt rewrite (short replies, allergen caution, order grounded in tools, totals computed in code)
- [x] Turn the scratch text-only conversation test into a repeatable eval in the repo (several scenarios, run N times each, since the model is non-deterministic); the model once said "got it" without calling `add_item`  (done: `apps/agent/evals`, CI workflow)
- [ ] Handle noisy/accented callers and interruptions (needs real audio testing)

## Billing (platform charges restaurants)
- [ ] Stripe subscription plans + customer portal
- [ ] Usage-based charges (per call minute) and plan limits
- [ ] Auto-suspend on failed payment (reuse `tenant_settings.suspended`)
- [ ] Optional later: Stripe Connect so restaurants can take payment from their customers

## Platform admin
- [ ] Tenant detail page (members, numbers, recent orders, usage)
- [ ] User management (ban/unban, impersonate for support)
- [ ] Usage / revenue dashboard
- [x] Audit log for admin actions  (done for ALL actions, `/admin/audit`)
- [ ] Phone-number provisioning (buy/assign numbers) instead of manual entry in Settings

## Engineering
- [x] Deployment artifacts: Dockerfiles, `docker-compose.yml` (Caddy HTTPS or Cloudflare Tunnel), scheduled `backup` service, CI builds+pushes images to GHCR, `/api/health`, `DEPLOY.md` (tested locally as a full stack; actual server deploy still to do)
- [ ] Automatic deploys: create the GitHub `Prod` (main) and `Dev` (dev) environments with their secrets (see DEPLOY.md); decide how CI reaches the server if it's behind a Cloudflare tunnel/NAT (self-hosted runner?)
- [ ] **(launch)** Actually deploy to the Ubuntu server per DEPLOY.md: DNS, `.env`, GHCR login on the server, Resend, Google prod OAuth, LiveKit/SIP
- [ ] **(launch)** Automate copying backups off the server (rsync/rclone to object storage); only manual instructions exist
- [x] Tests: API routes (orders, tenant isolation), server actions, agent tools; CI (lint, build, tests)  (done: node tests + Playwright + agent tests in CI)
- [x] Postgres row-level security as a second layer of tenant isolation  (done)
- [ ] Error monitoring (Sentry) and structured logs; DB backups
- [ ] Privacy policy, terms of service, data retention / deletion
- [ ] Remove dev-only `DEV_CALLED_NUMBER` from production config
