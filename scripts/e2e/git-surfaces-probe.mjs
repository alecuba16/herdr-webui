// Sibling-surface probes for doc section 3.3: git log and git side tree
// (desktop git_ui).
//
// V25 git log: the log tab renders .git-ui-log-row rows virtualized with
//      content-visibility: auto; contain-intrinsic-size: auto 30px
//      (git_ui/log.css:514-518) and re-renders restore scrollTop via
//      captureContentScroll (git_ui.js:1037-1042, 1201-1210). The probe
//      measures mechanism B there: under a pinned scrollTop, a re-render
//      wipes the content, offscreen rows reset to the 30px intrinsic, and
//      the marker row moves.
// V26 git side tree: side rows are .herdr-tree-row, and desktop boots
//      load shared/file-tree.css whose .herdr-tree-row rule applies
//      content-visibility to ALL such rows (file_tree.css:124-129), so
//      the doc claim "not virtualized" needs a live check; the probe
//      reads the computed style of a side row directly, then measures a
//      content-neutral re-render's effect on a pinned side scroll.
//
// Layout note: the git main views live in center pane tabs (Phase 3c)
// and the side tree lives in the right sidebar column. The probe
// measures the side tree first (column expanded), then collapses the
// right sidebar so the center pane gets real width, then measures the
// log body.
//
// Env: E2E_ORIGIN, CDP_PORT, E2E_REPO (same contract as other probes).

const ORIGIN = process.env.E2E_ORIGIN || "https://127.0.0.1:8901";
const CDP_PORT = Number(process.env.CDP_PORT || 9225);
const REPO = process.env.E2E_REPO;

const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onclose = () => { console.error("CDP websocket closed"); process.exit(3); };
const pending = new Map();
let nextId = 1;
ws.onmessage = (m) => {
  const data = JSON.parse(m.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function waitFor(expr, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalJs(`!!(${expr})`)) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

await evalJs(`try { localStorage.setItem('herdr-web-layout', 'desktop') } catch (e) { /* about:blank */ }`);
const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: REPO }),
}).then((r) => r.json()).catch(() => null);
const wsId = open && ((open.result || open).workspace) ? ((open.result || open).workspace).workspace_id : null;
if (!wsId) throw new Error("workspace open failed: " + JSON.stringify(open).slice(0, 300));
await send("Page.navigate", { url: `${ORIGIN}/session/default/workspace/${wsId}` });
await sleep(3000);
await waitFor(`!!document.getElementById('settingsSearch')`, "boot settled");

// Open git the way a user does: the rail button click (loads the lazy
// module through the app's own funnel, openWorkspaceGitUi).
await evalJs(`(() => { document.getElementById('rightRailGit').click(); return true; })()`);
await waitFor(`!!window.HerdrGitUi`, "git module loaded");
await waitFor(`!!document.querySelector('.git-ui-panel, .git-ui-content')`, "git panel rendered");
// The changes view is the default; wait for its side tree.
await waitFor(`!!document.querySelector('.git-ui-side .herdr-tree-row, .git-ui-list .herdr-tree-row')`, "side tree rendered");
await sleep(800);

// ---------- V26: git side tree (right column expanded) ----------
const v26style = await evalJs(`(() => {
  const side = document.querySelector('.git-ui-side') || document.querySelector('.git-ui-list');
  if (!side) return { error: 'no side node' };
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  const cs = rows.length ? getComputedStyle(rows[0]) : null;
  return {
    rows: rows.length,
    cv: cs ? cs.contentVisibility : null,
    intrinsic: cs ? cs.containIntrinsicSize : null,
    sideScrollHeight: side.scrollHeight,
    sideClientHeight: side.clientHeight,
  };
})()`);
console.log("[V26 side style]", JSON.stringify(v26style));

// A re-render of the whole panel (innerHTML wipe) restores the side
// scroll from state.sideScrollTop (git_ui.js:1100). Pin the side scroll
// at a nonzero offset if the list overflows, then re-render and measure
// the marker row move under the pinned scrollTop. refresh() re-renders
// the same changes view, so the measurement is content-neutral; toggling
// a section would change the list itself and pollute the delta.
const v26 = await evalJs(`(() => {
  const side = document.querySelector('.git-ui-side') || document.querySelector('.git-ui-list');
  if (!side) return { error: 'no side' };
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  if (!rows.length) return { error: 'no side rows' };
  if (side.scrollHeight > side.clientHeight + 10) side.scrollTop = Math.min(40, side.scrollHeight - side.clientHeight - 1);
  const visible = rows.filter((r) => {
    const t = r.getBoundingClientRect().top;
    return t >= side.getBoundingClientRect().top && t <= side.getBoundingClientRect().bottom;
  });
  const marker = visible[Math.floor(visible.length / 2)] || rows[0];
  window.__v26MarkerTitle = marker.getAttribute('title') || marker.textContent.trim().slice(0, 40);
  const before = {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    markerY: marker.getBoundingClientRect().top,
    markerH: marker.getBoundingClientRect().height,
  };
  window.__v26Before = before;
  window.HerdrGitUi.sideScroll(side);
  window.HerdrGitUi.refresh();
  return { before };
})()`);
await sleep(900);
const v26after = await evalJs(`(() => {
  const side = document.querySelector('.git-ui-side') || document.querySelector('.git-ui-list');
  if (!side) return { error: 'no side after' };
  const rows = [...side.querySelectorAll('.herdr-tree-row')];
  const marker = rows.find((r) => (r.getAttribute('title') || r.textContent.trim().slice(0, 40)) === window.__v26MarkerTitle)
    || rows[0];
  const after = {
    scrollTop: side.scrollTop,
    scrollHeight: side.scrollHeight,
    markerY: marker ? marker.getBoundingClientRect().top : null,
    markerH: marker ? marker.getBoundingClientRect().height : null,
    delta: marker ? marker.getBoundingClientRect().top - window.__v26Before.markerY : null,
    rows: rows.length,
  };
  return after;
})()`);
console.log("[V26 side re-render]", JSON.stringify({ before: v26.before, after: v26after }));

// ---------- V25: git log (center pane tab) ----------
// The log body lives in the center pane's git tab container. The real
// user path is the side toolbar's log toggle (side_tree.js
// renderGitViewTabs: HerdrGitUi.tab('log') -> workspace_panes
// openGitTab -> paneEnsureGitTab + git_ui openViewTab), which inserts
// the git:log tab into the pane tree before git_ui renders into the
// mount. Calling HerdrGitUi.openViewTab directly skips paneEnsureGitTab,
// so the tab never joins the pane tree and the next render parks the
// mount hidden; an earlier probe revision did exactly that and this
// block used the public toggle path instead.
const openedLog = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.git-ui-view-toggle')].find((b) => (b.getAttribute('onclick') || '').includes("HerdrGitUi.tab('log')"));
  if (!btn) return { error: 'no log toggle button' };
  btn.click();
  return { clicked: true };
})()`);
if (openedLog && openedLog.error) {
  console.log("[V25 log re-render]", JSON.stringify({ skipped: openedLog.error }));
} else {
await waitFor(`!!document.querySelector('.git-ui-log-row')`, "log rows rendered");
await sleep(1500);
// Give the center column a real chance to show the mount: the grid
// gives it minmax(0, 1fr) whenever the right column is not hogging
// the shell focus; record the geometry either way so a hidden mount
// is visible as a diagnosis, never as a fake zero measurement.
const surfacing = await evalJs(`(() => {
  const panes = window.HerdrWorkspacePanes;
  const mount = panes && panes.paneGitMountId ? document.getElementById(panes.paneGitMountId('log')) : null;
  const strip = document.querySelector('.pane-tab[data-tab-id="git:log"]');
  const paneEl = document.querySelector('#workspacePanes .workspace-pane');
  return {
    mountId: mount ? mount.id : null,
    mountDisplay: mount ? getComputedStyle(mount).display : null,
    mountRect: mount ? { w: mount.getBoundingClientRect().width, h: mount.getBoundingClientRect().height } : null,
    stripPresent: !!strip,
    paneRect: paneEl ? { w: paneEl.getBoundingClientRect().width, h: paneEl.getBoundingClientRect().height } : null,
    treeTabs: panes && panes.paneTabs ? panes.paneTabs() : null,
  };
})()`);
console.log("[V25 log surfacing]", JSON.stringify(surfacing));
const mountVisible = await evalJs(`(() => { const p = window.HerdrWorkspacePanes; if (!p || !p.paneGitMountId) return false; const m = document.getElementById(p.paneGitMountId('log')); return !!(m && m.getBoundingClientRect().width > 50); })()`);
if (!mountVisible) {
  const style = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.git-ui-log-row')];
    const cs = rows.length ? getComputedStyle(rows[Math.floor(rows.length / 2)]) : null;
    return { rows: rows.length, cv: cs ? cs.contentVisibility : null, intrinsic: cs ? cs.containIntrinsicSize : null, mountVisible: false };
  })()`);
  console.log("[V25 log state]", JSON.stringify(style));
    console.log("[V25 log re-render]", JSON.stringify({ skipped: 'mount not surfaceable in headless shell (pane tab hidden behind right-column focus)', surfacing }));
  } else {
    const logState = await evalJs(`(() => {
      const panes = window.HerdrWorkspacePanes;
      let host = null;
      if (panes && panes.paneGitMountId) {
        for (const k of ['log', 'changes']) {
          const m = document.getElementById(panes.paneGitMountId(k));
          if (m && m.querySelector('.git-ui-log-row')) { host = m; break; }
        }
      }
      const content = (host || document.body).querySelector('.git-ui-content');
      const rows = [...document.querySelectorAll('.git-ui-log-row')];
      const cs = rows.length ? getComputedStyle(rows[Math.floor(rows.length / 2)]) : null;
      return {
        hostId: host ? host.id : null,
        centerW: document.getElementById('workspacePanes') ? document.getElementById('workspacePanes').getBoundingClientRect().width : null,
        rows: rows.length,
        hasContent: !!content,
        contentScrollable: content ? content.scrollHeight > content.clientHeight : null,
        scrollHeight: content ? content.scrollHeight : null,
        clientHeight: content ? content.clientHeight : null,
        rowContentVisibility: cs ? cs.contentVisibility : null,
        rowContainIntrinsic: cs ? cs.containIntrinsicSize : null,
      };
    })()`);
    console.log("[V25 log state]", JSON.stringify(logState));

  // Pin the log scroll mid-list (the 120-commit fixture fills the 80-row
  // page past the viewport), then force a re-render through the public
  // refresh entry; captureContentScroll runs inside the render and the
  // restore puts scrollTop back, so any marker movement under the pinned
  // scrollTop is mechanism B (placeholder reset on offscreen rows).
  const v25 = await evalJs(`(() => {
    const panes = window.HerdrWorkspacePanes;
    let host = null;
    if (panes && panes.paneGitMountId) {
      for (const k of ['log', 'changes']) {
        const m = document.getElementById(panes.paneGitMountId(k));
        if (m && m.querySelector('.git-ui-log-row')) { host = m; break; }
      }
    }
    const content = (host || document.body).querySelector('.git-ui-content');
    if (!content) return { error: 'no content node' };
    const rows = [...document.querySelectorAll('.git-ui-log-row')];
    if (!rows.length) return { error: 'no log rows' };
    if (content.scrollHeight > content.clientHeight + 10) content.scrollTop = 600;
    const visible = rows.filter((r) => {
      const t = r.getBoundingClientRect().top;
      return t >= content.getBoundingClientRect().top && t <= content.getBoundingClientRect().bottom;
    });
    const marker = visible[Math.floor(visible.length / 2)] || rows[0];
    window.__v25MarkerHash = marker.getAttribute('data-log-hash');
    const cs = getComputedStyle(marker);
    const before = {
      scrollTop: content.scrollTop,
      scrollHeight: content.scrollHeight,
      markerY: marker.getBoundingClientRect().top,
      markerH: marker.getBoundingClientRect().height,
      cv: cs.contentVisibility,
      intrinsic: cs.containIntrinsicSize,
    };
    window.__v25Before = before;
    window.HerdrGitUi.refresh();
    return before;
  })()`);
  await sleep(1200);
  const v25after = await evalJs(`(() => {
    const panes = window.HerdrWorkspacePanes;
    let host = null;
    if (panes && panes.paneGitMountId) {
      for (const k of ['log', 'changes']) {
        const m = document.getElementById(panes.paneGitMountId(k));
        if (m && m.querySelector('.git-ui-log-row')) { host = m; break; }
      }
    }
    const content = (host || document.body).querySelector('.git-ui-content');
    const rows = [...document.querySelectorAll('.git-ui-log-row')];
    const marker = rows.find((r) => r.getAttribute('data-log-hash') === window.__v25MarkerHash);
    if (!marker) return { error: 'marker gone' };
    const after = {
      scrollTop: content.scrollTop,
      scrollHeight: content.scrollHeight,
      markerY: marker.getBoundingClientRect().top,
      markerH: marker.getBoundingClientRect().height,
      delta: marker.getBoundingClientRect().top - window.__v25Before.markerY,
      rows: rows.length,
    };
    return after;
  })()`);
  console.log("[V25 log re-render]", JSON.stringify({ before: v25, after: v25after }));
  }
}

process.exit(0);
