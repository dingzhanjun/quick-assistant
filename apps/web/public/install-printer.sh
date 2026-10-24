#!/bin/sh
# Installs the kitchen print agent on a Raspberry Pi (or any Linux box) and pairs it with the restaurant account.
#
#   curl -fsSL https://YOUR-SERVER/install-printer.sh | sudo sh -s -- CODE --server https://YOUR-SERVER --base https://YOUR-SERVER/printer
#
# CODE   one-time pairing code from Settings -> Kitchen printing (leave out to install without pairing)
# --server  the platform's address;  --base  the https folder holding order-printer-linux-<arch> and its .sha256
# Without arguments it reads CODE=, SERVER=, BASE= from /boot/firmware/order-printer.conf (or /boot/order-printer.conf):
# put that file on the SD card's boot partition for a monitor-less install.
set -eu

CODE=""; SERVER=""; BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) CODE="$1"; shift ;;
  esac
done
if [ -z "$BASE" ]; then # no arguments: read CODE= SERVER= BASE= from the boot partition (root-owned, physical access)
  for f in /boot/firmware/order-printer.conf /boot/order-printer.conf; do
    # shellcheck disable=SC1090
    [ -r "$f" ] && . "$f"
  done
fi
CODE="${CODE:-}"; SERVER="${SERVER:-}"; BASE="${BASE:-}"
case "$CODE" in *[!A-Za-z0-9-]*) echo "bad pairing code" >&2; exit 2 ;; esac
case "$SERVER$BASE" in *[!A-Za-z0-9.:/_-]*) echo "bad --server / --base" >&2; exit 2 ;; esac

[ "$(id -u)" -eq 0 ] || { echo "run as root: ... | sudo sh -s -- ..." >&2; exit 1; }
[ -n "$BASE" ] || { echo "missing --base (where the agent binary is downloaded from)" >&2; exit 2; }
case "$BASE" in https://*) ;; *) echo "--base must be an https URL" >&2; exit 2 ;; esac
if [ -n "$CODE" ] && [ -z "$SERVER" ]; then echo "--server is needed to pair" >&2; exit 2; fi

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l|armhf) ARCH=arm ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

NAME="order-printer-linux-$ARCH"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading $NAME ..."
curl -fsSL "$BASE/$NAME" -o "$TMP/$NAME"
curl -fsSL "$BASE/$NAME.sha256" -o "$TMP/$NAME.sha256"
WANT="$(cut -d' ' -f1 "$TMP/$NAME.sha256" | head -n1)"
GOT="$(sha256sum "$TMP/$NAME" | cut -d' ' -f1)"
[ "$WANT" = "$GOT" ] || { echo "checksum mismatch, not installing" >&2; exit 1; }

# a service user that may use the printer (the usblp driver makes /dev/usb/lp0 owned by group lp)
id orderprinter >/dev/null 2>&1 || useradd --system --home-dir /var/lib/order-printer --shell /usr/sbin/nologin orderprinter
usermod -aG lp orderprinter
install -d -o orderprinter -g orderprinter -m 0755 /opt/order-printer
install -d -o orderprinter -g orderprinter -m 0750 /etc/order-printer /var/lib/order-printer
install -o orderprinter -g orderprinter -m 0755 "$TMP/$NAME" /opt/order-printer/order-printer
ln -sf /opt/order-printer/order-printer /usr/local/bin/order-printer

cat > /etc/udev/rules.d/99-order-printer.rules <<'RULES'
SUBSYSTEM=="usbmisc", KERNEL=="lp*", GROUP="lp", MODE="0660"
RULES
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

# the only two things the agent may do as root: reboot (Service -> Reboot) and join a Wi-Fi network (local setup page)
cat > /etc/sudoers.d/order-printer <<'SUDO'
orderprinter ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/nmcli dev wifi connect *
SUDO
chmod 0440 /etc/sudoers.d/order-printer
visudo -cf /etc/sudoers.d/order-printer >/dev/null

cat > /etc/systemd/system/order-printer.service <<'UNIT'
[Unit]
Description=Kitchen print agent
After=network-online.target
Wants=network-online.target

[Service]
User=orderprinter
Group=orderprinter
SupplementaryGroups=lp
ExecStart=/opt/order-printer/order-printer run
Restart=always
RestartSec=3
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable order-printer >/dev/null

if [ -n "$CODE" ]; then
  echo "Pairing ..."
  # a failed pairing (expired or mistyped code) must not stop the install: the agent then starts unpaired, prints a setup
  # ticket with a PIN, and can be paired from its setup page
  su -s /bin/sh orderprinter -c "/opt/order-printer/order-printer pair '$CODE' --server '$SERVER'" || echo "Pairing failed: the agent starts unpaired (see the setup ticket)." >&2
fi
systemctl restart order-printer
echo "Done. Status: systemctl status order-printer   Logs: journalctl -u order-printer -f"
[ -n "$CODE" ] || echo "Not paired yet: the printer prints a setup ticket with a PIN; or run: sudo -u orderprinter order-printer pair CODE --server URL"
