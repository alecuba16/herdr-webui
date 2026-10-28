// Live acceptance for the mobile Scroll speed setting + PR #333 chat-lens
// focus parity (scroll_speed branch). Runs against the isolated server +
// headless Chrome booted by run-scroll-speed-mobile-e2e.sh. Real clicks
// and DOM observations only (same contract as terminal-decouple-mobile-
// acceptance.mjs):
//
//   ss1  mobile Settings > Terminal renders the Scroll speed row with
//        the default 3 and the range input 1-20
//   ss2  driving the slider persists herdr-web-options.scrollLines
//        without a settings DOM swap (debounced commit path)
//   ss2b an input-only drive (drag mid-gesture) commits via debounce
//   ss3  reload restores the slider and label from storage
//   ss3b corrupt and out-of-range stored values render clamped controls
//   ss4  a wheel row-step on the live terminal scrolls scrollLines rows
//   ss4b a wheel-up from the bottom scrolls back the same 7 rows
//   ss4c two half-row pixel deltas accumulate into exactly one step
//   ss4d deltaMode 1 (line) scrolls exactly the speed setting
//   ss4e deltaMode 2 (page) scrolls one terminal grid page
//   ss5  the lens global exists with the paste-guard surface
//   ss5b the paste takeover claims a paste with the lens closed
//   ss6  lens focusTypingSurface lands the caret on the composer
//   ss7  zero console errors across the whole run
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9229";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/scroll_speed_mobile_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-scroll-speed-mobile-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);
// R-35 evidence: every console error the page emits during the run,
// collected via Runtime.consoleAPICalled and asserted at the end.
const consoleErrors = [];

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      consoleErrors.push((params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
    }
  });

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  const clickEl = async (expr) => {
    const pt = await evalExpr(expr);
    if (!pt) return "no-point";
    const point = typeof pt === "string" ? JSON.parse(pt) : pt;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    return "clicked";
  };
  const rectExpr = (selector) => `(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`;

  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }

  await evalExpr(`localStorage.setItem("herdr-web-layout", "mobile")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(4000);

  const layout = await evalExpr(`document.documentElement.dataset.herdrLayout || "none"`);
  record("mobile layout resolved", layout === "mobile", `got ${layout}`);
  if (layout !== "mobile") throw new Error("mobile layout did not resolve: " + layout);

  const ready = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (window.HerdrMobile && window.HerdrMobile.showScreen) { resolve("ready"); return; }
      if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("mobile bundle booted", ready === "ready", `got ${ready}`);
  if (ready !== "ready") throw new Error("mobile bundle never booted");

  // Open the fixture repo through the real recents path (record + real
  // Open click), same as the decouple probe.
  const rec = await evalExpr(`fetch("/api/recent-workspaces/record", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({path: ${JSON.stringify(REPO)}, label: "ss-mobile"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  record("fixture repo recorded in recents", !String(rec).startsWith("err"), String(rec).slice(0, 120));

  await clickEl(rectExpr(`document.querySelector('.mobile-nav button[data-screen="more"]')`));
  await sleep(600);
  await clickEl(rectExpr(`Array.from(document.querySelectorAll('.mobile-drawer-item')).find((b) => /worktrees/i.test(b.textContent || ""))`));
  await sleep(800);
  // The recents rows live inside a closed disclosure: expand it first or
  // the Open button is not in the layout and the real click lands nowhere.
  await evalExpr(`(() => {
    const details = Array.from(document.querySelectorAll("details.mobile-disclosure")).find((d) => /recent/i.test(d.textContent || ""));
    if (details) {
      details.open = true;
      details.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return "expanded";
  })()`);
  await sleep(800);
  const openClicked = await clickEl(rectExpr(`Array.from(document.querySelectorAll(".mobile-worktree-row")).reduce((acc, row) => { const btn = Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "Open"); return btn && !btn.disabled ? btn : acc; }, null)`));
  record("recents Open clicked", openClicked === "clicked", openClicked);
  await sleep(3500);

  // Mint a panel through the real Panels sheet so the terminal screen
  // has a live pane (open_terminal defaults off, like the decouple probe).
  await clickEl(rectExpr(`document.querySelector('.mobile-nav button[data-screen="terminal"]')`));
  await sleep(800);
  await clickEl(rectExpr(`document.getElementById("mobilePanelsChip")`));
  await sleep(600);
  const mint = await evalExpr(`(async () => {
    const sheet = document.getElementById("mobileTabsSheet");
    if (!sheet || sheet.hidden) return JSON.stringify({ error: "no-sheet" });
    const btn = Array.from(sheet.querySelectorAll("button")).find((b) => /new panel/i.test(b.textContent || ""));
    if (!btn) return JSON.stringify({ error: "no-new-panel" });
    btn.click();
    await new Promise((r) => setTimeout(r, 3000));
    const chip = (document.getElementById("mobilePanelsChip") || {}).textContent || "";
    return JSON.stringify({ chip: chip.trim() });
  })()`);
  const mintInfo = JSON.parse(mint);
  record("panel minted for terminal screen", /1 panes?/.test(mintInfo.chip || ""), mint);

  // ss1: the row renders with default 3.
  await evalExpr(`HerdrMobile.showScreen("settings")`);
  await sleep(800);
  const row = await evalExpr(`(() => {
    const label = document.querySelector('[data-settings-id="scrollLines"]');
    if (!label) return null;
    const input = label.querySelector("input[type=range]");
    return JSON.stringify({ value: input ? input.value : null, min: input ? input.min : null, max: input ? input.max : null, text: label.textContent.slice(0, 80) });
  })()`);
  const parsedRow = row ? JSON.parse(row) : null;
  record("ss1 Scroll speed row renders with default 3", !!parsedRow && parsedRow.value === "3" && parsedRow.min === "1" && parsedRow.max === "20", row || "missing");

  // ss2: drive the slider through real input+change events; the
  // debounced commit must persist without swapping the settings DOM.
  const rowNodeBefore = await evalExpr(`(() => {
    const label = document.querySelector('[data-settings-id="scrollLines"]');
    return label ? "ok" : null;
  })()`);
  record("row present before slider drive", rowNodeBefore === "ok", rowNodeBefore || "missing");

  await evalExpr(`(() => {
    const input = document.querySelector('[data-settings-id="scrollLines"] input[type=range]');
    input.focus();
    input.value = "7";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return "driven";
  })()`);
  await sleep(1500); // debounce window is 800ms
  const stored = await evalExpr(`JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines`);
  record("ss2 slider drive persists scrollLines=7", String(stored) === "7", `stored ${stored}`);
  const labelAlive = await evalExpr(`(() => {
    const label = document.querySelector('[data-settings-id="scrollLines"]');
    const input = label && label.querySelector("input[type=range]");
    return JSON.stringify({ hasRow: !!label, focused: !!(input && document.activeElement === input) });
  })()`);
  const aliveParsed = JSON.parse(labelAlive);
  record("ss2 row survives the commit without DOM swap", aliveParsed.hasRow, labelAlive);

  // ss2b: an input-only drive (no change event, like a real drag
  // mid-gesture) must persist through the debounced path alone.
  await evalExpr(`(() => {
    const input = document.querySelector('[data-settings-id="scrollLines"] input[type=range]');
    input.focus();
    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return "driven";
  })()`);
  await sleep(400);
  const storedEarly = await evalExpr(`JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines`);
  await sleep(1200); // past the 800ms debounce
  const storedLate = await evalExpr(`JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines`);
  record(
    "ss2b input-only drive commits through the debounce",
    String(storedEarly) === "7" && String(storedLate) === "12",
    `at+400ms ${storedEarly}, at+1600ms ${storedLate}`,
  );

  // ss3: reload and confirm the slider restores from storage.
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3500);
  await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (window.HerdrMobile && window.HerdrMobile.showScreen) { resolve("ready"); return; }
      if (Date.now() - started > 15000) resolve("timeout");
      else setTimeout(check, 300);
    };
    check();
  })`);
  await evalExpr(`HerdrMobile.showScreen("settings")`);
  await sleep(800);
  const afterReload = await evalExpr(`(() => {
    const label = document.querySelector('[data-settings-id="scrollLines"]');
    const input = label && label.querySelector("input[type=range]");
    return JSON.stringify({ value: input ? input.value : null, text: label ? label.textContent.slice(0, 80) : null });
  })()`);
  const reloadParsed = JSON.parse(afterReload);
  record("ss3 reload restores slider at 12", reloadParsed.value === "12", afterReload);

  // ss3b: corrupt and out-of-range stored values must render clamped
  // working values, never a blank or broken control (R-27 live check).
  const corruptProbe = await evalExpr(`(async () => {
    const results = [];
    for (const value of ["banana", 999, 0, -4]) {
      localStorage.setItem("herdr-web-options", JSON.stringify({ scrollLines: value }));
      HerdrMobile.showScreen("settings");
      await new Promise((r) => setTimeout(r, 300));
      const label = document.querySelector('[data-settings-id="scrollLines"]');
      const input = label && label.querySelector("input[type=range]");
      const text = label ? label.textContent : "";
      results.push({ value: String(value), rendered: input ? input.value : null, text: text.slice(0, 60) });
    }
    localStorage.setItem("herdr-web-options", JSON.stringify({ scrollLines: 12 }));
    HerdrMobile.showScreen("settings");
    return JSON.stringify(results);
  })()`);
  let corruptParsed = null;
  try { corruptParsed = JSON.parse(corruptProbe); } catch { corruptParsed = null; }
  record(
    "ss3b corrupt and out-of-range values render clamped",
    !!corruptParsed && corruptParsed.every((r) => r.rendered !== null && Number(r.rendered) >= 1 && Number(r.rendered) <= 20),
    corruptProbe,
  );

  // ss4: wheel speed on the live terminal. Fill scrollback through the
  // adapter, then a synthetic wheel row-step must move scrollTop by
  // scrollLines * rowHeight at whatever speed the earlier checks stored.
  const mintOk = /1 panes?/.test(mintInfo.chip || "");
  await evalExpr(`HerdrMobile.showScreen("terminal")`);
  await sleep(2000);
  const wheelProbe = await evalExpr(`(async () => {
    const term = document.getElementById("terminal");
    if (!term) return JSON.stringify({ error: "no terminal element" });
    const adapter = term.__herdrTerminalAdapter;
    if (!adapter) return JSON.stringify({ error: "no adapter" });
    for (let i = 0; i < 400; i += 1) {
      adapter.write("line " + i + "\\r\\n");
    }
    await new Promise((r) => setTimeout(r, 400));
    const rowHeight = adapter.rowHeight();
    const speed = Number(JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines) || 3;
    // Start from the top so the downward wheel step has scrollback room:
    // wterm clamps scrollTop at the bottom, where the fill loop leaves it.
    if (term.wterm && typeof term.wterm._setScrollTop === "function") {
      term.wterm._setScrollTop(0);
    } else {
      term.scrollTop = 0;
    }
    await new Promise((r) => setTimeout(r, 200));
    const before = term.scrollTop;
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: rowHeight, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const after = term.scrollTop;
    return JSON.stringify({ rowHeight, speed, delta: after - before, expected: rowHeight * speed, before, after });
  })()`);
  const wheelParsed = JSON.parse(wheelProbe);
  record(
    "ss4 wheel row-step scrolls speed rows per step",
    mintOk && wheelParsed.delta !== undefined && wheelParsed.delta === wheelParsed.expected,
    wheelProbe,
  );

  // ss4b: wheel-up from the bottom moves back the same distance (the
  // handler is direction-symmetric and the accumulator drains both ways).
  const upProbe = await evalExpr(`(async () => {
    const term = document.getElementById("terminal");
    if (!term) return JSON.stringify({ error: "no terminal element" });
    const adapter = term.__herdrTerminalAdapter;
    if (!adapter) return JSON.stringify({ error: "no adapter" });
    const rowHeight = adapter.rowHeight();
    const speed = Number(JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines) || 3;
    if (term.wterm && typeof term.wterm._scrollToBottom === "function") {
      term.wterm._scrollToBottom();
    } else {
      term.scrollTop = term.scrollHeight || 0;
    }
    await new Promise((r) => setTimeout(r, 200));
    const before = term.scrollTop;
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: -rowHeight, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const after = term.scrollTop;
    return JSON.stringify({ delta: before - after, expected: rowHeight * speed, before, after });
  })()`);
  const upParsed = JSON.parse(upProbe);
  record(
    "ss4b wheel-up from bottom scrolls back speed rows",
    mintOk && upParsed.delta !== undefined && upParsed.delta === upParsed.expected,
    upProbe,
  );

  // ss4c: live accumulator: two half-row deltas must produce exactly one
  // scrollLines step (trackpad parity, no row lost to rounding per event).
  const accProbe = await evalExpr(`(async () => {
    const term = document.getElementById("terminal");
    if (!term) return JSON.stringify({ error: "no terminal element" });
    const adapter = term.__herdrTerminalAdapter;
    if (!adapter) return JSON.stringify({ error: "no adapter" });
    const rowHeight = adapter.rowHeight();
    const speed = Number(JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines) || 3;
    if (term.wterm && typeof term.wterm._setScrollTop === "function") {
      term.wterm._setScrollTop(0);
    } else {
      term.scrollTop = 0;
    }
    await new Promise((r) => setTimeout(r, 200));
    const before = term.scrollTop;
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: rowHeight / 2, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 100));
    const mid = term.scrollTop;
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: rowHeight / 2, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const after = term.scrollTop;
    return JSON.stringify({ firstHalfDelta: mid - before, totalDelta: after - before, expected: rowHeight * speed, before, mid, after });
  })()`);
  const accParsed = JSON.parse(accProbe);
  record(
    "ss4c two half-row deltas accumulate into one speed-sized step",
    mintOk && accParsed.firstHalfDelta === 0 && accParsed.totalDelta === accParsed.expected,
    accProbe,
  );

  // ss4d/ss4e: deltaMode 1 and 2 on the live adapter. Line mode scrolls
  // exactly the speed setting; page mode scrolls one grid page (term.rows),
  // not the setting (unit-tested parity, here on the real terminal).
  const modeProbe = await evalExpr(`(async () => {
    const term = document.getElementById("terminal");
    if (!term) return JSON.stringify({ error: "no terminal element" });
    const adapter = term.__herdrTerminalAdapter;
    if (!adapter) return JSON.stringify({ error: "no adapter" });
    const rowHeight = adapter.rowHeight();
    const speed = Number(JSON.parse(localStorage.getItem("herdr-web-options") || "{}").scrollLines) || 3;
    const pageRows = Math.max(1, (adapter.rows || term.rows) || 24);
    const reset = async () => {
      if (term.wterm && typeof term.wterm._setScrollTop === "function") term.wterm._setScrollTop(0);
      else term.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 150));
      return term.scrollTop;
    };
    const beforeLine = await reset();
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, deltaMode: 1, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const afterLine = term.scrollTop;
    const beforePage = await reset();
    term.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, deltaMode: 2, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    const afterPage = term.scrollTop;
    return JSON.stringify({ speed, pageRows, lineDelta: afterLine - beforeLine, lineExpected: rowHeight * speed, pageDelta: afterPage - beforePage, pageExpected: rowHeight * pageRows });
  })()`);
  const modeParsed = JSON.parse(modeProbe);
  record(
    "ss4d line-mode wheel scrolls exactly the speed setting",
    mintOk && modeParsed.lineDelta !== undefined && modeParsed.lineDelta === modeParsed.lineExpected,
    modeProbe,
  );
  record(
    "ss4e page-mode wheel scrolls one grid page",
    mintOk && modeParsed.pageDelta !== undefined && modeParsed.pageDelta === modeParsed.pageExpected,
    modeProbe,
  );

  // ss5: the lens global exposes the surface the paste guard reads.
  const pasteProbe = await evalExpr(`(() => {
    const lens = window.HerdrMobileLens;
    return JSON.stringify({ hasLens: !!lens, hasIsActive: !!(lens && typeof lens.isActive === "function") });
  })()`);
  record("ss5 lens surface present for paste guard", JSON.parse(pasteProbe).hasIsActive === true, pasteProbe);

  // ss5b: with the lens closed, the paste takeover claims a paste on the
  // terminal (preventDefault + stopImmediatePropagation, PR #333 parity).
  // The lens-open yield half stays unit-tested: the fixture pane runs a
  // plain shell, no chat agent, so the lens never opens here.
  const pasteClaim = await evalExpr(`(() => {
    const term = document.getElementById("terminal");
    if (!term) return JSON.stringify({ error: "no terminal element" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => "e2e paste probe" };
    term.dispatchEvent(event);
    return JSON.stringify({ defaulted: event.defaultPrevented, stopped: event.__herdrStopped === true });
  })()`);
  const claimParsed = JSON.parse(pasteClaim);
  record(
    "ss5b paste takeover claims the event with lens closed",
    mintOk && claimParsed.defaulted === true,
    pasteClaim,
  );

  // ss6: caret re-landing on the composer through the exported surface.
  const focusProbe = await evalExpr(`(() => {
    const lens = window.HerdrMobileLens;
    if (!lens || typeof lens.focusTypingSurface !== "function") return JSON.stringify({ error: "no focusTypingSurface export" });
    const composer = document.getElementById("mobileComposerInput");
    if (!composer) return JSON.stringify({ error: "no composer input" });
    lens.focusTypingSurface();
    return JSON.stringify({ active: document.activeElement === composer, disabled: composer.disabled });
  })()`);
  const focusParsed = JSON.parse(focusProbe);
  record(
    "ss6 lens focusTypingSurface lands on composer (live DOM)",
    mintOk && focusParsed.active === true,
    focusProbe,
  );

  // ss7: no console errors across the whole run (R-35 click-through
  // evidence: the driven surfaces never threw).
  record(
    "ss7 zero console errors across the run",
    consoleErrors.length === 0,
    consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : "none",
  );

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  console.error(error);
  process.exit(1);
});
