// Real-browser acceptance for the terminal text-selection fix.
//
// Bug: a pane program (jcode TUI, tmux with mouse on) enables SGR mouse
// tracking (DECSET 1000+1006). wterm's input class claimed every mousedown
// as an SGR mouse report (preventDefault), which kills native drag
// selection, and herdr stripped the SGR bytes unless the user opted into
// Terminal mouse reporting, so the drag did nothing at all.
//
// Fix: the adapter disables wterm's mouse interception when reporting is
// off (default), keeping SGR wheel forwarding intact. This driver proves
// both directions on the real served bundle with trusted CDP input:
//
//   S1: pane emits ESC[?1000;1006h, reporting off (default). A trusted
//       drag across terminal rows must produce a non-collapsed DOM
//       selection containing pane text.
//   S2: flip reporting on through the live adapter setter, the same drag
//       must NOT select: wterm interception is back, bytes flow to the pty.
//   S3: wheel over the pane with tracking on still produces an SGR wheel
//       report into the pty (scroll forwarding not regressed).
//
// Entry points are the app's own: POST /api/tabs creates the Shell tab
// (create_tab spawns the pty), bare go() activates it, bare sendInputData
// types into the pane, bare term/options are bundle-scope globals the
// concatenated classic script shares with Runtime.evaluate.

import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const OUT = process.argv[2] || "selection_result.json";
const REPO = process.env.REPO;
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9226";

if (!REPO) {
  console.error("REPO env required (use scripts/e2e/run-terminal-selection-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

const list = await fetchJson(`${CDP_HTTP}/json`);
const page = list.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
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

// Trusted drag: synthetic MouseEvents are untrusted, browsers ignore them
// for native selection. Input.dispatchMouseEvent goes through the real
// input pipeline, so the selection machinery actually runs.
async function trustedDrag(cdp, from, to) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + 20, y: from.y, button: "left", buttons: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 });
  await sleep(60);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  await sleep(120);
}

const selectionState = () => evalExpr(`(() => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return JSON.stringify({ collapsed: true, text: "", inside: false });
  const term = document.getElementById("terminal");
  return JSON.stringify({
    collapsed: false,
    text: String(sel.toString()).slice(0, 120),
    inside: !!(term && sel.rangeCount && term.contains(sel.getRangeAt(0).commonAncestorContainer)),
  });
})()`);

async function run() {
  await reload();

  // ── workspace with the app's own create flow ────────────────────────
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "selection-probe"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  record("workspace created", !!wsId, JSON.stringify(made).slice(0, 200));
  if (!wsId) throw new Error("no workspace_id");

  await reload(`${APP_URL.endsWith("/") ? APP_URL : APP_URL + "/"}session/default/workspace/${wsId}`);

  const loaded = await evalExpr(`new Promise((resolve) => {
  const started = Date.now();
  const check = () => {
    if (typeof state !== "undefined" && state.workspaces && state.workspaces.length) { resolve("loaded"); return; }
    if (Date.now() - started > 30000) resolve("timeout");
    else setTimeout(check, 400);
  };
  check();
})`);
  record("app loaded the workspace list", loaded === "loaded", `got ${loaded}`);
  if (loaded !== "loaded") throw new Error("app never loaded the workspace list");

  // ── Shell tab: create via the same endpoint the + button uses ──────
  const tabMade = await evalExpr(`fetch("/api/tabs", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({workspace_id: ${JSON.stringify(wsId)}, label: "shell"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const tabId = tabMade && tabMade.result && tabMade.result.tab ? tabMade.result.tab.tab_id : (tabMade && tabMade.result && tabMade.result.id) || null;
  record("shell tab created", !!tabId, JSON.stringify(tabMade).slice(0, 200));
  if (!tabId) throw new Error("no tab_id: " + JSON.stringify(tabMade).slice(0, 300));

  // Activate through the app's own navigation so the pane connects.
  const went = await evalExpr(`(async () => {
    if (typeof go !== "function") return "no-go";
    await go(${JSON.stringify(wsId)}, ${JSON.stringify(tabId)});
    return "went";
  })()`);
  record("go() activated the tab", went === "went", went);

  // Wait for the terminal to connect: state.terminalId lands and wterm
  // mounts on #terminal itself (the WTerm constructor adds the .wterm
  // class to the container element, it does not create a child).
  const termUp = await evalExpr(`new Promise((resolve) => {
  const started = Date.now();
  const check = () => {
    const host = document.getElementById("terminal");
    const ready = typeof state !== "undefined" && state.terminalId && host && host.classList.contains("wterm") && host.querySelector(".term-row");
    if (ready) { resolve("up"); return; }
    if (Date.now() - started > 30000) resolve("timeout");
    else setTimeout(check, 400);
  };
  check();
})`);
  record("terminal mounted", termUp === "up", `got ${termUp}`);
  if (termUp !== "up") throw new Error("terminal never mounted");

  // ── run the mouse-tracking program in the pane pty ──────────────────
  // Same class of program as the jcode TUI: enables SGR tracking, then
  // prints stable rows so a drag has deterministic text to grab. Wait for
  // the input socket first: sendInputData silently drops bytes while
  // termWs is still connecting, which ate the command in earlier runs.
  const wsReady = await evalExpr(`new Promise((resolve) => {
  const started = Date.now();
  const check = () => {
    const open = typeof termWs !== "undefined" && termWs && termWs.readyState === 1;
    if (open) { resolve("open"); return; }
    if (Date.now() - started > 20000) resolve("timeout");
    else setTimeout(check, 200);
  };
  check();
})`);
  record("terminal input socket open", wsReady === "open", `got ${wsReady}`);

  const typed = await evalExpr(`(async () => {
  if (typeof sendInputData !== "function") return "no-sendInputData";
  sendInputData("printf '\\\\x1b[?1000;1006h'; for i in $(seq 1 20); do echo \\"row-$i-selectable-text\\"; done; sleep 300");
  sendInputData("\\r");
  await new Promise((r) => setTimeout(r, 1500));
  return "typed";
})()`);
  record("tracking program typed into pane", typed === "typed", typed);

  const gridReady = await evalExpr(`new Promise((resolve) => {
  const started = Date.now();
  const check = () => {
    const rows = document.querySelectorAll("#terminal .term-row:not(.term-scrollback-row)");
    const text = Array.from(rows).map((r) => r.textContent).join(" ");
    if (text.includes("row-5-selectable-text") || Date.now() - started > 15000) resolve(text.includes("row-5-selectable-text") ? "ready" : "timeout:" + text.slice(0, 80));
    else setTimeout(check, 300);
  };
  check();
})`);
  record("pane rows rendered", gridReady === "ready", gridReady);

  // wterm gate state, straight from the adapter's own cache: reporting off
  // (default) must have replaced the input class's handleMouse (the real
  // 0.5.4 bundle keeps it on wterm.input, not the WTerm instance).
  const gateOff = await evalExpr(`(() => {
  const host = document.getElementById("terminal");
  const adapter = host && host.__herdrTerminalAdapter;
  if (!adapter || !adapter.wterm) return "no-adapter";
  const target = adapter.wterm.input && typeof adapter.wterm.input.handleMouse === "function" ? adapter.wterm.input : adapter.wterm;
  if (!target) return "no-target";
  return JSON.stringify({ hasOriginal: !!target.__herdrHandleMouse, liveIsNoop: target.handleMouse !== target.__herdrHandleMouse });
})()`);
  let gate;
  try { gate = JSON.parse(gateOff); } catch { gate = { raw: gateOff }; }
  record("S0 gate armed at default (reporting off)", !!gate.hasOriginal && gate.liveIsNoop === true, gateOff);

  // Row geometry for the trusted drags. #terminal carries the .wterm
  // class; its rows are direct children of the grid.
  const geom = await evalExpr(`(() => {
  const rows = Array.from(document.querySelectorAll("#terminal .term-row:not(.term-scrollback-row)"));
  const first = rows.find((r) => (r.textContent || "").includes("row-1-selectable-text"));
  const fifth = rows.find((r) => (r.textContent || "").includes("row-5-selectable-text"));
  if (!first || !fifth) return JSON.stringify({ error: "program rows missing: " + rows.slice(0, 6).map((r) => (r.textContent || "").slice(0, 30)).join(" | ") });
  const a = first.getBoundingClientRect();
  const b = fifth.getBoundingClientRect();
  return JSON.stringify({ from: { x: Math.round(a.left + 2), y: Math.round(a.top + 2) }, to: { x: Math.round(b.left + 120), y: Math.round(b.top + 2) } });
})()`);
  const g = JSON.parse(geom);
  if (g.error) throw new Error("no drag geometry: " + g.error);

  // ── S1: trusted drag must select with reporting off ─────────────────
  await trustedDrag(cdp, g.from, g.to);
  const s1raw = await selectionState();
  const s1 = JSON.parse(s1raw);
  record(
    "S1 drag selects text with reporting off",
    s1.collapsed === false && s1.inside && (s1.text || "").includes("row-"),
    s1raw,
  );

  await evalExpr(`document.getSelection().removeAllRanges()`);

  // ── S2: reporting on through the live setter, drag must NOT select ─
  const flipped = await evalExpr(`(() => {
  if (typeof term === "undefined" || !term) return "no-term";
  if (typeof term.setMouseReporting !== "function") return "no-setter";
  term.setMouseReporting(true);
  return "on";
})()`);
  record("S2 reporting flipped on live", flipped === "on", flipped);

  // The interception swap must restore the original handler.
  const gateOn = await evalExpr(`(() => {
  const host = document.getElementById("terminal");
  const adapter = host && host.__herdrTerminalAdapter;
  if (!adapter || !adapter.wterm) return "no-adapter";
  const target = adapter.wterm.input && typeof adapter.wterm.input.handleMouse !== "undefined" ? adapter.wterm.input : adapter.wterm;
  if (!target) return "no-target";
  return JSON.stringify({ hasOriginal: !!target.__herdrHandleMouse, liveIsOriginal: typeof target.handleMouse === "function" && target.handleMouse === target.__herdrHandleMouse });
})()`);
  let gate2;
  try { gate2 = JSON.parse(gateOn); } catch { gate2 = { raw: gateOn }; }
  record("S2 gate disarmed (original handleMouse restored)", gate2.liveIsOriginal === true, gateOn);

  await trustedDrag(cdp, g.from, g.to);
  const s2raw = await selectionState();
  const s2 = JSON.parse(s2raw);
  record("S2 drag does not select with reporting on", s2.collapsed === true, s2raw);

  // The drag bytes went to the program instead: SGR press sequences show
  // up on the pane (the sleeping printf shell has them in its stdin, not
  // its output; instead verify the selection stayed empty and the wheel
  // path below proves byte flow end to end).
  await evalExpr(`(() => {
  if (typeof term !== "undefined" && term && typeof term.setMouseReporting === "function") term.setMouseReporting(false);
  return "off";
})()`);

  // ── S3: wheel with tracking on still forwards SGR bytes ────────────
  // Arm a byte counter on the pane input path, turn reporting on, wheel,
  // and check an SGR wheel report (ESC [ < 6 4/65 ; ... M) was emitted.
  const wheel = await evalExpr(`(async () => {
  const host = document.getElementById("terminal");
  const adapter = host && host.__herdrTerminalAdapter;
  if (!host || !adapter) return JSON.stringify({ error: "no-adapter" });
  if (typeof term === "undefined" || !term || typeof term.setMouseReporting !== "function") return JSON.stringify({ error: "no-setter" });
  let captured = "";
  const orig = sendInputData;
  sendInputData = function (data, opts) { captured += String(data); return orig.call(this, data, opts); };
  try {
    term.setMouseReporting(true);
    const r = host.getBoundingClientRect();
    await new Promise((res) => setTimeout(res, 200));
    host.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.left + 100), clientY: Math.round(r.top + 100), deltaY: 40, deltaMode: 0,
    }));
    await new Promise((res) => setTimeout(res, 500));
  } finally {
    term.setMouseReporting(false);
    sendInputData = orig;
  }
  const sgr = captured.includes("\\u001b[<6");
  return JSON.stringify({ forwarded: sgr, sample: captured.slice(0, 40) });
})()`);
  let s3;
  try { s3 = JSON.parse(wheel); } catch { s3 = { raw: wheel }; }
  record(
    "S3 wheel forwards SGR bytes with tracking on",
    s3.forwarded === true,
    wheel.slice(0, 160),
  );
}

try {
  await run();
} catch (error) {
  record("driver completed", false, String(error && error.message || error));
}

writeReport(OUT, recorder);
console.log(recorder.failed ? "FAILED" : "ALL PASSED");
process.exit(recorder.failed ? 1 : 0);
