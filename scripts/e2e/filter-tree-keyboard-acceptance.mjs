// Arrow-key tree navigation acceptance for the desktop file browser filter
// results. Contract: Up/Down move the selected row (one Tab stop for the
// whole tree), Left/Right collapse/expand the focused folder, Enter opens a
// file, Tab leaves the tree for the next section instead of walking rows.
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO (same contract as collapse-probe.mjs).

import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";

const ORIGIN = process.env.E2E_ORIGIN;
const CDP_PORT = Number(process.env.CDP_PORT || 9226);
const REPO = process.env.E2E_REPO;
const OUT = process.env.E2E_OUT || "/tmp/filter-tree-keyboard-acceptance.json";

if (!ORIGIN || !REPO) throw new Error("E2E_ORIGIN and E2E_REPO must be set");

const recorder = makeRecorder();

const list = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const cdp = await attach(page.webSocketDebuggerUrl);

const evalJs = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
async function waitFor(expr, label, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}
// Real key event, not a synthetic dispatchEvent: the browser runs the full
// default-action pipeline so focus movement and Tab order are observable.
const keyCodes = { ArrowDown: "ArrowDown", ArrowUp: "ArrowUp", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Enter: "Enter", Tab: "Tab" };
async function pressKey(name) {
  const code = keyCodes[name] || name;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: 0 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: 0 });
  await sleep(350);
}

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed");

await cdp.send("Page.navigate", { url: `${ORIGIN}/session/default` });
await sleep(2500);
await evalJs(`try { localStorage.setItem('herdr-web-layout', 'desktop') } catch (e) { true; }`);
await cdp.send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled");
await waitFor(`(() => (typeof state !== 'undefined' && state.ws === ${JSON.stringify(wsId)}))()`, "state.ws set");

await evalJs(`openWorkspaceFileBrowser(${JSON.stringify(wsId)}, { forceOpen: true })`);
await waitFor(`!!document.querySelector('.file-browser-side .herdr-tree-row')`, "tree rendered");
await evalJs(`(() => { if (window.HerdrRightSidebar && window.HerdrRightSidebar.collapsed()) window.HerdrRightSidebar.setCollapsed(false); return true; })()`);
await sleep(600);

// Focus the filter input by clicking it, then type a query that matches a
// nested path so the results tree has folder rows to collapse.
await evalJs(`(() => { const i = document.getElementById('fileBrowserFilter'); if (!i) return false; i.focus(); return document.activeElement === i; })()`);
await evalJs(`(() => { HerdrFileBrowser.filterInput('app'); return true; })()`);
// Enter commits the search immediately (no debounce wait).
await evalJs(`(() => { HerdrFileBrowser.filterKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} }); return true; })()`);
await waitFor(`(() => { const rows = document.querySelectorAll('.file-browser-side .herdr-tree-row'); return rows.length > 0 && !!document.querySelector('.herdr-tree-hit'); })()`, "filter results rendered");

const state1 = await evalJs(`(() => {
  const side = document.querySelector('.file-browser-side');
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  return {
    count: rows.length,
    tabStops: rows.filter((r) => r.tabIndex === 0).length,
    selected: rows.find((r) => r.classList.contains('active')) ? rows.find((r) => r.classList.contains('active')).title : null,
    focused: document.activeElement && document.activeElement.title ? document.activeElement.title : String(document.activeElement && document.activeElement.id || document.activeElement && document.activeElement.className || "none"),
    titles: rows.map((r) => r.title),
    dirRows: rows.filter((r) => r.classList.contains('dir')).map((r) => r.title),
  };
})()`);
recorder.record("results render as folder/file tree with one tab stop", state1.tabStops === 1 && state1.count > 1,
  `rows=${state1.count} tabStops=${state1.tabStops} selected=${state1.selected} focused=${state1.focused}`);

// Move focus onto the tree's single tab stop (the selected row), then walk.
await evalJs(`(() => { const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row')]; const sel = rows.find((r) => r.tabIndex === 0); if (sel) { sel.focus(); return document.activeElement === sel; } return false; })()`);

const before = await evalJs(`(() => ({ sel: HerdrFileBrowser.selectedFilterForTest ? HerdrFileBrowser.selectedFilterForTest() : null, idx: [...document.querySelectorAll('.file-browser-side .herdr-tree-row')].findIndex((r) => r.tabIndex === 0) }))()`);
await pressKey("ArrowDown");
const afterDown = await evalJs(`(() => ({ sel: HerdrFileBrowser.selectedFilterForTest ? HerdrFileBrowser.selectedFilterForTest() : null, idx: [...document.querySelectorAll('.file-browser-side .herdr-tree-row')].findIndex((r) => r.tabIndex === 0), focusTitle: document.activeElement && document.activeElement.title || null }))()`);
recorder.record("ArrowDown moves selection and DOM focus to next row", afterDown.idx === before.idx + 1 && afterDown.focusTitle === afterDown.sel,
  `before=${before.sel}@${before.idx} after=${afterDown.sel}@${afterDown.idx} focus=${afterDown.focusTitle}`);

await pressKey("ArrowUp");
const afterUp = await evalJs(`(() => ({ idx: [...document.querySelectorAll('.file-browser-side .herdr-tree-row')].findIndex((r) => r.tabIndex === 0), focusTitle: document.activeElement && document.activeElement.title || null }))()`);
recorder.record("ArrowUp moves selection back", afterUp.idx === before.idx && afterUp.focusTitle === before.sel,
  `idx=${afterUp.idx} focus=${afterUp.focusTitle}`);

// Left/Right collapse/expand the focused folder row.
const dirTitle = state1.dirRows[0];
if (dirTitle) {
  await evalJs(`(() => { HerdrFileBrowser.setFilterSelectedForTest(${JSON.stringify(dirTitle)}); const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row')]; const sel = rows.find((r) => r.tabIndex === 0); if (sel) sel.focus(); return true; })()`);
  const rowsBefore = await evalJs(`document.querySelectorAll('.file-browser-side .herdr-tree-row').length`);
  await pressKey("ArrowLeft");
  const collapsed = await evalJs(`(() => ({ rows: document.querySelectorAll('.file-browser-side .herdr-tree-row').length, collapsed: HerdrFileBrowser.isFilterCollapsedForTest(${JSON.stringify(dirTitle)}), expandedAttr: (document.querySelector('.file-browser-side .herdr-tree-row.dir[aria-expanded]') || {}).getAttribute ? null : null, focus: document.activeElement && document.activeElement.title || null }))()`);
  const folderStillVisible = await evalJs(`(() => [...document.querySelectorAll('.file-browser-side .herdr-tree-row')].some((r) => r.title === ${JSON.stringify(dirTitle)}))()`);
  recorder.record("ArrowLeft collapses the folder group", collapsed.collapsed && collapsed.rows < rowsBefore && folderStillVisible,
    `rows ${rowsBefore}->${collapsed.rows} collapsed=${collapsed.collapsed} focus=${collapsed.focus}`);
  await pressKey("ArrowRight");
  const expanded = await evalJs(`(() => ({ rows: document.querySelectorAll('.file-browser-side .herdr-tree-row').length, collapsed: HerdrFileBrowser.isFilterCollapsedForTest(${JSON.stringify(dirTitle)}), focus: document.activeElement && document.activeElement.title || null }))()`);
  recorder.record("ArrowRight expands the folder group", !expanded.collapsed && expanded.rows === rowsBefore,
    `rows->${expanded.rows} collapsed=${expanded.collapsed} focus=${expanded.focus}`);

  // Caret click (mouse) folds the group the same way Left/Right does.
  await evalJs(`(() => { const row = [...document.querySelectorAll('.file-browser-side .herdr-tree-row.dir')].find((r) => r.title === ${JSON.stringify(dirTitle)}); if (!row) return false; row.querySelector('.herdr-tree-caret').click(); return true; })()`);
  await sleep(250);
  const caretCollapsed = await evalJs(`(() => ({ collapsed: HerdrFileBrowser.isFilterCollapsedForTest(${JSON.stringify(dirTitle)}), rows: document.querySelectorAll('.file-browser-side .herdr-tree-row').length }))()`);
  recorder.record("caret click folds the folder group like ArrowLeft", caretCollapsed.collapsed === true && caretCollapsed.rows < rowsBefore,
    `collapsed=${caretCollapsed.collapsed} rows=${caretCollapsed.rows}`);
  // Restore expanded for the checks below, then put focus back on the
  // selected row (the restore re-render left focus on the body).
  await evalJs(`(() => { HerdrFileBrowser.toggleFilter(${JSON.stringify(encodeURIComponent(dirTitle))}); return true; })()`);
  await sleep(250);
  await evalJs(`(() => { const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row')]; const sel = rows.find((r) => r.tabIndex === 0); if (sel) sel.focus(); return true; })()`);

  // Enter on a folder row toggles it too (parity with the caret click).
  await pressKey("ArrowLeft");
  const enterCollapsed = await evalJs(`HerdrFileBrowser.isFilterCollapsedForTest(${JSON.stringify(dirTitle)})`);
  await pressKey("Enter");
  const enterExpanded = await evalJs(`HerdrFileBrowser.isFilterCollapsedForTest(${JSON.stringify(dirTitle)})`);
  recorder.record("Enter toggles the focused folder", enterCollapsed === true && enterExpanded === false,
    `collapsed=${enterCollapsed} -> ${enterExpanded}`);
} else {
  recorder.record("folder row present for collapse checks", false, "no dir rows in results");
}

// Enter on a file row opens it as an editor tab.
const fileRowTitle = state1.titles.find((t) => t && !state1.dirRows.includes(t));
if (fileRowTitle) {
  await evalJs(`(() => { HerdrFileBrowser.setFilterSelectedForTest(${JSON.stringify(fileRowTitle)}); const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row')]; const sel = rows.find((r) => r.tabIndex === 0); if (sel) sel.focus(); return true; })()`);
  await pressKey("Enter");
  const editorOpened = await evalJs(`(() => !!document.querySelector('.herdr-editor') || !!(window.HerdrWorkspacePanes && window.HerdrWorkspacePanes.activePaneTab && window.HerdrWorkspacePanes.activePaneTab()))()`);
  recorder.record("Enter on a file row opens the file", !!editorOpened, `title=${fileRowTitle} opened=${!!editorOpened}`);
} else {
  recorder.record("file row present for Enter check", false, "no file rows in results");
}

// Tab from the tree row must leave the tree entirely (not walk to the next
// row). After Tab, focus is outside .herdr-tree-row.
await evalJs(`(() => { const rows = [...document.querySelectorAll('.file-browser-side .herdr-tree-row')]; const sel = rows.find((r) => r.tabIndex === 0); if (sel) sel.focus(); return true; })()`);
await pressKey("Tab");
const tabTarget = await evalJs(`(() => ({ onRow: !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('herdr-tree-row')), target: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : "none" }))()`);
recorder.record("Tab leaves the tree (roving single stop)", !tabTarget.onRow, `target=${tabTarget.target}`);

// Tab round trip: from the filter input, Tab walks the section's own
// controls (nav arrows, clear) and then enters the tree exactly once, at
// the selected row (roving stop), never row by row.
await evalJs(`(() => { const i = document.getElementById('fileBrowserFilter'); if (i) i.focus(); return true; })()`);
let landed = null;
for (let i = 0; i < 8; i++) {
  await pressKey("Tab");
  const at = await evalJs(`(() => { const a = document.activeElement; return { onRow: !!(a && a.classList && a.classList.contains('herdr-tree-row')), selected: !!(a && a.classList && a.classList.contains('active')), title: a && a.title || null }; })()`);
  if (at.onRow) { landed = at; break; }
}
recorder.record("Tab from the filter input enters the tree at the selected row", !!(landed && landed.selected),
  `landed=${landed ? landed.title : "never"} selected=${landed ? landed.selected : false}`);

writeReport(OUT, recorder, { origin: ORIGIN, repo: REPO });
console.log(`report: ${OUT}`);
console.log(`filter-tree keyboard acceptance: ${recorder.failed ? "FAILED" : "PASSED"} (${recorder.passed} passed, ${recorder.failed} failed)`);
process.exit(recorder.failed ? 1 : 0);
