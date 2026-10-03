# TUI shortcuts

The full key reference for `herdr-webui-tui`. The in-app overlay
(`Ctrl+B ?`) carries the same list with a type-to-filter search; this
page is the browsable copy. Every screen keeps the `Ctrl+B ? help`
tail in the statusbar, so the overlay is discoverable without reading
docs first.

Shortcut model: `Ctrl+B` arms the prefix (statusbar shows `Ctrl+B>`),
the next key runs the matching WebUI default shortcut, `Esc` cancels,
pressing `Ctrl+B` again toggles the prefix off. The prefix works on
every screen, including while attached.

## Terminal screen (navigation)

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | move the workspace/agent selection |
| `Tab` / `BackTab` | switch workspace/agent list focus |
| `w` | focus workspaces |
| `a` | focus agents |
| `Enter` | attach to the selected pane's terminal (attach mode) |
| `r` | refresh |
| `?` | help overlay |
| `q` | quit confirmation (y confirms, n/Esc stays) |

## Attach mode

Enter on the Terminal screen opens a live terminal session on the
selected pane: keys type straight into the PTY through the live
terminal writer.

| Key | Action |
| --- | --- |
| printable keys, Enter, arrows | raw bytes into the pane terminal |
| `Ctrl+G` | detach back to navigation |
| `Ctrl+B ?` | help overlay (the prefix still works while attached) |

Keys with no terminal byte mapping (for example function keys beyond
the set `key_to_terminal_bytes` covers) are ignored; nothing is sent
and attach mode stays.

## Lens (chat transcript view)

`Ctrl+B Shift+L` opens a reading view over the selected pane's tail:
user turns (❯-marked prompt lines) render as accent-bold chat bubbles
with gap folding, everything else as output. Terminal-screen surface
only; it never opens over Files or Git.

| Key | Action |
| --- | --- |
| `j` / `Down` | one line away from the tail (pause follow) |
| `k` / `Up` | one line back toward the tail |
| `PgDn` / `PgUp` | ten lines away / toward the tail |
| `G` / `End` | jump to the tail, re-arm follow |
| `Esc`, `q`, `i` | close the lens |

While scrolled away from the tail the meta line shows a scrolled/new
output hint instead of the following state.

## Chat composer

`Ctrl+B Shift+C` opens a one-line message prompt for the selected
pane (webui composer box). The draft is kept per pane and survives
closing the prompt: every keystroke syncs it, reopening prefills it.

| Key | Action |
| --- | --- |
| typing | builds the message, syncs the per-pane draft |
| `Enter` | submit through `POST /api/panes/{id}/submit` |
| `Esc` | close, keep the draft |

The server owns shaping and validation: trailing newlines are the
composer's own Enter, CRLF reads as one newline, the cap is 20000
characters. A blocked pane's `agent_blocked` 409 shows the server note
verbatim (`Not sent: the agent is waiting for an answer in the
terminal. Answer it first.`) and the draft stays.

## Prompt cards (blocked panes)

When the selected pane's agent status is `blocked` and the tail parses
as a question dialog (numbered option list, ↑↓ nav hints, or an
"enter your response" free-text shape), a card floats at the
bottom-right of the terminal pane: no backdrop dim, it slides under
open modals, webui anchor parity.

| Key | Action |
| --- | --- |
| `j` / `k` (arrows) | move the option cursor |
| `Enter` | answer the highlighted option (raw `N` + Enter into the pane) |
| `1`-`9` | jump to option N and answer in one key (like a button click) |
| `Esc` | dismiss the card until the question or blocked episode changes |
| `q` | NOT consumed: plain q stays the TUI quit key, card never steals it |

Free-text cards open an answer prompt (`CardAnswer`) whose submit picks
the transport from the pane's live status: the composer submit route
when the pane is unblocked, raw typed text + Enter when still blocked
(the composer route refuses blocked panes by design). Every raw send
re-parses the tail first: if the dialog moved on, nothing is sent and
the status says `question changed, not sent`.

## Prefix shortcuts (`Ctrl+B` then key)

| Shortcut | Action |
| --- | --- |
| `f` | Files screen |
| `g` | Git screen (Changes tab) |
| `t` | back to the Terminal screen |
| `/` | search palette (Enter commits/navigates, Ctrl+X removes a recent) |
| `?`, `0` | help overlay |
| `r` | refresh |
| `j` / `k` | next / previous workspace |
| `a` / `A` | next / previous agent |
| `]` / `[` | next / previous panel in the workspace (wraps) |
| `p` / `x` | new / close tab (last tab closes its workspace) |
| `n`, `N` | new workspace (folder browser, Enter picks, second prompt names it) |
| `Shift+S` | rename workspace |
| `Shift+R` | rename panel (webui `renamePanel`) |
| `Shift+X` | close workspace (y confirms) |
| `w` | browse worktrees/folders (Enter opens, o opens folder, h parent, type filters) |
| `Shift+T` | create worktree (branch, then path) |
| `Del` / `Backspace` | remove linked worktree |
| `q` | quit (y confirms, Esc stays) |
| `Shift+B` | collapse/expand the sidebar |
| `.` / `,` | focus next/prev region (sidebar -> main, wraps) |
| `Shift+M` | temporary terminal (open or refocus) |
| `Shift+P` | promote the temporary terminal to a workspace |
| `Shift+L` | chat lens |
| `Shift+C` | chat composer |
| `e`, `E` | edit the current file (Files preview or Git Changes selection) |
| `s` | settings overlay (t cycles the theme) |
| `I` | git cwd: type a repo path |
| `1`-`4` | git: changes / commit modal / log / stash |
| `b` | git: branches |
| `l` | git: log |
| `c` | git: commit modal |
| `v` | git: switch branch |
| `y` / `u` / `d` / `z` | git: stage / unstage / discard / stash the selected file |
| `G` | git: toggle stage all |
| `h` | git: file history of the Changes selection |
| `o` | git: back to Changes |
| `m` | git: toggle blame in the diff |

## Per-screen keys

The Files, Git, and edit surfaces own in-screen keys (not prefix
combinations). The complete list lives in the in-app help overlay;
`docs/features.md` (Terminal UI section) documents the behavior in
prose. Highlights: Files `Enter` enters/opens, `e` edits (Ctrl-S save,
Ctrl-R reload, Ctrl-F find, Ctrl-H replace), `R`/`x` rename/delete,
`/` filter with `t` scope cycle, `M` markdown outline. Git: `Tab`
cycles views, `s`/`d` stage/discard, `Space`/`c` mark and compare
commits, `J`/`K`/`H` hunk cursor and apply, `D` delete branch or drop
stash, `t`/`R`/`b` tag/reset/rebase.

## Overlay key rules (shared)

- `Esc` closes overlays: lens, help, settings, worktree browser, search
  palette, prompts. In filters it clears the query first, closes on the
  second press.
- Overlays dim the backdrop (webui `.modal-backdrop` parity) and keep
  their own footer hint line; every hint ends with the `Ctrl+B ?`
  discovery tail.
- Quit is always `q` (plus `Ctrl+B q`); every quit path goes through
  the y/n confirmation overlay. The prompt card is the one floating
  element that never intercepts it.
