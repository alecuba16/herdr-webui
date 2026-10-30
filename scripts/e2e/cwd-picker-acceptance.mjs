// Real-DOM acceptance for the location bar path chip (workspace folder
// switching) and the removed drawer folder surfaces.
//
// The behavioral suites drive openPathPicker with a stubbed picker in a vm;
// this script runs the actual served bundle in headless Chrome and clicks the
// real DOM: the bar's path chip, the real directory picker tree, and the
// workspace switch it triggers. Server + Chrome are started by
// run-cwd-picker-e2e.sh.
//
// Flow checked (all against the served app, real clicks, real backend):
//  1. Workspace open on REPO_A -> the location bar renders the path chip
//     with REPO_A's basename and a branch chip for the repo.
//  2. The Git drawer holds no path title, folder picker, or return button
//     (plan phase 2b moved folder switching to the bar).
//  3. Clicking the path chip opens the real directory picker seeded with
//     REPO_A; navigating to REPO_B and pressing "Select this folder"
//     switches the workspace to REPO_B (bar chip, state.ws, rail status).
//  4. The same flow on a plain (non-repo) folder creates a workspace on
//     it; the bar keeps the path chip and drops the branch chip.
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9224";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const REPO_A = process.env.REPO_A;
const REPO_B = process.env.REPO_B;
const PLAIN = process.env.PLAIN_DIR;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/cwd_picker_e2e_result.json`;

if (!REPO_A || !REPO_B || !PLAIN) {
  console.error("REPO_A, REPO_B and PLAIN_DIR must be set (use scripts/e2e/run-cwd-picker-e2e.sh)");
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

  // Open the workspace on REPO_A through the real API, then navigate to it
  // with the same routed URL the app persists selection under.
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO_A)}, label: "cwd-picker-e2e"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  if (!made || !made.result) record("workspace created", false, JSON.stringify(made).slice(0, 200));
  else record("workspace created on repo A", true, "");
  const wsId = made && made.result ? (made.result.workspace && made.result.workspace.workspace_id) : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${wsId}` });
  await sleep(3000);

  // Wait until the app has the workspace list and a selected workspace; the
  // bar keys off state.ws and hides without one.
  const loaded = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const ws = state && state.workspaces && state.workspaces.length;
      if (ws && state.ws) { resolve("loaded"); return; }
      if (Date.now() - started > 30000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("app loaded the workspace list and selection", loaded === "loaded", `got ${loaded}`);

  // 1. Bar renders the workspace folder as a path chip plus a branch chip.
  const bar = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const bar = document.getElementById("locationBar");
      const chip = bar && bar.querySelector(".location-bar-path-chip");
      if (bar && !bar.hidden && chip) resolve("visible");
      else if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("location bar visible with the path chip", bar === "visible", `got ${bar}`);

  const step1 = await evalExpr(`(() => {
    const bar = document.getElementById("locationBar");
    const chip = bar.querySelector(".location-bar-path-chip");
    const branch = bar.querySelector(".location-bar-branch-chip");
    return {
      pathText: chip ? chip.textContent : "",
      pathIsButton: !!(chip && chip.tagName === "BUTTON"),
      hasOnclick: !!(chip && chip.getAttribute("onclick")),
      titleAttr: chip ? (chip.getAttribute("title") || "") : "",
      branchChip: !!branch,
      branchDisabled: !!(branch && branch.disabled),
    };
  })()`);
  record("path chip renders the workspace folder basename", step1.pathText.includes(REPO_A.split("/").pop()), step1.pathText);
  record("path chip is a button wired to the picker", step1.pathIsButton && step1.hasOnclick, JSON.stringify(step1));
  record("path chip title documents the change-folder hint", (step1.titleAttr || "").includes("Change workspace folder"), step1.titleAttr);
  const branchShown = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const chip = document.querySelector("#locationBar .location-bar-branch-chip");
      if (chip && !chip.disabled) resolve(chip.textContent);
      else if (Date.now() - started > 15000) resolve("timeout:" + (chip ? chip.textContent : "no chip"));
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("branch chip fills from the rail status probe", String(branchShown).includes("main"), `got ${branchShown}`);

  // 2. The Git drawer carries no folder surfaces (plan phase 2b).
  const drawer = await evalExpr(`new Promise((resolve) => {
    const btn = document.getElementById("rightRailGit");
    if (!btn) { resolve("no toggle"); return; }
    btn.click();
    const started = Date.now();
    const check = () => {
      const panel = document.getElementById("gitUiPanel");
      const ready = panel && panel.querySelector(".git-ui-branch-chip, .git-ui-btn");
      if (ready) resolve("opened");
      else if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("git drawer opened on the workspace repo", drawer === "opened", `got ${drawer}`);
  const step2 = await evalExpr(`(() => {
    const panel = document.getElementById("gitUiPanel");
    return {
      pathTitle: !!panel.querySelector(".git-ui-path-title"),
      returnButton: !!panel.querySelector(".git-ui-return-cwd-icon"),
      sideHead: !!panel.querySelector(".git-ui-side-bottom-head"),
      differsNotice: !!panel.querySelector(".git-ui-folder-different"),
      worktreeChip: !!panel.querySelector(".git-ui-worktree-chip"),
    };
  })()`);
  record("drawer has no path title or return button", !step2.pathTitle && !step2.returnButton && !step2.sideHead, JSON.stringify(step2));
  record("drawer has no differs notice", !step2.differsNotice, "");
  record("drawer keeps its worktree chip", step2.worktreeChip, "");

  // 3. Click the path chip: the real directory picker opens, seeded with REPO_A.
  await evalExpr(`document.querySelector("#locationBar .location-bar-path-chip").click()`);
  const pickerOpen = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const modal = document.getElementById("directoryPickerModal");
      if (modal) resolve({ open: true, text: modal.textContent.slice(0, 400) });
      else if (Date.now() - started > 10000) resolve({ open: false });
      else setTimeout(check, 200);
    };
    check();
  })`);
  record("clicking the path chip opens the real directory picker", pickerOpen.open === true, "");
  record("picker is seeded at the workspace folder", (pickerOpen.text || "").includes(REPO_A.split("/").pop()) || (pickerOpen.text || "").includes(REPO_A), (pickerOpen.text || "").slice(0, 120));

  // Navigate the picker to REPO_B and select it: the workspace switches.
  const picked = await evalExpr(`(async () => {
    HerdrDirectoryPicker.toggle(${JSON.stringify(encodeURIComponent(REPO_B))});
    await new Promise((r) => setTimeout(r, 1500));
    const modal = document.getElementById("directoryPickerModal");
    const select = modal && Array.from(modal.querySelectorAll("button")).find((b) => /Select this folder/.test(b.textContent || ""));
    if (!select) return "no select button";
    select.click();
    return "selected";
  })()`);
  record("picker selects repo B", picked === "selected", `got ${picked}`);

  const step3 = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const bar = document.getElementById("locationBar");
      const chip = bar && bar.querySelector(".location-bar-path-chip");
      const ws = state && state.workspaces ? (state.workspaces || []).find((w) => w.workspace_id === state.ws) : null;
      const wsCwd = ws ? (window.HerdrWorkspacePath ? window.HerdrWorkspacePath(ws) : ws.cwd || ws.path) : "";
      if (chip && (chip.textContent || "").includes(${JSON.stringify(REPO_B.split("/").pop())}) && wsCwd === ${JSON.stringify(REPO_B)}) resolve("switched");
      else if (Date.now() - started > 15000) resolve("timeout:" + JSON.stringify({chip: chip && chip.textContent, wsCwd}));
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("workspace switched to repo B (bar chip and state.ws)", step3 === "switched", `got ${step3}`);

  // The real backend answers status for the new workspace folder (the rail
  // probe refetches for it).
  const statusCheck = await evalExpr(`fetch(${JSON.stringify("/api/git-ui/status?cwd=" + encodeURIComponent(REPO_B))}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const branchOk = !!statusCheck && !!statusCheck.branch && statusCheck.repo_path === REPO_B;
  record("real backend status answers for repo B folder", branchOk, JSON.stringify(statusCheck).slice(0, 160));

  // 4. Plain folder: the same bar flow creates a workspace on it; the bar
  // keeps the path chip and drops the branch chip (no repo).
  await evalExpr(`document.querySelector("#locationBar .location-bar-path-chip").click()`);
  const picker4 = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const modal = document.getElementById("directoryPickerModal");
      if (modal) resolve("open");
      else if (Date.now() - started > 10000) resolve("timeout");
      else setTimeout(check, 200);
    };
    check();
  })`);
  if (picker4 !== "open") {
    record("step 4: path chip reopens the picker", false, `got ${picker4}`);
  } else {
    const step4 = await evalExpr(`(async () => {
      const modal = document.getElementById("directoryPickerModal");
      HerdrDirectoryPicker.toggle(${JSON.stringify(encodeURIComponent(PLAIN))});
      await new Promise((r) => setTimeout(r, 1500));
      const select = Array.from(modal.querySelectorAll("button")).find((b) => /Select this folder/.test(b.textContent || ""));
      if (!select) return { selected: false };
      select.click();
      // The workspace switch is async (create + navigate); poll the bar,
      // then poll the nogit probe landing (it drops the branch chip).
      const started = Date.now();
      let chip = null;
      while (Date.now() - started < 15000) {
        chip = document.querySelector("#locationBar .location-bar-path-chip");
        if (chip && (chip.textContent || "").includes(${JSON.stringify(PLAIN.split("/").pop())})) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      let branchGone = !document.querySelector("#locationBar .location-bar-branch-chip");
      while (!branchGone && Date.now() - started < 25000) {
        await new Promise((r) => setTimeout(r, 300));
        branchGone = !document.querySelector("#locationBar .location-bar-branch-chip");
      }
      return {
        selected: true,
        pathChip: !!(chip && (chip.textContent || "").includes(${JSON.stringify(PLAIN.split("/").pop())})),
        branchChipGone: branchGone,
      };
    })()`);
    record("workspace switched to the plain folder", step4.selected && step4.pathChip, JSON.stringify(step4));
    record("bar drops the branch chip for a non-repo folder", step4.selected && step4.branchChipGone === true, "");
  }

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath.replace(/\.json$/, "") + ".final.png", Buffer.from(screenshot.data, "base64"));

  writeReport(outPath, recorder);
  console.log(recorder.failed === 0 ? "CWD PICKER E2E ACCEPTANCE PASSED" : `CWD PICKER E2E ACCEPTANCE FAILED (${recorder.failed} failures)`);
  process.exit(recorder.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E driver error:", err);
  record("driver", false, String(err));
  writeCrashReport(outPath, recorder, err);
  process.exit(1);
});
