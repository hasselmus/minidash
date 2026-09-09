#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
CONFIG="${MINIDASH_CONFIG:-$RUN_HOME/.config/minidash/config.json}"
NODE="$(command -v node)"
UNIT=/etc/systemd/system/minidash.service

if [[ -z "$RUN_HOME" ]]; then
  echo "Could not determine home directory for $RUN_USER" >&2
  exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "MiniDash config not found: $CONFIG" >&2
  echo "Create it from $ROOT/config.example.json before installing the service." >&2
  exit 1
fi
if [[ -z "$NODE" ]]; then
  echo "node was not found in PATH" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
cat >"$TMP" <<UNIT_EOF
[Unit]
Description=MiniDash always-on LAN dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=MINIDASH_CONFIG=$CONFIG
ExecStart=$NODE $ROOT/server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT_EOF

sudo install -m 0644 "$TMP" "$UNIT"
sudo systemctl daemon-reload
sudo systemctl enable --now minidash
sudo systemctl --no-pager --full status minidash
