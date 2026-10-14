// Real-DOM acceptance for the Notes rail. Boots an isolated server +
// chrome-headless (run-notes-rail-e2e.sh), then drives the real served
// bundle end to end:
//   - the rail Notes button hosts #notesPanel in the sidebar column
//   - a created note hits POST /api/notes and renders in the list
//   - editing mounts the shared CodeMirror editor
//   - the flushed save lands in the sidecar and survives a client reload
//     (the restart case is covered by the Rust state-rebuild test)
//   - per-note delete is confirm-free; Clear all rides the danger confirm
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9225";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8897/";
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/notes_rail_e2e_result.json`;

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

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  await reload();

  // n1: the rail Notes button hosts the panel in the sidebar column.
  const hosted = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailNotes");
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const panel = document.getElementById("notesPanel");
    const host = document.getElementById("rightSidebarContent");
    return JSON.stringify({
      hosted: !!(panel && host && panel.parentNode === host),
      empty: !!(panel && panel.textContent.includes("No notes yet")),
    });
  })()`);
  let hostInfo = null;
  try { hostInfo = JSON.parse(hosted); } catch { /* below */ }
  record("rail Notes button hosts #notesPanel in the column", !!hostInfo && hostInfo.hosted === true, hosted.slice(0, 300));
  record("empty state shows before any note exists", !!hostInfo && hostInfo.empty === true, hosted.slice(0, 300));

  // n2: create a note. POST /api/notes must render a row.
  const created = await evalExpr(`(async () => {
    const btn = document.getElementById("notesNew");
    if (!btn) return "no-new";
    btn.click();
    await new Promise((r) => setTimeout(r, 1000));
    const rows = document.querySelectorAll("[data-notes-open]");
    const titleInput = document.getElementById("notesTitleInput");
    return JSON.stringify({
      rows: rows.length,
      editing: !!titleInput,
    });
  })()`);
  let createInfo = null;
  try { createInfo = JSON.parse(created); } catch { /* below */ }
  // Creating enters the editing view straight away; the list (and its rows)
  // renders only after going back.
  record("new note enters editing straight away", !!createInfo && createInfo.editing === true, created.slice(0, 300));
  const listedAfterBack = await evalExpr(`(async () => {
    const back = document.getElementById("notesBack");
    if (!back) return "no-back";
    back.click();
    await new Promise((r) => setTimeout(r, 600));
    return JSON.stringify({ rows: document.querySelectorAll("[data-notes-open]").length });
  })()`);
  let backInfo = null;
  try { backInfo = JSON.parse(listedAfterBack); } catch { /* below */ }
  record("created note renders a list row", !!backInfo && backInfo.rows === 1, listedAfterBack.slice(0, 300));
  // Reopen the note for the editing checks below.
  await evalExpr(`(async () => {
    const row = document.querySelector("[data-notes-open]");
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 800));
    return "ok";
  })()`);

  // n3: pick rust, type a title and content, check CodeMirror mounted with
  // the rust language and the debounced save hit the API.
  const edited = await evalExpr(`(async () => {
    const lang = document.getElementById("notesLanguage");
    if (!lang) return "no-lang";
    lang.value = "rust";
    lang.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 800));
    const title = document.getElementById("notesTitleInput");
    if (!title) return "no-title";
    title.value = "build steps";
    title.dispatchEvent(new Event("change"));
    await new Promise((r) => setTimeout(r, 800));
    const editorHost = document.getElementById("notesEditor");
    const cm = editorHost && editorHost.querySelector(".cm-editor");
    const content = "fn main() { println!(\\"e2e\\"); }";
    const api = window.HerdrNotesPanel;
    if (api && api.flush) {
      const editorApi = document.getElementById("notesPanel")._herdrEditorApi;
      if (editorApi && editorApi.setValue) editorApi.setValue(content);
    }
    if (api && api.flush) await api.flush();
    await new Promise((r) => setTimeout(r, 1000));
    const saved = await fetch("/api/notes").then((r) => r.json()).catch(() => null);
    const note = saved && saved.notes && saved.notes[0];
    return JSON.stringify({
      cm: !!cm,
      title: note ? note.title : null,
      language: note ? note.language : null,
      content: note ? note.content : null,
    });
  })()`);
  let editInfo = null;
  try { editInfo = JSON.parse(edited); } catch { /* below */ }
  record("CodeMirror mounted for the edited note", !!editInfo && editInfo.cm === true, edited.slice(0, 300));
  record("title and language saved through the API", !!editInfo && editInfo.title === "build steps" && editInfo.language === "rust", edited.slice(0, 300));
  const expectedContent = 'fn main() { println!("e2e"); }';
  record("content flushed through the shared editor save path", !!editInfo && editInfo.content === expectedContent, edited.slice(0, 300));

  // n4: the sidecar survives a full client reload (no server restart here;
  // the persistence-across-restart case is covered by the Rust suite's
  // state-rebuild test).
  await reload();
  const reloaded = await evalExpr(`(async () => {
    const btn = document.getElementById("rightRailNotes");
    if (!btn) return "no-button";
    btn.click();
    await new Promise((r) => setTimeout(r, 1500));
    const panel = document.getElementById("notesPanel");
    return JSON.stringify({
      row: !!(panel && panel.querySelector('[data-notes-open]')),
      title: panel ? (panel.querySelector(".notes-row-title") || {}).textContent : null,
    });
  })()`);
  let reloadInfo = null;
  try { reloadInfo = JSON.parse(reloaded); } catch { /* below */ }
  record("note survives a client reload through the sidecar GET", !!reloadInfo && reloadInfo.row === true && /build steps/.test(String(reloadInfo.title || "")), reloaded.slice(0, 300));

  // n5: per-note delete is confirm-free and empties the list; then create
  // again and check Clear all goes through the danger confirm.
  const deleted = await evalExpr(`(async () => {
    const del = document.querySelector("[data-notes-delete]");
    if (!del) return "no-delete";
    let asked = 0;
    const origConfirm = window.confirm;
    window.confirm = () => { asked += 1; return false; };
    del.click();
    await new Promise((r) => setTimeout(r, 900));
    window.confirm = origConfirm;
    return JSON.stringify({
      asked,
      rows: document.querySelectorAll("[data-notes-open]").length,
    });
  })()`);
  let delInfo = null;
  try { delInfo = JSON.parse(deleted); } catch { /* below */ }
  record("per-note delete asks nothing and removes the row", !!delInfo && delInfo.asked === 0 && delInfo.rows === 0, deleted.slice(0, 300));

  // Recreate one note for the clear-all check. Creating lands in the editor
  // view, so go back to the list first: notesClear only renders there.
  await evalExpr(`(async () => {
    const btn = document.getElementById("notesNew");
    if (!btn) return "no-new";
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const back = document.getElementById("notesBack");
    if (!back) return "no-back";
    back.click();
    await new Promise((r) => setTimeout(r, 600));
    const clear = document.getElementById("notesClear");
    return clear ? "list-ready" : "no-clear-button";
  })()`).then((r) => { if (r !== "list-ready") console.log("recreate step:", r); });
  const cleared = await evalExpr(`(async () => {
    const clear = document.getElementById("notesClear");
    if (!clear) return "no-clear";
    let danger = null;
    const panel = window.HerdrNotesPanel;
    if (!panel) return "no-panel";
    if (typeof askQuestion === "function") {
      const origAsk = askQuestion;
      window.askQuestion = (opts) => { danger = opts && opts.danger; return Promise.resolve(false); };
      // notes.js captured the original binding at call time, so restoring
      // happens after the awaited clearAll below.
      try { await panel.clearAll(); } finally { window.askQuestion = origAsk; }
    } else {
      await panel.clearAll();
    }
    await new Promise((r) => setTimeout(r, 600));
    const saved = await fetch("/api/notes").then((r) => r.json()).catch(() => null);
    return JSON.stringify({
      danger,
      notes: saved && saved.notes ? saved.notes.length : null,
    });
  })()`);
  let clearInfo = null;
  try { clearInfo = JSON.parse(cleared); } catch { /* below */ }
  record("clear-all rides the danger confirm and rejects cleanly", !!clearInfo && clearInfo.danger === true && clearInfo.notes === 1, cleared.slice(0, 300));

  console.log(`\n${recorder.passed}/${recorder.results.length} checks passed`);
  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((e) => {
  console.error("driver crashed:", e);
  writeCrashReport(outPath, recorder, e);
  process.exit(1);
});