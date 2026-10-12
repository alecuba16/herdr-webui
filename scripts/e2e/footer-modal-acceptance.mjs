// Real-DOM acceptance for the merged footer settings modal: one footer
// button, settings + Help & Shortcuts in one modal, left section rail with
// accent current, click-nav scroll, prefix ? opening at the help section,
// search scoping, Escape close, and the narrow-window chip rail (desktop
// layout forced: sub-760px sessions boot the mobile bundle instead).
// Uses the already-running no-auth verify server (scripts/e2e/.tmp-footer-verify).
import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9223";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8915/";
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/footer_modal_e2e_result.json`;

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
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

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3000);

  // 1. core.js ran to completion: footer exists with exactly the merged button.
  const footer = await evalExpr(`(() => {
    const b = document.getElementById("footerSettingsButton");
    const old = document.getElementById("footerShortcutsButton");
    return { merged: !!b, oldGone: !old, title: b ? b.title : null };
  })()`);
  record("footer has the single merged settings button", footer.merged && footer.oldGone, JSON.stringify(footer));

  // 2. Modal opens from the footer button; shell + nav + body all present.
  const opened = await evalExpr(`(() => {
    document.getElementById("footerSettingsButton").click();
    const m = document.getElementById("settingsModal");
    const shell = m && m.querySelector(".settings-shell");
    const nav = m && m.querySelector("#settingsNav");
    const body = m && m.querySelector(".settings-body");
    const help = m && m.querySelector(".settings-help-section");
    return {
      visible: m && m.style.display !== "none",
      shell: !!shell, nav: !!nav, body: !!body, help: !!help,
      navItems: nav ? nav.querySelectorAll(".settings-nav-item").length : 0,
      labels: nav ? Array.from(nav.querySelectorAll(".settings-nav-item")).map((n) => n.textContent.trim()) : [],
    };
  })()`);
  record("settings modal: shell, nav rail, body, help section all present", opened.shell && opened.nav && opened.body && opened.help, JSON.stringify(opened));
  record("nav rail lists every section incl. Help & Shortcuts first", opened.navItems >= 5 && opened.labels[0] === "Help & Shortcuts", JSON.stringify(opened.labels));

  // 3. On open, the first visible section's nav item is current (accent).
  await sleep(600);
  const current = await evalExpr(`(() => {
    const item = document.querySelector("#settingsNav .settings-nav-item.settings-nav-current");
    const sections = Array.from(document.querySelectorAll(".settings-body > .settings-section"));
    const firstVisible = sections.find((s) => s.offsetParent !== null);
    const cs = item ? getComputedStyle(item) : null;
    const visibleHead = firstVisible && firstVisible.querySelector(":scope > .settings-section-head h3");
    return {
      found: !!item,
      label: item ? item.textContent.trim() : null,
      color: cs ? cs.color : null,
      firstSectionLabel: visibleHead ? visibleHead.textContent.trim() : null,
      currentCount: document.querySelectorAll("#settingsNav .settings-nav-item.settings-nav-current").length,
    };
  })()`);
  record("open marks the top visible section current, exactly one", current.found && current.currentCount === 1 && current.firstSectionLabel === current.label, JSON.stringify(current));

  // 4. Clicking the last nav item scrolls to it and moves the accent there.
  //    Fresh open first: a click issued while a previous smooth scroll is
  //    still animating races two scrollTo animations and the second can
  //    land short.
  const navMove = await evalExpr(`(async () => {
    document.getElementById("settingsCloseTop").click();
    await new Promise((r) => setTimeout(r, 250));
    document.getElementById("footerSettingsButton").click();
    await new Promise((r) => setTimeout(r, 700));
    const modal = document.querySelector("#settingsModal .modal");
    const items = Array.from(document.querySelectorAll("#settingsNav .settings-nav-item"));
    const last = items[items.length - 1];
    last.click();
    await new Promise((r) => setTimeout(r, 1500));
    const cur = document.querySelector("#settingsNav .settings-nav-item.settings-nav-current");
    const nearBottom = modal && (modal.scrollHeight - modal.scrollTop - modal.clientHeight) < 240;
    return { clicked: last.textContent.trim(), currentLabel: cur ? cur.textContent.trim() : null, nearBottom };
  })()`);
  record("click-nav moves the accent and scrolls modal to that section", navMove.currentLabel === navMove.clicked && navMove.nearBottom, JSON.stringify(navMove));

  // 5. Prefix ? (Ctrl+B then ?) opens the modal at the Help & Shortcuts section.
  const atHelp = await evalExpr(`(async () => {
    document.getElementById("settingsCloseTop").click();
    await new Promise((r) => setTimeout(r, 200));
    document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, metaKey: false, bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", code: "Slash", shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const m = document.getElementById("settingsModal");
    const cur = document.querySelector("#settingsNav .settings-nav-item.settings-nav-current");
    return { open: m && m.style.display !== "none", currentLabel: cur ? cur.textContent.trim() : null };
  })()`);
  record("prefix ? opens settings at Help & Shortcuts", atHelp.open && atHelp.currentLabel === "Help & Shortcuts", JSON.stringify(atHelp));

  // 6. Settings search narrows settings sections; help hides during the
  //    search (it holds reference docs, not rows) and returns when cleared.
  const search = await evalExpr(`(async () => {
    const input = document.getElementById("settingsSearch");
    input.value = "theme";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const sections = Array.from(document.querySelectorAll(".settings-body > .settings-section"));
    const help = document.querySelector(".settings-body > .settings-help-section");
    const visibleSettings = sections.filter((s) => !s.classList.contains("settings-help-section") && !s.classList.contains("settings-filter-hidden")).length;
    const helpHiddenDuringSearch = help && help.classList.contains("settings-filter-hidden");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const helpBack = help && !help.classList.contains("settings-filter-hidden");
    return { visibleSettings, helpHiddenDuringSearch, helpBack, total: sections.length };
  })()`);
  record("search narrows settings sections; help hides during search and returns when cleared", search.visibleSettings >= 1 && search.visibleSettings < search.total && search.helpHiddenDuringSearch && search.helpBack, JSON.stringify(search));

  // 7. Escape closes the merged modal.
  const esc = await evalExpr(`(async () => {
    const m = document.getElementById("settingsModal");
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { closed: m.style.display === "none" };
  })()`);
  record("Escape closes the settings modal", esc.closed, JSON.stringify(esc));

  // 8. Narrow desktop window (not mobile layout): rail becomes horizontal
  //    chips with 44px targets. Force the desktop bundle first: under
  //    760px app_boot would otherwise reload into the mobile bundle,
  //    which ships its own settings UI without this rail.
  await evalExpr(`(() => { try { localStorage.setItem("herdr-web-layout", "desktop"); } catch (_) {} return "set"; })()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const mobilePrep = await evalExpr(`(() => {
    if (document.getElementById("footerSettingsButton")) return "ready";
    if (document.getElementById("settingsToggle")) return "no-footer";
    return "dead";
  })()`);
  if (mobilePrep !== "ready") {
    await cdp.send("Page.navigate", { url: APP_URL });
    await sleep(3000);
  }
  const mobile = await evalExpr(`(() => {
    const btn = document.getElementById("footerSettingsButton");
    if (!btn) return { missingButton: true };
    btn.click();
    const nav = document.getElementById("settingsNav");
    const cs = getComputedStyle(nav);
    const first = nav.querySelector(".settings-nav-item");
    const firstCs = first ? getComputedStyle(first) : null;
    return {
      dir: cs.flexDirection,
      height: firstCs ? firstCs.height : null,
      scrollable: nav.scrollWidth >= nav.clientWidth,
    };
  })()`);
  record("mobile: rail becomes horizontal chips with 44px targets", mobile.dir === "row" && mobile.height === "44px", JSON.stringify(mobile));

  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((err) => {
  record("driver crashed", false, String(err));
  writeReport(outPath, recorder);
  process.exit(1);
});