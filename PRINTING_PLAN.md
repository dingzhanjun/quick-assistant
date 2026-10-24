# Kitchen printing plan

Orders must be printed in the restaurant's kitchen. Decisions made (2026-10-19):

- **A local print agent** (option B): a small program on a **Raspberry Pi / Linux mini PC** in the restaurant opens an
  outbound HTTPS connection to our server and prints jobs to the printer. No open ports, no router changes.
- **The server renders the ticket as an image** (a 1-bit PNG). The agent stays tiny: it downloads the picture and prints it.
- **The agent is written in Go** (decided 2026-10-19): one static binary per architecture (`GOOS=linux GOARCH=arm64|arm`),
  about 10-30 MB of RAM (a 1 GB Pi is plenty), no Python or virtual environment on the Pi to break, self-update = swap the
  binary. The protocol is language-neutral, so this never touches the server.
- **Printers are connected by USB** (ESC/POS thermal receipt printers).
- **Print timing is a per-restaurant setting** (default: immediately on every new order).
- **Ticket text: English.** Notes are English, as everywhere else.

```
phone order saved -> print job (ticket picture) -> server queue -> print agent (long-poll) -> /dev/usb/lp0 -> printer
                                                     ^ ack / heartbeat (printer status) ----+
```

## Status

- **Phase 1 done (2026-10-19)**: tables + RLS (migration 0018; agent token hashes are write-only for restaurant code),
  `print_timing` column, ticket JSON (`lib/print/ticket.ts`), renderer `@napi-rs/canvas` + Roboto
  (`lib/print/render.ts`, 1-bit PNG via `png1.ts`, about 7 KB per ticket, 10-20 ms), job creation (`lib/print/jobs.ts`:
  `enqueuePrint`, `enqueueTestPrint`; dedupe key; CANCELLED only if the order was printed), hooks in the agent order route
  (new / changed + CANCELLED for the replaced order), agent cancel route, staff cancel / accept (`on_accept`), 30-day
  purge, `NOTIFY print_jobs` trigger. Tests: `tests/print.test.ts`. Not yet: golden-image tests, dashboard ticket preview.
- **Phase 2 done (2026-10-19)**: agent API under `/api/print/*` (`pair`, `poll` long-poll woken by LISTEN/NOTIFY,
  `jobs/{id}/image`, `jobs/{id}/result`, `heartbeat`, `commands/{id}/result`; bearer token per agent, stored hashed; code in
  `lib/print/{agent,queue,service,devices,views}.ts`). Jobs are leased 60 s with `FOR UPDATE SKIP LOCKED`, retried, and
  `failed` after 5 attempts (audited `print.job_failed`). Pairing codes are 8 characters, one-time, 15 minutes, rate
  limited per IP (in process). Service commands: fixed allow-list, deduplicated, 10 per 10 minutes, expire after 5 minutes,
  delivered before tickets, audited. Dashboard: Settings -> Kitchen printing (timing, printers with live
  status, test print, add / revoke agent, service panel); `/admin/printing` (all agents, same commands); orders board
  shows Printed / Printing / Print failed (live) and a Reprint button (staff too). Tests: `tests/print-api.test.ts` (fake
  agent), isolation + staff cases in `tests/tenant-isolation.test.ts`, `e2e/print.spec.ts`. Not yet: the dashboard
  ticket preview, alerts (phase 4), the real agent (phase 3: until it exists the fake agent in the tests is the only client).
- **Phase 3 done (2026-10-19), except real hardware**: `apps/printer-agent` (Go, standard library only; README there). Pairing
  (`pair`, or the local page), long-poll, PNG -> ESC/POS raster in bands -> `/dev/usb/lp*` (name validated), copies (max 3),
  never prints a ticket twice (remembered across restarts), status via `DLE EOT`, heartbeat with LAN IP / host name /
  version / uptime, the allow-listed commands (restart, test print, show log, update, re-detect, reboot, **setup ticket**),
  self-update (server `/api/print/update`, https + sha256, `.prev` kept, rollback after 3 failed starts, only between
  tickets), setup ticket (text + printer QR + PIN), PIN-protected HTTPS setup page (status, pairing, Wi-Fi via `nmcli`, test
  print; lockout; off while paired and online), installer `apps/web/public/install-printer.sh` (systemd, udev, sudoers,
  user), CI job `printer-agent` (vet, test, cross-compile; the binaries themselves are built into the web image, see below). Go tests
  (escpos golden bytes, fake-server worker tests, update / rollback, setup page security) and `e2e/printagent.spec.ts` (the
  real binary against the real server) pass. Decision: no mDNS library: Raspberry Pi OS already answers `<hostname>.local`
  through avahi, and the setup ticket prints the IP. NOT tried on real hardware: USB printing, status read, printer QR,
  sudo reboot / nmcli, the installer and udev rule, the SD-card first-boot route.
- **Monitor-less first boot (SD-card files) done (2026-10-20)**: Settings -> Kitchen printing -> "Set up a new Pi without a
  monitor" (`createSetupFiles`, `lib/print/firstboot.ts`) generates cloud-init `user-data` (host name, time zone, locked
  `kitchen` user + optional SSH key, a first-boot systemd service that downloads `install-printer.sh`, installs and pairs,
  retries every minute until the network is up, deletes the code, prints a test ticket) and `network-config` (Wi-Fi as a
  derived key, never the plain password) for Raspberry Pi OS **Trixie** (Bookworm's `firstrun.sh` route is not covered). The
  embedded pairing code lives 7 days (`PAIRING_LONG_DAYS`). The installer no longer aborts when pairing fails: the agent then
  starts unpaired and prints the setup ticket. Needs `PRINT_AGENT_BASE_URL`. Tests: `tests/print-firstboot.test.ts`
  (YAML parse, quoting / injection, `sh -n` of the embedded script), the action in `tests/print-api.test.ts`, e2e download.
  NOT verified on a real Trixie image: that cloud-init accepts these files as written (keys `users`, `write_files`,
  `runcmd`, netplan `wifis` with `regulatory-domain`), that `network-online.target` is reached on Wi-Fi in time, and that the
  boot partition is really `/boot/firmware` with `user-data` replaceable by copying.
- **First-boot retry limit (2026-10-21):** the first-boot installer script retries every minute for at most 12 runs (about an hour,
  counted in `/var/lib/order-printer-firstboot/runs`, not by clock: a fresh Pi has no real-time clock before NTP). After that it prints a
  plain ESC/POS "SETUP FAILED" ticket (host name + the last error, written straight to `/dev/usb/lp*` because the agent is not
  installed), writes `.../failed` (the unit's `ConditionPathExists=!...failed` stops it) and disables the service. Success deletes the
  pairing code and the counter. `tests/print-firstboot.test.ts` runs the real script in a sandbox (stubbed curl / systemctl): retries,
  give-up ticket, failing installer, success.
- **Agent downloads hosted by the web image (2026-10-21):** a GitHub release is unusable for a private repo (a Pi cannot log in), so
  `apps/web/Dockerfile` has a Go stage (pinned `golang:1.23-bookworm` digest) that builds the three binaries + `.sha256` + `VERSION`
  from `apps/printer-agent` into `public/printer/`; the web app serves them at `/printer/`. `lib/print/release.ts` derives
  `{ version, baseUrl }` from those files (or from the `PRINT_AGENT_*` override); `/api/print/update`, the dashboard's SD-card
  setup (enabled automatically) and `createSetupFiles` use it. A new agent version = bump `apps/printer-agent/VERSION` + a web
  deploy. CI: the `printer-agent` job no longer publishes releases (no tag trigger); it runs vet / test / cross-compile and gates
  `build-image`. Tests: `tests/print-release.test.ts`; the web image was built and the files downloaded from a container.
- **Agent 0.1.1 (2026-10-21): the Pi reports its IPv4 address only.** `LANIP()` dialed the server with plain `udp`, so a server name
  with an IPv6 record made the dashboard show a long IPv6 address. It now probes with `udp4`, falls back to the first IPv4 of any
  interface (loopback and 169.254 link-local skipped) and reports nothing rather than an IPv6 address. Tests: `netinfo_test.go`.
  VERSION bumped (existing Pis update from the dashboard's "Update the agent software").
- **Agent 0.1.2 (2026-10-21): tickets were cut off when the device was closed too early.** Symptom on a TM-T20II (M267A) via
  `/dev/usb/lp0`: with the agent stopped, `order-printer test` printed the title and version line, then stopped (no host line, no
  cut); the NEXT job began with a stray `@` (its ESC byte lost) or printed a page of junk; the cycle repeated. Cause: the kernel's
  `usblp` driver returns from `write()` once the last USB transfer is SUBMITTED, and `close()` cancels it if still in flight, so
  the tail of every ticket was lost and the printer was left inside a half-received command that swallowed the start of the next
  job. Fix: `Devices.Write` (and the status query) now wait for the descriptor to become writable again (`ppoll`, which `usblp`
  signals when the last transfer completed; `drain_linux.go`, 60 s limit) before closing. Tests: `drain_linux_test.go` (full pipe:
  waits until drained, honours the timeout), run in a Linux container. An under-voltage warning on the Pi 3B (weak supply) was a
  separate, real problem and is fixed by a 5.1 V / 2.5 A supply.

## 1. Design

### Ticket
- The **server renders the ticket as a 1-bit PNG**: 576 dots wide for 80 mm paper, 384 for 58 mm, a few hundred rows, about
  5-20 KB. Reasons: any ESC/POS printer prints it without code pages or built-in fonts, the layout
  is identical everywhere, and a layout change never needs an agent update. Font: Roboto (open licence) shipped in the web image. Renderer candidates: `satori` + `resvg`, or `@napi-rs/canvas`; decide in a spike.
- The structured ticket data (JSON) is stored with the job too: it drives the **dashboard preview** and keeps the door open
  for agents that render locally later (JSON is about 1 KB and printer-native text prints faster than raster; that is the
  main reason to switch to local rendering if raster speed on the real printer turns out to be a problem).
- Content: restaurant name; **big order number**; **big pickup time** ("ASAP" or "6:30 PM"); customer name; one block per
  line item: quantity x name, chosen options, notes; a total; time the order was placed.
  Banner for `CHANGED` ("replaces #7") and `CANCELLED` (clear, inverted) tickets. Test tickets say TEST.
- Kinds: `new`, `changed`, `cancelled`, `reprint`, `test`.

### Data model (all restaurant data, so row-level security applies)
- `print_agents`: id, tenant_id, name, token_hash, pairing_code_hash + expiry, version, last_seen_at, revoked_at, `lan_ip`,
  `hostname`, `info` (jsonb: network name, uptime, printers seen).
- `print_agent_commands`: id, tenant_id, agent_id, command (allow-list), args, requested_by, status (`queued | sent | done |
  failed | expired`), result (text, e.g. the log tail), created_at, finished_at.
- `printers`: id, tenant_id, agent_id, name (e.g. "Kitchen"), device_key (what the agent calls it, e.g. `lp0`), paper width,
  copies, enabled, last_status (jsonb: online / paper out / cover open), last_status_at.
- `print_jobs`: id, tenant_id, printer_id, order_id, kind, status (`pending | leased | done | failed`), attempts,
  leased_until, ticket (jsonb), image (bytea, both kept 30 days), error, created_at, printed_at, `dedupe_key` unique
  (`order:kind:printer`) so a retry or a double trigger never creates two tickets.
- `tenant_settings`: `print_timing` (`immediate | on_accept`).

### Server API (agent side; one token per agent, one restaurant per token)
- `POST /api/print/pair` {code, version, devices[]}: swaps the one-time pairing code for the agent token and registers
  the USB devices the agent found.
- `GET /api/print/poll?wait=25`: long-poll. Returns the next job (`{id, printer, copies, kind}`) or 204. Leases the job
  for 60 s (`FOR UPDATE SKIP LOCKED`). The wake-up uses Postgres LISTEN/NOTIFY, like the live orders board, so a ticket
  starts printing about a second after the order is saved.
- `GET /api/print/jobs/{id}/image`: the PNG. `POST /api/print/jobs/{id}/result` {ok, error}: ack. A lease that expires is
  retried (at-least-once); the agent remembers recent job ids and never prints the same one twice.
- `POST /api/print/heartbeat` {printers: [status], lan_ip, hostname, version, info} every 30 s. The poll also returns queued
  service commands; the agent reports each result with `POST /api/print/commands/{id}/result`.
- Tokens are stored hashed, can be revoked, and the agent routes resolve the restaurant from the token, then run under
  `withTenant` (row-level security).

### Triggers
- New phone order (after commit): print on `immediate`, or when staff move it out of `new` on `on_accept`.
- Cancel / change by phone, and cancel by staff on the board: a `CANCELLED` / `CHANGED` ticket (always immediate).
- "Reprint" button on an order; "Test print" in Settings.

### Dashboard
- Settings -> Printing (owner): print timing, printers list with live status ("online", "paper out",
  "agent offline since 14:02"), copies, paper width, **Add printer** (shows a pairing code and the install command),
  Test print, Revoke agent.
- **Service panel** per agent (owner and platform admin): LAN IP, hostname, version, last contact, and the command buttons
  (Restart, Test print, Show log, Update, Re-detect printers, Reboot) with the result of the last command.
- Orders board: "Printed" / "Not printed" badge per order (live) and a Reprint button.

### Alerts (reusing the job queue and audit log)
- Email when a ticket is still unprinted after N minutes, or when the agent has been silent for 3 minutes while the
  restaurant is open. One alert per incident; a recovery note.

### Service and setup without a monitor (headless)
A service person must be able to install, find and fix a Pi with no screen and without knowing its IP address.

1. **Cloud service view (works whenever the Pi has internet; covers most cases).**
   - The heartbeat also reports the Pi's **local IP, hostname, network name, software version, uptime and the printers it
     sees** (`print_agents`: `lan_ip`, `hostname`, `version`, `info` jsonb).
   - Settings -> Printing and `/admin` show a **Service** panel per agent: "Kitchen Pi: online, 192.168.1.47, v1.3, printer OK".
   - **Commands** are queued on the server (`print_agent_commands`: agent, command, args, requested_by, status, result)
     and delivered through the same outbound long-poll, so no port is opened and nothing has to be discovered. Fixed
     allow-list only: `restart-agent`, `test-print`, `show-log` (last lines), `update`, `redetect-printers`, `reboot`.
     **Never an arbitrary shell.**
   - Who may use it: the restaurant owner and the platform admin (a technician uses a platform-admin account on a phone
     browser). Every command is written to the audit log (`print_agent.command`) with who and when; commands are rate
     limited and expire if the agent does not collect them within a few minutes.
2. **Setup ticket printed on the receipt printer (no network knowledge needed).** On first boot, and when a button is
   pressed (or the service panel asks), the agent prints a small ticket with its **IP address, hostname, version, pairing
   status, a one-time PIN and a QR code** for the local setup page. The printer in the kitchen is the display, and
   holding the ticket proves someone is physically there.
3. **Local setup page (for a Pi with no working network or no internet).** `http://order-printer-<id>.local:8080` (mDNS via
   avahi; the printed ticket gives the IP as a fallback), served by the agent on the LAN only. Protected by the PIN from the
   setup ticket (rate limited, locked after repeated failures, PIN regenerated each time). It offers only: network setup
   (Wi-Fi name and password, or Ethernet), status, re-pair with a new code, and a test print. HTTPS with a self-signed
   certificate is acceptable here because the PIN is the secret; it is never exposed beyond the local network.
4. **Monitor-less install.** Documented SD-card preparation with Raspberry Pi Imager (hostname, Wi-Fi name and password,
   SSH key) plus a small file on the boot partition with the pairing code. On first boot the Pi joins the network, installs
   or updates the agent, and pairs. Ethernet needs no configuration at all.
5. **Not building:** a native phone app that scans the network (app-store releases, iOS local-network permission, upkeep;
   the cloud view and the printed ticket cover the same need), and any unauthenticated command port on the LAN. An optional
   later extra for engineers: Tailscale (or similar) on the Pi for SSH from anywhere.

### Print agent (`apps/printer-agent`, Go)
- Standard library only (`net/http`, `image/png`, `os`), plus one mDNS library (e.g. `grandcat/zeroconf`) for the setup page.
  Commands: `order-printer pair <CODE> --server <URL>` and `order-printer run`.
- USB on Linux: writes ESC/POS bytes to the kernel's `/dev/usb/lp*` device (the `usblp` driver; no libusb needed), reads
  real-time status (`DLE EOT`) when the printer allows it.
- Converts the PNG to an ESC/POS raster image (`GS v 0`, in bands), adds a feed and a partial cut, optional buzzer.
- Installer script (`curl ... | sudo sh -s -- <CODE>`): downloads the binary for the Pi's architecture (built in CI and
  attached to each release), installs a systemd service, adds the udev rule so the service may use the printer, pairs.
  Config in `/etc/order-printer/`.
- **Self-update:** the agent checks the server for a newer version, downloads the new binary, verifies its checksum, swaps
  it in and restarts (systemd restarts it if the new one fails to start; the old binary is kept for one rollback).
- **Service support:** reports its LAN details in the heartbeat, executes the allow-listed commands, prints the setup ticket,
  serves the PIN-protected local setup page (see the headless section above).
- Later: network printers (TCP 9100, a few lines of code), libusb fallback for printers that do not expose `/dev/usb/lp*`.

## 2. Phases

| Phase | Work | Size | Depends on |
|---|---|---|---|
| 1 | Tables, RLS and grants, ticket renderer (PNG) with golden-image tests, ticket JSON + dashboard preview, job creation for new / changed / cancelled / reprint / test, per-restaurant settings | M | spike on the renderer and the font |
| 2 | Agent API (pair, long-poll, image, result, heartbeat with LAN details), pairing, Settings -> Printing page, **Service panel and command queue**, Test print, "Printed" badge, Reprint | M | 1 |
| 3 | The Go agent: PNG to ESC/POS raster, `/dev/usb/lp*`, status, installer, systemd, release binaries, self-update, **command execution, setup ticket, PIN-protected local setup page, monitor-less SD-card instructions** | M-L | 2 (can be tested against a fake printer file) |
| 4 | Alerts, print history, docs, real-printer acceptance test | S-M | 3, **your hardware** |
| 5 (later) | TCP 9100, libusb fallback, 58 mm tuning, second kitchen printer routing, optional Go rewrite | M | real-world use |

## 3. Tests
- Renderer: golden PNGs for a plain order, a long order, `CHANGED` and `CANCELLED` banners.
- Protocol: a fake agent (acts as the printer client): pair, poll, fetch image, ack; lease expiry and retry; duplicate
  job protection; revoked token; **tenant isolation** (an agent never sees another restaurant's jobs); row-level
  security coverage (the existing test fails if a new table lacks it).
- Agent (`go test`): golden raster output, and an integration test that prints to an ordinary file standing in for `/dev/usb/lp0`.
- Service: the command queue only accepts allow-listed commands, a command expires if not collected, results are stored,
  every command is audited, another restaurant's agent can never receive it; the local setup page rejects a wrong PIN,
  locks out after repeated failures and never offers anything beyond its short list.
- Browser test: add printer in Settings, place an order, a fake agent receives the ticket, the board shows "Printed".

## 4. What I need from you
1. **Hardware for the real test:** a Raspberry Pi (3, 4, 5 or Zero 2 W) with a power supply and SD card, and an ESC/POS
   USB thermal printer. **Tell me the exact printer model** (Epson TM-T20 / TM-T88, Xprinter and others behave
   differently); some cheap printers do not expose `/dev/usb/lp*` and will need the libusb fallback.
2. Paper width (80 mm or 58 mm).
3. Each restaurant's choice of print timing (default: immediately).
4. An OK to add a font file (Roboto, open licence) to the web image; it adds under 1 MB.

## 5. Risks
- USB printers that are not `usblp` class (needs libusb; phase 5).
- Thermal printing of large raster images can be slow on cheap models: keep tickets short, band the image, check speed
  on the real printer.
- A third language in the repo (Go next to TypeScript and Python) and a Go build job in CI for `linux/arm64` + `linux/arm`.
- Raspberry Pi SD cards wear out and Pis lose power: the server keeps jobs, the agent starts at boot, and the alert
  tells you when a Pi is gone. Consider a read-only root filesystem later.
- The local setup page is a small web server on the LAN: keep it minimal, PIN-protected, rate limited, and off whenever the
  Pi is already paired and online (it can be re-enabled from the printer button or the service panel).
- Support load: every restaurant has hardware to install. The one-line installer and pairing code exist to keep that small.
