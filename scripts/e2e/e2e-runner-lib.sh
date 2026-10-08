#!/usr/bin/env bash
# Shared boilerplate for the real-browser e2e runner scripts: the Chrome for
# Testing binary lookup, process teardown, health-check polling, and the
# port/leftover-instance guard. Sourced by the runners; they own their own
# fixture setup and driver invocation. Runners set before sourcing:
#   WORK          scratch dir (mktemp -d); torn down unless KEEP=1
#   PORT, CDP     server/CDP ports (fail fast if already listening)
#   SERVER_PID, CHROME_PID, CHROME_PROFILE  set during the run
#   KEEP          1 skips teardown

chrome_bin() {
  if [[ -n "${CHROME_BIN:-}" ]]; then
    if [[ ! -x "$CHROME_BIN" ]]; then
      echo "ERROR: CHROME_BIN='$CHROME_BIN' is not executable." >&2
      return 1
    fi
    echo "$CHROME_BIN"; return 0
  fi
  local shell="$HOME/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  if [[ -x "$shell" ]]; then echo "$shell"; return 0; fi
  local app="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$app" ]]; then echo "$app"; return 0; fi
  echo "ERROR: no chrome-headless-shell or Google Chrome found; set CHROME_BIN." >&2
  return 1
}

stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

wait_for() {
  local desc="$1" url="$2"
  for i in $(seq 1 50); do
    if curl -sf -k "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "error: $desc never became reachable at $url" >&2
  return 1
}

# A leftover instance from a previous --keep run would answer the health
# check and the run would silently test the stale build. Fail fast instead.
fail_if_port_busy() {
  local port="$1" label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .; then
    echo "ERROR: $label port $port is already in use; kill the leftover e2e instance first." >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    return 1
  fi
}

# Teardown shared by the EXIT trap and INT/TERM routing. Sourced runners
# register it with: trap runner_cleanup EXIT; trap runner_on_signal INT TERM
runner_cleanup() {
  if [[ "${KEEP:-0}" -eq 1 ]]; then
    echo "--keep set: leaving server (${PORT:-?}), Chrome (${CDP:-?}) and $WORK running"
    return
  fi
  stop_pid "${CHROME_PID:-}"
  stop_pid "${SERVER_PID:-}"
  rm -rf "$WORK" 2>/dev/null || true
}

# An EXIT trap alone does not fire on SIGTERM/SIGINT: `timeout` or Ctrl+C
# would leave the server and Chrome behind. Route these signals to the EXIT
# trap (same as run-keyboard-guards-e2e.sh).
runner_on_signal() {
  echo "e2e runner: interrupted, tearing down" >&2
  exit 130
}
