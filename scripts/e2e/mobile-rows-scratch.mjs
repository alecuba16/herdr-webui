// Scratch validation probe: the mobile unified search
// sheet must list the deduped action rows. Chrome boots at a phone width
// so the (max-width: 760px) media query selects the mobile bundle.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8915/";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9233";
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

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2000);

  const isMobile = await evalJs(`window.matchMedia("(max-width: 760px)").matches && !!document.getElementById("mobileSearchResults")`);
  recorder.record("mobile bundle booted at phone width", isMobile === true, `got ${isMobile}`);

  // Open the unified search sheet the way the mobile UI does.
  const opened = await evalJs(`(() => {
    const nav = Array.from(document.querySelectorAll("nav.mobile-nav button")).find((b) => b.dataset.screen === "search");
    if (nav) {
      nav.click();
      return "nav-clicked";
    }
    const sheet = document.getElementById("mobileSearchSheet");
    if (sheet) {
      sheet.hidden = false;
      return "sheet-shown";
    }
    return "(no sheet found)";
  })()`,);
  recorder.record("mobile search sheet opens", /^(nav-clicked|sheet-shown)$/.test(String(opened)), `got ${opened}`);
  await sleep(600);

  // Empty query lists all candidates: settings must appear exactly once.
  const rows = await evalJs(`(() => {
    const box = document.getElementById("mobileSearchResults");
    if (!box) return "(no results box)";
    const buttons = Array.from(box.querySelectorAll("button.mobile-row"));
    return JSON.stringify(buttons.map((b) => b.textContent.trim()));
  })()`);
  const parsed = (() => { try { return JSON.parse(rows); } catch { return []; } })();
  const settingsCount = parsed.filter((t) => /settings/i.test(t)).length;
  recorder.record("mobile action rows list settings exactly once", settingsCount === 1, `settings rows: ${settingsCount}, rows: ${rows.slice(0, 300)}`);
  const titles = parsed.map((t) => t.slice(0, 40));
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  recorder.record("mobile action rows contain no duplicates", dupes.length === 0, `dupes: ${JSON.stringify(dupes)}`);
  const expectedActions = ["Open workspace", "Discover worktrees", "Manage sessions", "Toggle theme", "Settings"];
  const missing = expectedActions.filter((needle) => !parsed.some((t) => t.startsWith(needle)));
  recorder.record("mobile action rows all render", missing.length === 0, `missing: ${JSON.stringify(missing)}, rows: ${parsed.length}`);

  writeReport(OUT, recorder, { app: APP_URL, chrome: version.Browser });
  if (recorder.failed) {
    console.error(`FAIL mobile-rows: ${recorder.failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK mobile-rows: ${recorder.passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  writeCrashReport(OUT, err, { app: APP_URL });
  console.error(`CRASH mobile-rows: ${err && err.message ? err.message : String(err)}`);
  process.exit(2);
});