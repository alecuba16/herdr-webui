# End-to-end acceptance checks

The desktop file explorer has an editable-by-default rework (lock toggle,
dirty tab dots, Cmd/Ctrl+S save). Synthetic `node --test` suites cover the
logic in a fake DOM, but they cannot catch DOM-liveness bugs (a real
regression was found this way: the dirty dot never appeared while typing).
These scripts drive the **actually served app** in a real browser.

## One command

```sh
just e2e            # or: scripts/e2e/run-e2e.sh
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
6. Runs `session-ux-acceptance.mjs` over CDP against the same server:
   - fresh browser lands on the built-in backend (`default · built-in` footer,
     accent-family color, `backend-builtin` class)
   - session manager opens via the footer button, shows the backend-aware
     current label, and carries the ✕ close button
   - session rows and status pills carry backend color classes
   - ✕ button and backdrop click both close the manager
   - picking an external herdr row (when a compatible install exists) flips
     the footer to `· Herdr` with the mauve `backend-herdr` color
   - the New Herdr offer's hidden state matches the detected install in the
     real DOM (the `hidden` attribute must actually hide the button)
   - closing a stale session (backend died without removing its socket, so
     the row has no live backend) returns `ok + already_stopped` instead of
     a 502 ENOENT error, and the UI shows the clean already-stopped message
     without the offline auto-open manager overwriting it
   - the mobile layout renders the backend badge with matching colors
7. Tears everything down (pass `--keep` to leave the stack up for debugging).

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
## Git explorer acceptance (no browser needed)

`scripts/e2e/run-git-e2e.sh` covers the Git explorer rework (folder rows,
folder stage/unstage/discard, compare modes) against the real server. It
boots the JS bundles the server actually serves in a node vm and proxies
every fetch to the backend, so it needs no browser and runs anywhere node
and cargo do.

What it verifies on a throwaway dirty repo:

- the Git panel loads status from the real backend
- untracked `scratchdir/` renders as a dir row with no phantom file row
- the dir context menu posts `discard` with the folder path and
  `confirmed: true` to the real backend
- the folder is really gone from the repo afterwards

| Variable    | Default | Meaning                            |
| ----------- | ------- | ---------------------------------- |
| `E2E_PORT`  | `8898`  | HTTPS port of the isolated server  |

Run it locally with `just git-e2e` (also not wired into CI).

## Content search acceptance (no browser needed)

`scripts/e2e/run-content-search-e2e.sh` covers the backend-built content
search chunks. Like the git acceptance it boots the served JS bundles in a
node vm and proxies every fetch to the real backend, so it runs anywhere
node and cargo do.

What it verifies on a fixture repo with two overlapping matches:

- both search routes return pre-merged chunks with per-row `highlight_html`
- overlapping context windows arrive as one continuous chunk
- matched rows carry `match_id` and the hit is wrapped in `<mark>`
- HTML in the fixture line arrives escaped from the backend
- the served renderer emits the markup verbatim (no double-escaping) and
  wires `openMatch` / `expandSnippet` from backend ids
- repeat renders reuse the normalized chunk cache
- the single-file route (Load all matches) also returns chunks

| Variable    | Default | Meaning                            |
| ----------- | ------- | ---------------------------------- |
| `E2E_PORT`  | `8897`  | HTTPS port of the isolated server |

## Theme system acceptance

`just theme-e2e` (or `scripts/e2e/run-theme-e2e.sh`) covers the theme system
in a real browser over CDP. It boots the isolated server plus headless
Chrome, emulates `prefers-color-scheme` flips, and drives the real UI:

- auto mode follows the emulated system preference
- the toggle cycles auto -> dark -> light -> auto and updates
  `aria-pressed`, `aria-label`, `title`, and `data-herdr-theme` in sync
- light mode applies immediately (a regression where the effective theme
  lagged one click behind the toggle was caught here)
- auto mode re-resolves live when the system theme flips
- the settings `Default theme` select drives the same state machine
- the choice persists across reload
- body text contrast is measured on the actually rendered light palette

| Variable    | Default | Meaning                              |
| ----------- | ------- | ------------------------------------ |
| `E2E_PORT`  | `8897`  | HTTPS port of the isolated server    |
| `CDP_PORT`  | `9222`  | Chrome remote debugging port         |

Run it locally; it is also kept as a pre-merge manual gate (not in CI).

## Settings confirm/rollback acceptance

`scripts/e2e/settings-confirm-acceptance.mjs` (desktop) and
`scripts/e2e/settings-confirm-mobile-acceptance.mjs` (mobile) cover the
settings confirm/rollback UX in a real browser over CDP. They expect an
isolated server and headless Chrome already up (same stack as
`run-e2e.sh` steps 1-4, or point `E2E_BASE_URL` at your own server and
`CDP_PORT` at the debugging port).

Desktop script verifies on the served app:

- editing a text-like setting (exploration dir) without confirming does
  NOT touch the saved options, and the row shows the pending outline,
  yellow pencil ("Enter or press to confirm"), and rollback arrow
- Enter commits: value saved, chrome hidden, row outline cleared
- the pencil click commits the same way
- the rollback arrow restores the open-time baseline without saving it
  (a subsequent Enter still saves the restored text)
- selects (agent sorting) save immediately and show only the rollback
  arrow; rolling back restores the baseline and persists the restore
- the notification-volume range saves immediately and its rollback
  restores the open-time baseline
- reopening Settings re-reads baselines: freshly saved values show no
  chrome, and rollback targets the latest open-time baseline, not a
  stale first-visit one

Mobile script forces the mobile layout via device metrics emulation and
verifies:

- no rollback chip before any change
- a change shows the ↺ chip and persists immediately
- tapping the chip restores the baseline value and clears the chip
- re-entering Settings re-captures the open-time baseline

## Terminal fill + panel refit acceptance

`just terminal-fit-e2e` (or `scripts/e2e/run-terminal-fit-e2e.sh`) drives
the served desktop app in headless Chrome over CDP against a fixture git
repo. This is also the only browser-level check that opens the real Git
drawer (`openWorkspaceGitUi`) and asserts `HerdrGitUi.isVisible()`, so it
guards the git_ui.js module decomposition against DOM-liveness breakage.

It verifies:

- the terminal fills the shell horizontally and vertically (8px shell
  padding accounted) and cols/rows match the measured cell size
- opening the Git drawer and returning to the terminal refits it
- opening the Files browser and back refits it
- a sidebar toggle (shell width change without window resize) refits,
  and restoring the sidebar restores the original width and fit

| Variable    | Default | Meaning                              |
| ----------- | ------- | ------------------------------------ |
| `E2E_PORT`  | `8899`  | HTTPS port of the isolated server    |
| `CDP_PORT`  | `9222`  | Chrome remote debugging port         |
