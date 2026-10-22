// Live acceptance for the panel-name visibility fix: an agent running in
// workspace B must keep its named panel token in the agents list while the
// user is selected in workspace A, even though the snapshot bootstrap
// filters B's tab rows out of the payload.
//
// run-panel-name-e2e.sh boots the isolated server + headless Chrome; this
// driver creates two workspaces, adds a second tab to each, renames one tab
// per workspace through the real POST /api/tabs/{id}/rename route, then
// checks the real served bundle: the filtered snapshot carries
// tab_labels_by_id for every workspace, and the agents list row for the
// not-selected workspace still names its renamed panel.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9229";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const REPO = process.env.REPO;
const REPO_B = process.env.REPO_B;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/panel_name_e2e_result.json`;

if (!REPO || !REPO_B) {
  console.error("REPO and REPO_B must be set (use scripts/e2e/run-panel-name-e2e.sh)");
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
    await sleep(2500);
  };

  await reload();

  // Two workspaces, one per fixture repo, each with a shell tab in a pane.
  const makeWorkspace = async (cwd, label) => {
    const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(cwd)}, label: ${JSON.stringify(label)}})}).then((r) => r.json()).catch((e) => "err:" + e)`);
    const id = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
    if (!id) throw new Error(`no workspace_id for ${label}: ` + JSON.stringify(made).slice(0, 300));
    return id;
  };
  const wsA = await makeWorkspace(REPO, "panel-a");
  const wsB = await makeWorkspace(REPO_B, "panel-b");
  record("two workspaces created", true, `${wsA} ${wsB}`);

  const api = async (path, init) =>
    (await evalExpr(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init || {})}).then((r) => r.json()).catch((e) => "err:" + e)`));

  // Second tab per workspace (a single-panel workspace hides the token by
  // design), then rename one tab in each workspace through the real route.
  const tabA2 = await api("/api/tabs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: wsA }) });
  const tabB2 = await api("/api/tabs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: wsB }) });
  const tabA2Id = tabA2 && tabA2.result && tabA2.result.tab ? tabA2.result.tab.tab_id : null;
  const tabB2Id = tabB2 && tabB2.result && tabB2.result.tab ? tabB2.result.tab.tab_id : null;
  if (!tabA2Id || !tabB2Id) throw new Error("tab creation failed: " + JSON.stringify({ tabA2, tabB2 }).slice(0, 300));
  record("second tab created in each workspace", true, `${tabA2Id} ${tabB2Id}`);

  const renamedA = await api(`/api/tabs/${encodeURIComponent(tabA2Id)}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "alpha-build" }) });
  const renamedB = await api(`/api/tabs/${encodeURIComponent(tabB2Id)}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "beta-deploy" }) });
  record("tabs renamed through the API", !String(renamedA).startsWith("err") && !String(renamedB).startsWith("err"), `${JSON.stringify(renamedA).slice(0, 80)} ${JSON.stringify(renamedB).slice(0, 80)}`);

  // A fresh fixture has no agents (shell panes never report one), so the
  // agents DOM stays empty in this live run; the JS unit tests cover the
  // agent-row rendering with fixtures. What this run proves end to end is
  // the part the unit tests cannot: the real server derives and ships
  // tab_labels_by_id, the real served bundle stores it, and the exact
  // agentTabLabel code path renders the other workspace's panel name from
  // it while its tab row is filtered out.

  // Select workspace A and load the app through the real served bundle.
  await reload(`${APP_URL}session/default/workspace/${wsA}`);
  const loaded = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state && state.workspaces && state.workspaces.length && state.tabLabelsById) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("app loaded with tabLabelsById populated", loaded === "loaded" && typeof loaded === "string", `got ${loaded}`);
  if (loaded !== "loaded" || typeof loaded !== "string") throw new Error("app never populated tabLabelsById: " + JSON.stringify(loaded).slice(0, 120));

  // Server payload check: the filtered snapshot still labels B's tab.
  const snap = await api(`/api/session-snapshot?workspace_id=${encodeURIComponent(wsA)}`);
  const snapOk = snap && snap.result && snap.result.tab_labels_by_id;
  const bLabeled = snapOk && snap.result.tab_labels_by_id[tabB2Id] === "beta-deploy";
  const aLabeled = snapOk && snap.result.tab_labels_by_id[tabA2Id] === "alpha-build";
  const tabsFiltered = snapOk && (snap.result.snapshot || snap.result).tabs &&
    (snap.result.snapshot || snap.result).tabs.every((t) => t.workspace_id === wsA);
  record("filtered snapshot keeps both workspaces' tab labels", Boolean(bLabeled && aLabeled), JSON.stringify(snapOk ? snap.result.tab_labels_by_id : snap).slice(0, 200));
  record("filtered snapshot still drops B's tab rows", Boolean(tabsFiltered), `tabs all wsA: ${tabsFiltered}`);

  // Client state check: the map landed and the synthetic-row fallback works.
  const clientCheck = await evalExpr(`(() => {
    const map = state.tabLabelsById || {};
    return JSON.stringify({
      a: map[${JSON.stringify(tabA2Id)}],
      b: map[${JSON.stringify(tabB2Id)}],
      allTabsIds: (state.allTabs || []).map((t) => t.tab_id),
      bTabRowPresent: (state.allTabs || []).some((t) => t.tab_id === ${JSON.stringify(tabB2Id)}),
    });
  })()`);
  const client = JSON.parse(clientCheck);
  record("client holds B's label though its tab row is filtered out", client.b === "beta-deploy" && client.bTabRowPresent === false, clientCheck.slice(0, 250));

  // Render check through the same code path the agents list uses:
  // agentTabLabel with the fallback row must return the custom name.
  const renderCheck = await evalExpr(`(() => {
    const t = { workspace_id: ${JSON.stringify(wsB)}, label: state.tabLabelsById[${JSON.stringify(tabB2Id)}] };
    const counts = new Map([[${JSON.stringify(wsB)}, 2]]);
    return agentTabLabel(${JSON.stringify(wsB)}, t, counts);
  })()`);
  record("agentTabLabel renders B's panel name from the fallback", renderCheck === "beta-deploy", `got ${renderCheck}`);

  // Gate check: the first tabs keep their default "Shell" label, so the
  // synthetic-row fallback must skip them (the map carries no tab number;
  // a synthetic row would render each as a wrong #1). The named panel in
  // B still gets its token through the same renderAgentRow call.
  const defaultGate = await evalExpr(`(() => {
    const counts = new Map([[${JSON.stringify(wsB)}, 2]]);
    const row = () => renderAgentRow(
      { workspace_id: ${JSON.stringify(wsB)}, tab_id: "gate-tab", pane_id: "gate-pane", agent_status: "idle", name: "agent" },
      {},
      {},
      counts,
    );
    // renderAgentRow reads the map by agent tab_id; set it per case.
    const shell = (() => { state.tabLabelsById = { "gate-tab": "Shell" }; return row(); })();
    const named = (() => { state.tabLabelsById = { "gate-tab": "beta-deploy" }; return row(); })();
    return JSON.stringify({ shellHasToken: shell.includes("agent-panel"), namedHasToken: named.includes("beta-deploy") });
  })()`);
  const gate = JSON.parse(defaultGate);
  record("default-label foreign panel gets no synthetic token", gate.shellHasToken === false && gate.namedHasToken === true, defaultGate);
  // Restore the real map for the switch check below.
  await reload(`${APP_URL}session/default/workspace/${wsB}/tab/${encodeURIComponent(tabB2Id)}`);
  const loadedB = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (state && state.workspaces && state.workspaces.length && state.tabLabelsById) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  const renderB = await evalExpr(`(() => {
    const map = state.tabLabelsById || {};
    return JSON.stringify({ a: map[${JSON.stringify(tabA2Id)}], b: map[${JSON.stringify(tabB2Id)}] });
  })()`);
  record("switching to B keeps A's label too", loadedB === "loaded" && typeof loadedB === "string" && JSON.parse(renderB).a === "alpha-build", `${loadedB} ${renderB}`);

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  console.error("driver crashed:", error);
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});
