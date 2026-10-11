// Real-DOM acceptance for the W1 (git tab cross-leaf) and T1/T2
// (worktree_remove teardown + workspace_ids event) fixes. Boots via
// run-fix-probe.sh: isolated server + headless Chrome. Drives the real
// served bundle through the same surfaces a user touches.
//
// W1: split, open the git drawer's Changes view (tab lands in the active
// leaf), focus the other leaf, click the drawer's Changes row again. The
// one-owner rule must hold: one git:changes id across all leaves, focus
// on the owner.
//
// T1: create a worktree workspace, POST worktree-remove with its
// workspace_id, poll the snapshot: the workspace and its tabs/panes are
// gone. T2: the worktree.removed event payload carries workspace_ids.

import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL;
const REPO = process.env.REPO;
const CDP_HTTP = process.env.CDP_HTTP;
if (!APP_URL || !REPO || !CDP_HTTP) {
  console.error("APP_URL, REPO, and CDP_HTTP must be set (use scripts/e2e/run-fix-probe.sh)");
  process.exit(2);
}

const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/fix_probe_result.json`;
const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch (_) { /* degrade */ }

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  await reload();

  // ── W1: git tab cross-leaf routing ─────────────────────────────────
  // W1: git tab cross-leaf routing. Open a workspace on the fixture
  // repo and navigate to its route (the drawer reads state.ws from the
  // URL), then drive the drawer flow.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "fix-probe"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  record("workspace created", !!wsId, JSON.stringify(made).slice(0, 200));
  if (!wsId) throw new Error("no workspace_id: " + JSON.stringify(made).slice(0, 300));
  await reload(`${APP_URL}session/default/workspace/${wsId}`);
  const loaded = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state && state.workspaces && state.workspaces.length) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("app loaded the workspace list", loaded === "loaded", `got ${loaded}`);
  if (loaded !== "loaded") throw new Error("app never loaded the workspace list");

  const splitOk = await evalExpr(`(() => {
    const p = window.HerdrWorkspacePanes;
    if (!p) return "no-module";
    if (!p.splitPaneRight) return "no-split";
    return p.splitPaneRight() ? "split" : "refused";
  })()`);
  record("splitPaneRight created a second leaf", splitOk === "split", `got ${splitOk}`);
  if (splitOk !== "split") throw new Error("splitPaneRight failed: " + splitOk);

  // Open the git drawer's Changes view: the git tab lands in the ACTIVE
  // leaf (the fresh one after the split).
  const openGit = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailGit");
    if (!btn) return "no-toggle";
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const changes = Array.from(document.querySelectorAll(".git-ui-view-toggle")).find((b) => /changes/i.test(b.textContent || ""));
    if (!changes) return "no-changes-toggle";
    changes.click();
    await new Promise((r) => setTimeout(r, 1500));
    const p = window.HerdrWorkspacePanes;
    const owners = p.paneLeaves(p.paneRoot()).filter((l) => (l.tabs || []).includes("git:changes"));
    return JSON.stringify({ owners: owners.length, activePane: p.paneRoot().activePaneId, ownerPane: owners[0] && owners[0].paneId });
  })()`);
  let gitOpenInfo = null;
  try { gitOpenInfo = JSON.parse(openGit); } catch { gitOpenInfo = null; }
  record("git tab opens in the active leaf", !!gitOpenInfo && gitOpenInfo.owners === 1, openGit.slice(0, 300));
  if (!gitOpenInfo) throw new Error("git open failed: " + openGit);
  const ownerPane = gitOpenInfo.ownerPane;

  // Focus the OTHER leaf (the terminal one) the way a user does: click
  // the terminal tab button in that pane's strip. Then click the drawer's
  // Changes row again: the pre-fix bug minted a second git:changes id in
  // the now-active leaf. The fix must route the click to the owner.
  const clicked = await evalExpr(`(async () => {
    const p = window.HerdrWorkspacePanes;
    const other = p.paneLeaves(p.paneRoot()).find((l) => !(l.tabs || []).includes("git:changes"));
    if (!other) return "no-other-leaf";
    // A terminal tab in the other leaf's strip, clicked through the DOM.
    const stripBtn = Array.from(document.querySelectorAll('.pane-tab[data-tab-kind="terminal"]'))
      .find((btn) => (btn.textContent || "").length > 0 && other.tabs.includes(btn.dataset.tabId));
    if (!stripBtn) return "no-terminal-tab";
    stripBtn.click();
    await new Promise((r) => setTimeout(r, 600));
    if (p.paneRoot().activePaneId !== other.paneId) return "focus-did-not-move";
    // The drawer nav row: same surface a user hits twice.
    const changes = Array.from(document.querySelectorAll(".git-ui-view-toggle")).find((b) => /changes/i.test(b.textContent || ""));
    if (!changes) return "no-changes-toggle";
    changes.click();
    await new Promise((r) => setTimeout(r, 1500));
    const leaves = p.paneLeaves(p.paneRoot());
    const owners = leaves.filter((l) => (l.tabs || []).includes("git:changes"));
    return JSON.stringify({ owners: owners.length, activePane: p.paneRoot().activePaneId, ownerPanes: owners.map((l) => l.paneId), totalGitTabs: leaves.flatMap((l) => l.tabs).filter((t) => t === "git:changes").length });
  })()`);
  let clickInfo = null;
  try { clickInfo = JSON.parse(clicked); } catch { clickInfo = null; }
  record("second drawer click keeps one git:changes id", !!clickInfo && clickInfo.owners === 1 && clickInfo.totalGitTabs === 1, clicked.slice(0, 300));
  record("second drawer click focuses the owning leaf", !!clickInfo && String(clickInfo.activePane) === String(ownerPane), clicked.slice(0, 300));

  // ── T1/T2: worktree_remove teardown + event payload ─────────────
  // Create a worktree through POST /api/worktrees (the route the
  // worktree picker uses): cwd + branch + label.
  const worktree = await evalExpr(`(async () => {
    const res = await fetch("/api/worktrees", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, branch: "probe-wt", label: "probe-wt"})}).then((r) => r.json()).catch((e) => "err:" + e);
    return JSON.stringify(res);
  })()`);
  let wtInfo = null;
  try { wtInfo = JSON.parse(worktree); } catch { wtInfo = null; }
  record("worktree created", !!wtInfo && !String(worktree).includes("err:"), worktree.slice(0, 300));
  const wtWorkspaceId = wtInfo && (wtInfo.result && wtInfo.result.workspace && wtInfo.result.workspace.workspace_id) || (wtInfo.result && wtInfo.result.worktree && wtInfo.result.worktree.open_workspace_id);
  if (!wtWorkspaceId) throw new Error("no worktree workspace_id: " + worktree.slice(0, 300));

  // Snapshot before: the worktree workspace is open with its tabs/panes.
  const before = await evalExpr(`fetch("/api/session-snapshot").then((r) => r.json()).catch((e) => "err:" + e)`);
  const beforeHas = before && JSON.stringify(before).includes(wtWorkspaceId);
  record("worktree workspace visible before remove", !!beforeHas, JSON.stringify(before).slice(0, 200));

  // Subscribe to the events socket BEFORE the remove so the
  // worktree.removed event is captured.
  const eventsTap = await evalExpr(`(async () => {
    window.__probeEvents = [];
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/events");
    window.__probeEventsSocket = ws;
    ws.onmessage = (ev) => { try { window.__probeEvents.push(JSON.parse(ev.data)); } catch (_) {} };
    await new Promise((resolve) => { ws.onopen = resolve; setTimeout(resolve, 2000); });
    return "open";
  })()`);
  record("events socket open", eventsTap === "open", String(eventsTap).slice(0, 120));

  // Remove through the route the worktree UI uses.
  const removed = await evalExpr(`fetch("/api/workspaces/${encodeURIComponent(wtWorkspaceId)}/worktree-remove", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({force: true})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  record("worktree-remove call succeeded", !String(removed).includes("err:"), String(removed).slice(0, 300));

  // Poll the snapshot until the workspace is gone (the backend tears
  // down tabs/panes/PTYs synchronously, but the browser refreshes on its
  // own cadence).
  let after = null;
  let gone = false;
  for (let i = 0; i < 20; i++) {
    after = await evalExpr(`fetch("/api/session-snapshot").then((r) => r.json()).catch((e) => "err:" + e)`);
    gone = after && !JSON.stringify(after).includes(wtWorkspaceId);
    if (gone) break;
    await sleep(400);
  }
  record("worktree workspace gone from snapshot after remove", !!gone, JSON.stringify(after).slice(0, 300));

  // T2: the event payload names the dropped workspace. The events
  // socket wraps backend frames as {type:"event", event:{...}}, so
  // match on the stringified frame rather than one fixed shape.
  const event = await evalExpr(`(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const events = window.__probeEvents || [];
    const hit = events.find((e) => JSON.stringify(e).includes("worktree.removed"));
    if (!hit) return "no-event";
    return JSON.stringify(hit);
  })()`);
  let evtInfo = null;
  try { evtInfo = JSON.parse(event); } catch { evtInfo = null; }
  const payloadStr = evtInfo ? JSON.stringify(evtInfo) : event;
  const carriesIds = !!evtInfo && payloadStr.includes("workspace_ids") && payloadStr.includes(wtWorkspaceId);
  record("worktree.removed event carries workspace_ids", carriesIds, event.slice(0, 400));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeReport(outPath, recorder, { crash: String(e) }, true);
  process.exit(1);
});