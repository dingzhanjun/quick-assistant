#!/bin/sh
# Builds the print-agent binaries into apps/web/public/printer/ (what the web Docker image does), so a local `pnpm dev:web` /
# `pnpm --filter web start` can serve them at /printer/ and the dashboard's SD-card setup works. Needs Go. The files are git-ignored.
set -eu
cd "$(dirname "$0")/../../printer-agent"
OUT="../web/public/printer"
V="$(tr -d ' \n' < VERSION)"
mkdir -p "$OUT"
build() { # name GOARCH GOARM
  CGO_ENABLED=0 GOOS=linux GOARCH="$2" GOARM="$3" go build -trimpath -ldflags "-s -w -X main.version=$V" -o "$OUT/order-printer-linux-$1" ./cmd/order-printer
  (cd "$OUT" && shasum -a 256 "order-printer-linux-$1" > "order-printer-linux-$1.sha256")
}
build arm64 arm64 ""
build arm arm 6
build amd64 amd64 ""
echo "$V" > "$OUT/VERSION"
ls -la "$OUT"
