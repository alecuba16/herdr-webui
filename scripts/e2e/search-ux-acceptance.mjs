// Real-DOM acceptance for the search-UX batch (update-windows):
//   n1  the right rail content-search results show an inline loading row
//       while a search runs (also above stale results during a refine),
//   n2  "Open full file" on a content hit opens a pane-strip editor tab
//       through the same funnel as a file-explorer tree click,
//   n3  Cmd/Ctrl+F opens in-file find when an editor is open, otherwise
//       opens and focuses the right rail search panel input.
//
// Drives the real served bundle over CDP (run-search-ux-e2e.sh boots the
// isolated server + headless Chrome). The mid-search window for n1 is
// deterministic because CDP Fetch pauses the content-search response.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9226";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/search_ux_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-search-ux-e2e.sh)");
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

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "").slice(0, 400)}`);
    return r.result.value;
  };

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  // Real keyboard chord through CDP input so the window keydown capture
  // runs exactly as it does for a human (modifiers:4 = Meta, Cmd on mac).
  const pressFind = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, windowsVirtualKeyCode: 70, key: "f", code: "KeyF" });
    await sleep(80);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, windowsVirtualKeyCode: 70, key: "f", code: "KeyF" });
    await sleep(600);
  };

  await reload();

  // Workspace on the fixture repo, then land on its route.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "search-ux-e2e"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
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

  // ---------- n3a: Cmd+F with no editor opens the right rail panel ----
  // No file is open and focus is not inside an editor, so the shortcut
  // falls through to the right rail search panel.
  await pressFind();
  const focusInfo = await evalExpr(`(() => {
    const panel = document.getElementById("searchPanel");
    const input = document.getElementById("searchPanelInput");
    const active = document.activeElement;
    return JSON.stringify({
      hosted: !!(panel && panel.parentNode && String(panel.parentNode.id || "") === "rightSidebarContent"),
      railCollapsed: window.HerdrRightSidebar ? !!window.HerdrRightSidebar.collapsed() : null,
      focused: !!(input && active === input),
      paletteOpen: (() => { const p = document.getElementById("searchPalette"); return !!(p && p.style && p.style.display && p.style.display !== "none"); })(),
    });
  })()`);
  let n3a = null;
  try { n3a = JSON.parse(focusInfo); } catch { n3a = null; }
  record("Cmd+F opens the right rail search panel", !!n3a && n3a.hosted === true && n3a.railCollapsed === false, focusInfo.slice(0, 300));
  record("Cmd+F focuses the panel search input", !!n3a && n3a.focused === true, focusInfo.slice(0, 300));
  record("Cmd+F leaves the search palette closed", !!n3a && n3a.paletteOpen === false, focusInfo.slice(0, 300));

  // ---------- n1: loading row mid-search, also above stale results -----
  // Pause the content-search response via CDP Fetch; the panel keeps its
  // loading state until we fulfill, so the mid-search DOM is stable.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/file-browser/content-search*", requestStage: "Response" }] });
  let pausedRequestId = null;
  cdp.on("Fetch.requestPaused", (params) => { pausedRequestId = params.requestId; });

  const typeIntoPanel = async (text) => {
    await evalExpr(`(() => {
      const input = document.getElementById("searchPanelInput");
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`);
  };

  const typeIntoMobileSearch = async (text) => {
    await evalExpr(`(() => {
      const input = document.getElementById("mobileSearchInput");
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`);
  };

  const waitForPause = async (timeoutMs = 10000) => {
    let waited = 0;
    while (!pausedRequestId && waited < timeoutMs) { await sleep(150); waited += 150; }
    return pausedRequestId;
  };

  const searchPayload = (files) => Buffer.from(JSON.stringify({
    root: REPO,
    path: "",
    query: "needle",
    files,
    total_files: files.length,
    total_matches: files.reduce((sum, f) => sum + Number(f.match_count || 0), 0),
    visited: 3,
    truncated: false,
  })).toString("base64");

  const matchFile = {
    path: "README.md",
    name: "README.md",
    size: 74,
    hash: "e2e",
    match_count: 1,
    matches: [{ match_id: "m1", line: 3, text: "A needle line so content search finds this file.", match_start: 2, match_end: 8, before: [], after: [] }],
    chunks: [{ start: 1, end: 3, match_ids: ["m1"], rows: [{ line: 3, matched: true, match_id: "m1", highlight_html: "A <mark class=\"herdr-content-search-hit\">needle</mark> line so content search finds this file." }] }],
    truncated: false,
  };

  await typeIntoPanel("needle");
  const pause1 = await waitForPause();
  record("content-search request reached the pause", !!pause1, pause1 || "timeout");

  const midInfo = await evalExpr(`(() => {
    const results = document.getElementById("searchPanelResults");
    if (!results) return "no-results";
    return JSON.stringify({
      loadingRow: !!results.querySelector(".herdr-content-search-loading"),
      panelOpen: !!(window.HerdrSearchPanel && window.HerdrSearchPanel.isOpen && window.HerdrSearchPanel.isOpen()),
    });
  })()`);
  let mid = null;
  try { mid = JSON.parse(midInfo); } catch { mid = null; }
  record("loading row renders mid-search", !!mid && mid.loadingRow === true, String(midInfo).slice(0, 300));

  // Release: first query resolves with the README hit.
  if (pause1) {
    await cdp.send("Fetch.fulfillRequest", {
      requestId: pause1,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: searchPayload([matchFile]),
    });
    pausedRequestId = null;
  }
  await sleep(1200);

  const doneInfo = await evalExpr(`(() => {
    const results = document.getElementById("searchPanelResults");
    if (!results) return "no-results";
    return JSON.stringify({
      loadingRow: !!results.querySelector(".herdr-content-search-loading"),
      hitFile: !!Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || "")),
    });
  })()`);
  let done = null;
  try { done = JSON.parse(doneInfo); } catch { done = null; }
  record("loading row disappears after the search settles", !!done && done.loadingRow === false, String(doneInfo).slice(0, 300));
  record("content results render the fixture file", !!done && done.hitFile === true, String(doneInfo).slice(0, 300));

  // Refine while results are visible: stale results stay, loading row on top.
  await typeIntoPanel("needle2");
  const pause2 = await waitForPause();
  const refineInfo = await evalExpr(`(() => {
    const results = document.getElementById("searchPanelResults");
    if (!results) return "no-results";
    return JSON.stringify({
      loadingRow: !!results.querySelector(".herdr-content-search-loading"),
      staleStillRendered: !!Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || "")),
    });
  })()`);
  let refine = null;
  try { refine = JSON.parse(refineInfo); } catch { refine = null; }
  record("refined query keeps stale results visible", !!refine && refine.staleStillRendered === true, String(refineInfo).slice(0, 300));
  record("loading row renders above stale results", !!refine && refine.loadingRow === true, String(refineInfo).slice(0, 300));

  // Release the refine request with zero results and drop the pause.
  if (pause2) {
    await cdp.send("Fetch.fulfillRequest", {
      requestId: pause2,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: searchPayload([]),
    });
    pausedRequestId = null;
  }
  await cdp.send("Fetch.disable").catch(() => {});
  await sleep(800);

  // ---------- n2: "Open full file" opens a pane-strip editor tab --------
  // Re-run the first query against the real backend, expand the file row,
  // then click the real "Open full file" button.
  await typeIntoPanel("needle");
  await sleep(1500);
  const opened = await evalExpr(`(async () => {
    const results = document.getElementById("searchPanelResults");
    if (!results) return "no-results";
    const head = Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || ""));
    if (!head) return "no-file-head";
    head.click();
    await new Promise((r) => setTimeout(r, 400));
    const section = head.closest(".herdr-content-search-file");
    const actions = section && section.querySelector(".herdr-content-search-file-actions");
    if (!actions) return "no-actions";
    const btn = Array.from(actions.querySelectorAll("button")).find((b) => /open full file/i.test(b.textContent || ""));
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 1800));
    const p = window.HerdrWorkspacePanes;
    const tabs = p ? p.paneLeaves(p.paneRoot()).flatMap((l) => l.tabs) : [];
    const editor = !!document.querySelector(".pane-editor-container .herdr-editor");
    return JSON.stringify({ tabs, editor });
  })()`);
  let openInfo = null;
  try { openInfo = JSON.parse(opened); } catch { openInfo = null; }
  record("Open full file creates an editor tab in the pane strip", !!openInfo && (openInfo.tabs || []).some((t) => String(t).includes("README")), String(opened).slice(0, 300));
  record("Open full file mounts the editor container", !!openInfo && openInfo.editor === true, String(opened).slice(0, 300));

  // ---------- n3b: Cmd+F inside the open editor opens in-file find -----
  // The same chord dispatched at the editor node: the global handler
  // declines (editor target) and the editor's own capture handler opens
  // the find toolbar.
  await evalExpr(`(() => {
    const node = document.querySelector(".pane-editor-container .herdr-editor");
    if (!node) return "no-editor";
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true, cancelable: true }));
    return "sent";
  })()`);
  await sleep(700);
  const findInfo = await evalExpr(`(() => {
    const toolbar = document.querySelector(".pane-editor-container .herdr-editor-find");
    return JSON.stringify({
      visible: !!(toolbar && !toolbar.hidden),
      queryFocused: !!(toolbar && toolbar.querySelector(".herdr-editor-find-query") === document.activeElement),
    });
  })()`);
  let find = null;
  try { find = JSON.parse(findInfo); } catch { find = null; }
  record("Cmd+F in the editor reveals the find toolbar", !!find && find.visible === true, String(findInfo).slice(0, 300));
  record("Cmd+F in the editor focuses the find query input", !!find && find.queryFocused === true, String(findInfo).slice(0, 300));

  // ---------- mobile layout: shared renderer surfaces + open flow -----
  // The loading row lives in the shared renderer and CSS, and mobile has
  // no pane strip or global Cmd/Ctrl+F, so the mobile phase checks the
  // search sheet: loading row mid-search, stale results kept during a
  // refine, and "Open full file" opening the file view on the Files
  // screen.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalExpr(`localStorage.setItem('herdr-web-layout', 'mobile')`);
  await reload(`${APP_URL}session/default/workspace/${wsId}`);
  await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (document.querySelector('.mobile-nav')) { resolve("mobile"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);

  const mobileOpened = await evalExpr(`(async () => {
    const nav = document.querySelector('.mobile-nav button[data-screen="search"]');
    if (!nav) return "no-nav";
    nav.click();
    await new Promise((r) => setTimeout(r, 600));
    const sheet = document.getElementById("mobileSearchSheet");
    const input = document.getElementById("mobileSearchInput");
    if (!sheet || sheet.hidden) return "sheet-closed";
    if (!input || document.activeElement !== input) return "input-not-focused";
    return "open";
  })()`);
  record("mobile search sheet opens focused", mobileOpened === "open", `got ${mobileOpened}`);

  // Hold the content-search response again for the deterministic window.
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/file-browser/content-search*", requestStage: "Response" }] });
  pausedRequestId = null;
  await typeIntoMobileSearch("needle");
  const mobilePause = await waitForPause();
  const mobileMidInfo = await evalExpr(`(() => {
    const results = document.getElementById("mobileSearchResults");
    if (!results) return "no-results";
    return JSON.stringify({ loadingRow: !!results.querySelector(".herdr-content-search-loading") });
  })()`);
  let mobileMid = null;
  try { mobileMid = JSON.parse(mobileMidInfo); } catch { mobileMid = null; }
  record("mobile loading row renders mid-search", !!mobileMid && mobileMid.loadingRow === true, String(mobileMidInfo).slice(0, 300));
  if (mobilePause) {
    await cdp.send("Fetch.fulfillRequest", {
      requestId: mobilePause,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: searchPayload([matchFile]),
    });
    pausedRequestId = null;
  }
  await sleep(1200);

  const mobileSettledInfo = await evalExpr(`(() => {
    const results = document.getElementById("mobileSearchResults");
    if (!results) return "no-results";
    return JSON.stringify({
      loadingRow: !!results.querySelector(".herdr-content-search-loading"),
      hitFile: !!Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || "")),
    });
  })()`);
  let mobileSettled = null;
  try { mobileSettled = JSON.parse(mobileSettledInfo); } catch { mobileSettled = null; }
  record("mobile loading row disappears after settle", !!mobileSettled && mobileSettled.loadingRow === false, String(mobileSettledInfo).slice(0, 300));
  record("mobile content results render the fixture file", !!mobileSettled && mobileSettled.hitFile === true, String(mobileSettledInfo).slice(0, 300));

  // Refine with the pause still enabled: stale results stay + loading row.
  pausedRequestId = null;
  await typeIntoMobileSearch("needle2");
  const mobileRefinePause = await waitForPause();
  const mobileRefineInfo = await evalExpr(`(() => {
    const results = document.getElementById("mobileSearchResults");
    if (!results) return "no-results";
    return JSON.stringify({
      loadingRow: !!results.querySelector(".herdr-content-search-loading"),
      staleStillRendered: !!Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || "")),
    });
  })()`);
  let mobileRefine = null;
  try { mobileRefine = JSON.parse(mobileRefineInfo); } catch { mobileRefine = null; }
  record("mobile refined query keeps stale results", !!mobileRefine && mobileRefine.staleStillRendered === true, String(mobileRefineInfo).slice(0, 300));
  record("mobile loading row renders above stale results", !!mobileRefine && mobileRefine.loadingRow === true, String(mobileRefineInfo).slice(0, 300));
  if (mobileRefinePause) {
    await cdp.send("Fetch.fulfillRequest", {
      requestId: mobileRefinePause,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: searchPayload([]),
    });
    pausedRequestId = null;
  }
  await cdp.send("Fetch.disable").catch(() => {});
  await sleep(800);

  // Re-run the first query for real, then "Open full file" opens the
  // Files screen with the file loaded (the mobile analog of n2).
  await typeIntoMobileSearch("needle");
  await sleep(1500);
  const mobileFileOpened = await evalExpr(`(async () => {
    const results = document.getElementById("mobileSearchResults");
    if (!results) return "no-results";
    const head = Array.from(results.querySelectorAll(".herdr-content-search-file-head")).find((n) => /README/i.test(n.textContent || ""));
    if (!head) return "no-file-head";
    head.click();
    await new Promise((r) => setTimeout(r, 400));
    const section = head.closest(".herdr-content-search-file");
    const actions = section && section.querySelector(".herdr-content-search-file-actions");
    if (!actions) return "no-actions";
    const btn = Array.from(actions.querySelectorAll("button")).find((b) => /open full file/i.test(b.textContent || ""));
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 2200));
    // The file view renders the Back row + #mobileFilePreview; the tree
    // view renders "+ File" instead, so the preview mount is the marker.
    const filesSection = document.querySelector(".mobile-files");
    const preview = document.getElementById("mobileFilePreview");
    const back = filesSection ? Array.from(filesSection.querySelectorAll(".mobile-btn")).find((b) => /back/i.test(b.textContent || "")) : null;
    const errorNode = filesSection ? filesSection.querySelector(".mobile-error") : null;
    return JSON.stringify({ onFiles: !!filesSection, preview: !!preview && !!(preview.querySelector && preview.innerHTML), back: !!back, error: errorNode ? String(errorNode.textContent || "") : "" });
  })()`);
  let mobileFile = null;
  try { mobileFile = JSON.parse(mobileFileOpened); } catch { mobileFile = null; }
  record("mobile Open full file shows the Files screen", !!mobileFile && mobileFile.onFiles === true, String(mobileFileOpened).slice(0, 300));
  record("mobile Open full file loads the file preview", !!mobileFile && mobileFile.preview === true && mobileFile.back === true, String(mobileFileOpened).slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeCrashReport(outPath, recorder, e);
  process.exit(1);
});