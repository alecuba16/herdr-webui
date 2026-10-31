// Real-DOM acceptance for the zero-tab welcome leaf Enter flow.
//
// Live bug: opening a fresh workspace from the open-workspace modal (or the
// dashboard Actions card) restores focus to the opener button when the modal
// closes. The empty-leaf card says "Press Enter to open a terminal", but the
// Enter press natively re-clicked the focused opener button instead: the
// header Actions button reopened the search palette instead of creating the
// first terminal.
//
// This probe replays the real flow against the served app with real key
// events: click the dashboard's Actions-menu card (the palette opens), run
// its open-workspace action, land on the fresh zero-tab workspace, then press
// Enter and verify a terminal tab exists and the palette stays closed.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9791";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8791/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/enter_fix_e2e_result.json`;

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
  const clickAt = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const clickCenter = async (selector) => {
    const rect = await evalExpr(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error(`no node for selector ${selector}`);
    await clickAt(rect.x, rect.y);
  };

  // Wait for the app shell to be up (dashboard visible, no workspaces yet).
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

  // 1. Click the dashboard's Actions-menu card: the search palette opens and
  // focus moves into it (same path a user takes to open a workspace).
  await clickCenter(".project-dashboard-action:not(.primary)");
  await sleep(400);
  let paletteOpen = await evalExpr(`(() => {
    const modal = document.getElementById("searchPalette");
    return !!modal && modal.style.display === "grid";
  })()`);
  record("dashboard Actions card opens the search palette", !!paletteOpen, "");

  // 2. Run the palette's open-workspace action on the probe repo through the
  // real action row, then let the palette close and the workspace land.
  const opened = await evalExpr(`new Promise(async (resolve) => {
    try {
      // Seed the discovery path so the modal is ready to create instantly.
      const pathInput = document.getElementById("worktreeDiscoverPath");
      // open-workspace action opens the modal seeded from the default folder.
      runSearchAction("open-workspace");
      await new Promise((r) => setTimeout(r, 300));
      if (pathInput) pathInput.value = ${JSON.stringify(REPO)};
      const labelInput = document.getElementById("worktreeWorkspaceLabel");
      if (labelInput) labelInput.value = "enter-fix-probe";
      createWorkspaceFromSmartModal().then(() => resolve("opened")).catch((e) => resolve("err:" + e));
    } catch (e) { resolve("err:" + e); }
  })`);
  record("workspace created through the open flow", opened === "opened", `got ${opened}`);

  // Wait until the zero-tab leaf is on screen and focus has settled.
  const leafShown = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const leaf = document.getElementById("workspaceEmptyLeaf");
      const shown = leaf && !leaf.hidden && state.ws && !state.tab;
      if (shown) {
        resolve({
          shown: true,
          active: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "none",
        });
      } else if (Date.now() - started > 30000) resolve({ shown: false, active: "timeout" });
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("zero-tab welcome leaf is showing", !!leafShown.shown, `active=${leafShown.active}`);

  // The modal closed before the workspace POST finished, so focus sits on the
  // dashboard Actions card (the opener). With the fix, the leaf claims focus
  // from that stale opener button.
  const activeAfter = await evalExpr(`(() => {
    const leaf = document.getElementById("workspaceEmptyLeaf");
    const active = document.activeElement;
    return {
      leafFocused: !!active && (active === leaf || leaf.contains(active)),
      activeId: (active && active.id) || "",
      activeTag: (active && active.tagName) || "",
    };
  })()`);
  record(
    "leaf claimed focus from the stale opener button",
    activeAfter.leafFocused,
    `active=${activeAfter.activeTag}#${activeAfter.activeId}`,
  );

  // 3. Press Enter: with the fix this creates the first terminal tab; on the
  // bug it re-clicked the focused opener button and reopened the palette.
  await pressEnter();
  await sleep(1500);

  const afterEnter = await evalExpr(`(() => {
    const palette = document.getElementById("searchPalette");
    return {
      paletteOpen: !!palette && palette.style.display === "grid",
      tab: state.tab || null,
      tabs: (state.tabs || []).length,
      activeTag: (document.activeElement && document.activeElement.tagName) || "",
    };
  })()`);
  record(
    "Enter creates the first terminal, palette stays closed",
    !afterEnter.paletteOpen && !!afterEnter.tab,
    `paletteOpen=${afterEnter.paletteOpen} tab=${afterEnter.tab} tabs=${afterEnter.tabs}`,
  );

  const leafHidden = await evalExpr(`(() => {
    const leaf = document.getElementById("workspaceEmptyLeaf");
    return !leaf || leaf.hidden;
  })()`);
  record("welcome leaf hides once the terminal exists", !!leafHidden, "");

  // 4. Regression guard: with the palette open on purpose, Enter must run the
  // palette selection, never mint a terminal behind the modal.
  await evalExpr(`openSearchPalette()`);
  await sleep(300);
  const paletteReopened = await evalExpr(`(() => {
    const modal = document.getElementById("searchPalette");
    return !!modal && modal.style.display === "grid";
  })()`);
  record("palette reopens on demand", !!paletteReopened, "");
  await pressEnter();
  await sleep(600);
  const afterPaletteEnter = await evalExpr(`(() => {
    const modal = document.getElementById("searchPalette");
    return {
      paletteOpen: !!modal && modal.style.display === "grid",
      tabs: (state.tabs || []).length,
    };
  })()`);
  record(
    "Enter inside the palette does not mint terminals behind the modal",
    afterPaletteEnter.tabs === afterEnter.tabs,
    `tabs=${afterPaletteEnter.tabs} paletteOpen=${afterPaletteEnter.paletteOpen}`,
  );

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  console.error("probe crashed:", error);
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});