#!/usr/bin/env bash
# Isolated server for the terminal-display-metric e2e repro.
# Never touches the user's running instance (own port, own XDG_CONFIG_HOME,
# own session id). Usage: scripts/e2e/run-terminal-metrics-e2e.sh [--keep]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-8899}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/herdr-term-e2e.XXXXXX")"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

cleanup() {
  [[ $KEEP -eq 1 ]] && { echo "--keep set: leaving $WORK running"; return; }
  [[ -n "${SERVER_PID:-}" ]] && { kill "$SERVER_PID" 2>/dev/null || true; }
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$WORK/cfg/herdr-webui"
cat > "$WORK/cfg/herdr-webui/webui-settings.json" <<'EOF'
{ "localhost_no_auth": true, "theme": "dark" }
EOF

echo "==> starting isolated server on http://127.0.0.1:$PORT (workdir $WORK)"
XDG_CONFIG_HOME="$WORK/cfg" "$ROOT/target/debug/herdr-webui" \
  --https off \
  --bind "127.0.0.1:$PORT" \
  --session "term-e2e-$$-$(date +%s)" \
  --backend-mode builtin &
SERVER_PID=$!

for i in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "==> server ready (pid $SERVER_PID)"
    wait "$SERVER_PID"
    exit 0
  fi
  sleep 0.2
done
echo "error: server never became reachable" >&2
exit 1