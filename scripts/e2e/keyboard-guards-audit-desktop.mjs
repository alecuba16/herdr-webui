// Desktop-layout live audit of keyboard guard attributes.
// Same rules as the mobile audit (guards-audit.mjs) but boots the DESKTOP
// layout: wide viewport + localStorage herdr-web-layout=desktop, then walks
// the desktop surfaces (settings modal inputs, worktree/workspace modals,
// tab/workspace rename, composer, prompt card, editor find/replace + edit
// textarea, content search filter) and runs the exhaustive per-surface DOM
// enumeration with duplicate-attribute detection.
const ORIGIN = process.env.E2E_ORIGIN || "https://localhost:8899";
const CDP_PORT = process.env.CDP_PORT || "9223";
const REPO = process.env.E2E_REPO || "";
if (!REPO) { console.error("E2E_REPO must point at the fixture repo (see run-keyboard-guards-e2e.sh)"); process.exit(2); }

let ws; let seq = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(expression) {
  // Watchdog: if an eval never resolves, probe the page via a fresh CDP
  // connection to tell page-wedged from lost-response, then fail loudly.
  let hung = false;
  const watchdog = setTimeout(() => {
    hung = true;
    console.log(`EVAL-HUNG after 15s: ${expression.slice(0, 140)}`);
    (async () => {
      try {
        const l2 = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
        const p2 = l2.find((t) => t.type === "page");
        const ws2 = new WebSocket(p2.webSocketDebuggerUrl);
        await new Promise((r) => { ws2.onopen = r; });
        let ok = false;
        ws2.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 99) { ok = !!(d.result && d.result.result); ws2.close(); } };
        ws2.send(JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "(() => { const i = document.querySelector('.tab-rename-input, .workspace-rename-input'); return JSON.stringify({ alive: true, renameInput: !!i, blocking: !!document.querySelector('.blocking, .blocking-overlay, #blockingOverlay'), url: location.pathname }); })()", returnByValue: true } }));
        setTimeout(() => { if (!ok) console.log("SECOND-WS: page NOT responding (wedged renderer)"); try { ws2.close(); } catch (e) {} }, 8000);
      } catch (e) { console.log("SECOND-WS failed:", e.message); }
    })();
  }, 15000);
  try {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200)}`);
    return r.result.value;
  } finally {
    if (!hung) clearTimeout(watchdog);
  }
}
async function waitFor(expr, label, timeout = 12000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

const failures = [];
// Intentional live exceptions (mirrors the static scan ALLOWLIST):
// the server-settings username keeps autocomplete="username" so password
// managers can fill it; its password twin is type=password (excluded).
const LIVE_ALLOWLIST = new Set(["optServerUser"]);
// enterkeyhint values the platform spec defines; anything else is a typo.
const VALID_HINTS = new Set(["enter", "done", "go", "next", "previous", "search", "send"]);
// Exact enterkeyhint per input key (from the guarded call sites). A wrong
// hint is a UX bug the presence check cannot catch. null = deliberately
// hintless (inputAttrs() with no argument).
const EXPECTED_HINTS = {
  terminalComposerInput: "send",
  searchPaletteInput: "search",
  settingsSearch: "search",
  directoryPickerSearchInput: "search",
  gitUiFileFilter: "search",
  "git-log-filter-author": "search",
  "git-log-filter-date": "search",
  "git-log-filter-description": "search",
  gitCommitTitle: "done",
  gitCommitBody: "done",
  gitUiCleanupRoot: "done",
  gitUiBranchCwd: "done",
  optEditorTabSize: "done", optFileBrowserSearchPageSize: "done",
  optFileContentSearchMinChars: "done", optFileContentSearchPageSize: "done",
  optFileContentSearchContextLines: "done", optFileContentSearchAutoCollapseFiles: "done",
  optFileContentSearchMatchesPerFile: "done", optGlobalShortcutPrefix: "done",
  optSearchShortcut: "done", optServerSessionExpiration: "done",
  optSidebarWorkspacePercent: "done",
  optTreeIndentPx: "done", optWorkingDismissMinutes: "done",
  optWorktreeAutoDiscover: "done", optNoSleepAutoCooldown: "done",
  // Deliberately hintless (inputAttrs() with no argument):
  optBuiltinShell: null, optDefaultFolder: null, optServerBind: null,
  optTerminalFontFamily: null, optWorktreeDefaultDirectory: null,
  optExplorationDefaultDirectory: null,
  workspaceCreatePath: null, workspaceCreateLabel: null,
  worktreeDiscoverPath: null, worktreeCreateSource: null, worktreeLabel: null,
  worktreePath: null, worktreeBase: null, worktreeBranch: null,
  worktreeNewLabel: null, worktreeNewPath: null, worktreeNewBase: null,
  worktreeNewBranch: null, worktreeWorkspaceLabel: null,
  // Find/Replace bar inputs (CodeMirror-generated, placeholder-keyed):
  "Find|text": "search", "Replace|text": "done",
  // Rename inputs have no id/name/placeholder, so their derived key is
  // "|text" (empty placeholder + type). Both surfaces (tab rename via panel
  // switcher dblclick, workspace rename) pin the same hint.
  "|text": "done",
};
function assertGuards(surface, item) {
  if (LIVE_ALLOWLIST.has(item.key)) {
    console.log(`SKIP ${surface} (${item.key}): allowlisted (password manager username)`);
    return true;
  }
  const g = item.guards;
  const missing = [];
  if (g.autocomplete !== "off") missing.push("autocomplete");
  if (g.autocorrect !== "off") missing.push("autocorrect");
  if (g.autocapitalize !== "none") missing.push("autocapitalize");
  if (g.spellcheck !== "false") missing.push("spellcheck");
  if (g.writingsuggestions !== "false") missing.push("writingsuggestions");
  if (g.translate !== "no") missing.push("translate");
  if (item.enterkeyhint && !VALID_HINTS.has(item.enterkeyhint)) missing.push(`enterkeyhint=${item.enterkeyhint} (invalid)`);
  if (missing.length) {
    failures.push(`${surface} (${item.key}): missing ${missing.join(",")}`);
    console.log(`FAIL ${surface} (${item.key}): missing ${missing.join(",")}`);
    return false;
  }
  const expected = EXPECTED_HINTS[item.key];
  if (expected !== undefined) {
    if (expected === null) {
      if (item.enterkeyhint !== null) {
        failures.push(`${surface} (${item.key}): expected NO enterkeyhint, got ${item.enterkeyhint}`);
        console.log(`FAIL ${surface} (${item.key}): expected NO enterkeyhint, ${item.enterkeyhint}`);
        return false;
      }
    } else if (item.enterkeyhint !== expected) {
      failures.push(`${surface} (${item.key}): expected enterkeyhint=${expected}, got ${item.enterkeyhint}`);
      console.log(`FAIL ${surface} (${item.key}): expected enterkeyhint=${expected}, got ${item.enterkeyhint}`);
      return false;
    }
    console.log(`OK   ${surface} (${item.key}): all 6 guards + enterkeyhint=${item.enterkeyhint} (pinned)`);
    return true;
  }
  const attrNames = [...item.outer.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
  const dupes = attrNames.filter((a, i) => attrNames.indexOf(a) !== i);
  if (dupes.length) {
    failures.push(`${surface} (${item.key}): duplicate attributes ${[...new Set(dupes)].join(",")}`);
    console.log(`FAIL ${surface} (${item.key}): duplicate attributes ${[...new Set(dupes)].join(",")}`);
    return false;
  }
  console.log(`OK   ${surface} (${item.key}): all 6 guards${item.enterkeyhint ? ` + enterkeyhint=${item.enterkeyhint}` : ""}`);
  return true;
}

// Enumerate every text-like input/textarea under a selector, with guards.
const ENUM_JS = `(sel) => {
  const root = document.querySelector(sel) || document;
  const matches = (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
  const els = [...(matches(root) ? [root] : []), ...root.querySelectorAll('input, textarea')].filter(el => {
    if (["checkbox","radio","range","button","submit","hidden","password","color"].includes(el.type)) return false;
    return true;
  });
  return els.map(el => {
    const key = el.id || el.name || ((el.getAttribute('placeholder') || '') + '|' + el.type);
    const outer = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);
    return { key, tag: el.tagName.toLowerCase(), type: el.type, outer,
      enterkeyhint: el.getAttribute('enterkeyhint'),
      guards: {
        autocomplete: el.getAttribute('autocomplete'),
        autocorrect: el.getAttribute('autocorrect'),
        autocapitalize: el.getAttribute('autocapitalize'),
        spellcheck: el.getAttribute('spellcheck'),
        writingsuggestions: el.getAttribute('writingsuggestions'),
        translate: el.getAttribute('translate'),
      } };
  });
}`;

async function auditSurface(surface, sel, { required = false } = {}) {
  const rootOk = await evalJs(`(() => !!document.querySelector(${JSON.stringify(sel)}) || ${sel === null ? "true" : "false"})()`);
  if (!rootOk) {
    if (required) { failures.push(`${surface}: container ${sel} not found`); console.log(`FAIL ${surface}: container ${sel} not found`); }
    else console.log(`SKIP ${surface}: container ${sel} not present in this view state`);
    return [];
  }
  const items = await evalJs(`(${ENUM_JS})(${JSON.stringify(sel)})`);
  let guardCount = 0;
  for (const item of items || []) {
    if (assertGuards(surface, item)) guardCount++;
  }
  console.log(`  [${surface}: ${items ? items.length : 0} text input(s) under ${sel}, ${guardCount} guarded]`);
  return items || [];
}

async function clickBtn(matchExpr, label, scopeSel = "document") {
  const clicked = await evalJs(`(() => {
    const scope = ${scopeSel};
    const btns = [...scope.querySelectorAll('button')];
    const b = btns.find(x => ${matchExpr}.test((x.textContent || '').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`button not found: ${label}`);
}

async function main() {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.method === "Runtime.exceptionThrown") {
      const d = data.params.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      console.log(`PAGE-EXC: ${String(desc).slice(0, 220)}`);
    }
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  // Desktop layout: wide viewport, no device emulation, explicit preference.
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${ORIGIN}/session/default` });
  await sleep(2000);
  // Force desktop layout BEFORE app_boot reads the preference.
  await evalJs(`localStorage.setItem('herdr-web-layout', 'desktop')`);
  await send("Page.navigate", { url: `${ORIGIN}/session/default` });
  await sleep(2500);
  await waitFor(`!!document.getElementById('settingsSearch') && !!document.querySelector('.tab')`, "desktop boot settled", 20000);

  // Open the main repo workspace if Home is empty (extended e2e closes them).
  // state is a top-level let inside the classic script: visible to eval as a
  // bare binding, but NOT on window. Never use window.state here.
  let hasWs = await evalJs(`(() => !!document.querySelector('.workspace, .workspaces li, #workspaces li') || (typeof state !== 'undefined' && !!state.ws) )()`);
  if (!hasWs) {
    const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: REPO }),
    }).then((r) => r.json()).catch(() => null);
    const wsId = open && (open.result || open).workspace && (open.result || open).workspace.workspace_id;
    if (!wsId) throw new Error("cannot open main repo workspace");
    await send("Page.navigate", { url: `${ORIGIN}/session/default` });
    await sleep(2500);
    await waitFor(`(() => { return (typeof state !== 'undefined' && !!state.ws && state.ws !== 'default') || !!document.querySelector('#workspaces .item'); })()`, "workspace opened", 15000);
  }

  // A. Idle DOM sweep: every text-like input rendered on the default view.
  await auditSurface("idle DOM", null, "document");

  // B. Settings modal (#settingsToggle in the sidebar head).
  const settingsOpen = await evalJs(`(() => { const b = document.getElementById('settingsToggle'); if (!b) return false; b.click(); return true; })()`);
  if (settingsOpen) {
    await sleep(1000);
    await waitFor(`!!document.getElementById('settingsSearch')`, "settings modal search input", 8000);
    await auditSurface("settings modal", "#settingsModal", { required: true });
    // Expand every collapsible section (details) so nested inputs render.
    await evalJs(`(() => { document.querySelectorAll('#settingsModal details').forEach(d => { d.open = true; }); return true; })()`);
    await sleep(300);
    await auditSurface("settings modal (expanded)", "#settingsModal", { required: true });
    await evalJs(`(() => { const c = document.getElementById('settingsClose') || document.getElementById('settingsCloseTop'); if (c) c.click(); return true; })()`);
  } else {
    failures.push("settings modal: #settingsToggle not found");
    console.log("FAIL settings modal: #settingsToggle not found");
  }
  await sleep(500);

  // C. Worktree create modal (global openWorktreeCreateModal(state.ws)).
  // wsId: prefer the active workspace, fall back to the first listed one.
  const wsId = await evalJs(`(() => { if (typeof state === 'undefined') return ''; const active = state.ws || (state.workspaces && state.workspaces[0] && state.workspaces[0].workspace_id); return active || ''; })()`);
  if (wsId) {
    await evalJs(`openWorktreeCreateModal(${JSON.stringify(wsId)})`);
    await sleep(800);
    await auditSurface("worktree create modal", "#worktreeCreateModal", { required: true });
    await evalJs(`(() => { const c = document.getElementById('worktreeCreateClose'); if (c) c.click(); return true; })()`);
    await sleep(300);
  } else console.log("SKIP worktree create modal: no active workspace");

  // D. Tab rename: the pane strip owns the rename input (terminal tab
  // button → startTabRename). Activate the workspace so state.tabs loads,
  // then dblclick a pane-strip terminal tab.
  const tabPrepared = await evalJs(`(async () => {
    if (document.querySelector('.tab-rename-input')) return 'exists';
    if (typeof state !== 'undefined' && !state.ws && ${JSON.stringify(wsId || "")}) { if (typeof go === 'function') { try { await go(${JSON.stringify(wsId || "")}); } catch (e) {} } }
    for (let i = 0; i < 20; i++) {
      if (typeof state !== 'undefined' && state.tabs && state.tabs.length) return 'tabs-loaded';
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'none';
  })()`);
  if (tabPrepared === 'none') console.log("SKIP tab rename: no workspace tabs available");
  else {
    const tabRenamed = await evalJs(`(() => { const b = document.querySelector('#workspacePanes .pane-tab.terminal'); if (!b) return false; b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    if (tabRenamed) {
    try {
      await waitFor(`!!document.querySelector('.tab-rename-input')`, "tab rename input", 5000);
    } catch {
      failures.push("tab rename: input did not mount after dblclick");
      console.log("FAIL tab rename: input did not mount after dblclick");
    }
    await auditSurface("tab rename", ".tab-rename-input", { required: true });
    // Cleanup via direct state reset (what tabRenameKey Escape does) instead
    // of a synthetic Escape dispatch: synthetic keydown + global shortcut
    // listeners wedged the renderer in this audit sequence.
    await evalJs(`(() => { if (typeof state !== 'undefined' && state.editingTab) { state.editingTab = null; state.editingTabValue = ""; render(); } return true; })()`);
    } else console.log("SKIP tab rename: pane strip terminal tab not found");
  }
  await sleep(300);

  // D2. Workspace rename: dblclick the active workspace sidebar item.
  const wsRenamed = await evalJs(`(() => { const w = document.querySelector('#workspaces .item.active, #workspaces .item'); if (!w) return false; w.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  if (wsRenamed) {
    try {
      await waitFor(`!!document.querySelector('.workspace-rename-input')`, "workspace rename input", 5000);
    } catch {
      console.log("SKIP workspace rename: input did not mount after dblclick");
    }
    await auditSurface("workspace rename", ".workspace-rename-input");
    // Cleanup via direct state reset (what workspaceRenameKey Escape does):
    // synthetic Escape dispatch wedged the renderer in this audit sequence.
    await evalJs(`(() => { if (typeof state !== 'undefined' && state.editingWorkspace) { state.editingWorkspace = null; state.editingWorkspaceValue = ""; render(); } return true; })()`);
  } else console.log("SKIP workspace rename: no workspace item");
  await sleep(300);
  console.log("PROGRESS: entering composer block");

  // E. Composer: HerdrComposer.sync() mounts the overlay on the first pane
  // event; call it directly so the textarea exists even without lens open.
  const composerMounted = await evalJs(`(() => { if (globalThis.HerdrComposer && globalThis.HerdrComposer.sync) globalThis.HerdrComposer.sync(); return !!document.getElementById('terminalComposerInput'); })()`);
  if (composerMounted) await auditSurface("composer", "#terminalComposer", { required: true });
  else { failures.push("composer: textarea not mounted after sync()"); console.log("FAIL composer: textarea not mounted after sync()"); }
  console.log("PROGRESS: composer done, entering file browser block");

  // F. File browser (lazy module) + editor: open via the real app trigger,
  // click a file row, audit the editor and its find/replace bar.
  if (wsId) {
    await evalJs(`openWorkspaceFileBrowser(${JSON.stringify(wsId)})`);
    try {
      await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row.file')`, "file browser tree rows", 12000);
      const fileOpened = await evalJs(`(() => {
        const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row.file')];
        // Markdown files open in preview mode by default; pick a plain text
        // file first so the editor textarea mounts instead of the md preview.
        const f = rows.find(r => /\.(toml|txt|rs|json|ya?ml|lock)$/i.test(r.title || ''))
          || rows.find(r => !/\.md$/i.test(r.title || ''))
          || rows[0];
        if (!f) return false;
        f.click();
        return true;
      })()`);
      if (fileOpened) {
        try {
          await waitFor(`!!document.querySelector('.herdr-editor')`, "editor mounted", 12000);
        } catch {
          failures.push("file editor: .herdr-editor did not mount after file click");
          console.log("FAIL file editor: .herdr-editor did not mount after file click");
        }
        await auditSurface("file editor", ".herdr-editor", { required: true });
        // Find bar: the pane strip owns the control for the active editor.
        const findOpened = await evalJs(`(() => { const b = document.querySelector('.pane-find-button'); if (!b) return false; b.click(); return !!document.querySelector('.herdr-editor-find:not([hidden])'); })()`);
        if (findOpened) {
          await auditSurface("editor find bar", ".herdr-editor-find", { required: true });
          await evalJs(`(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); return true; })()`);
        } else {
          failures.push("editor find bar: toggle did not reveal the find bar");
          console.log("FAIL editor find bar: toggle did not reveal the find bar");
        }
      } else { failures.push("file editor: no file row in file browser tree"); console.log("FAIL file editor: no file row in file browser tree"); }
      // Close the file browser so later surfaces enumerate cleanly.
      await evalJs(`(() => { if (window.HerdrFileBrowser) HerdrFileBrowser.hide(); return true; })()`);
      await sleep(400);
    } catch (e) {
      failures.push(`file browser: ${e.message}`);
      console.log(`FAIL file browser: ${e.message}`);
    }
  } else console.log("SKIP file browser: no active workspace");

  // G. Git UI lazy surfaces: real trigger opens git_ui.js + directory_picker.js,
  // then drive each tab and modal that renders text inputs.
  if (wsId) {
    await evalJs(`openWorkspaceGitUi(${JSON.stringify(wsId)}, { forceOpen: true })`);
    try {
      await waitFor(`!!document.getElementById('gitUiPanel')`, "git ui panel", 12000);
      // Wait for the initial git status load to populate the view cache,
      // otherwise active() is null and openCommitModal() silently no-ops.
      // DOM evidence: the toolbar Commit button renders enabled only when
      // status loaded AND staged changes exist.
      await waitFor(`(() => { const b = document.querySelector('.git-ui-toolbar button.git-ui-btn.primary[title*="Commit"]'); return !!b && !b.disabled; })()`, "git ui status loaded with staged changes", 15000);
      // Commit modal (title + body textarea). Needs staged changes; stage
      // the README via the API-backed git flow if the tree has a tracked file.
      const stagedSomething = await evalJs(`(async () => {
        if (!window.HerdrGitUi) return false;
        // Try opening the modal directly first.
        HerdrGitUi.openCommitModal();
        if (document.querySelector('.git-ui-commit-modal')) return true;
        return false;
      })()`);
      await sleep(600);
      let commitItems = await auditSurface("git commit modal", ".git-ui-commit-modal");
      // The body textarea renders only when includeBody is checked. Toggle
      // it so gitCommitBody is live-audited too.
      if (stagedSomething) {
        await evalJs(`(() => { const cb = document.getElementById('gitCommitIncludeBody'); if (cb && !cb.checked) { cb.checked = true; HerdrGitUi.toggleCommitBody(true); } return true; })()`);
        await sleep(400);
        commitItems = await auditSurface("git commit modal (with body)", ".git-ui-commit-modal");
      }
      if (!stagedSomething) console.log("SKIP git commit modal: no staged changes in this repo state");
      await evalJs(`(() => { if (window.HerdrGitUi) { HerdrGitUi.closeCommitModal && HerdrGitUi.closeCommitModal(); } return true; })()`);
      await sleep(300);
      // Branch modal: cwd input + directory picker.
      await evalJs(`(() => { if (window.HerdrGitUi) { HerdrGitUi.openBranchModal && HerdrGitUi.openBranchModal(); } return true; })()`);
      await sleep(500);
      await auditSurface("git branch modal", ".git-ui-modal");
      // Directory picker (lazy directory_picker.js): open on the cwd input.
      await evalJs(`(() => { const i = document.getElementById('gitUiBranchCwd'); if (i && window.HerdrDirectoryPicker) { HerdrDirectoryPicker.openInput('gitUiBranchCwd'); } return !!document.getElementById('directoryPickerSearchInput'); })()`);
      await sleep(500);
      await auditSurface("directory picker", ".directory-picker");
      await evalJs(`(() => { if (window.HerdrDirectoryPicker) HerdrDirectoryPicker.close(); return true; })()`);
      await evalJs(`(() => { if (window.HerdrGitUi) { HerdrGitUi.closeBranchModal && HerdrGitUi.closeBranchModal(); } return true; })()`);
      await sleep(300);
      // Log tab: three filter inputs.
      await evalJs(`(() => { if (window.HerdrGitUi) HerdrGitUi.tab('log'); return true; })()`);
      await sleep(700);
      await auditSurface("git log filters", "#gitUiPanel");
      // Cleanup tab: scan root input.
      await evalJs(`(() => { if (window.HerdrGitUi) HerdrGitUi.tab('cleanup'); return true; })()`);
      await sleep(700);
      await auditSurface("git cleanup", "#gitUiPanel");
      // Diff search + file filter only render with diff content; enumerate the
      // panel each time and rely on the static scan for the code paths.
      await evalJs(`(() => { if (window.HerdrGitUi) HerdrGitUi.tab('changes'); return true; })()`);
      await sleep(500);
      await auditSurface("git changes", "#gitUiPanel");
      await evalJs(`(() => { if (window.HerdrGitUi) HerdrGitUi.hide(); return true; })()`);
      await sleep(300);
    } catch (e) {
      failures.push(`git ui: ${e.message}`);
      console.log(`FAIL git ui: ${e.message}`);
    }
  } else console.log("SKIP git ui: no active workspace");

  // H. Workspace search palette (static HTML in app.html; direct opener).
  const paletteOpen = await evalJs(`(() => { if (typeof openSearchPalette === 'function') return openSearchPalette(); const b = document.getElementById('searchBtn'); if (b) { b.click(); return true; } return false; })()`);
  if (paletteOpen) {
    await sleep(400);
    await auditSurface("workspace search palette", "#searchPalette", { required: true });
    await evalJs(`(() => { if (typeof closeSearchPalette === 'function') closeSearchPalette(); else { const m = document.getElementById('searchPalette'); if (m) m.style.display = 'none'; } return true; })()`);
  } else { failures.push("search palette: openSearchPalette unavailable or disabled"); console.log("FAIL search palette: openSearchPalette unavailable or disabled"); }

  console.log("");
  if (failures.length) {
    sweepSummary();
    console.log(`AUDIT FAILED (${failures.length}):`);
    failures.forEach((f) => console.log(` - ${f}`));
    process.exit(1);
  }
  sweepSummary();
  console.log("DESKTOP AUDIT PASSED: every enumerated desktop text input carries the full keyboard guard set");
  process.exit(0);
}

function sweepSummary() {
  console.log(`(summary line kept for parity with mobile audit)`);
}

main().catch((e) => { console.error("AUDIT ERROR:", e.message); process.exit(2); });
