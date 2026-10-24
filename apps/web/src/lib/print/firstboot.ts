import { pbkdf2Sync } from "node:crypto";

// "Set up a Pi without a monitor": the dashboard generates the files the owner copies onto the SD card's boot partition
// (Raspberry Pi OS Trixie reads them with cloud-init on the first boot):
//   user-data       host name, time zone, a locked service user (+ optional SSH key), and the first-boot installer
//   network-config  Wi-Fi (only when Wi-Fi details were given; Ethernet needs nothing)
// On first boot a systemd service downloads `install-printer.sh` from the platform, installs the agent and pairs it with the
// one-time code in the file. It retries every minute until the network is up, deletes the code afterwards, and the printer
// prints a short "I am alive" ticket.

export type FirstBootInput = {
  hostname: string;
  timezone: string;
  code: string; // pairing code (valid several days for this use)
  server: string; // https://platform
  base: string; // https folder with the agent binaries
  wifi?: { ssid: string; password: string; country: string };
  sshKey?: string; // optional public key for an engineer; without one nobody can log in (the dashboard manages the Pi)
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const URL_RE = /^https:\/\/[A-Za-z0-9.:/_-]+$/;
// The platform address is https in production (it comes from DOMAIN); plain http is allowed so a developer can try a Pi against
// a server on the local network. The binary download (BASE) must always be https.
const SERVER_RE = /^https?:\/\/[A-Za-z0-9.:/_-]+$/;
const CODE_RE = /^[A-Za-z0-9-]{4,20}$/;
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [^\r\n]{0,80})?$/;
const TZ_RE = /^[A-Za-z0-9_+/-]{1,60}$/;

// A YAML double-quoted scalar is a JSON string, so JSON.stringify quotes any value safely.
const q = (s: string) => JSON.stringify(s);

export function validateFirstBoot(i: FirstBootInput): string | null {
  if (!HOST_RE.test(i.hostname)) return "Host name: 1-32 lowercase letters, digits and dashes (e.g. kitchen-pi)";
  if (!TZ_RE.test(i.timezone)) return "Invalid time zone";
  if (!CODE_RE.test(i.code)) return "Invalid pairing code";
  if (!SERVER_RE.test(i.server)) return "The server address must be http(s)://...";
  if (!URL_RE.test(i.base)) return "PRINT_AGENT_BASE_URL must be an https:// folder URL";
  if (i.wifi) {
    if (!/^[^\x00-\x1f]{1,32}$/.test(i.wifi.ssid)) return "Wi-Fi name: 1-32 characters";
    if (i.wifi.password.length < 8 || i.wifi.password.length > 63 || /[\x00-\x1f]/.test(i.wifi.password)) return "Wi-Fi password: 8-63 characters";
    if (!/^[A-Z]{2}$/.test(i.wifi.country)) return "Wi-Fi country: two capital letters, e.g. US";
  }
  if (i.sshKey && !SSH_KEY_RE.test(i.sshKey.trim())) return "That does not look like an SSH public key (ssh-ed25519 AAAA...)";
  return null;
}

const FIRSTBOOT_SCRIPT = `#!/bin/sh
# First boot: install the kitchen print agent and pair it. Started by order-printer-firstboot.service, which re-runs this
# every minute until it succeeds (the network may take a while to come up). After MAX_RUNS unsuccessful runs (about an
# hour) it GIVES UP: prints a "SETUP FAILED" ticket, writes <state>/failed (the unit then no longer starts) and disables
# the service. The paths and timings can be overridden with FB_* variables (the tests do).
set -u
CONF="\${FB_CONF:-/etc/order-printer-firstboot.conf}"
BIN="\${FB_BIN:-/opt/order-printer/order-printer}"
STATE="\${FB_STATE:-/var/lib/order-printer-firstboot}"
DEVS="\${FB_DEVS:-/dev/usb/lp*}"
TMPF="\${FB_TMP:-/tmp/install-printer.sh}"
TRIES="\${FB_TRIES:-20}"
PAUSE="\${FB_PAUSE:-10}"
MAX_RUNS="\${FB_MAX_RUNS:-12}"

[ -x "$BIN" ] && exit 0
mkdir -p "$STATE"
runs=$(cat "$STATE/runs" 2>/dev/null || echo 0)
runs=$((runs + 1))
echo "$runs" > "$STATE/runs"

if [ "$runs" -gt "$MAX_RUNS" ]; then
  reason=$(cat "$STATE/last-error" 2>/dev/null || echo "unknown")
  echo "first boot install: giving up after $MAX_RUNS runs: $reason" >&2
  : > "$STATE/failed"
  dev=$(ls $DEVS 2>/dev/null | head -n 1)
  if [ -n "$dev" ]; then
    # a plain-text ESC/POS ticket (the agent is not installed, so the printer is driven directly)
    printf '\\033@\\033a\\001\\035!\\021SETUP FAILED\\n\\035!\\000\\033a\\000\\n%s\\n%s\\n\\nThe printer could not be set up.\\nCheck the network cable or the\\nWi-Fi password, then flash the\\ncard again with new files.\\n\\033d\\003\\035VB\\003' "$(hostname)" "$reason" > "$dev" 2>/dev/null || true
  fi
  systemctl disable order-printer-firstboot.service >/dev/null 2>&1 || true
  exit 0
fi

fail() {
  echo "$1" > "$STATE/last-error"
  echo "first boot install failed (run $runs of $MAX_RUNS): $1" >&2
  exit 1
}

[ -r "$CONF" ] || fail "the settings file $CONF is missing"
. "$CONF"
i=0
until curl -fsS --max-time 20 -o "$TMPF" "$SERVER/install-printer.sh"; do
  i=$((i + 1))
  [ "$i" -ge "$TRIES" ] && fail "cannot download the installer from $SERVER (no network, or the server is down)"
  sleep "$PAUSE"
done
sh "$TMPF" "$CODE" --server "$SERVER" --base "$BASE" || fail "the installer failed (check the download address)"
rm -f "$CONF" "$TMPF"
rm -rf "$STATE"
# a short ticket proves the whole chain: Pi, USB, printer
if id orderprinter >/dev/null 2>&1; then
  su -s /bin/sh orderprinter -c "$BIN test" || true
fi
`;

const FIRSTBOOT_UNIT = `[Unit]
Description=Install the kitchen print agent (first boot)
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/opt/order-printer/order-printer
ConditionPathExists=!/var/lib/order-printer-firstboot/failed

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/order-printer-firstboot.sh
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
`;

const block = (text: string, indent: number) => text.replace(/\n$/, "").split("\n").map((l) => (l ? " ".repeat(indent) + l : l)).join("\n");

export function buildFirstBootFiles(i: FirstBootInput): { userData: string; networkConfig: string | null } {
  const err = validateFirstBoot(i);
  if (err) throw new Error(err);
  const key = i.sshKey?.trim();
  const conf = `CODE=${i.code}\nSERVER=${i.server}\nBASE=${i.base}\n`;
  const lines = [
    "#cloud-config",
    "# Generated by the restaurant dashboard (Settings -> Kitchen printing). Contains a one-time pairing code: do not share.",
    `hostname: ${q(i.hostname)}`,
    "manage_etc_hosts: true",
    `timezone: ${q(i.timezone)}`,
    // Raspberry Pi OS ships with the SSH server off; this is its documented switch for cloud-init (the runcmd line below is a fallback)
    ...(key ? ["enable_ssh: true"] : []),
    "users:",
    "  - name: kitchen",
    "    gecos: Kitchen printer",
    "    shell: /bin/bash",
    "    lock_passwd: true",
    ...(key ? ["    sudo: ALL=(ALL) NOPASSWD:ALL", "    ssh_authorized_keys:", `      - ${q(key)}`] : []),
    `ssh_pwauth: false`,
    "write_files:",
    "  - path: /etc/order-printer-firstboot.conf",
    '    permissions: "0600"',
    "    content: |",
    block(conf, 6),
    "  - path: /usr/local/sbin/order-printer-firstboot.sh",
    '    permissions: "0755"',
    "    content: |",
    block(FIRSTBOOT_SCRIPT, 6),
    "  - path: /etc/systemd/system/order-printer-firstboot.service",
    '    permissions: "0644"',
    "    content: |",
    block(FIRSTBOOT_UNIT, 6),
    "runcmd:",
    ...(i.wifi ? [`  - [ sh, -c, ${q(`raspi-config nonint do_wifi_country ${i.wifi.country} || true`)} ]`] : []),
    ...(key ? ["  - [ systemctl, enable, --now, ssh ]"] : []),
    "  - [ systemctl, daemon-reload ]",
    "  - [ systemctl, enable, order-printer-firstboot.service ]",
    "  - [ systemctl, start, --no-block, order-printer-firstboot.service ]",
    "",
  ];

  let networkConfig: string | null = null;
  if (i.wifi) {
    // the 64-hex form is the WPA pre-shared key derived from the password and the network name
    const psk = pbkdf2Sync(i.wifi.password, i.wifi.ssid, 4096, 32, "sha1").toString("hex");
    networkConfig = [
      "network:",
      "  version: 2",
      "  wifis:",
      "    renderer: NetworkManager",
      "    wlan0:",
      "      dhcp4: true",
      "      optional: true",
      `      regulatory-domain: ${q(i.wifi.country)}`,
      "      access-points:",
      `        ${q(i.wifi.ssid)}:`,
      `          password: ${q(psk)}`,
      "",
    ].join("\n");
  }
  return { userData: lines.join("\n"), networkConfig };
}
