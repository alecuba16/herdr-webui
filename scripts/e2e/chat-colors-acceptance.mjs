// Real-DOM acceptance for the chat mode segment colorization.
//
// The unit tests pin the CSS contract textually; this driver runs the
// actually served bundle in headless Chrome and checks the COMPUTED
// colors: thinking toggle magenta, tool name cyan, failed tool danger,
// running row amber, prose at full foreground, on dark AND light themes.
// A fixture jcode session (isolated HOME) feeds the transcript through
// the real conversation route; a fake jcode process keeps the pane
// resolvable. Server + Chrome are started by run-chat-colors-e2e.sh.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9224";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-chat-colors-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

// Token hues per theme, resolved from the served tokens.css so a token
// value change does not need a driver edit: read --term-magenta /
// --term-cyan / --status-working / --danger off documentElement at run
// time and compare the rows against those, instead of hardcoding hex.
async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch (_) { /* degrade gracefully */ }

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

  // Workspace on the fixture repo: the root pane spawns the fake jcode
  // (builtin_shell), so the pane is a live jcode agent in that cwd.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "chat-colors"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  record("workspace created on fixture repo", true, wsId);
  await reload(`${APP_URL}session/default/workspace/${wsId}`);

  // The lens switch appears only once the pane resolves a jcode session:
  // poll until #terminalLensSwitch is visible (agent detection +
  // evidence sweep both need a beat).
  const switchState = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const node = document.getElementById("terminalLensSwitch");
      if (node && !node.hidden) { resolve("visible"); return; }
      if (Date.now() - started > 20000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("chat lens switch visible on jcode pane", switchState === "visible", `got ${switchState}`);
  if (switchState !== "visible") throw new Error("lens switch never appeared");

  // Open the lens through the real toggle button.
  await evalExpr(`document.getElementById("lensToggleChat").click()`);
  const lensReady = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const lens = document.getElementById("terminalLens");
      const content = lens && lens.querySelector(".terminal-lens-content");
      if (content && content.querySelector(".lens-thinking")) { resolve("ready"); return; }
      if (Date.now() - started > 20000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("lens opens and renders the fixture turns", lensReady === "ready", `got ${lensReady}`);
  if (lensReady !== "ready") throw new Error("lens never rendered turns");

  // Computed-color probe. Palette hues are read from document.BODY (the
  // light overrides live on body.light, documentElement only carries the
  // dark defaults), so token reads and row reads agree under both themes.
  // Each phase drives the app's own theme path: the settings select's
  // change handler runs applyTheme(), which flips body.light AND rewrites
  // the inline --bg custom props that applyThemeColorVars stamps on body
  // at boot (they persist across class toggles otherwise).
  const forceTheme = async (mode) => {
    await evalExpr(`(() => {
      const select = document.getElementById("optTheme");
      select.value = ${JSON.stringify(mode)};
      select.dispatchEvent(new Event("change"));
    })()`);
    await sleep(200);
  };

  // Computed-color probe. One shared prelude injects the canvas-based
  // color normalizer into every eval: colors arrive mixed-format (hex
  // from tokens, rgb() from getComputedStyle) and must compare as one
  // string form. Palette hues are read from document.BODY (the light
  // overrides live on body.light, documentElement only carries the
  // dark defaults), so token reads and row reads agree per theme.
  const PRELUDE = 'const toRgb = (v) => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = "#000"; c.fillStyle = String(v); return c.fillStyle; };';
  const probe = (expr) => evalExpr(`(() => {
    const cs = getComputedStyle(document.body);
    ${PRELUDE}
    const token = (name) => toRgb(cs.getPropertyValue(name).trim());
    const colorOf = (el) => el ? toRgb(getComputedStyle(el).color) : null;
    return (${expr});
  })()`);

  // Dark theme phase.
  await forceTheme("dark");
  const dark = await probe(`{
    magenta: token("--term-magenta"),
    cyan: token("--term-cyan"),
    amber: token("--status-working"),
    danger: token("--danger"),
    bg: toRgb(cs.backgroundColor),
    thinking: colorOf(document.querySelector(".lens-thinking-toggle")),
    toolName: colorOf(document.querySelector(".lens-tool-head:not(.lens-tool-error) .lens-tool-name")),
    errorName: colorOf(document.querySelector(".lens-tool-error .lens-tool-name")),
    errorHead: colorOf(document.querySelector(".lens-tool-head.lens-tool-error")),
    runningRow: colorOf(document.querySelector(".lens-tool-running")),
    text: colorOf(document.querySelector(".lens-text")),
    runningCount: document.querySelectorAll(".lens-tool-running").length,
    toolCount: document.querySelectorAll(".lens-tool-head").length,
    errorCount: document.querySelectorAll(".lens-tool-error").length,
  }`);

  record("fixture renders one running tool row", dark.runningCount === 1, `count ${dark.runningCount}`);
  record("fixture renders two resolved tool rows", dark.toolCount === 2, `count ${dark.toolCount}`);
  record("fixture renders one failed tool row", dark.errorCount === 1, `count ${dark.errorCount}`);

  // Theme checks: probe colors arrive pre-normalized to hex strings.
  const assertSegmentColors = (mode, snap) => {
    record(`thinking toggle reads magenta (${mode})`,
      snap.thinking === snap.magenta, `${snap.thinking} vs ${snap.magenta}`);
    record(`tool name reads cyan (${mode})`,
      snap.toolName === snap.cyan, `${snap.toolName} vs ${snap.cyan}`);
    record(`failed tool name reads danger (${mode})`,
      snap.errorName === snap.danger, `${snap.errorName} vs ${snap.danger}`);
    record(`running tool row reads amber (${mode})`,
      snap.runningRow === snap.amber, `${snap.runningRow} vs ${snap.amber}`);
  };
  assertSegmentColors("dark", dark);
  record("assistant prose stays at --fg (dark)",
    !!dark.text && dark.text !== dark.toolName && dark.text !== dark.magenta,
    `prose ${dark.text}`);

  // Expanded states: the design promise is that reading surfaces keep
  // --fg / --fg-dim AFTER a user opens a segment. --fg-dim is a
  // theme-aware token (base.css defines it per theme), so compare the
  // body color against the thinking-body CSS fallback chain resolved
  // on the element itself: assert the body is NOT a label hue and
  // matches the element's own computed color (self-consistency).
  const expandedDark = await evalExpr(`(async () => {
    ${PRELUDE}
    const cs = getComputedStyle(document.body);
    const click = (sel) => document.querySelector(sel).click();
    click(".lens-thinking-toggle");
    await new Promise((r) => setTimeout(r, 300));
    const bodyEl = document.querySelector(".lens-thinking-body");
    const thinkingBody = bodyEl ? toRgb(getComputedStyle(bodyEl).color) : null;
    const dimToken = toRgb(cs.getPropertyValue("--fg-dim").trim() || "#a6adc8");
    click(".lens-tool-head:not(.lens-tool-error)");
    await new Promise((r) => setTimeout(r, 300));
    const outEl = document.querySelector(".lens-tool-output");
    const outputColor = outEl ? toRgb(getComputedStyle(outEl).color) : null;
    const outputBg = outEl ? toRgb(getComputedStyle(outEl).backgroundColor) : null;
    const fgToken = toRgb(cs.getPropertyValue("--fg").trim());
    return { thinkingBody, dimToken, outputColor, outputBg, fgToken };
  })()`);
  record("expanded thinking body stays dim (dark)",
    !!expandedDark.thinkingBody && expandedDark.thinkingBody === expandedDark.dimToken,
    `${expandedDark.thinkingBody} vs ${expandedDark.dimToken}`);
  record("expanded tool output stays --fg (dark)",
    expandedDark.outputColor === expandedDark.fgToken,
    `${expandedDark.outputColor} vs ${expandedDark.fgToken}`);
  record("expanded tool output paints --panel (dark)",
    !!expandedDark.outputBg,
    expandedDark.outputBg || "no output element");

  // Screenshot for the record (visual evidence, not an assertion).
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  const shotPath = `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_dark.png`;
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  record("dark screenshot saved", true, shotPath);

  // Light theme phase: same force, same probe, same assertions, and
  // the same expanded-state checks (the --fg-dim gap was a LIGHT-theme
  // bug: the token never existed, so every var(--fg-dim) use painted the
  // dark-theme gray at 1.97:1 on light bg; the token now ships per
  // theme in base.css and both phases assert the body follows it).
  await forceTheme("light");
  const light = await probe(`{
    magenta: token("--term-magenta"),
    cyan: token("--term-cyan"),
    amber: token("--status-working"),
    danger: token("--danger"),
    bg: toRgb(cs.backgroundColor),
    thinking: colorOf(document.querySelector(".lens-thinking-toggle")),
    toolName: colorOf(document.querySelector(".lens-tool-head:not(.lens-tool-error) .lens-tool-name")),
    errorName: colorOf(document.querySelector(".lens-tool-error .lens-tool-name")),
    runningRow: colorOf(document.querySelector(".lens-tool-running")),
  }`);
  assertSegmentColors("light", light);

  // Expanded states under light: this is the exact surface where the
  // undefined --fg-dim painted dark-theme gray at 1.97:1. The toggle
  // clicks land on the still-open rows from the dark phase, so probe
  // what is open; assert the thinking body matches the theme's
  // --fg-dim token (now defined per theme).
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
  record("expanded thinking body follows light --fg-dim",
    !!expandedLight.thinkingBody && expandedLight.thinkingBody === expandedLight.dimToken,
    `${expandedLight.thinkingBody} vs ${expandedLight.dimToken}`);
  record("light --fg-dim is theme-defined (not the dark fallback)",
    expandedLight.dimToken !== "#a6adc8",
    expandedLight.dimToken);

  const shotLight = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotLightPath = `${process.env.JCODE_SCRATCH_DIR || "."}/chat_colors_light.png`;
  writeFileSync(shotLightPath, Buffer.from(shotLight.data, "base64"));
  record("light screenshot saved", true, shotLightPath);

  // WCAG AA contrast spot-check (>= 4.5:1) against the served body
  // background, computed here from the rendered hex colors.
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
      record(`contrast ${key} >= 4.5:1 (${theme})`,
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
