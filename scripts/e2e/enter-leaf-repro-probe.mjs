// Real-DOM reproduction probe for the zero-tab welcome-leaf Enter bug.
//
// Live bug: a user opens a workspace with the mouse through the real UI
// (sidebar Actions button -> palette -> open-workspace modal -> Create
// workspace). The palette close restores focus to the header Actions button,
// the modal then records that same still-visible button as its opener, and on
// success it restores focus to it again. The fresh workspace shows the
// welcome card ("Press Enter to open a terminal"), but the Enter press
// natively re-clicked that focused opener button instead of creating the
// first terminal: the palette reopened.
//
// Everything here is real mouse clicks and real Enter key events against the
// served bundle. No JS-level shortcuts: the point is the focus path the real
// UI takes.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9791";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8791/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/enter_repro_result.json`;

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
      if (node.scrollIntoView) node.scrollIntoView({ block: "center" });
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error(`no node for selector ${selector}`);
    await sleep(150);
    await clickAt(rect.x, rect.y);
  };
  const clickButtonById = (id) => clickCenter(`#${id}`);
  const waitFor = async (expression, label, timeoutMs = 30000) => {
    const got = await evalExpr(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        let ok = false;
        try { ok = !!(${expression}); } catch (e) { ok = false; }
        if (ok) { resolve("ok"); return; }
        if (Date.now() - started > ${timeoutMs}) resolve("timeout");
        else setTimeout(check, 400);
      };
      check();
    })`);
    record(label, got === "ok", `got ${got}`);
    return got === "ok";
  };

  // Boot: dashboard visible, nothing open yet.
  await waitFor(
    `document.getElementById("projectDashboard") && !document.getElementById("projectDashboard").hidden && typeof createWorkspaceFromSmartModal === "function"`,
    "app booted to the project dashboard",
  );

  // Step 1: mouse click the sidebar header's Actions button. Focus lands on
  // that button; the palette opens on top. Unlike the dashboard card, this
  // button stays in the DOM after the workspace view replaces the dashboard,
  // so focus restoration can actually land on it.
  await clickButtonById("headerActionsButton");
  await sleep(400);
  await waitFor(
    `document.getElementById("searchPalette") && document.getElementById("searchPalette").style.display === "grid"`,
    "sidebar Actions button click opens the search palette",
  );

  // Step 2: mouse click the palette's open-workspace row (a real button in
  // the results list). The palette closes (focus restores to the Actions
  // card) and the open-workspace modal opens.
  const clickedRow = await evalExpr(`(() => {
    const rows = [...document.querySelectorAll("#searchPaletteResults button, #searchPaletteResults [role='option'], #searchPaletteResults .search-result")]
      .filter((row) => /open workspace/i.test(row.textContent || ""));
    return rows.length || 0;
  })()`);
  record("palette lists the open-workspace action row", clickedRow > 0, `rows=${clickedRow}`);
  const rowRect = await evalExpr(`(() => {
    const rows = [...document.querySelectorAll("#searchPaletteResults button, #searchPaletteResults [role='option'], #searchPaletteResults .search-result")]
      .filter((row) => /open workspace/i.test(row.textContent || ""));
    const row = rows[0];
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rowRect) throw new Error("no open-workspace row rect");
  await clickAt(rowRect.x, rowRect.y);
  await sleep(400);
  await waitFor(
    `document.getElementById("worktreeOpenModal") && document.getElementById("worktreeOpenModal").style.display === "grid"`,
    "palette open-workspace row click opens the modal",
  );

  // Step 3: type the repo path and label with real key events into the modal
  // inputs, then mouse click the Create workspace button. The click focuses
  // that submit button; on success the modal closes and focus restores to
  // its opener chain (modal opener -> palette opener -> dashboard card).
  await evalExpr(`(() => {
    document.getElementById("worktreeDiscoverPath").value = ${JSON.stringify(REPO)};
    document.getElementById("worktreeWorkspaceLabel").value = "enter-repro";
    return true;
  })()`);
  await clickButtonById("worktreeWorkspaceSubmit");
  await sleep(800);

  // Wait until the fresh zero-tab workspace is showing the welcome card.
  await waitFor(
    `state.ws && !state.tab && document.getElementById("workspaceEmptyLeaf") && !document.getElementById("workspaceEmptyLeaf").hidden`,
    "fresh workspace shows the welcome leaf",
  );

  // What has focus now? This is the heart of the bug: the opener chain.
  const focusState = await evalExpr(`(() => {
    const active = document.activeElement;
    const leaf = document.getElementById("workspaceEmptyLeaf");
    return {
      tag: (active && active.tagName) || "",
      id: (active && active.id) || "",
      className: (active && active.className) || "",
      text: (active && (active.textContent || "").slice(0, 40)) || "",
      leafFocused: active === leaf || (leaf && leaf.contains(active)),
    };
  })()`);
  console.log("focus after workspace open:", JSON.stringify(focusState));

  // Step 4: press Enter the way the user does.
  await pressEnter();
  await sleep(2000);

  const after = await evalExpr(`(() => {
    const palette = document.getElementById("searchPalette");
    return {
      paletteOpen: !!palette && palette.style.display === "grid",
      modalOpen: !!document.getElementById("worktreeOpenModal") && document.getElementById("worktreeOpenModal").style.display === "grid",
      tab: state.tab || null,
      tabs: (state.tabs || []).length,
    };
  })()`);
  console.log("after Enter:", JSON.stringify(after));

  const terminalCreated = !!after.tab && after.tabs > 0;
  record(
    "Enter creates the first terminal (the advertised behavior)",
    terminalCreated,
    `paletteOpen=${after.paletteOpen} tab=${after.tab} tabs=${after.tabs}`,
  );
  record(
    "Enter does not reopen the actions palette (the bug)",
    !after.paletteOpen,
    `paletteOpen=${after.paletteOpen}`,
  );

  writeReport(outPath, recorder, { focusAfterOpen: focusState, afterEnter: after });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  console.error("probe crashed:", error);
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});