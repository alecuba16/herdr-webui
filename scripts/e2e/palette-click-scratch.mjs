// Scratch validation probe: palette row click must fire
// the learn-by-use toast through runSearchAction's hint map, the route a
// mouse user takes (prefix-run route is covered by chord-hints).
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8914/";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9232";
const OUT = process.argv[2];

async function main() {
  const recorder = makeRecorder();
  const version = await fetchJson(`${CDP_HTTP}/json/version`);
  const pages = await fetchJson(`${CDP_HTTP}/json/list`);
  const page = pages.find((p) => p.type === "page");
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result && r.result.value;
  };

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(1500);

  const evalScript = await evalJs(`(() => {
    // The mobile page never mounts the desktop palette; bail early so
    // the check reports (no palette) instead of crashing.
    if (!document.getElementById("searchPalette")) return "(no palette)";
    openSearchPalette();
    return "opened";
  })()`);
  if (evalScript !== "opened") {
    recorder.record("palette opens for the click route", false, `got ${evalScript}`);
  } else {
    recorder.record("palette opens for the click route", true, "opened");
  }
  await sleep(500);

  // Row click on toggle-sidebar: DOM click, the exact mouse route.
  const clicked = await evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll("#searchPalette [data-action], #searchPalette .search-result, #searchPalette button"));
    const row = rows.find((r) => (r.textContent || "").includes("sidebar"));
    if (!row) return "(no sidebar row)";
    row.click();
    return "clicked: " + row.className;
  })()`);
  recorder.record("sidebar row found and clicked", /^clicked:/.test(String(clicked)), `got ${clicked}`);
  await sleep(400);

  const toast = await evalJs(`(() => {
    const t = document.querySelector(".shortcut-hint-toast");
    if (!t) return "(no toast)";
    return [t.querySelector(".shortcut-hint-toast-label"), t.querySelector(".shortcut-hint-toast-prefix"), t.querySelector(".shortcut-hint-toast-key")].map((n) => (n ? n.textContent : "")).join(" / ");
  })()`);
  recorder.record("row click fires the chord toast", /Toggle sidebar\s*\/\s*Ctrl\+B\s*\/\s*B/.test(String(toast)), `got ${toast}`);

  // The click toggled the sidebar; flip it back so nothing leaks.
  await evalJs(`(() => { if (typeof toggleSidebar === "function") { toggleSidebar(); return "restored"; } const b = document.getElementById("sidebarToggle"); if (b) b.click(); return "clicked-toggle"; })()`);

  writeReport(OUT, recorder, { app: APP_URL, chrome: version.Browser });
  if (recorder.failed) {
    console.error(`FAIL palette-click: ${recorder.failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK palette-click: ${recorder.passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  writeCrashReport(OUT, err, { app: APP_URL });
  console.error(`CRASH palette-click: ${err && err.message ? err.message : String(err)}`);
  process.exit(2);
});