# order-printer: the kitchen print agent

A small Go program (standard library only, one static binary, about 10-30 MB of RAM) that runs on a Raspberry Pi next to a
USB ESC/POS receipt printer. It only connects OUTWARD to the platform over HTTPS (no open port, no router change):
it long-polls `/api/print/poll`, downloads each ticket as a 1-bit PNG, prints it to `/dev/usb/lp0`, and confirms.
Design and decisions: `/PRINTING_PLAN.md`.

```
cmd/order-printer      CLI: run | pair <CODE> --server URL | detect | test | version
internal/api           client for /api/print/*
internal/agent         worker (poll, print, dedupe, heartbeat), service commands, self-update, state
internal/escpos        PNG -> GS v 0 raster bands, text + QR, cut, status (DLE EOT)
internal/setup         PIN-protected local setup page (HTTPS, LAN)
```

## Develop

```sh
cd apps/printer-agent
go vet ./... && go test ./...
go build -o order-printer ./cmd/order-printer
# a plain file stands in for the printer:
mkdir -p /tmp/dev && : > /tmp/dev/lp0
ORDER_PRINTER_DEV_DIR=/tmp/dev ORDER_PRINTER_CONFIG=/tmp/op/config.json ORDER_PRINTER_STATE=/tmp/op/state \
  ./order-printer pair ABCD-EFGH --server http://localhost:3000 && \
ORDER_PRINTER_DEV_DIR=/tmp/dev ORDER_PRINTER_CONFIG=/tmp/op/config.json ORDER_PRINTER_STATE=/tmp/op/state ./order-printer run
```

`apps/web/e2e/printagent.spec.ts` runs this real binary against the real server (pair, print, service command, revoke).
Environment: `ORDER_PRINTER_CONFIG` (default `/etc/order-printer/config.json`), `ORDER_PRINTER_STATE`
(`/var/lib/order-printer`), `ORDER_PRINTER_DEV_DIR` (`/dev/usb`), `ORDER_PRINTER_PORT` (setup page, 8080).

## Release

**The server hosts the agent downloads itself.** `apps/web/Dockerfile` has a Go stage that builds
`order-printer-linux-{arm64,arm,amd64}`, their `.sha256` files and a `VERSION` file from this folder into the web image's
`public/printer/`, so they are served at `https://<your domain>/printer/...`. No GitHub release is involved (that would not work for a
private repository: a Pi cannot log in to GitHub). To ship a new agent: change the code, **bump `VERSION`** (a plain number such as
`0.2.0`), merge, and deploy the web image as usual. Agents already in restaurants check `/api/print/update` every 6 hours (or on the
dashboard's "Update the agent software"); when the server's version is higher they download the new binary, verify the checksum, keep
the old one as `order-printer.prev`, and restart (if the new one cannot reach the server in 3 starts, the old one is put back).
The CI job `printer-agent` runs `go vet`, `go test` and a cross-compile check; `printer-agent` must pass before the images build.

For local development `pnpm --filter web agent:build` builds the same files into `apps/web/public/printer/` (git-ignored). To host the
files somewhere else, set BOTH `PRINT_AGENT_VERSION` and `PRINT_AGENT_BASE_URL` on the web server (they override the built-in files).

## Install on a Pi (Raspberry Pi OS, 32- or 64-bit)

In the restaurant's dashboard: Settings -> Kitchen printing -> "Add a print agent" shows a one-time code (15 minutes) and the
exact command, which looks like

```sh
curl -fsSL https://YOUR-SERVER/install-printer.sh | sudo sh -s -- ABCD-EFGH --server https://YOUR-SERVER --base https://YOUR-SERVER/printer
```

The script downloads the binary for the Pi's CPU and checks its checksum, creates the `orderprinter` user (group `lp`),
installs the udev rule and a sudoers entry limited to `systemctl reboot` and `nmcli dev wifi connect`, installs and starts the
`order-printer` systemd service, and pairs. The printer then appears in Settings with its status.

### Without a monitor or keyboard (SD card files from the dashboard)

Preferred: Settings -> Kitchen printing -> "Set up a new Pi without a monitor" downloads cloud-init `user-data` (+ `network-config` for
Wi-Fi) for Raspberry Pi OS Trixie. Flash plain Raspberry Pi OS Lite with no customisation, copy the files onto `bootfs`, put the
card in the Pi: it installs the agent (retrying for about an hour, then printing a SETUP FAILED ticket and stopping), pairs with a 7-day code and prints a test ticket by itself (`apps/web/src/lib/print/firstboot.ts`;
not yet tried on a real Pi). Older route:

1. Raspberry Pi Imager: choose Raspberry Pi OS Lite, set host name, user, Wi-Fi name and password, enable SSH (key).
2. Ethernet needs no configuration at all.
3. Boot, then either SSH in once and run the command above, or put `install-printer.sh` on the card's boot partition together
   with `order-printer.conf` (`CODE=ABCD-EFGH`, `SERVER=https://...`, `BASE=https://...`) and run it from Imager's first-boot
   script. (The boot-partition route is written but has not been tried on a real Pi.)
4. If the Pi is unpaired when it starts, it prints a **setup ticket** (IP address, host name, version, a PIN, a QR code) and keeps
   the local setup page open.

### Finding and fixing a Pi

- Dashboard -> Settings -> Kitchen printing (owner) or `/admin/printing` (platform admin, works from a phone): shows each Pi's
  local IP, host name, version, last contact, printer status, and buttons: restart the agent, print a test ticket, show the
  last 80 log lines, update, re-detect printers, reboot, print the setup ticket. These are the ONLY commands; there is no shell.
- "Print the setup ticket" prints the ticket and opens the local setup page for 15 minutes: `https://<ip>:8080`, sign in with
  the PIN on the ticket. It offers only status, pairing, Wi-Fi, and a test print. 5 wrong PINs lock it for 15 minutes. It is
  otherwise OFF while the Pi is paired and online (and ON while unpaired or cut off from the server for more than 3 minutes).
- On the Pi: `systemctl status order-printer`, `journalctl -u order-printer -f`, `order-printer detect`, `order-printer test`.

## Security notes

- The agent token is stored hashed on the server; revoking in the dashboard makes the agent fall back to unpaired mode.
- Device names from the server are checked (`lp<digits>` only) before touching the filesystem; commands are an allow-list on
  both sides; updates must be https and match their checksum.
- The setup page uses a throw-away self-signed certificate (the browser warns once); the PIN is the secret. It never runs a
  command except `nmcli` with validated arguments.
- NOT tested on real hardware yet: USB printing through `/dev/usb/lp0`, the `DLE EOT` status read, the printer's QR command,
  sudo `reboot`/`nmcli`, the installer, the udev rule, mDNS-free access by IP. Use the acceptance checklist in
  `PRINTING_PLAN.md` (phase 4) with the real Pi and printer.
