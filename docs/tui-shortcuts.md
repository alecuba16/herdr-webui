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

`Ctrl+B Shift+L` opens a reading view over the selected pane's deep
scrollback (the same buffer the pane scrolls): user turns (❯-marked
prompt lines) render as accent-bold chat bubbles with gap folding,
everything else as output. Terminal-screen surface only; it never
opens over Files or Git.

| Key | Action |
| --- | --- |
| `k` / `Up` | one line toward older output (pause follow) |
| `j` / `Down` | one line back toward the tail |
| `PgUp` / `PgDn` | ten lines older / back toward the tail |
| `G` / `End` | jump to the tail, re-arm follow |
| `Esc`, `q`, `i` | close the lens |

Scrolling past the oldest held line lazy-fetches older scrollback
(the window grows geometrically, up to 40k lines). While scrolled
away from the tail the meta line shows a scrolled/new output hint
instead of the following state.

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

## Blocked panes

The TUI has no question-card overlay: a blocked pane's dialog owns the
keyboard, so answers are typed straight into the pane (attach mode) or
answered from the webui's chat lens card. The server-side parser
(`src/prompt_cards.rs`) still backs the webui's
`/api/panes/{pane_id}/prompt` endpoint.

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
| `Shift+L` | chat lens |
| `Shift+C` | chat composer |
| `e`, `E` | edit the current file (Files preview or Git Changes selection) |
| `s` | settings overlay (t cycles the theme) |
| `Shift+P` | session manager (Enter switch, l launch, x close, c cleanup, n new) |
| `G` | git: toggle stage all (webui `KeyG` parity) |
| `i` | git: focus the file list (webui `KeyI` parity) |
| `I` | git cwd: type a repo path |
| `1`-`4` | git: changes / commit modal / log / stash |
| `b` | git: branches |
| `l` | git: log |
| `c` | git: commit modal |
| `v` | git: switch branch |
| `y` / `u` / `d` / `z` | git: stage / unstage / discard / stash the selected file |
| `h` | git: file history of the Changes selection |
| `o` | git: back to Changes |
| `m` | git: toggle blame in the diff |

## Per-screen keys

The Files, Git, and edit surfaces own in-screen keys (not prefix
combinations). The complete list lives in the in-app help overlay;
`docs/features.md` (Terminal UI section) documents the behavior in
prose. Highlights: Files `Enter` enters/opens, `e` edits (Ctrl-S save,
Ctrl-R reload, Ctrl-F find, Ctrl-H replace), `R`/`x` rename/delete,
`/` filter with `t` scope cycle, `M` markdown outline. While a
committed filter shows results, the matched substring of every file
name is highlighted in yellow (same token as the webui tree marks)
and the selection jumps to the first match; `j`/`k` and arrows then
walk the all-matches list, Enter opens the selected match. Git: `Tab`
cycles views, `s`/`d` stage/discard, `G` toggles stage all in the
Changes view (webui `KeyG` parity), `Space`/`c` mark and compare
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
  the y/n confirmation overlay.
