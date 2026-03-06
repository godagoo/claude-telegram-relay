#!/bin/bash
# Install the systemd service for Claude Telegram Relay
# Run: bash setup/install-systemd.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
BUN_DIR="$(dirname "$BUN_PATH")"

if [ ! -f "$BUN_PATH" ]; then
  echo "Error: bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

echo "Project:  $PROJECT_DIR"
echo "Bun:      $BUN_PATH"

# Generate service file from template
sed \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__BUN_DIR__|$BUN_DIR|g" \
  "$PROJECT_DIR/daemon/claude-relay.service" \
  > /etc/systemd/system/claude-relay.service

systemctl daemon-reload
systemctl enable claude-relay
systemctl restart claude-relay

echo ""
echo "Service installed and started."
echo "Check status: systemctl status claude-relay"
echo "View logs:    journalctl -u claude-relay -f"
