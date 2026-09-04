# End-to-end acceptance checks

The desktop file explorer has an editable-by-default rework (lock toggle,
dirty tab dots, Cmd/Ctrl+S save). Synthetic `node --test` suites cover the
logic in a fake DOM, but they cannot catch DOM-liveness bugs (a real
regression was found this way: the dirty dot never appeared while typing).
These scripts drive the **actually served app** in a real browser.

## One command

```sh
scripts/e2e/run-e2e.sh
```

What it does:

1. Builds the debug binary.
2. Creates a throwaway git fixture repo (`src/demo.py`) in a temp dir.
3. Starts an **isolated** server: its own `XDG_CONFIG_HOME` and
   `--session`, so a locally running herdr-webui instance is never touched.
4. Launches headless Chrome with remote debugging.
5. Runs `acceptance.mjs` over CDP: dashboard → open-workspace modal →
   files mode → expand `src` → open `demo.py`, then verifies:
   - lock toggle renders; file opens editable (`contenteditable="true"`)
   - lock → read-only + active state; unlock → editable again
   - typing shows the live dirty dot
   - Cmd+S saves (POST), clears the dot, keeps editing, **and the edit is
     really on disk**
   - locking a dirty file asks "Discard unsaved changes..." and discards
   - Cmd+S on a locked file makes no disk write
6. Tears everything down (pass `--keep` to leave the stack up for debugging).

## Environment knobs

| Variable    | Default | Meaning                              |
| ----------- | ------- | ------------------------------------ |
| `E2E_PORT`  | `8899`  | HTTPS port of the isolated server   |
| `CDP_PORT`  | `9222`  | Chrome remote debugging port         |
| `CHROME_BIN`| auto    | Path to Chrome/Chromium if not found |

## Requirements

- Node >= 21 (global `WebSocket` used by the CDP driver).
- Chrome or Chromium installed.
- `curl` and `git` on PATH.

The harness needs HTTPS with a self-signed cert; the CDP session sets
`Security.setIgnoreCertificateErrors` so no interstitial blocks the run.

Note: run this locally; it is not wired into CI (macos-latest runners have
Chrome, but the suite is intentionally kept as a pre-merge manual gate).