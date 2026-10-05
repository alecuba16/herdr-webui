# External real-browser e2e

The in-repo CDP harness (driver, acceptance suites, run scripts, CI steps)
was removed. Extension installs are not always available, and the same
coverage comes from a self-contained headless Chrome driven externally.

## Setup

1. Install the `cdp-chrome` skill under `~/.agents/skills/cdp-chrome`
   (self-contained, Google-signed Chrome for Testing; no extension, no
   system-browser permissions needed).
2. Start an isolated server (never touch a running instance):

```sh
E2E_PORT=8899
WORK="$(mktemp -d)"
mkdir -p "$WORK/cfg/herdr-webui"
XDG_CONFIG_HOME="$WORK/cfg" \
  target/debug/herdr-webui --bind 127.0.0.1:$E2E_PORT --session e2e-ext &
SERVER_PID=$!
```

3. Launch headless Chrome from the skill with a throwaway profile:

```sh
CHROME=~/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell
"$CHROME" --headless=new --remote-debugging-port=9222 \
  --no-first-run --no-default-browser-check --ignore-certificate-errors \
  --user-data-dir="$(mktemp -d)" about:blank &
CHROME_PID=$!
```

`--ignore-certificate-errors` replaces the removed driver's
`Security.setIgnoreCertificateErrors` call (the server uses self-signed TLS).

## Driving the page

Node >= 21 has a global `WebSocket`, so plain `node` speaks CDP with zero
dependencies:

- `GET http://127.0.0.1:9222/json/list` -> pick the `type: "page"` target
- connect its `webSocketDebuggerUrl`
- send `{"id":N,"method":"...","params":{}}` frames; replies carry the same `id`

Key methods used by browser e2e for this app:

| Method | Use |
| ------ | --- |
| `Page.navigate` | open `https://127.0.0.1:8899/` |
| `Page.enable` | required before navigation events settle |
| `Runtime.evaluate` (with `returnByValue: true`) | DOM assertions, form fill |
| `Input.dispatchKeyEvent` | keystrokes |
| `Emulation.setDeviceMetricsOverride` | viewport sizes |
| `Page.captureScreenshot` | evidence |

Login flow specifics (from the live app): the login form is
`<form id="login">` with `input[name=username]` / `input[name=password]`;
submit by dispatching a `submit` event on the form (the handler is
`onsubmit`, reads `FormData`). The session cookie is `HttpOnly`, so assert
it via an authenticated API call, not `document.cookie`.

## Teardown

```sh
kill $CHROME_PID; rm -rf "$CHROME_PROFILE"
kill $SERVER_PID; rm -rf "$WORK"
```

## Reference script

A working login -> app e2e built this way lives outside the repo at
`~/.jcode/scratch/browser_e2e.mjs` (validated against the live app:
login render, form submit, app render, HttpOnly cookie, screenshot).