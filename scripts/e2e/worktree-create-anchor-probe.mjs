// Live-browser check for the worktree chip popover's create entry.
// The create button inside the chip popover must morph that popover in
// place: the discovery create view opens at the chip popover's position,
// not a second popover at the path chip. Launches its own headless shell
// against an already-running preview (PREVIEW_PORT, default 8788).
import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PREVIEW_PORT = process.env.PREVIEW_PORT || "8788";
const BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9777);
const CHROME = `${process.env.HOME}/.agents/chrome-headless-shell/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const recorder = makeRecorder();

const profile = mkdtempSync(join(tmpdir(), "herdr-anchor-probe-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function evalJs(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
  return res.result && res.result.value;
}

try {
  await sleep(1500);
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${BASE}/` });
  await sleep(1500);

  // Open a real git repo as the workspace so the chips render. Use the
  // exposed open-folder flow on the main checkout (it has linked worktrees
  // and a rich branch list).
  const repoRoot = process.env.REPO_ROOT || "/Users/alejandro.blanco/Documents/projects/herdr-webui";
  await evalJs(cdp, `window.HerdrOpenFolder && window.HerdrOpenFolder.createPlainWorkspace(${JSON.stringify(repoRoot)})`);
  await sleep(2500);
  const chips = await evalJs(cdp, `(() => ({
    pathChip: !!document.querySelector(".location-bar-path-chip"),
    worktreeChip: !!document.querySelector(".location-bar-worktree-chip"),
    branchChip: !!document.querySelector(".location-bar-branch-chip"),
    title: document.title,
  }))()`);
  recorder.record("workspace opened with chips", chips.pathChip || chips.worktreeChip, JSON.stringify(chips));

  if (!(chips.pathChip || chips.worktreeChip)) {
    writeReport(join(tmpdir(), "worktree-create-anchor-report.json"), recorder);
    process.exit(1);
  }

  // Open the worktree chip popover (or branch popover fallback).
  await evalJs(cdp, `(() => {
    const chip = document.querySelector(".location-bar-worktree-chip") || document.querySelector(".location-bar-branch-chip");
    if (chip) chip.click();
    return "chip-clicked";
  })()`);
  await sleep(1200);
  const before = await evalJs(cdp, `(() => {
    const pop = document.querySelector(".location-bar-worktree-popover, .location-bar-branch-popover");
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
  })()`);
  recorder.record("chip popover open", !!before, JSON.stringify(before));

  // Press the create button inside the chip popover.
  const created = await evalJs(cdp, `(() => {
    const btn = document.querySelector('.location-bar-worktree-popover .git-ui-worktree-create, .location-bar-branch-popover .git-ui-worktree-create');
    if (!btn) return "no-create-button";
    btn.click();
    return "clicked";
  })()`);
  await sleep(2000);

  const after = await evalJs(cdp, `(() => {
    const pop = document.querySelector(".location-bar-discovery-popover");
    if (!pop) return null;
    const r = pop.getBoundingClientRect();
    const style = pop.getAttribute("style") || "";
    return {
      left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width),
      style,
      hasForm: !!pop.querySelector("#locationBarDiscoveryName"),
      hasBase: !!pop.querySelector("#locationBarDiscoveryBase"),
      hasCaret: !!pop.querySelector(".location-bar-base-picker-indicator"),
      hasToggle: !pop.querySelector('[data-discovery-focus="base-picker-toggle"]'),
      filterHidden: !pop.querySelector("#locationBarDiscoveryFilter"),
      hasPull: !!pop.querySelector("#locationBarDiscoveryPullBase"),
      chipPopoverGone: !document.querySelector(".location-bar-worktree-popover, .location-bar-branch-popover"),
    };
  })()`);
  recorder.record("create entry clicked", created === "clicked", created);
  if (before && after) {
    const sameSpot = Math.abs(after.left - before.left) <= 2 && Math.abs(after.top - before.top) <= 2;
    recorder.record("discovery create view morphs the popover in place", sameSpot,
      `chip popover at ${before.left},${before.top} -> discovery at ${after.left},${after.top}`);
  } else {
    recorder.record("discovery create view morphs the popover in place", false, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  recorder.record("create view renders the form with the in-field caret and no standalone list",
    after && after.hasForm && after.hasBase && after.hasCaret && after.hasToggle && after.filterHidden && after.hasPull, JSON.stringify(after));
  recorder.record("old chip popover closed", after && after.chipPopoverGone, "");

  // Open the Base dropdown: the input click shows filter plus branch
  // rows, pick fills Base and closes the dropdown, Escape closes only
  // the dropdown.
  const opened = await evalJs(cdp, `(() => {
    const base = document.querySelector("#locationBarDiscoveryBase");
    if (!base) return "no-base-input";
    base.click();
    return "clicked";
  })()`);
  await sleep(1000);
  // Geometry: the dropdown is a fixed-position overlay anchored to the
  // Base field, so it escapes the popover's scroll container; the create
  // row, pull checkbox and footer stay visible, the panel stays inside
  // the viewport, and rows at the panel bottom actually hit-test inside
  // it (not clipped by any ancestor).
  const geometry = await evalJs(cdp, `(() => {
    const pop = document.querySelector(".location-bar-discovery-popover");
    const panel = pop && pop.querySelector("#locationBarBasePicker");
    if (!pop || !panel) return null;
    const view = window.innerHeight;
    const pr = panel.getBoundingClientRect();
    const createBtn = pop.querySelector('[data-discovery-focus="create"]');
    const pull = pop.querySelector("#locationBarDiscoveryPullBase");
    const footer = pop.querySelector(".location-bar-discovery-footer");
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom <= view && r.height > 0;
    };
    // The panel's own last row must hit-test to an element still inside
    // the panel: a clipped panel returns outside nodes here.
    const rows = panel.querySelectorAll('.git-ui-branch-row-main, .git-ui-branch-load-more, .git-ui-branch-list-empty');
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    let lastRowHitInside = true;
    if (lastRow) {
      const rr = lastRow.getBoundingClientRect();
      if (rr.height > 0 && pr.height > 0) {
        const y = Math.min(rr.top + Math.min(rr.height, 4) / 2, pr.bottom - 2);
        const hit = document.elementFromPoint(Math.round(pr.left + Math.min(pr.width / 2, 60)), Math.round(y));
        lastRowHitInside = !!hit && panel.contains(hit);
      }
    }
    return {
      panelTop: Math.round(pr.top),
      panelBottom: Math.round(pr.bottom),
      viewport: view,
      withinViewport: pr.top >= -1 && pr.bottom <= view + 1,
      createVisible: visible(createBtn),
      pullVisible: visible(pull),
      footerVisible: visible(footer),
      overlay: getComputedStyle(panel).position === "fixed",
      rowsHitInsidePanel: lastRowHitInside,
    };
  })()`);
  recorder.record("Base dropdown overlays without clipping the form",
    !!geometry && geometry.withinViewport && geometry.overlay && geometry.rowsHitInsidePanel && geometry.createVisible && geometry.pullVisible && geometry.footerVisible,
    JSON.stringify(geometry));
  const picked = await evalJs(cdp, `(() => {
    const pop = document.querySelector(".location-bar-discovery-popover");
    const panel = pop && pop.querySelector("#locationBarBasePicker");
    const filter = panel && panel.querySelector("#locationBarDiscoveryFilter");
    const local = panel && !!panel.textContent.includes("Local branches");
    const pick = panel && panel.querySelector('[onclick*="discoveryPickBaseFromRow"]');
    let pickLabel = "";
    if (pick) {
      pick.click();
      const base = document.querySelector("#locationBarDiscoveryBase");
      pickLabel = base && base.value || "";
    }
    return {
      panel: !!panel,
      filter: !!filter,
      localRows: local,
      pickedBase: pickLabel,
      panelGoneAfterPick: !document.querySelector("#locationBarBasePicker"),
      popSurvives: !!document.querySelector(".location-bar-discovery-popover"),
    };
  })()`);
  recorder.record("Base input click opens the Base dropdown", opened === "clicked" && picked && picked.panel && picked.filter && picked.localRows, JSON.stringify({ opened, picked }));
  recorder.record("picking a row fills Base and closes the dropdown",
    picked && picked.pickedBase && picked.panelGoneAfterPick && picked.popSurvives, JSON.stringify(picked));

  // Reopen and check Escape closes only the dropdown.
  const escapeCheck = await evalJs(cdp, `(() => {
    const base = document.querySelector("#locationBarDiscoveryBase");
    if (!base) return { reopened: false };
    base.click();
    const panel = document.querySelector("#locationBarBasePicker");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return {
      reopened: !!panel,
      closedAfterEscape: !document.querySelector("#locationBarBasePicker"),
      popSurvives: !!document.querySelector(".location-bar-discovery-popover"),
    };
  })()`);
  recorder.record("Escape closes only the Base dropdown",
    escapeCheck && escapeCheck.reopened && escapeCheck.closedAfterEscape && escapeCheck.popSurvives, JSON.stringify(escapeCheck));

  // Cleanup: cancel the draft and dismiss.
  await evalJs(cdp, `(() => {
    const cancel = Array.from(document.querySelectorAll(".location-bar-discovery-popover button")).find((b) => /cancel/i.test(b.textContent || ""));
    if (cancel) cancel.click();
    return "done";
  })()`);
  await sleep(400);
  await evalJs(cdp, `(() => { document.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "done"; })()`);
  await sleep(400);

  // Optional default-branch offer check: OFFER_FOLDER must be a plain
  // checkout on a non-default branch. The discovery list should show an
  // "Open on <default>" row that names the current branch.
  if (process.env.OFFER_FOLDER) {
    await evalJs(cdp, `window.HerdrLocationBar && window.HerdrLocationBar.openDiscoveryForFolder(${JSON.stringify(process.env.OFFER_FOLDER)})`);
    await sleep(2000);
    const offer = await evalJs(cdp, `(() => {
      const pop = document.querySelector(".location-bar-discovery-popover");
      if (!pop) return null;
      const row = pop.querySelector(".location-bar-default-branch-offer");
      const text = row ? row.textContent || "" : "";
      return {
        offer: !!row,
        text: text.trim().replace(/\s+/g, " "),
        currentNamed: /current branch:/.test(text),
      };
    })()`);
    recorder.record("default-branch offer renders for a checkout on another branch",
      !!offer && offer.offer && offer.currentNamed, JSON.stringify(offer));
  }

  writeReport(join(tmpdir(), "worktree-create-anchor-report.json"), recorder);
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(recorder.failed ? 1 : 0);