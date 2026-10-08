// Real-DOM acceptance for the reworked Git-log hover card.
//
// The behavioral suites render HerdrGitLog.render in a vm; this script runs
// the actual served bundle in headless Chrome against a real fixture repo
// with tags and verifies the DOM: labeled field rows (Commit id / Tags /
// Author / Date), one copy command per field, one per tag chip, and the copy
// toast actually appearing after a click. Server + Chrome are started by
// scripts/e2e/run-log-hover-e2e.sh.
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9224";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/log_hover_e2e_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-log-hover-e2e.sh)");
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
  // Match the desktop audits' viewport so the git drawer does not push log
  // rows past the right edge (hover points must land inside the window).
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch (_) { /* degrade: hover checks may skip if the window is tiny */ }
  // Headless Chrome denies navigator.clipboard by default; grant it so the
  // copy commands can run their real write path.
  try {
    await cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  } catch (_) { /* older builds: the click check degrades gracefully */ }

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

  // Create a workspace on the fixture repo through the real API, then
  // navigate to the routed URL (root "/" boots clean).
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "log-hover-e2e"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  record("workspace created on fixture repo", true, wsId);
  await reload(`${APP_URL}session/default/workspace/${wsId}`);

  // Wait for the app state to carry the workspace list.
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

  // Open the Git drawer and switch to the Log tab via the real API.
  const opened = await evalExpr(`new Promise((resolve) => {
    const btn = document.getElementById("gitWorkspaceToggle");
    if (!btn) { resolve("no toggle"); return; }
    btn.click();
    const started = Date.now();
    const check = () => {
      const panel = document.getElementById("gitUiPanel");
      if (panel) { resolve("opened"); return; }
      if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("git drawer opened", opened === "opened", `got ${opened}`);
  if (opened !== "opened") throw new Error("git drawer never opened");

  await evalExpr(`HerdrGitUi.tab('log')`);
  const rows = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const nodes = document.querySelectorAll(".git-ui-log-row[data-log-hash]");
      if (nodes.length) resolve("rows:" + nodes.length);
      else if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("log tab shows commit rows", rows.startsWith("rows:"), `got ${rows}`);
  if (!rows.startsWith("rows:")) throw new Error("log never rendered rows");

  // 1. The tagged commit row carries a hover card with all four labeled
  //    field rows.
  const fields = await evalExpr(`(() => {
    const cards = document.querySelectorAll(".git-ui-log-hover-card");
    for (const card of cards) {
      const cardText = card.textContent || "";
      if (card.querySelector(".git-ui-log-hover-tag")) {
        const labels = Array.from(card.querySelectorAll(".git-ui-log-hover-field-label")).map((el) => el.textContent);
        const tags = Array.from(card.querySelectorAll(".git-ui-log-hover-tag")).map((el) => el.textContent.replace(/\\u2319$/, "").trim());
        const buttons = Array.from(card.querySelectorAll("button.git-ui-log-copy-hash")).map((el) => el.getAttribute("title") || "");
        return JSON.stringify({ labels, tags, buttons });
      }
    }
    return "no tagged card";
  })()`);
  let tagged = null;
  try { tagged = JSON.parse(fields); } catch { tagged = null; }
  record("tagged hover card has all four field rows", !!tagged && ["Commit id", "Tags", "Author", "Date"].every((l) => (tagged.labels || []).includes(l)), fields.slice(0, 300));
  record("tag chips render without the tag: prefix", !!tagged && (tagged.tags || []).length >= 2 && (tagged.tags || []).every((t) => !t.includes("tag:")), fields.slice(0, 300));

  // 2. Every field with a value has its own copy command; tag copies carry
  //    the "Tag <name>" kind.
  const tagButtons = (tagged && tagged.buttons || []).filter((b) => b.startsWith("Copy Tag "));
  record("one copy command per tag", tagButtons.length >= 2, JSON.stringify(tagButtons));
  const expectedFields = tagged ? ["Copy Commit id", "Copy Author", "Copy Date", "Copy Commit message"].filter((b) => (tagged.buttons || []).includes(b)) : [];
  record("per-field copy commands present", expectedFields.length >= 3, JSON.stringify(expectedFields));

  // 3. Clicking a tag's copy button writes to the clipboard and shows the
  //    positioned toast. A synthetic el.click() carries no user activation,
  //    so navigator.clipboard.writeText would be denied; dispatch real
  //    trusted mouse input through CDP instead. Order matters: the card is
  //    display:none until the row is hovered, and the button is display:none
  //    until the card is hovered, so hover the row, confirm the card is
  //    visible, only then measure the button rect (hidden elements report
  //    zero rects) and move+click onto it.
  const hoverRow = async () => {
    const rowPoint = await evalExpr(`(() => {
      const card = Array.from(document.querySelectorAll(".git-ui-log-hover-card")).find((c) => c.querySelector(".git-ui-log-hover-tag"));
      const row = card && card.closest(".git-ui-log-row");
      if (!row) return null;
      const r = row.getBoundingClientRect();
      // Clamp inside the viewport: wide rows can extend past the right edge,
      // and a hover point outside the window never opens the card.
      const x = Math.min(Math.max(r.x + 24, 8), window.innerWidth - 8);
      const y = Math.min(Math.max(r.y + Math.min(r.height / 2, 8), 8), window.innerHeight - 8);
      return JSON.stringify({ x, y });
    })()`);
    if (!rowPoint) return "no-row";
    const rp = JSON.parse(rowPoint);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rp.x, y: rp.y, button: "none", buttons: 0 });
    const cardShown = await evalExpr(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const card = Array.from(document.querySelectorAll(".git-ui-log-hover-card")).find((c) => c.querySelector(".git-ui-log-hover-tag"));
        if (card && getComputedStyle(card).display !== "none") { resolve("shown"); return; }
        if (Date.now() - started > 5000) resolve("card-hidden");
        else setTimeout(check, 150);
      };
      check();
    })`);
    return cardShown;
  };
  const cardState = await hoverRow();
  let clicked = "no-card:" + cardState;
  if (cardState === "shown") {
    // Moving onto the card body flips .git-ui-log-hover-card:hover, which
    // is what reveals the copy buttons; only then does the button have a
    // non-zero rect to measure and click.
    const cardPoint = await evalExpr(`(() => {
      const card = Array.from(document.querySelectorAll(".git-ui-log-hover-card")).find((c) => c.querySelector(".git-ui-log-hover-tag"));
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const x = Math.min(Math.max(r.x + 30, 8), window.innerWidth - 8);
      const y = Math.min(Math.max(r.y + 20, 8), window.innerHeight - 8);
      return JSON.stringify({ x, y });
    })()`);
    if (cardPoint) {
      const cp = JSON.parse(cardPoint);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cp.x, y: cp.y, button: "none", buttons: 0 });
      await sleep(250);
    }
    const btnPoint = await evalExpr(`(() => {
      const card = Array.from(document.querySelectorAll(".git-ui-log-hover-card")).find((c) => c.querySelector(".git-ui-log-hover-tag"));
      const btn = card && card.querySelector(".git-ui-log-hover-tag button");
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return "zero-rect";
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (btnPoint && btnPoint !== "zero-rect") {
      const pt = JSON.parse(btnPoint);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, button: "none", buttons: 0 });
      await sleep(250);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", buttons: 0, clickCount: 1 });
      clicked = await evalExpr(`new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
          const toast = document.querySelector(".git-ui-scope-copy-toast");
          if (toast) {
            const text = toast.textContent || "";
            navigator.clipboard.readText().then((clipped) => resolve("toast:" + text + "|clipboard:" + clipped)).catch(() => resolve("toast:" + text + "|clipboard:unreadable"));
            return;
          }
          if (Date.now() - started > 8000) resolve("no-toast");
          else setTimeout(check, 200);
        };
        check();
      })`);
    } else {
      clicked = "bad-button-point:" + String(btnPoint);
    }
  }
  record("tag copy click shows toast", clicked.startsWith("toast:"), clicked.slice(0, 200));
  record("tag copy toast names the tag", clicked.includes("copied") && /Tag [^|]+copied/.test(clicked.split("|")[0]), clicked.slice(0, 200));

  // 4. A tagless commit shows "None" in the Tags row and no empty-field
  //    copy buttons.
  const none = await evalExpr(`(() => {
    for (const card of document.querySelectorAll(".git-ui-log-hover-card")) {
      if (!card.querySelector(".git-ui-log-hover-tag")) {
        const text = card.textContent || "";
        const empties = Array.from(card.querySelectorAll(".git-ui-log-hover-empty")).map((el) => el.textContent);
        const buttons = Array.from(card.querySelectorAll("button.git-ui-log-copy-hash")).map((el) => el.getAttribute("title") || "");
        return JSON.stringify({ hasNone: empties.includes("None"), buttons });
      }
    }
    return "no plain card";
  })()`);
  let plain = null;
  try { plain = JSON.parse(none); } catch { plain = null; }
  record("tagless card shows None for Tags", !!plain && plain.hasNone === true, none.slice(0, 200));
  record("tagless card still copies hash/message", !!plain && (plain.buttons || []).includes("Copy Commit id"), none.slice(0, 200));

  // 5. Selected row gets the accent-2 background.
  const selected = await evalExpr(`new Promise((resolve) => {
    const row = document.querySelector(".git-ui-log-row[data-log-hash]");
    if (!row) { resolve("no row"); return; }
    row.click();
    const started = Date.now();
    const check = () => {
      const sel = document.querySelector(".git-ui-log-row.selected");
      if (sel) {
        const bg = getComputedStyle(sel).backgroundColor;
        resolve("selected:" + bg);
        return;
      }
      if (Date.now() - started > 8000) resolve("no-selected");
      else setTimeout(check, 200);
    };
    check();
  })`);
  record("selected row highlights", selected.startsWith("selected:"), selected);
  // accent-2 is a translucent accent tint; Chrome reports it in the modern
  // color(srgb r g b / a) syntax with alpha < 1, while the panel greys are
  // opaque. Assert translucency plus a blue-dominant accent channel.
  const bg = selected.replace("selected:", "");
  const alphaMatch = bg.match(/\/ ([01](?:\.\d+)?)/);
  const rgbMatch = bg.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  const tinted = !!alphaMatch && parseFloat(alphaMatch[1]) < 1 && !!rgbMatch && parseFloat(rgbMatch[2]) > parseFloat(rgbMatch[1]) && parseFloat(rgbMatch[3]) > parseFloat(rgbMatch[1]);
  record("selected row background is the accent tint, not an opaque panel grey", tinted, `computed ${bg}`);

  // Screenshot evidence of the reworked card.
  try {
    await evalExpr(`(() => { const row = document.querySelector(".git-ui-log-row[data-log-hash]"); if (row) row.scrollIntoView({block: "center"}); return "ok"; })()`);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const dir = process.env.JCODE_SCRATCH_DIR || ".";
    writeFileSync(`${dir}/log_hover_e2e.png`, Buffer.from(shot.data, "base64"));
    record("screenshot captured", true, `${dir}/log_hover_e2e.png`);
  } catch (e) {
    record("screenshot captured", false, String(e));
  }

  // DOM hygiene: open Settings and audit for duplicate element ids (the
  // settings-module injection used to re-insert sections, duplicating ids
  // like optLayoutMode) and for form fields without id/name (the vendored
  // terminal IME textarea).
  const settingsAudit = await evalExpr(`new Promise((resolve) => {
    const btn = document.getElementById("footerSettingsButton");
    if (!btn) { resolve("no settings button"); return; }
    btn.click();
    const started = Date.now();
    const check = () => {
      const modal = document.getElementById("settingsModal");
      if (!modal || modal.style.display === "none") {
        if (Date.now() - started > 8000) { resolve("modal never opened"); return; }
        setTimeout(check, 200); return;
      }
      const seen = new Map();
      const dupes = [];
      for (const node of document.querySelectorAll("[id]")) {
        const count = seen.get(node.id) || 0;
        seen.set(node.id, count + 1);
        if (count === 1) dupes.push(node.id);
      }
      const layoutCount = document.querySelectorAll("#optLayoutMode").length;
      const unnamed = Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"))
        .filter((f) => !f.id && !f.getAttribute("name"))
        .map((f) => (f.getAttribute("aria-label") || f.className || f.tagName).slice(0, 60));
      resolve(JSON.stringify({ dupes: dupes.slice(0, 20), layoutCount, unnamed }));
    };
    check();
  })`);
  let audit = null;
  try { audit = JSON.parse(settingsAudit); } catch { audit = null; }
  record("settings modal opens for the audit", !!audit, settingsAudit.slice(0, 200));
  if (audit) {
    record("no duplicate element ids in the document", audit.dupes.length === 0, JSON.stringify(audit.dupes));
    record("optLayoutMode appears exactly once", audit.layoutCount === 1, `count ${audit.layoutCount}`);
  }

  // The vendored terminal IME textarea must carry an id/name pair after the
  // wterm build patch (Chrome flags unnamed form fields).
  const ime = await evalExpr(`(() => {
    const area = document.querySelector("textarea[aria-label='Terminal']");
    return area ? JSON.stringify({ id: area.id || "", name: area.getAttribute("name") || "" }) : "no terminal textarea";
  })()`);
  let imeInfo = null;
  try { imeInfo = JSON.parse(ime); } catch { imeInfo = null; }
  record("terminal IME textarea has an id/name pair", !!imeInfo && !!imeInfo.id && !!imeInfo.name, ime.slice(0, 120));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder);
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeCrashReport(outPath, recorder, e);
  process.exit(1);
});
