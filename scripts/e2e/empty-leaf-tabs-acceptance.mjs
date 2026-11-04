// Live acceptance for the empty-leaf card visibility against file/Git pane
// tabs. The zero-tab card ("Press Enter to open a terminal") must hide the
// moment a file or Git pane tab opens, stay hidden while any such tab is
// open in any pane, and come back only when the last one closes. The Enter
// shortcut must also refuse while such a tab is open, or a press on the
// empty pane body would mint a terminal behind the open file/Git view.
//
// Flow against the served app, all inside a zero-TERMINAL workspace so the
// card's !state.tab leg never fires early: create a fixture workspace
// through the real open flow (card visible), open/close a file (hide,
// restore), open Git log (hide), Enter guard (no terminal), close (card
// back), split (card stays in an empty split), open the file into the
// fresh leaf (hide), close it (split collapses, card back), keyboard-close
// a Git tab through the focused strip ✕, two Git views (close one, card
// stays hidden), cross-workspace scoping (ws-2 card shows while ws-1 keeps
// a Git tab), return to ws-1 (card hides beside its Git tab), and finally
// Enter mints the first terminal (card hides for the terminal reason).
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
  const leafHiddenExpr = `(() => { const leaf = document.getElementById("workspaceEmptyLeaf"); return !leaf || leaf.hidden; })()`;

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
      resolve(${leafHiddenExpr} ? "hidden" : "visible");
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
      resolve(${leafHiddenExpr} ? "hidden" : "visible");
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

  // 6. Split-pane scoping, part one: a split with no real tabs keeps the
  // card (it mounts in the active leaf; the empty sibling strip still
  // offers New terminal).
  const splitPrep = await evalExpr(`new Promise(async (resolve) => {
    try {
      const panes = window.HerdrWorkspacePanes;
      const split = panes.splitPaneRight();
      await new Promise((r) => setTimeout(r, 200));
      const root = panes.paneRoot();
      resolve({
        split,
        leaves: panes.paneLeaves(root).length,
        shown: (() => { const leaf = document.getElementById("workspaceEmptyLeaf"); return leaf && !leaf.hidden; })(),
      });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "empty split keeps the card while no file or Git tab is open",
    !!splitPrep.split && splitPrep.leaves === 2 && splitPrep.shown,
    `split=${splitPrep.split} leaves=${splitPrep.leaves} shown=${splitPrep.shown} err=${splitPrep.err || "none"}`,
  );

  // 7. Split-pane scoping, part two: open the file into the fresh split
  // leaf (the split focused it), card hides; closing it empties that leaf
  // and the split collapses back to one leaf with the card restored.
  const splitFile = await evalExpr(`new Promise(async (resolve) => {
    try {
      await window.HerdrWorkspacePanes.openEditorTab("README.md");
      await new Promise((r) => setTimeout(r, 200));
      const panes = window.HerdrWorkspacePanes;
      resolve({ hidden: ${leafHiddenExpr} });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "file opened into the split leaf hides the card",
    splitFile.hidden === true,
    `hidden=${splitFile.hidden} err=${splitFile.err || "none"}`,
  );

  const splitClosed = await evalExpr(`new Promise(async (resolve) => {
    try {
      window.HerdrWorkspacePanes.closeEditorTabImmediate(encodeURIComponent("README.md"));
      await new Promise((r) => setTimeout(r, 200));
      const panes = window.HerdrWorkspacePanes;
      const root = panes.paneRoot();
      resolve({
        leaves: panes.paneLeaves(root).length,
        shown: (() => { const leaf = document.getElementById("workspaceEmptyLeaf"); return leaf && !leaf.hidden; })(),
      });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "closing the split leaf's only tab collapses to one leaf and restores the card",
    splitClosed.leaves === 1 && splitClosed.shown,
    `leaves=${splitClosed.leaves} shown=${splitClosed.shown} err=${splitClosed.err || "none"}`,
  );

  // 8. Keyboard strip close: focus the git tab's ✕ span (role=button,
  // tabindex=0) and press Enter; the delegated keydown must run the same
  // close path as the click, and the card must return.
  const kbClose = await evalExpr(`new Promise(async (resolve) => {
    try {
      await window.HerdrWorkspacePanes.openGitTab("log");
      await new Promise((r) => setTimeout(r, 200));
      const closeBtn = document.querySelector('.pane-tab.git .pane-tab-close');
      if (!closeBtn) { resolve("no-close-button"); return; }
      if (closeBtn.focus) closeBtn.focus();
      const focused = document.activeElement === closeBtn;
      resolve(focused ? "focused" : "focus-missed");
    } catch (e) { resolve("err:" + String(e && e.message ? e.message : e)); }
  })`);
  record("git tab close button focused via keyboard", kbClose === "focused", `got ${kbClose}`);

  await pressEnter();
  await sleep(500);
  const kbAfter = await evalExpr(`(() => ({
    gitOpen: window.HerdrWorkspacePanes.paneLeaves(window.HerdrWorkspacePanes.paneRoot()).some((leaf) => leaf.tabs.some((id) => id.startsWith("git:"))),
    shown: (() => { const leaf = document.getElementById("workspaceEmptyLeaf"); return leaf && !leaf.hidden; })(),
  }))()`);
  record(
    "Enter on the focused close button closes the git tab and restores the card",
    !kbAfter.gitOpen && kbAfter.shown,
    `gitOpen=${kbAfter.gitOpen} shown=${kbAfter.shown}`,
  );

  // 9. Two git views: closing one while the other stays open must keep the
  // card hidden (any-open-tab predicate, not last-action).
  const twoGit = await evalExpr(`new Promise(async (resolve) => {
    try {
      await window.HerdrWorkspacePanes.openGitTab("log");
      await window.HerdrWorkspacePanes.openGitTab("changes");
      await new Promise((r) => setTimeout(r, 300));
      window.HerdrWorkspacePanes.closeGitTabImmediate("log");
      await new Promise((r) => setTimeout(r, 200));
      const panes = window.HerdrWorkspacePanes;
      resolve({
        changesOpen: panes.paneLeaves(panes.paneRoot()).some((leaf) => leaf.tabs.includes("git:changes")),
        hidden: ${leafHiddenExpr},
      });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "closing one git view while changes stays open keeps the card hidden",
    twoGit.changesOpen && twoGit.hidden,
    `changesOpen=${twoGit.changesOpen} hidden=${twoGit.hidden} err=${twoGit.err || "none"}`,
  );

  // 10. Cross-workspace scoping: the predicate reads the CURRENT
  // workspace's pane tree. A second workspace with zero tabs must show its
  // own card even while workspace one still has the changes git tab open.
  const crossWs = await evalExpr(`new Promise(async (resolve) => {
    try {
      const ws1 = state.ws;
      runSearchAction("open-workspace");
      await new Promise((r) => setTimeout(r, 300));
      const pathInput = document.getElementById("worktreeDiscoverPath");
      if (pathInput) pathInput.value = ${JSON.stringify(REPO)};
      const labelInput = document.getElementById("worktreeWorkspaceLabel");
      if (labelInput) labelInput.value = "empty-leaf-ws2";
      await createWorkspaceFromSmartModal();
      await new Promise((r) => setTimeout(r, 800));
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve({
        ws1Id: ws1,
        wsChanged: state.ws && state.ws !== ws1,
        ws2Shown: leaf && !leaf.hidden,
      });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "second workspace shows its own card while ws-1 keeps a git tab open",
    crossWs.wsChanged && crossWs.ws2Shown,
    `wsChanged=${crossWs.wsChanged} ws2Shown=${crossWs.ws2Shown} err=${crossWs.err || "none"}`,
  );

  // Back on ws-1 the card must hide again: the changes git tab still lives
  // in ws-1's pane tree. Carry the ws-1 id across the eval boundary instead
  // of re-finding it by label: after ws-2 exists a label lookup can resolve
  // to the wrong row or none at all.
  const ws1Back = await evalExpr(`new Promise(async (resolve) => {
    try {
      const ws1 = ${JSON.stringify(String(crossWs.ws1Id || ""))};
      if (!ws1 || !(state.workspaces || []).some((w) => w.workspace_id === ws1)) {
        resolve({ err: "ws1-not-found" });
        return;
      }
      go(ws1, null, null);
      await new Promise((r) => setTimeout(r, 800));
      const panes = window.HerdrWorkspacePanes;
      resolve({
        changesOpen: panes.paneLeaves(panes.paneRoot()).some((leaf) => leaf.tabs.includes("git:changes")),
        hidden: ${leafHiddenExpr},
      });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record(
    "switching back to ws-1 hides the card beside its open git tab",
    ws1Back.changesOpen && ws1Back.hidden,
    `changesOpen=${ws1Back.changesOpen} hidden=${ws1Back.hidden} err=${ws1Back.err || "none"}`,
  );

  // 11. Close the last git tab on ws-1 and Enter mints the first terminal:
  // the card's own advertised action works once it is genuinely back.
  const finalState = await evalExpr(`new Promise(async (resolve) => {
    try {
      window.HerdrWorkspacePanes.closeGitTabImmediate("changes");
      await new Promise((r) => setTimeout(r, 200));
      const leaf = document.getElementById("workspaceEmptyLeaf");
      resolve({ shown: leaf && !leaf.hidden });
    } catch (e) { resolve({ err: String(e && e.message ? e.message : e) }); }
  })`);
  record("closing ws-1's last git view restores the card", finalState.shown === true, `shown=${finalState.shown} err=${finalState.err || "none"}`);

  await evalExpr(`(() => { const leaf = document.getElementById("workspaceEmptyLeaf"); if (leaf && leaf.focus) leaf.focus(); })()`);
  await pressEnter();
  await sleep(1500);
  const afterEnter = await evalExpr(`(() => ({
    tab: state.tab || null,
    tabs: (state.tabs || []).length,
    leafHidden: ${leafHiddenExpr},
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