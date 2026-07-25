# CPU Usage Optimization Analysis - Herdr WebUI

## Executive Summary

This document captures the complete functionality inventory and identified CPU hotspots in the Herdr WebUI codebase (both Rust backend and JS frontend). The goal is to optimize CPU usage while preserving all existing functionality.

---

## 1. Complete Functionality Inventory

### 1.1 Backend (Rust) - Core Responsibilities

| Module | Responsibility | Key Functions |
|--------|---------------|---------------|
| `builtin_backend.rs` | Built-in terminal/workspace/agent runtime | PTY management, workspace/tab/pane lifecycle, agent detection, event hub |
| `builtin_events.rs` | In-process event pub/sub | `BuiltinEventHub`, `PaneEventContext` |
| `file_browser.rs` | File system operations | Directory listing, file/folder search, content search, Git status propagation |
| `git_ui/*.rs` | Git operations | Log, diff, status, cleanup, worktree operations |
| `protocol.rs` | Terminal protocol frames | Attach, input, resize, output, graphics |
| `service.rs` | System service management | LaunchAgents (macOS), systemd (Linux) |
| `assets.rs` | Static asset embedding | HTML/CSS/JS/fonts/icons served from `/assets/*` |
| `main.rs` | HTTP/WebSocket server | Auth, routing, session management, proxy to external Herdr |
| `backend_client.rs` | Reusable client for TUI | Control/terminal socket communication |
| `tui*.rs` | Terminal UI binary | Interactive TUI for built-in backend |

### 1.2 Frontend (JS) - Core Responsibilities

| Module | Responsibility |
|--------|---------------|
| `desktop/app_js/core.js` | Main app state, refresh, session manager, settings, no-sleep |
| `desktop/app_js/terminal.js` | Terminal WebSocket, frame batching, scroll, paste, resize |
| `desktop/app_js/render.js` | Full DOM render with innerHTML diffing |
| `desktop/app_js/bindings.js` | Global shortcuts, theme auto-detection, temp terminal |
| `desktop/app_js/worktrees.js` | Worktree create/open/discover modals |
| `desktop/app_js/file_browser.js` | File tree, unified search, content search |
| `desktop/app_js/search.js` | Header search palette |
| `desktop/git_ui/*.js` | Git log, diff, actions, syntax |
| `mobile/app.js` | Mobile app shell, screens, events |
| `mobile/terminal.js` | Mobile terminal |
| `mobile/file_browser.js` | Mobile file browser |
| `shared/*` | Reusable: terminal_adapter, terminal_fit, file_tree, file_icons, workspace_search, file_content_search, editor, temp_terminal, actions |

### 1.3 Key User-Facing Features (Must Preserve)

1. **Terminal**: wterm/Ghostty renderer, attach, scroll-follow, paste chunking, links, mouse reporting, temp terminal (Ctrl+B Shift+M)
2. **Workspaces/Worktrees**: Create, open, discover, close, auto-close when last panel closes
3. **Git UI**: Log (graph), diff, staged/unstaged, cleanup, worktree from branch
4. **File Explorer**: Tree with Git status colors, unified header search (workspaces/files/folders/content), content search with lazy expansion
5. **Agent Status**: Blocked/working/idle/done detection via OSC 9 + screen scrape fallback for 20+ agents
6. **Settings**: Browser-local (localStorage) + server settings (webui-settings.json)
7. **No-Sleep**: Off/Auto/1h/2h/4h/Infinite with adaptive polling
8. **Notifications**: Local attention tone + browser notifications
9. **Themes**: Auto/light/dark with shared color tokens
10. **TUI**: `herdr-webui-tui` binary with live terminal attach

---

## 2. Identified CPU Hotspots

### 2.1 Critical (High Impact)

| # | Location | Issue | Frequency | Impact |
|---|----------|-------|-----------|--------|
| **1** | `builtin_backend.rs:1437` `publish_agent_status_if_changed()` | Runs on **every** `append_output()` call (every PTY read). Does: 64KB scrollback copy → lowercase → `ps` spawn (cached 250ms) → process tree walk → 20+ agent status regex scans | Every terminal output byte (~100-1000x/sec during active terminal) | **HIGHEST** - Blocks PTY reader thread, spawns `ps` repeatedly |
| **2** | `builtin_backend.rs:1705` `pane_agent_presentation()` | Called by `agent_list_json()` for **every pane** on every `/api/agents` call. Same expensive work as #1. | Every `agent.list` call: on `pane.agent_status_changed` event, auto-no-sleep 5s poll, legacy 5s snapshot, frontend refresh | **HIGH** - O(n_panes) × expensive computation |
| **3** | `main.rs:3534` + `main.rs:1845` | **Double `agent.list` storm**: `pane.agent_status_changed` event → `agent.list` → recomputes all panes → may fire more events. Auto-no-sleep also polls `agent.list` every 5s. | Continuous when agents active | **HIGH** - Feedback loop |
| **4** | `bindings.js:48` `setInterval(pollAutoTheme, 2000)` | Polls `matchMedia` every 2s **forever**, even when theme ≠ auto | Every 2s indefinitely | **MEDIUM-HIGH** - Wastes CPU on idle tabs |
| **5** | `builtin_backend.rs:1372` `history_tail_text()` | Copies 64KB scrollback → `String::from_utf8_lossy` → `terminal_screen_text_lossy` (full ANSI parse) on **every** status check | Same as #1, #2 | **MEDIUM** - Memory alloc + ANSI parsing |

### 2.2 Moderate Impact

| # | Location | Issue |
|---|----------|-------|
| 6 | `main.rs:1833` `run_auto_no_sleep_loop` | 5s interval `agent.list` poll when auto no-sleep active |
| 7 | `terminal.js` `enqueueTerminalFrame` | RAF batching is good, but `frameSize` check on every frame |
| 8 | `render.js` `updateTabActivity` | `getBoundingClientRect` in `syncWorkspacePanelMenuSize` every render |
| 9 | `mobile/app.js` `scheduleEventRefresh` | 120ms debounce but fires `refresh()` which does 4 API calls |
| 10 | `worktrees.js` autodiscover timers | Multiple `setTimeout` for path debounce (acceptable) |

### 2.3 Frontend Polling Already Optimized

- Events socket is **event-driven** (not polling) for built-in backend
- Legacy 5s snapshot polling only for external Herdr < protocol 16
- No-sleep polling adaptive: stops when mode=off and healthy
- Search debounced (180-500ms)

---

## 3. Root Cause Analysis

### Why #1 and #2 are so expensive:

```rust
// In publish_agent_status_if_changed() - runs on EVERY append_output()
let tail = self.history_tail_text(DETECTION_TAIL_BYTES);  // 64KB copy + ANSI parse
let process_agent = self.child_pid().and_then(detect_agent_label_from_process_tree);  // spawns `ps`
let agent = detect_agent_label(&self.argv).or(process_agent).or_else(|| detect_agent_label_from_text(&tail));
let status = detect_agent_status_with_osc(agent, &tail, &osc_progress);  // lowercases 64KB, 20+ substring scans
```

**No throttling exists** - this runs on every PTY read (can be 100-1000 times/second during active terminal output).

### Why #3 creates a storm:

```
PTY output → append_output() → publish_agent_status_if_changed() 
  → event_hub.publish("pane.agent_status_changed")
    → main.rs events bridge receives
      → calls agent.list (recomputes ALL panes)
        → pane_agent_presentation() for EACH pane (same expensive work)
          → may publish more pane.agent_status_changed events
            → REPEAT
```

---

## 4. Improvement Plan

### Phase 1: Critical Backend Fixes (Highest ROI)

| Task | Description | Expected CPU Reduction |
|------|-------------|------------------------|
| **1.1** | Add **throttling** to `publish_agent_status_if_changed`: min 500ms between checks per terminal | ~90% reduction in status detection CPU |
| **1.2** | **Cache** `PaneAgentPresentation` in `BuiltinData` with invalidation on output/OSC9 change. `agent.list` reads cache. | Eliminates O(n_panes) recompute on every `agent.list` |
| **1.3** | **Break the storm**: In events bridge, on `pane.agent_status_changed`, **don't call `agent.list`**. Use the event payload directly for no-sleep sync. | Stops feedback loop entirely |
| **1.4** | **Throttle `history_tail_text`**: Return cached tail string, invalidate only after N new bytes or time threshold. | Reduces 64KB copy + ANSI parse frequency |

### Phase 2: Frontend Quick Wins

| Task | Description | Expected CPU Reduction |
|------|-------------|------------------------|
| **2.1** | Replace `setInterval(pollAutoTheme, 2000)` with `matchMedia.addEventListener('change')` listener | Eliminates 2s wakeup forever |
| **2.2** | Ensure `scheduleRefreshBurst` only used when actually needed (terminal disconnect) | Minor |

### Phase 3: Backend Polish

| Task | Description |
|------|-------------|
| **3.1** | Add `last_status_check` timestamp to `TerminalRuntime`, only run detection if >500ms elapsed |
| **3.2** | Cache `process_table()` result per-terminal with shorter TTL (50ms) during active output |
| **3.3** | In `detect_agent_status`, avoid `text.to_lowercase()` allocation - use case-insensitive search or scan once |
| **3.4** | Auto-no-sleep: use event payload instead of `agent.list` poll when built-in event hub active |

### Phase 4: Verification

- Run all JS tests (243 tests)
- Run all Rust tests
- Manual smoke test: terminal output, agent status, no-sleep, worktrees, Git UI, file browser, search
- Profile CPU before/after

---

## 5. Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Throttle status detection | Status may lag by up to 500ms | 500ms is imperceptible; OSC9 path is instant |
| Cache pane presentation | Stale status if cache not invalidated | Invalidate on `append_output` + `osc9_tracker` change |
| Remove agent.list on event | No-sleep may not see all agents | Event payload has the changed agent; no-sleep only needs "any working" |
| matchMedia listener | Browser compat | Fallback to polling only if listener unavailable (all modern browsers support) |

---

## 6. Functionality Preservation Checklist

After each change, verify:
- [ ] Terminal attach/output/scroll works
- [ ] Agent status shows blocked/working/idle/done correctly for all 20+ agents
- [ ] OSC 9 jcode status works (working/idle/blocked)
- [ ] No-sleep auto mode activates/deactivates correctly
- [ ] Attention sounds fire on blocked/done
- [ ] Worktree create/open/discover works
- [ ] Git log/diff/cleanup works
- [ ] File browser tree, search, content search works
- [ ] Unified header search works (all 4 sections)
- [ ] Settings persist and apply
- [ ] Theme auto/light/dark works
- [ ] Temporary terminal (Ctrl+B Shift+M) works
- [ ] TUI `herdr-webui-tui` works
- [ ] Mobile app works
- [ ] All 243 JS tests pass
- [ ] All Rust tests pass

---

## 7. Implementation Order

1. **Backend throttling + cache** (Phase 1.1, 1.2, 1.4) - Core fix
2. **Break agent.list storm** (Phase 1.3) - Prevents feedback
3. **Frontend pollAutoTheme** (Phase 2.1) - Easy win
4. **Auto-no-sleep event-driven** (Phase 3.4)
5. **Verification & tests** (Phase 4)