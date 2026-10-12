// Real-DOM acceptance for the directory picker search box
// (directoryPickerSearchInput): with a term typed, results must list
// folders only, never files. Runs against the isolated server started by
// run-cwd-picker-e2e.sh, reusing its fixture layout (REPO_A + REPO_B +
// PLAIN under a scratch workdir) and CDP helpers.
//
// Flow checked:
//  1. Open the picker on the fixture workdir root (parent of all fixtures).
//  2. Type a term that matches both a folder (repo-a) and nothing file-like
//     in the same tree; assert every rendered row is a folder row.
//  3. Type a term that matches a plain file (note.txt) exactly; assert the
//     tree shows no rows (the file must not leak into folder search).
//  4. Backend contract check: same tree endpoint with q= and no kind param
//     still returns mixed results, proving search_kind=dir is what filters
//     (guards against the test passing vacuously).
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9224";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const REPO_A = process.env.REPO_A;
const WORK_ROOT = process.env.WORK_ROOT;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/dir_picker_search_e2e_result.json`;

if (!REPO_A || !WORK_ROOT) {
  console.error("REPO_A and WORK_ROOT must be set (use scripts/e2e/run-cwd-picker-e2e.sh)");
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

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(3000);

  // The picker script loads lazily at boot (app_boot.js loads the desktop
  // bundle after core.js); wait for the module before driving it.
  const ready = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (window.HerdrDirectoryPicker && typeof HerdrDirectoryPicker.open === "function") resolve("ready");
      else if (Date.now() - started > 15000) resolve("timeout");
      else setTimeout(check, 200);
    };
    check();
  })`);
  record("directory picker module loaded", ready === "ready", `got ${ready}`);

  // 1. Open the picker seeded at the fixture workdir root so the search
  // walks repo-a, repo-b and plain-dir at once. The picker follows the
  // hidden-input flow (git path title); drive open() directly with a
  // detached input like the git_ui caller does.
  const opened = await evalExpr(`new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "text";
    input.style.display = "none";
    input.value = ${JSON.stringify(WORK_ROOT)};
    HerdrDirectoryPicker.open(input);
    const started = Date.now();
    const check = () => {
      const modal = document.getElementById("directoryPickerModal");
      const search = modal && document.getElementById("directoryPickerSearchInput");
      if (modal && search) resolve({ open: true, text: modal.textContent.slice(0, 300) });
      else if (Date.now() - started > 10000) resolve({ open: false });
      else setTimeout(check, 200);
    };
    check();
  })`);
  record("picker opens at the fixture workdir root", opened.open === true, JSON.stringify(opened).slice(0, 160));

  // 2. Search for the folder name shared by REPO_A; every rendered row
  // must be a folder. Rows are `herdr-tree-row dir` or `herdr-tree-row file`
  // buttons (renderEntry in shared/file_tree.js).
  const folderRows = await evalExpr(`(async () => {
    HerdrDirectoryPicker.filter(${JSON.stringify("repo")});
    await new Promise((r) => setTimeout(r, 2500));
    const tree = document.querySelector("#directoryPickerModal .directory-picker-tree");
    if (!tree) return { error: "no tree" };
    const rows = Array.from(tree.querySelectorAll(".herdr-tree-row"));
    const texts = rows.map((row) => row.textContent.trim()).filter(Boolean);
    const fileRows = rows.filter((row) => /\bherdr-tree-row[^"]*\bfile\b/.test(row.className || ""));
    return { count: rows.length, texts, fileRowCount: fileRows.length };
  })()`);
  record("search 'repo' returns folder rows only", folderRows.count > 0 && folderRows.fileRowCount === 0, JSON.stringify({ count: folderRows.count, fileRowCount: folderRows.fileRowCount }));
  record("search 'repo' actually matched fixture folders", (folderRows.texts || []).some((t) => t.includes("repo-a")), JSON.stringify((folderRows.texts || []).slice(0, 6)));

  // 3. Search for the plain fixture file by exact name; no rows at all.
  const fileLeak = await evalExpr(`(async () => {
    HerdrDirectoryPicker.filter(${JSON.stringify("note")});
    await new Promise((r) => setTimeout(r, 2500));
    const tree = document.querySelector("#directoryPickerModal .directory-picker-tree");
    if (!tree) return { error: "no tree" };
    const rows = Array.from(tree.querySelectorAll(".herdr-tree-row"));
    return { count: rows.length, texts: rows.map((row) => row.textContent.trim()) };
  })()`);
  record("search 'note' (file-only match) returns no rows", fileLeak.count === 0, JSON.stringify(fileLeak));

  // 4. Anti-vacuity check against the real backend: unkinded q= search on
  // the same root must return the file too; the picker filters it only
  // through search_kind=dir.
  const mixed = await evalExpr(`fetch(${JSON.stringify(`/api/file-browser/tree?cwd=${encodeURIComponent(WORK_ROOT)}&path=&q=note&offset=0&limit=50`)}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const mixedPaths = Array.isArray(mixed && mixed.entries) ? mixed.entries.map((entry) => `${entry.kind}:${entry.path}`) : [String(mixed).slice(0, 120)];
  record("unkinded backend search still returns the file (picker kind param is the filter)", mixedPaths.some((p) => p.startsWith("file:")), JSON.stringify(mixedPaths));
  const kinded = await evalExpr(`fetch(${JSON.stringify(`/api/file-browser/tree?cwd=${encodeURIComponent(WORK_ROOT)}&path=&q=note&search_kind=dir&offset=0&limit=50`)}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const kindedKinds = Array.isArray(kinded && kinded.entries) ? kinded.entries.map((entry) => entry.kind) : [];
  record("kinded backend search returns dirs only", kindedKinds.length === 0 || kindedKinds.every((k) => k === "dir"), JSON.stringify(kindedKinds));

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outPath.replace(/\.json$/, "") + ".final.png", Buffer.from(screenshot.data, "base64"));

  writeReport(outPath, recorder);
  console.log(recorder.failed === 0 ? "DIR PICKER SEARCH E2E ACCEPTANCE PASSED" : `DIR PICKER SEARCH E2E ACCEPTANCE FAILED (${recorder.failed} failures)`);
  process.exit(recorder.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E driver error:", err);
  record("driver", false, String(err));
  writeCrashReport(outPath, recorder, err);
  process.exit(1);
});
