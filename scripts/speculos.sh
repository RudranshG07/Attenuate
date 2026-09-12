#!/usr/bin/env bash
# Emulated Ledger for development without hardware.
# Port 5001 because 5000 is macOS AirPlay Receiver.
set -euo pipefail

APP_VERSION=1.22.3
MODEL=nanox
API=http://localhost:5001
DIR="${TMPDIR:-/tmp}/speculos-attenuate"

mkdir -p "$DIR"
if [ ! -f "$DIR/app.elf" ]; then
  curl -sL -o "$DIR/app.elf" \
    "https://github.com/LedgerHQ/app-ethereum/releases/download/${APP_VERSION}/app-${APP_VERSION}-${MODEL}.elf"
fi

docker rm -f speculos >/dev/null 2>&1 || true
docker run -d --name speculos -p 5001:5000 -v "$DIR":/apps \
  ghcr.io/ledgerhq/speculos:latest \
  --model "$MODEL" --display headless --api-port 5000 /apps/app.elf >/dev/null

until curl -s -m 2 "$API/events" >/dev/null 2>&1; do sleep 1; done
sleep 3

press() { curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":"press-and-release"}' "$API/button/$1" >/dev/null; sleep 0.5; }
screen() { curl -s "$API/events?currentscreenonly=true" \
  | python3 -c "import sys,json;print(' '.join(e['text'] for e in json.load(sys.stdin)['events']))"; }

# EIP-712 without clear-signing descriptors requires blind signing.
press right   # App settings
press both    # enter
press both    # toggle Blind signing

enabled=$(screen | grep -c Enabled || true)

# Walk back out to the main screen. The settings list ends in a "Back" item, and an
# APDU sent from the "Quit app" entry fails with 0x6980, so leaving the menu open is
# not merely untidy.
for _ in $(seq 12); do
  screen | grep -q "^Back" && break
  press right
done
press both
for _ in $(seq 5); do
  screen | grep -q "app is ready" && break
  press left
done

if [ "$enabled" != "0" ] && screen | grep -q "app is ready"; then
  echo "speculos ready on $API, blind signing enabled"
else
  echo "warning: not at the ready screen, or blind signing off: $(screen)" >&2
fi
