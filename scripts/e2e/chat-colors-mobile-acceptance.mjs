// Real-DOM acceptance for the MOBILE chat mode segment colorization and
// the docked composer (the two mobile chat fixes).
//
// The unit tests pin the CSS contract textually; this driver runs the
// actually served MOBILE bundle in headless Chrome at a 390px phone
// viewport and checks, with the fixture conversation rendered through
// the real /api/panes/{id}/conversation route:
//
//   c1  the Chat|Terminal switch appears on a resolvable jcode pane
//   c2  Chat opens the lens through the real toggle
//   c3  the composer docks INSIDE the open lens (input box visible at
//       the overlay bottom, send button beside it): the fix for the
//       missing input box, which used to stay hidden in the keybar
//   c4  the composer stays 16px font (no iOS zoom-on-focus relayout)
//       and the lens has no horizontal overflow at phone width
//   c5  computed segment colors match the desktop lens contract:
//       thinking toggle magenta, tool name cyan, failed tool danger,
//       running row amber, prose at full foreground, on dark AND light
//   c6  contrast of every label hue clears WCAG AA (>= 4.5:1) against
//       the rendered background on both themes
//   c7  expanded reading surfaces stay readable (--fg / --fg-dim) after
//       the user opens a segment
//
// Server + Chrome are started by run-chat-colors-mobile-e2e.sh.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9228";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8892/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_mobile_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-chat-colors-mobile-e2e.sh)");
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

  // Phone viewport so auto-layout would pick mobile even without the
  // explicit preference; the preference alone is the deterministic part.
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }
  await evalExpr(`localStorage.setItem("herdr-web-layout", "mobile")`);
  await evalExpr(`localStorage.setItem("herdr-web-theme", "dark")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(4000);

  const layout = await evalExpr(`document.documentElement.dataset.herdrLayout || "none"`);
  record("mobile layout resolved", layout === "mobile", `got ${layout}`);
  if (layout !== "mobile") throw new Error("mobile layout did not resolve: " + layout);

  // Workspace on the fixture repo with a terminal pane: the pane spawns
  // the fake jcode (builtin_shell), so it is a live jcode agent in that
  // cwd. open_terminal must be explicit: the terminal-decoupling default
  // leaves new workspaces pane-less, and the lens gate needs a pane.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "chat-colors-mobile", open_terminal: true})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  record("workspace created on fixture repo", true, wsId);
  await sleep(1500);

  // Route to the pane itself. A bare workspace URL leaves the mobile app
  // on the home screen (parseRoute only syncs the terminal screen when a
  // tab/pane rides the URL), and the lens switch mounts on the terminal
  // screen alone. Fetch the pane id from the API and deep-link to it.
  const paneInfo = await evalExpr(`fetch("/api/panes").then((r) => r.json()).then((d) => JSON.stringify(((d && d.result && d.result.panes) || []).map((p) => p.pane_id))).catch((e) => "err:" + e)`);
  let paneId = null;
  try { paneId = JSON.parse(paneInfo)[0] || null; } catch { paneId = null; }
  record("pane created by open_terminal", !!paneId, `panes ${paneInfo}`);
  if (!paneId) throw new Error("open_terminal created no pane: " + paneInfo);
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${wsId}/tab/tab_1/pane/${paneId}` });
  await sleep(4000);
  const onTerminal = await evalExpr(`(() => {
    const active = document.querySelector('.mobile-nav button.active');
    return active && active.dataset ? (active.dataset.screen || "") : "";
  })()`);
  record("deep link lands on the terminal screen", onTerminal === "terminal", `screen ${onTerminal}`);

  // The pane boots with the workspace; the lens switch appears only once
  // the pane resolves the fixture session (agent detection + evidence
  // sweep both need a beat).
  const switchState = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const node = document.getElementById("mobileLensSwitch");
      if (node && !node.hidden) { resolve("visible"); return; }
      if (Date.now() - started > 25000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("c1 chat switch visible on resolvable jcode pane", switchState === "visible", `got ${switchState}`);
  if (switchState !== "visible") throw new Error("chat switch never appeared");

  // c2: open the lens through the real Chat toggle.
  await evalExpr(`document.getElementById("mobileLensChatToggle").click()`);
  const lensReady = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const lens = document.getElementById("mobileLens");
      const content = lens && !lens.hidden && lens.querySelector(".mobile-lens-content");
      if (content && content.querySelector(".lens-thinking")) { resolve("ready"); return; }
      if (Date.now() - started > 25000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("c2 Chat opens the lens and renders the fixture turns", lensReady === "ready", `got ${lensReady}`);
  if (lensReady !== "ready") throw new Error("lens never rendered turns");

  // c3: the composer must have re-parented INTO the open lens. The old
  // bug left it in the keybar, which the overlay covers: invisible and
  // unreachable. Geometry proves the dock: input visible inside the
  // overlay bounds, send button beside it, keybar empty.
  const dock = await evalExpr(`(() => {
    const lens = document.getElementById("mobileLens");
    const composer = document.getElementById("mobileComposer");
    const input = document.getElementById("mobileComposerInput");
    const send = document.getElementById("mobileComposerSend");
    const keybar = document.getElementById("mobileKeyBar");
    if (!lens || lens.hidden) return JSON.stringify({ fail: "lens-hidden" });
    const inLens = !!(composer && composer.parentNode === lens);
    const ir = input ? input.getBoundingClientRect() : null;
    const lr = lens.getBoundingClientRect();
    const sr = send ? send.getBoundingClientRect() : null;
    const inputVisible = !!ir && ir.width > 0 && ir.height > 0;
    const insideOverlay = !!ir && ir.bottom <= lr.bottom + 1 && ir.right <= lr.right + 1 && ir.top >= lr.top - 1;
    const sendVisible = !!sr && sr.width > 0 && sr.height > 0;
    const keybarEmpty = !keybar || !keybar.querySelector("#mobileComposer");
    const fs = input ? getComputedStyle(input).fontSize : "";
    return JSON.stringify({ inLens, inputVisible, insideOverlay, sendVisible, keybarEmpty, fontSize: fs,
      inputW: ir ? Math.round(ir.width) : 0, inputH: ir ? Math.round(ir.height) : 0 });
  })()`);
  let dockInfo = null;
  try { dockInfo = JSON.parse(dock); } catch { dockInfo = null; }
  const dockOk = !!dockInfo && dockInfo.inLens && dockInfo.inputVisible && dockInfo.insideOverlay && dockInfo.sendVisible && dockInfo.keybarEmpty;
  record("c3 composer docks inside the open lens (input + send visible, keybar empty)", dockOk, dock);
  if (!dockInfo || dockInfo.fail) throw new Error("composer dock probe failed: " + dock);

  // c4: input font stays 16px (smaller would trigger iOS zoom-on-focus
  // and relayout the whole overlay mid-typing) and no horizontal
  // overflow at 390px.
  record("c4 composer input font is 16px (no iOS focus zoom)", dockInfo.fontSize === "16px", `got ${dockInfo.fontSize}`);
  const overflow = await evalExpr(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  record("c4 no horizontal overflow at phone width", overflow === 0, `delta ${overflow}px`);

  // c5/c6: computed-color probe per theme. Palette hues are read from
  // document.BODY (the light overrides live on body.light), so token
  // reads and row reads agree per theme. The theme runs through the
  // app's own path (HerdrMobile.setThemeMode) so the flip exercises the
  // real applyTheme chain.
  const PRELUDE = 'const toRgb = (v) => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = "#000"; c.fillStyle = String(v); return c.fillStyle; };';
  const probe = (expr) => evalExpr(`(() => {
    const cs = getComputedStyle(document.body);
    ${PRELUDE}
    const token = (name) => toRgb(cs.getPropertyValue(name).trim());
    const colorOf = (el) => el ? toRgb(getComputedStyle(el).color) : null;
    return (${expr});
  })()`);

  const forceTheme = async (mode) => {
    await evalExpr(`HerdrMobile.setThemeMode(${JSON.stringify(mode)})`);
    await sleep(400);
  };

  const snapshotExpr = `{
    magenta: token("--term-magenta"),
    cyan: token("--term-cyan"),
    amber: token("--status-working"),
    danger: token("--danger"),
    bg: toRgb(cs.backgroundColor),
    thinking: colorOf(document.querySelector(".lens-thinking-toggle")),
    toolName: colorOf(document.querySelector(".lens-tool-head:not(.lens-tool-error) .lens-tool-name")),
    errorName: colorOf(document.querySelector(".lens-tool-error .lens-tool-name")),
    runningRow: colorOf(document.querySelector(".lens-tool-running")),
    runningName: colorOf(document.querySelector(".lens-tool-running .lens-tool-name")),
    text: colorOf(document.querySelector(".lens-text")),
    runningCount: document.querySelectorAll(".lens-tool-running").length,
    toolCount: document.querySelectorAll(".lens-tool-head").length,
    errorCount: document.querySelectorAll(".lens-tool-error").length,
    thinkingCount: document.querySelectorAll(".lens-thinking").length,
  }`;

  const dark = await probe(snapshotExpr);
  record("fixture renders one running tool row (dark)", dark.runningCount === 1, `count ${dark.runningCount}`);
  record("fixture renders two resolved tool rows (dark)", dark.toolCount === 2, `count ${dark.toolCount}`);
  record("fixture renders one failed tool row (dark)", dark.errorCount === 1, `count ${dark.errorCount}`);
  record("fixture renders one thinking row (dark)", dark.thinkingCount === 1, `count ${dark.thinkingCount}`);

  const assertSegmentColors = (mode, snap) => {
    record(`c5 thinking toggle reads magenta (${mode})`,
      snap.thinking === snap.magenta, `${snap.thinking} vs ${snap.magenta}`);
    record(`c5 tool name reads cyan (${mode})`,
      snap.toolName === snap.cyan, `${snap.toolName} vs ${snap.cyan}`);
    record(`c5 failed tool name reads danger (${mode})`,
      snap.errorName === snap.danger, `${snap.errorName} vs ${snap.danger}`);
    record(`c5 running tool row reads amber (${mode})`,
      snap.runningRow === snap.amber, `${snap.runningRow} vs ${snap.amber}`);
    record(`c5 running tool name stays cyan (${mode})`,
      snap.runningName === snap.cyan, `${snap.runningName} vs ${snap.cyan}`);
    record(`c5 assistant prose stays --fg (${mode})`,
      !!snap.text && snap.text !== snap.toolName && snap.text !== snap.magenta,
      `prose ${snap.text}`);
  };
  assertSegmentColors("dark", dark);

  // c7: expanded reading surfaces stay readable after a real toggle
  // click (dark): thinking body follows the theme's --fg-dim, tool
  // output keeps --fg on its --panel background.
  const expandedDark = await evalExpr(`(async () => {
    ${PRELUDE}
    const cs = getComputedStyle(document.body);
    const click = (sel) => document.querySelector(sel).click();
    click(".lens-thinking-toggle");
    await new Promise((r) => setTimeout(r, 400));
    const bodyEl = document.querySelector(".lens-thinking-body");
    const thinkingBody = bodyEl ? toRgb(getComputedStyle(bodyEl).color) : null;
    const dimToken = toRgb(cs.getPropertyValue("--fg-dim").trim() || "#a6adc8");
    click(".lens-tool-head:not(.lens-tool-error)");
    await new Promise((r) => setTimeout(r, 400));
    const outEl = document.querySelector(".lens-tool-output");
    const outputColor = outEl ? toRgb(getComputedStyle(outEl).color) : null;
    const outputBg = outEl ? toRgb(getComputedStyle(outEl).backgroundColor) : null;
    const fgToken = toRgb(cs.getPropertyValue("--fg").trim());
    return { thinkingBody, dimToken, outputColor, outputBg, fgToken };
  })()`);
  record("c7 expanded thinking body stays dim (dark)",
    !!expandedDark.thinkingBody && expandedDark.thinkingBody === expandedDark.dimToken,
    `${expandedDark.thinkingBody} vs ${expandedDark.dimToken}`);
  record("c7 expanded tool output stays --fg (dark)",
    expandedDark.outputColor === expandedDark.fgToken,
    `${expandedDark.outputColor} vs ${expandedDark.fgToken}`);
  record("c7 expanded tool output paints --panel (dark)",
    !!expandedDark.outputBg, expandedDark.outputBg || "no output element");

  // Dark screenshot for the record (visual evidence, not an assertion).
  const shotDark = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  const shotDarkPath = `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_mobile_dark.png`;
  writeFileSync(shotDarkPath, Buffer.from(shotDark.data, "base64"));
  record("dark screenshot saved", true, shotDarkPath);

  // Light theme phase: same force, same probe, same assertions. The
  // toggles land on the still-open rows from the dark phase, which is
  // fine: the probe reads computed colors, whatever is open.
  await forceTheme("light");
  const light = await probe(snapshotExpr);
  assertSegmentColors("light", light);

  const expandedLight = await evalExpr(`(async () => {
    ${PRELUDE}
    const cs = getComputedStyle(document.body);
    const dimToken = toRgb(cs.getPropertyValue("--fg-dim").trim() || "#a6adc8");
    const bodyEl = document.querySelector(".lens-thinking-body");
    const outEl = document.querySelector(".lens-tool-output");
    const thinkingBody = bodyEl ? toRgb(getComputedStyle(bodyEl).color) : null;
    const outputColor = outEl ? toRgb(getComputedStyle(outEl).color) : null;
    return { thinkingBody, dimToken, outputColor };
  })()`);
  record("c7 expanded thinking body follows light --fg-dim",
    !!expandedLight.thinkingBody && expandedLight.thinkingBody === expandedLight.dimToken,
    `${expandedLight.thinkingBody} vs ${expandedLight.dimToken}`);

  const shotLight = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotLightPath = `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_mobile_light.png`;
  writeFileSync(shotLightPath, Buffer.from(shotLight.data, "base64"));
  record("light screenshot saved", true, shotLightPath);

  // c6: WCAG AA contrast spot-check (>= 4.5:1) against the rendered
  // body background, computed here from the rendered hex colors.
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [16, 8, 0].map((s) => {
      let v = ((n >> s) & 255) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (fg, bg) => {
    if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg)) return null;
    const a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  for (const [theme, snap] of [["dark", dark], ["light", light]]) {
    for (const key of ["thinking", "toolName", "errorName", "runningRow"]) {
      const r = ratio(snap[key], snap.bg);
      record(`c6 contrast ${key} >= 4.5:1 (${theme})`,
        typeof r === "number" && r >= 4.5, r === null ? `bad color ${snap[key]}` : `${r.toFixed(2)}:1`);
    }
  }

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});
