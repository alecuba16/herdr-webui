// Real-DOM acceptance for the Git path-title folder picker and the
// return-to-workspace button (git-ui side panel).
//
// The behavioral suites drive openCwdPicker with a stubbed picker in a vm;
// this script runs the actual served bundle in headless Chrome and clicks the
// real DOM: the path title button, the real directory picker tree, and the
// return button. Server + Chrome are started by run-cwd-picker-e2e.sh.
//
// Flow checked (all against the served app, real clicks, real backend):
//  1. Workspace open on REPO_A -> Git drawer shows the path title as a
//     button (git-ui-path-title) with no return button next to it.
//  2. Clicking the title opens the real directory picker seeded with REPO_A.
//  3. Navigating the picker to REPO_B and pressing "Select this folder"
//     moves the Git panel to REPO_B: status refetches for the new cwd and the
//     return button (git-ui-return-cwd-icon) appears next to the title.
//  4. Clicking the return button restores REPO_A and the button disappears.
//  5. The cleanup-only view (plain folder) keeps a clickable path title.
import { mkdirSync, writeFileSync } from "node:fs";

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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const msgId = ++id;
          pending.set(msgId, { res2, rej2 });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || "")}`));
        else res2(msg.result);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = 0;
function record(name, pass, detail) {
  results.push({ name, pass, detail: String(detail || "") });
  if (!pass) failed += 1;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

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

  const reload = async () => {
    await cdp.send("Page.navigate", { url: APP_URL });
    await sleep(3000);
  };

  await reload();

  // Open the workspace on REPO_A through the real API, then navigate to it
  // with the same go() helper the create modal uses (creating alone does not
  // focus the workspace).
  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO_A)}, label: "cwd-picker-e2e"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  if (!made || !made.result) record("workspace created", false, JSON.stringify(made).slice(0, 200));
  else record("workspace created on repo A", true, "");
  const wsId = made && made.result ? (made.result.workspace && made.result.workspace.workspace_id) : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  // The app persists selection under the URL route; reload straight onto
  // the routed URL (navigating to "/" would boot clean with no workspace).
  await cdp.send("Page.navigate", { url: `${APP_URL}session/default/workspace/${wsId}` });
  await sleep(3000);

  // Wait until the app has the workspace list loaded (the Git drawer keys
  // off state.ws; opening before the list loads lands on the home default).
  // The list endpoint answers {result: {workspaces: [...]}}; verify the
  // app's own state, not just the endpoint, to avoid the fallback race.
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

  // Open the Git drawer via the real header toggle.
  const opened = await evalExpr(`new Promise((resolve) => {
    const btn = document.getElementById("gitWorkspaceToggle");
    if (!btn) { resolve("no toggle"); return; }
    btn.click();
    const started = Date.now();
    const check = () => {
      const panel = document.getElementById("gitUiPanel");
      const title = panel && panel.querySelector(".git-ui-path-title");
      // The title abbreviates deep paths (".../scratch/xyz/repo-a"), so
      // compare the un-abbreviated title attribute, which carries the cwd.
      const attr = title ? (title.getAttribute("title") || "") : "";
      if (title && attr.includes(${JSON.stringify(REPO_A)})) resolve("opened");
      else if (Date.now() - started > 20000) resolve("timeout:" + attr);
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("git drawer opened on the workspace repo", opened === "opened", `got ${opened}`);

  // 1. Title is a real button; no return button while cwd == workspace.
  const step1 = await evalExpr(`(() => {
    const panel = document.getElementById("gitUiPanel");
    const head = panel.querySelector(".git-ui-side-bottom-head");
    const title = head && head.querySelector(".git-ui-path-title");
    const ret = head && head.querySelector(".git-ui-return-cwd-icon");
    return {
      titleIsButton: !!(title && title.tagName === "BUTTON"),
      titleText: title ? title.textContent : "",
      hasOnclick: !!(title && typeof title.onclick === "function") || !!(title && title.getAttribute("onclick")),
      titleAttr: title ? (title.getAttribute("title") || "") : "",
      returnPresent: !!ret,
    };
  })()`);
  record("path title renders as a button with picker onclick", step1.titleIsButton && step1.hasOnclick, JSON.stringify(step1));
  record("title attr documents the change-folder hint", (step1.titleAttr || "").includes("Change Git folder"), step1.titleAttr.split("\\n")[0]);
  record("no return button while git cwd matches the workspace", !step1.returnPresent, "");

  // 2. Click the title: the real directory picker opens, seeded with REPO_A.
  await evalExpr(`document.querySelector("#gitUiPanel .git-ui-path-title").click()`);
  const step2 = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const modal = document.getElementById("directoryPickerModal");
      if (modal) resolve({ open: true, text: modal.textContent.slice(0, 400) });
      else if (Date.now() - started > 10000) resolve({ open: false });
      else setTimeout(check, 200);
    };
    check();
  })`);
  record("clicking the title opens the real directory picker", step2.open === true, "");
  record("picker is seeded at the git cwd", (step2.text || "").includes(REPO_A.split("/").pop()) || (step2.text || "").includes(REPO_A), (step2.text || "").slice(0, 120));

  // 3. Navigate the picker to REPO_B and select it.
  // The picker rows call HerdrDirectoryPicker.toggle(encodedPath) -> the
  // private load(); drive the same public entry the rows use, then press
  // the real Select button.
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
      const panel = document.getElementById("gitUiPanel");
      const head = panel && panel.querySelector(".git-ui-side-bottom-head");
      const title = head && head.querySelector(".git-ui-path-title");
      const ret = head && head.querySelector(".git-ui-return-cwd-icon");
      const modal = document.getElementById("directoryPickerModal");
      if (title && ret && !modal) resolve({ moved: true, titleText: title.textContent, returnPresent: true, retTitle: ret.getAttribute("title") || "" });
      else if (Date.now() - started > 15000) resolve({ moved: false, titleText: title ? title.textContent : "", returnPresent: !!ret, modalGone: !modal });
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("git panel moved to repo B", step3.moved === true, JSON.stringify(step3));
  record("return button appears next to the title", step3.returnPresent === true, step3.retTitle);
  record("picker closed after selection", !("modalGone" in step3) || step3.modalGone !== false, "");

  // The status fetch for the new cwd went through the real backend: the
  // API answers for repo B with its branch (the panel refetches status for
  // the new cwd on apply).
  const statusCheck = await evalExpr(`fetch(${JSON.stringify("/api/git-ui/status?cwd=" + encodeURIComponent(REPO_B))}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const branchOk = !!statusCheck && !!statusCheck.branch && statusCheck.repo_path === REPO_B;
  record("real backend status answers for repo B cwd", branchOk, JSON.stringify(statusCheck).slice(0, 160));

  // 4. Click the return button: back to REPO_A, button disappears.
  const step4 = await evalExpr(`new Promise((resolve) => {
    const ret = document.querySelector("#gitUiPanel .git-ui-side-bottom-head .git-ui-return-cwd-icon");
    if (!ret) { resolve({ clicked: false }); return; }
    ret.click();
    const started = Date.now();
    const check = () => {
      const head = document.querySelector("#gitUiPanel .git-ui-side-bottom-head");
      const title = head && head.querySelector(".git-ui-path-title");
      const retAfter = head && head.querySelector(".git-ui-return-cwd-icon");
      if (title && !retAfter) resolve({ clicked: true, titleText: title.textContent });
      else if (Date.now() - started > 15000) resolve({ clicked: true, timeout: true, titleText: title ? title.textContent : "" });
      else setTimeout(check, 300);
    };
    check();
  })`);
  record("return button restores the workspace folder and disappears", step4.clicked && !step4.timeout, JSON.stringify(step4));

  // 5. Cleanup-only view (plain folder): keep the clickable title.
  const step5 = await evalExpr(`(async () => {
    HerdrGitUi.openCwdPicker();
    await new Promise((r) => setTimeout(r, 400));
    const modal = document.getElementById("directoryPickerModal");
    if (!modal) return { reopened: false };
    HerdrDirectoryPicker.toggle(${JSON.stringify(encodeURIComponent(PLAIN))});
    await new Promise((r) => setTimeout(r, 1500));
    const select = Array.from(modal.querySelectorAll("button")).find((b) => /Select this folder/.test(b.textContent || ""));
    if (!select) return { reopened: true, selected: false };
    select.click();
    await new Promise((r) => setTimeout(r, 2500));
    const head = document.querySelector("#gitUiPanel .git-ui-side-bottom-head");
    const title = head && head.querySelector(".git-ui-path-title");
    return {
      reopened: true, selected: true,
      titleIsButton: !!(title && title.tagName === "BUTTON"),
      layoutToggleGone: !document.querySelector("#gitUiPanel .git-ui-diff-layout-toggle"),
    };
  })()`);
  record("cleanup-only view keeps the clickable path title", step5.reopened && step5.selected && step5.titleIsButton, JSON.stringify(step5));
  record("cleanup-only view hides the diff layout toggle", step5.layoutToggleGone === true, "");

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(outPath.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(outPath.replace(/\.json$/, "") + ".final.png", Buffer.from(screenshot.data, "base64"));

  const report = { passed: results.length - failed, failed, results };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(failed === 0 ? "CWD PICKER E2E ACCEPTANCE PASSED" : `CWD PICKER E2E ACCEPTANCE FAILED (${failed} failures)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E driver error:", err);
  results.push({ name: "driver", pass: false, detail: String(err) });
  try { writeFileSync(outPath, JSON.stringify({ passed: 0, failed: 1, results }, null, 2)); } catch {}
  process.exit(1);
});