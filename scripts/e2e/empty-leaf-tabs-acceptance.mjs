// Live acceptance for the empty-leaf card visibility against file/Git pane
// tabs. The zero-tab card ("Press Enter to open a terminal") must hide the
// moment a file or Git pane tab opens, stay hidden while any such tab is
// open in any pane, and come back only when the last one closes. The Enter
// shortcut must also refuse while such a tab is open, or a press on the
// empty pane body would mint a terminal behind the open file/Git view.
//
// Flow against the served app: create a fixture repo workspace through the
// real open flow (zero tabs -> card visible), open a file through the real
// file browser (card hides), close it (card returns), open Git log (card
// hides), press Enter in the pane column (no terminal minted), close the
// Git tab (card returns), then press Enter (first terminal mints).
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9791";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8791/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/empty_leaf_tabs_e2e_result.json`;

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };
  const keyDown = (code, key, keyCode) =>
    cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: keyCode });
  const keyUp = (code, key, keyCode) =>
    cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: keyCode });
  const pressEnter = async () => {
    await keyDown("Enter", "Enter", 13);
    await keyUp("Enter", "Enter", 13);
  };

  // Wait for the app shell: dashboard visible, actions registry up.
  const boot = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const dashboard = document.getElementById("projectDashboard");
      const ready = dashboard && !dashboard.hidden && typeof runSearchAction === "function";
      if (ready) { resolve("ready"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("app booted to the project dashboard", boot === "ready", `got ${boot}`);

  // Create the fixture workspace through the real open flow.
  const opened = await evalExpr(`new Promise(async (resolve) => {
    try {
      runSearchAction("open-workspace");
      await new Promise((r) => setTimeout(r, 300));
      const pathInput = document.getElementById("worktreeDiscoverPath");
      if (pathInput) pathInput.value = ${JSON.stringify(REPO)};
      const labelInput = document.getElementById("worktreeWorkspaceLabel");
      if (labelInput) labelInput.value = "empty-leaf-tabs-probe";
      createWorkspaceFromSmartModal().then(() => resolve("opened")).catch((e) => resolve("err:" + e));
    } catch (e) { resolve("err:" + e); }
  })`);
  record("workspace created through the open flow", opened === "opened", `got ${opened}`);

  const leafShown = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const leaf = document.getElementById("workspaceEmptyLeaf");
      const shown = leaf && !leaf.hidden && state.ws && !state.tab;
      if (shown) resolve("shown");
      else if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("zero-tab welcome leaf is showing", leafShown === "shown", `got ${leafShown}`);

  // 1. Open a file through the real file browser path: the pane tab appears
  // and the card must hide immediately (same tick, not next poll).
  const fileOpened = await evalExpr(`new Promise(async (resolve) => {
    try {
      await window.HerdrWorkspacePanes.openEditorTab("README.md");
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve(leaf && leaf.hidden ? "hidden" : "visible");
    } catch (e) { resolve("err:" + (e && e.message ? e.message : e)); }
  })`);
  record("opening a file hides the welcome leaf immediately", fileOpened === "hidden", `got ${fileOpened}`);

  // The editor tab must actually exist in the pane tree (not a fluke of the
  // hidden attribute): verify through the exported pane helpers.
  const editorTabLive = await evalExpr(`(() => {
    const panes = window.HerdrWorkspacePanes;
    const root = panes.paneRoot();
    return {
      hasTab: panes.paneLeaves(root).some((leaf) => leaf.tabs.includes("editor:README.md")),
      active: state.tab || null,
    };
  })()`);
  record("editor pane tab exists in the tree", editorTabLive.hasTab, `active=${editorTabLive.active}`);

  // 2. Close the file tab through the immediate close path (same one the
  // strip's confirm path lands on): the card must return.
  const fileClosed = await evalExpr(`new Promise(async (resolve) => {
    try {
      window.HerdrWorkspacePanes.closeEditorTabImmediate(encodeURIComponent("README.md"));
      await new Promise((r) => setTimeout(r, 100));
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve(leaf && !leaf.hidden ? "shown" : "hidden");
    } catch (e) { resolve("err:" + (e && e.message ? e.message : e)); }
  })`);
  record("closing the last file restores the welcome leaf", fileClosed === "shown", `got ${fileClosed}`);

  // 3. Open Git log through the real git_ui open path: card hides again.
  const gitOpened = await evalExpr(`new Promise(async (resolve) => {
    try {
      await window.HerdrWorkspacePanes.openGitTab("log");
      await new Promise((r) => setTimeout(r, 200));
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve(leaf && leaf.hidden ? "hidden" : "visible");
    } catch (e) { resolve("err:" + (e && e.message ? e.message : e)); }
  })`);
  record("opening Git log hides the welcome leaf", gitOpened === "hidden", `got ${gitOpened}`);

  // 4. Enter guard: with the Git tab open, Enter in the pane column must
  // NOT mint a terminal behind the Git view.
  const preEnter = await evalExpr(`(() => ({ tabs: (state.tabs || []).length }))()`);
  // Focus the pane column body so the keydown target sits in scope.
  await evalExpr(`document.getElementById("workspacePanes").focus && document.getElementById("workspacePanes").focus()`);
  await evalExpr(`(() => { document.body.focus ? document.body.focus() : null; })()`);
  await pressEnter();
  await sleep(800);
  const postEnter = await evalExpr(`(() => ({
    tabs: (state.tabs || []).length,
    gitOpen: window.HerdrWorkspacePanes.paneLeaves(window.HerdrWorkspacePanes.paneRoot()).some((leaf) => leaf.tabs.some((id) => id.startsWith("git:"))),
  }))()`);
  record(
    "Enter with an open Git tab does not mint a terminal",
    postEnter.tabs === preEnter.tabs && postEnter.gitOpen,
    `tabs ${preEnter.tabs} -> ${postEnter.tabs}, gitOpen=${postEnter.gitOpen}`,
  );

  // 5. Close the Git tab: the card returns.
  const gitClosed = await evalExpr(`new Promise(async (resolve) => {
    try {
      window.HerdrWorkspacePanes.closeGitTabImmediate("log");
      await new Promise((r) => setTimeout(r, 100));
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve(leaf && !leaf.hidden ? "shown" : "hidden");
    } catch (e) { resolve("err:" + (e && e.message ? e.message : e)); }
  })`);
  record("closing the last Git view restores the welcome leaf", gitClosed === "shown", `got ${gitClosed}`);

  // 6. Enter now works again: the first terminal mints and the card hides.
  await evalExpr(`(() => { const leaf = document.getElementById("workspaceEmptyLeaf"); if (leaf && leaf.focus) leaf.focus(); })()`);
  await pressEnter();
  await sleep(1500);
  const afterEnter = await evalExpr(`(() => ({
    tab: state.tab || null,
    tabs: (state.tabs || []).length,
    leafHidden: (() => { const leaf = document.getElementById("workspaceEmptyLeaf"); return !leaf || leaf.hidden; })(),
  }))()`);
  record(
    "Enter after the last close mints the first terminal",
    !!afterEnter.tab && afterEnter.tabs > 0 && afterEnter.leafHidden,
    `tab=${afterEnter.tab} tabs=${afterEnter.tabs} leafHidden=${afterEnter.leafHidden}`,
  );

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  console.error("probe crashed:", error);
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});