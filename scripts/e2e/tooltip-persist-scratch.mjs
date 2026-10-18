// Scratch validation probe: the sidebar toggle tooltip
// must keep its chord suffix across render() polls. Boot asserts the
// chord, then drives refresh() the way the events socket does (a failed
// refresh also calls render(), and visibilitychange calls refresh()),
// and finally rechecks the tooltip.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8916/";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9234";
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
  await sleep(2500);

  // 1. After boot both toggles carry the live chord.
  const readTitles = () => evalJs(`(() => {
    const side = document.getElementById("sidebarToggle");
    const right = document.getElementById("rightSidebarToggle");
    return JSON.stringify({ side: side ? side.title : "(missing)", right: right ? right.title : "(missing)" });
  })()`);
  const bootTitles = JSON.parse(await readTitles());
  recorder.record("boot: sidebar toggle title has chord", /Hide sidebar \(Ctrl\+B then B\)/.test(String(bootTitles.side)), `got ${bootTitles.side}`);
  recorder.record("boot: right sidebar toggle title has chord", /workspace views \(Ctrl\+B then [A-Z[]/.test(String(bootTitles.right)), `got ${bootTitles.right}`);

  // 2. Drive a render() poll the way the UI does: a click on the toggle
  // itself runs applySidebarCollapsed + syncShortcutTooltips, and every
  // refresh()/render() pass re-runs applySidebarCollapsed. Click twice
  // to collapse then re-expand, checking the title after each pass.
  await evalJs(`document.getElementById("sidebarToggle").click()`);
  await sleep(300);
  const collapsedTitles = JSON.parse(await readTitles());
  recorder.record("after collapse: title keeps chord", /Show sidebar \(Ctrl\+B then B\)/.test(String(collapsedTitles.side)), `got ${collapsedTitles.side}`);

  await evalJs(`document.getElementById("sidebarToggle").click()`);
  await sleep(300);
  const expandedTitles = JSON.parse(await readTitles());
  recorder.record("after re-expand: title keeps chord", /Hide sidebar \(Ctrl\+B then B\)/.test(String(expandedTitles.side)), `got ${expandedTitles.side}`);

  // 3. Force refresh() passes: visibilitychange fires refresh() in
  // bindings.js (tab return path), and every refresh ends in render(),
  // which re-runs applySidebarCollapsed.
  await evalJs(`(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
    return "refresh-dispatched";
  })()`);
  await sleep(1200);
  const afterRefresh = JSON.parse(await readTitles());
  recorder.record("after refresh cycle: title keeps chord", /Hide sidebar \(Ctrl\+B then B\)/.test(String(afterRefresh.side)), `got ${afterRefresh.side}`);
  recorder.record("after refresh cycle: right toggle keeps chord", /workspace views \(Ctrl\+B/.test(String(afterRefresh.right)), `got ${afterRefresh.right}`);

  // 4. aria-label must match the title (screen-reader parity).
  const ariaOk = await evalJs(`(() => {
    const side = document.getElementById("sidebarToggle");
    return side && side.title === side.getAttribute("aria-label");
  })()`);
  recorder.record("aria-label matches chord title", ariaOk === true, `got ${ariaOk}`);

  writeReport(OUT, recorder, { app: APP_URL, chrome: version.Browser });
  if (recorder.failed) {
    console.error(`FAIL tooltip-persist: ${recorder.failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK tooltip-persist: ${recorder.passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  writeCrashReport(OUT, err, { app: APP_URL });
  console.error(`CRASH tooltip-persist: ${err && err.message ? err.message : String(err)}`);
  process.exit(2);
});