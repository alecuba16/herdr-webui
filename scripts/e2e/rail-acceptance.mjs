// Real-DOM acceptance for the maximize rail (n1) and the git tab labels
// (n2/n3) from the update-windows batch.
//
// Boots an isolated server + chrome-headless (run-rail-e2e.sh), creates a
// workspace on a fixture repo, splits the pane, maximizes one leaf, and
// checks the real served bundle: the rail renders the sibling strip with
// live controls, clicking the rail's tab restores the layout, the
// maximized pane's own tab keeps the flat view, and the git drawer opens
// as a pane tab labeled gitchanges.
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/rail_e2e_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-rail-e2e.sh)");
  process.exit(2);
}

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

  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "rail-e2e"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  record("workspace created on fixture repo", true, wsId);
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

  // Split right: two leaves, terminal tab in leaf A.
  const splitOk = await evalExpr(`(() => {
    const p = window.HerdrWorkspacePanes;
    if (!p || !p.splitPaneRight) return "no-module";
    return p.splitPaneRight() ? "split" : "refused";
  })()`);
  record("splitPaneRight created a second leaf", splitOk === "split", `got ${splitOk}`);
  if (splitOk !== "split") throw new Error("splitPaneRight failed: " + splitOk);

  // The right sidebar Files drawer routes a file into the ACTIVE leaf.
  // Split moved focus to the fresh leaf, so the editor lands there: the
  // rail will show its strip once the terminal leaf is maximized.
  const opened = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailFiles");
    if (!btn) return "no-toggle";
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const row = document.querySelector('.herdr-tree-row.file[title="README.md"]');
    if (!row) return "no-row";
    row.click();
    await new Promise((r) => setTimeout(r, 1200));
    return "opened";
  })()`);
  record("file browser opened a README.md editor tab", opened === "opened", `got ${opened}`);

  // Maximize the terminal leaf (first leaf, holds the route terminal).
  const leavesInfo = await evalExpr(`(() => {
    const p = window.HerdrWorkspacePanes;
    const leaves = p.paneLeaves(p.paneRoot());
    return JSON.stringify(leaves.map((l) => ({ paneId: l.paneId, tabs: l.tabs, active: l.active })));
  })()`);
  let leaves = [];
  try { leaves = JSON.parse(leavesInfo); } catch { /* handled below */ }
  record("two leaves exist before maximize", leaves.length === 2, leavesInfo.slice(0, 300));

  const terminalLeaf = leaves.find((l) => (l.tabs || []).some((t) => !String(t).startsWith("editor:") && !String(t).startsWith("git:")));
  if (!terminalLeaf) throw new Error("no terminal leaf found: " + leavesInfo);
  const maxed = await evalExpr(`(() => {
    const p = window.HerdrWorkspacePanes;
    return p.maximizePaneFor(${JSON.stringify(terminalLeaf.paneId)}) ? "maxed" : "refused";
  })()`);
  record("terminal leaf maximized", maxed === "maxed", `got ${maxed}`);
  if (maxed !== "maxed") throw new Error("maximizePaneFor failed");

  // Core n1 check: the rail renders the sibling strip.
  const rail = await evalExpr(`(() => {
    const rails = document.querySelectorAll("#workspacePanes > .pane-strip-rail");
    if (!rails.length) return "no-rail";
    const stubs = Array.from(rails[0].querySelectorAll(".workspace-pane"));
    return JSON.stringify({
      stubs: stubs.length,
      stubKeys: stubs.map((s) => s.dataset.paneId),
      stripTabs: stubs.map((s) => Array.from(s.querySelectorAll(".pane-tab")).map((t) => (t.textContent || "").trim()).join("|")),
      hasControls: stubs.every((s) => s.querySelector(".pane-strip-controls")),
    });
  })()`);
  let railInfo = null;
  try { railInfo = JSON.parse(rail); } catch { railInfo = null; }
  record("rail renders the hidden sibling strip", !!railInfo && railInfo.stubs === 1 && railInfo.hasControls, rail.slice(0, 300));
  record("rail strip shows the sibling editor tab", !!railInfo && /README/i.test(String(railInfo.stripTabs)), rail.slice(0, 300));

  // Clicking the maximized pane's own tab keeps the flat view.
  const ownTab = await evalExpr(`(() => {
    const p = window.HerdrWorkspacePanes;
    const active = p.paneActiveTab();
    if (!active) return "no-active";
    p.activatePaneTab(active);
    return p.paneIsMaximized() ? "kept" : "lost";
  })()`);
  record("own-tab click keeps maximize", ownTab === "kept", `got ${ownTab}`);

  // Click the rail's editor tab: restore + activate. Real trusted click:
  // measure the tab rect and dispatch mouse input at its center.
  const clicked = await (async () => {
    const pt = await evalExpr(`(() => {
      const stub = document.querySelector("#workspacePanes > .pane-strip-rail .workspace-pane");
      if (!stub) return null;
      const tab = Array.from(stub.querySelectorAll(".pane-tab")).find((t) => /README/i.test(t.textContent || ""));
      if (!tab) return "no-tab";
      const r = tab.getBoundingClientRect();
      if (!r.width || !r.height) return "zero-rect";
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (!pt || pt === "no-tab" || pt === "zero-rect") return pt || "no-point";
    const point = JSON.parse(pt);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await sleep(150);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(800);
    return await evalExpr(`(() => {
      const p = window.HerdrWorkspacePanes;
      return JSON.stringify({
        maximized: p.paneIsMaximized(),
        railCount: document.querySelectorAll("#workspacePanes > .pane-strip-rail").length,
        splitBack: document.querySelectorAll("#workspacePanes > .pane-row, #workspacePanes > .pane-column").length,
        activeTab: p.paneActiveTab(),
        focusPane: p.paneRoot().activePaneId,
      });
    })()`);
  })();
  let clickInfo = null;
  try { clickInfo = JSON.parse(clicked); } catch { clickInfo = null; }
  record("rail tab click restores the split layout", !!clickInfo && clickInfo.maximized === false && clickInfo.splitBack === 1 && clickInfo.railCount === 0, clicked.slice(0, 300));
  record("rail tab click activates the editor in its leaf", !!clickInfo && String(clickInfo.activeTab || "").includes("README"), clicked.slice(0, 300));

  // n2/n3: the git drawer opens a pane tab labeled gitchanges. The rail
  // button only toggles the drawer; the Changes view-toggle row inside the
  // drawer routes through HerdrGitUi.tab("changes") -> paneEnsureGitTab,
  // which pushes the git tab into the active (focused) leaf.
  const gitTab = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailGit");
    if (!btn) return "no-toggle";
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const changes = Array.from(document.querySelectorAll(".git-ui-view-toggle")).find((b) => /changes/i.test(b.textContent || ""));
    if (!changes) return "no-changes-toggle";
    changes.click();
    await new Promise((r) => setTimeout(r, 1500));
    const p = window.HerdrWorkspacePanes;
    const gitTabs = p.paneLeaves(p.paneRoot()).flatMap((l) => l.tabs).filter((t) => String(t).startsWith("git:"));
    const stripLabel = Array.from(document.querySelectorAll(".pane-tab")).map((t) => (t.textContent || "").trim()).filter((txt) => txt.toLowerCase().includes("git"));
    return JSON.stringify({ gitTabs: gitTabs.length, labels: stripLabel });
  })()`);
  let gitInfo = null;
  try { gitInfo = JSON.parse(gitTab); } catch { gitInfo = null; }
  record("git drawer opens a git pane tab", !!gitInfo && gitInfo.gitTabs >= 1, gitTab.slice(0, 300));
  record("git tab strip label reads gitchanges", !!gitInfo && (gitInfo.labels || []).some((l) => /gitchanges/i.test(l)), gitTab.slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeCrashReport(outPath, recorder, e);
  process.exit(1);
});