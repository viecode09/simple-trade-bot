#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="simple-trade-bot"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
NODE_BIN="$(command -v node || true)"
TEMPLATE="$APP_DIR/deploy/$SERVICE_NAME.service"
TARGET="/etc/systemd/system/$SERVICE_NAME.service"

if [[ $EUID -ne 0 ]]; then
  echo "Jalankan dengan sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js tidak ditemukan di PATH. Install dulu (mis. apt install nodejs atau nvm)." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "PERINGATAN: $APP_DIR/.env belum ada. Buat dari .env.example sebelum start." >&2
fi

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "PERINGATAN: node_modules belum ada. Jalankan 'npm install' sebagai $RUN_USER." >&2
fi

sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__USER__|$RUN_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$TEMPLATE" > "$TARGET"

echo "Unit ditulis ke $TARGET (User=$RUN_USER, Node=$NODE_BIN, Dir=$APP_DIR)"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl status --no-pager "$SERVICE_NAME" || true

echo
echo "Perintah berguna:"
echo "  systemctl status $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME"
echo "  systemctl stop $SERVICE_NAME"
