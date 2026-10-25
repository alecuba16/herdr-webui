// Empirical verification of the perf/UX audit's top claims, driven through
// the real served app (run-audit-probe.sh boots the isolated server +
// chrome-headless-shell). Unlike the read-only swarm audit, this exercises
// the real public interfaces: real desktop bundle, real wterm surfaces,
// real CDP key events for the prefix chords, real mobile layout, real API
// endpoints. Every check records observed behavior, not source reading.
//
//  ap1  terminal virtualization: 10k-line output leaves O(visible) DOM
//        row nodes (claim: already optimal)
//  ap2  scrollback spacer honesty: scrollHeight stays ~10k lines while
//        row node count stays small (claim: spacer-carried virtualization)
//  ap3  parked-pane gap: two real terminal panels, split, stream output
//        in the right one, then maximize the left pane. The right pane's
//        aux surface is parked hidden; observe whether its DOM keeps
//        mutating while invisible (claim: keeps live WS + DOM rebuild)
//  ap4  mobile offline visibility: block the events stream at the network
//        layer, observe what the mobile user sees (claim: only a dot)
//  ap6  rail-status endpoint: real HTTP shape + timing (claim: sequential
//        git status per cwd; observed via latency, structure via payload)
//  ap7  branches popover payload: real HTTP, per-branch tip details
//        present (claim: N+1 git show cost server-side)
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9527";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8957/";
const REPO = process.env.REPO;
const outPath = process.env.PROBE_OUT || `${process.env.JCODE_SCRATCH_DIR || "."}/audit_probe_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-audit-probe.sh)");
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
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };
  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };
  const keyDown = (code, key, keyCode, modifiers = 0) =>
    cdp.send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: keyCode, modifiers });
  const keyUp = (code, key, keyCode, modifiers = 0) =>
    cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: keyCode, modifiers });
  // Types text into whatever element currently has focus through the
  // browser's real input pipeline (same channel a physical keyboard uses).
  const typeText = (text) => cdp.send("Input.insertText", { text });

  await reload();

  // ---- setup: workspace with a live shell tab -------------------------
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "probe", open_terminal: true})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  const tabId = made && made.result && made.result.tab ? made.result.tab.tab_id : null;
  record("ap0 workspace.create with open_terminal mints a live shell tab", !!wsId && !!tabId, `ws=${wsId} tab=${tabId}`);
  if (!wsId) throw new Error("workspace create failed: " + JSON.stringify(made).slice(0, 300));
  await reload(`${APP_URL}session/default/workspace/${wsId}`);
  await sleep(2000);

  // ---- ap1/ap2: terminal virtualization through the real input path ----
  // Focus the terminal (the app boots with the shell focused, but be
  // explicit: focusTerminal via the app's own API would need a symbol;
  // clicking the shell does it through the real DOM event path).
  await evalExpr(`(() => { const sh = document.querySelector("#terminalShell"); if (sh) sh.click(); return !!sh; })()`);
  await sleep(300);
  await typeText("seq 1 10000");
  await keyDown("Enter", "Enter", 13); await keyUp("Enter", "Enter", 13);
  await sleep(5000);
  const virt = await evalExpr(`(() => {
    const shell = document.querySelector("#terminalShell");
    if (!shell) return { err: "no shell" };
    const rows = shell.querySelectorAll(".term-row").length;
    const scRows = shell.querySelectorAll(".term-scrollback-row").length;
    const spacers = shell.querySelectorAll(".term-scrollback-spacer").length;
    const scroller = shell.querySelector(".term-scrollback, [class*=scrollback]");
    return {
      liveRows: rows,
      scrollbackRows: scRows,
      spacers,
      scrollHeight: scroller ? scroller.scrollHeight : -1,
      clientHeight: scroller ? scroller.clientHeight : -1,
      totalDom: shell.querySelectorAll("*").length,
      lastLine: (shell.textContent || "").includes("9999"),
    };
  })()`);
  record("ap1 10k-line output keeps row node count O(visible) (virtualization real)",
    !virt.err && virt.scrollHeight > 5000 && virt.totalDom < 2000,
    JSON.stringify(virt));
  record("ap2 scrollback spacers carry the 10k-line height while few rows exist",
    !virt.err && virt.spacers > 0 && virt.scrollHeight / Math.max(1, virt.clientHeight) > 10,
    `spacers=${virt.spacers} scrollHeight=${virt.scrollHeight} clientHeight=${virt.clientHeight}`);

  // ---- ap3: parked-shell gap through the real git-tab path ----------
  // Butterfly F1's persistent case: the PRIMARY shell parks hidden in
  // #workspacePanes when a git/editor tab takes over its leaf, while its
  // WebSocket stays open and wterm keeps parsing frames. Stream output,
  // open the git rail (real user path: #rightRailGit click), then observe
  // the parked shell's DOM while output still streams into it.
  // Maximize earlier showed the split-sibling case disposes its aux
  // (releaseStale keep-set); the primary shell is the one that parks.
  await typeText("while true; do echo tick $(date +%s%N); done");
  await keyDown("Enter", "Enter", 13); await keyUp("Enter", "Enter", 13);
  await sleep(600);
  // Real git view open: the right-rail Git button.
  const gitClick = await evalExpr(`(() => {
    const btn = document.getElementById("rightRailGit");
    if (!btn) return { err: "no rightRailGit" };
    btn.click();
    return { clicked: true };
  })()`);
  record("ap3a right-rail Git clicked (real git-tab path)", !gitClick.err, JSON.stringify(gitClick));
  await sleep(2500);
  // The rail opens git in the sidebar column; the view-toggle Log button
  // routes the git view into a CENTER pane tab (openGitTab("log")), the
  // real user path that parks the terminal shell behind a git tab.
  const logClick = await evalExpr(`(() => {
    const btn = Array.from(document.querySelectorAll(".git-ui-view-toggle")).find((b) => ((b.textContent || "").trim().toLowerCase() === "log"));
    if (!btn) return { err: "no log toggle", toggles: Array.from(document.querySelectorAll(".git-ui-view-toggle")).map((b) => b.textContent && b.textContent.trim()) };
    btn.click();
    return { clicked: true };
  })()`);
  record("ap3a2 git view-toggle Log clicked (real center-tab path)", !logClick.err, JSON.stringify(logClick).slice(0, 200));
  await sleep(2500);
  const parkInfo = await evalExpr(`(() => {
    const shell = document.getElementById("terminalShell");
    if (!shell) return { err: "no shell" };
    const style = getComputedStyle(shell);
    return {
      parked: shell.parentElement && shell.parentElement.id === "workspacePanes" && style.display === "none",
      parent: shell.parentElement ? (shell.parentElement.className || shell.parentElement.id) : null,
      display: style.display,
      gitMount: !!document.querySelector("[id^=pane-git-mount], .pane-git-container"),
    };
  })()`);
  record("ap3b primary shell parked hidden behind the git tab",
    parkInfo.parked === true, JSON.stringify(parkInfo));

  // Observe the parked shell for 3s while the background loop streams.
  // After the parked-render-pause fix the expectation inverted: the shell
  // parks display:none, its IntersectionObserver flips
  // setRenderingPaused(true), wterm stops scheduling renders, and the DOM
  // goes quiet. A small residual (< 20 muts) is tolerated: theme writes,
  // spacer updates on resize, and non-terminal chrome inside the shell
  // subtree still mutate legitimately.
  const parkedMut = await evalExpr(`(() => new Promise((resolve) => {
    const shell = document.getElementById("terminalShell");
    if (!shell) { resolve({ err: "no shell" }); return; }
    if (getComputedStyle(shell).display !== "none") { resolve({ err: "shell not parked", display: getComputedStyle(shell).display }); return; }
    let muts = 0;
    const mo = new MutationObserver((list) => { muts += list.length; });
    mo.observe(shell, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      mo.disconnect();
      resolve({ parkedMutations: muts, tail: (shell.textContent || "").slice(-90) });
    }, 3000);
  }))()`);
  record("ap3 parked hidden shell render is paused (DOM quiet during background stream)",
    parkedMut.parkedMutations !== undefined && parkedMut.parkedMutations < 20,
    JSON.stringify(parkedMut).slice(0, 300));

  // ---- ap6: rail-status (real HTTP) -----------------------------------
  const railStart = Date.now();
  const rail = await evalExpr(`fetch("/api/git-ui/rail-status", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({workspaces: [{workspace_id: ${JSON.stringify(wsId)}, cwd: ${JSON.stringify(REPO)}}]})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const railMs = Date.now() - railStart;
  record("ap6 rail-status answers per-workspace items over real HTTP",
    rail && rail.items && Array.isArray(rail.items) && rail.items.length >= 1, `ms=${railMs} items=${rail && rail.items ? rail.items.length : "?"}`);

  // ---- ap7: branches payload (real HTTP) ------------------------------
  const brStart = Date.now();
  const branches = await evalExpr(`fetch("/api/git-ui/branches?cwd=" + encodeURIComponent(${JSON.stringify(REPO)})).then((r) => r.json()).catch((e) => "err:" + e)`);
  const brMs = Date.now() - brStart;
  const brOk = branches && (branches.branches || branches.result || branches.items);
  record("ap7 branches endpoint answers the popover payload",
    !!brOk, `ms=${brMs} keys=${branches ? Object.keys(branches).slice(0, 8).join(",") : "?"}`);

  // ---- ap4: mobile offline visibility ---------------------------------
  await evalExpr(`(() => { localStorage.setItem("herdr-web-layout", "mobile"); return true; })()`);
  await reload();
  await sleep(2500);
  const mobileInfo = await evalExpr(`(() => {
    const dot = document.getElementById("mobileConnectionDot");
    return {
      layout: document.documentElement.dataset.herdrLayout,
      dotFound: !!dot,
      dotState: dot ? dot.dataset.state : null,
      dotSize: dot ? getComputedStyle(dot).width + "x" + getComputedStyle(dot).height : null,
      banner: !!document.querySelector(".offline-banner, .connection-banner, [class*=offline]"),
      metaRole: !!document.querySelector("#mobileMeta[role=status]"),
    };
  })()`);
  record("ap4a mobile layout serves the mobile bundle (layout switch real)",
    mobileInfo.layout === "mobile" && mobileInfo.dotFound, JSON.stringify(mobileInfo));
  // Real offline condition: kill the isolated fixture server. This is
  // the true outage bear described (server death), not a simulated block:
  // the events WS dies, the terminal WS dies, only chrome + the loaded
  // mobile app remain. The runner's cleanup trap owns the server PID
  // anyway.
  const { execSync } = await import("node:child_process");
  const port = new URL(APP_URL).port;
  let killed = false;
  try {
    const pids = execSync(`lsof -ti tcp:${port}`).toString().trim().split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    killed = pids.length > 0;
  } catch { killed = false; }
  record("ap4b fixture server killed (real outage begins)", killed, `port=${port}`);
  // Give the mobile events module time to see the death: ws.onclose fires
  // immediately; the offline banner debounces 1.5s before showing, then
  // scheduleEventReconnect reattempts every 1.5s. The boot had a real
  // connect (events socket opened against the live fixture), so the
  // outage path is armed: the banner must be up by the end of the window.
  await sleep(2000);
  // Sample the dot + banner + chrome repeatedly to record what the user
  // actually sees during a real outage. The banner must appear and STAY:
  // a flash that hides itself would fail the visibility bar.
  const offline = await evalExpr(`(async () => {
    const states = [];
    let bannerVisible = 0;
    let toasts = 0;
    let offlineText = false;
    for (let i = 0; i < 16; i++) {
      const dot = document.getElementById("mobileConnectionDot");
      const banner = document.getElementById("mobileOfflineBanner");
      const bodyText = document.body.innerText.slice(0, 500);
      states.push(dot ? dot.dataset.state : "none");
      if (banner && !banner.hidden) bannerVisible++;
      toasts = Math.max(toasts, document.querySelectorAll("[class*=toast]").length);
      if (/offline|reconnect|connection lost|retrying/i.test(bodyText)) offlineText = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    const dot = document.getElementById("mobileConnectionDot");
    const banner = document.getElementById("mobileOfflineBanner");
    return {
      dotStates: [...new Set(states)],
      dotTitle: dot ? dot.title : null,
      bannerSamplesVisible: bannerVisible,
      bannerHiddenAtEnd: banner ? !!banner.hidden : null,
      toastsEver: toasts,
      offlineTextEver: offlineText,
      metaText: (document.getElementById("mobileMeta") || {}).textContent || "",
    };
  })()`);
  record("ap4 mobile outage shows the debounced offline banner and keeps it up",
    killed && offline.dotStates.includes("connecting") && offline.bannerSamplesVisible >= 8 && offline.bannerHiddenAtEnd === false && offline.offlineTextEver,
    JSON.stringify(offline).slice(0, 300));

  writeReport(outPath, recorder, { repo: REPO, app: APP_URL, date: new Date().toISOString() });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  console.error(error);
  process.exit(1);
});