// Real-DOM acceptance for the mobile Notes screen. Same runner family as
// the desktop rail (run-notes-mobile-e2e.sh boots the isolated server +
// chrome-headless); this one forces the MOBILE layout and drives the
// drawer screen with real clicks and the real served bundle:
//
//   mn1 the More drawer carries a Notes item and it opens the screen
//   mn2 the screen lists server notes with a per-row Delete and a sync
//        button in the head
//   mn3 + Note creates a note (POST) and lands in the editor with the
//        title input and language select
//   mn4 the shared CodeMirror editor mounts headerless (no .herdr-editor-
//        head) inside #mobileNoteEditor
//   mn5 typing through the editor API schedules the debounced save and
//        the badge flips to Saved after the flush
//   mn6 external DELETE (server API) with the editor clean closes it
//        back to the list after a sync
//   mn7 per-row Delete (real click, no confirm sheet) removes the row
//   mn8 Clear all rides the danger confirm sheet (Cancel keeps notes,
//        Confirm clears)
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9226";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8898/";
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/notes_mobile_e2e_result.json`;

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

  const clickEl = async (pt) => {
    const point = typeof pt === "string" ? JSON.parse(pt) : pt;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
    await sleep(120);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    return "clicked";
  };
  const rectExpr = (selector) => `(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`;

  // Phone viewport; the explicit layout preference makes it deterministic.
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }

  await evalExpr(`localStorage.setItem("herdr-web-layout", "mobile")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(4000);

  const layout = await evalExpr(`document.documentElement.dataset.herdrLayout || "none"`);
  record("mobile layout resolved", layout === "mobile", `got ${layout}`);
  if (layout !== "mobile") throw new Error("mobile layout did not resolve: " + layout);

  const booted = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (window.HerdrMobile && window.HerdrMobileNotes && window.HerdrMobile.showScreen) { resolve("ready"); return; }
      if (Date.now() - started > 20000) resolve("timeout");
      else setTimeout(check, 400);
    };
    check();
  })`);
  record("mobile bundle booted with HerdrMobileNotes exports", booted === "ready", `got ${booted}`);
  if (booted !== "ready") throw new Error("mobile bundle never exposed HerdrMobileNotes");

  // mn1: open More drawer, then the Notes item (real clicks).
  let clicked = await clickEl(await evalExpr(rectExpr(`document.querySelector('.mobile-nav button[data-screen="more"]')`)));
  await sleep(600);
  const notesItem = await evalExpr(rectExpr(`Array.from(document.querySelectorAll('.mobile-drawer-item')).find((b) => /notes/i.test(b.textContent || ""))`));
  record("More drawer carries a Notes item", !!notesItem, notesItem ? "found" : "missing");
  clicked = await clickEl(notesItem);
  record("notes screen opened via More drawer", clicked === "clicked", `got ${clicked}`);
  await sleep(1000);

  // mn2: the screen head + empty state.
  const head = await evalExpr(`(() => {
    const screen = document.getElementById("mobileNotesScreen");
    if (!screen) return "no-screen";
    return {
      sync: !!document.getElementById("mobileNotesSync"),
      create: /\\+ Note/.test(screen.textContent || ""),
      empty: /No notes yet/.test(screen.textContent || ""),
    };
  })()`);
  record("notes screen renders head with sync + create and empty state", head && head.sync && head.create && head.empty, JSON.stringify(head));

  // mn3: create a note, land in the editor.
  clicked = await clickEl(await evalExpr(rectExpr(`Array.from(document.querySelectorAll('#mobileNotesScreen button')).find((b) => /\\+ Note/.test(b.textContent || ""))`)));
  await sleep(1200);
  const editorHead = await evalExpr(`(() => {
    const title = document.getElementById("mobileNoteTitle");
    const language = document.getElementById("mobileNoteLanguage");
    const host = document.getElementById("mobileNoteEditor");
    return { title: !!title, language: !!language, host: !!host };
  })()`);
  record("create lands in the editor with title + language select", editorHead && editorHead.title && editorHead.language && editorHead.host, JSON.stringify(editorHead));

  // mn4: the shared editor mounts headerless.
  const headerless = await evalExpr(`(() => {
    const host = document.getElementById("mobileNoteEditor");
    if (!host) return "no-host";
    return {
      cm: !!host.querySelector(".cm-editor"),
      head: !!host.querySelector(".herdr-editor-head"),
    };
  })()`);
  record("CodeMirror mounts headerless in the editor host", headerless && headerless.cm && !headerless.head, JSON.stringify(headerless));

  // mn5: type through the real CodeMirror content node, wait for the debounced save.
  const typedOk = await evalExpr(`(async () => {
    const cm = document.querySelector("#mobileNoteEditor .cm-content");
    if (!cm) return "no-content";
    cm.focus();
    document.execCommand("insertText", false, "mobile e2e draft");
    await new Promise((r) => setTimeout(r, 900));
    const badge = document.getElementById("mobileNoteSaveState");
    return { badge: badge ? badge.textContent : "no-badge" };
  })()`);
  const saved = await evalExpr(`(async () => {
    const notes = await fetch("/api/notes").then((r) => r.json());
    const any = (notes.notes || []).some((n) => (n.content || "").includes("mobile e2e draft"));
    const badge = document.getElementById("mobileNoteSaveState");
    return { persisted: any, badge: badge ? badge.textContent : "no-badge" };
  })()`);
  record("typed content persists after the debounced save", saved && saved.persisted, JSON.stringify(saved));
  record("save badge settles to Saved", saved && saved.badge === "Saved", JSON.stringify(saved));

  // mn6: external DELETE with a clean editor closes it after a sync.
  const noteId = await evalExpr(`(async () => {
    const notes = await fetch("/api/notes").then((r) => r.json());
    return (notes.notes || []).find((n) => (n.content || "").includes("mobile e2e draft"))?.id || null;
  })()`);
  await evalExpr('fetch("/api/notes/" + ' + JSON.stringify(String(noteId)) + ', { method: "DELETE" })');
  clicked = await clickEl(await evalExpr(rectExpr(`document.getElementById("mobileNotesSync")`)));
  await sleep(1200);
  const closed = await evalExpr(`(() => ({
    editing: !!document.getElementById("mobileNoteEditor"),
    screen: !!document.getElementById("mobileNotesScreen"),
  }))()`);
  record("external delete closes the clean editor after sync", closed && !closed.editing && closed.screen, JSON.stringify(closed));

  // mn7: create two notes, per-row Delete removes one without a confirm sheet.
  await evalExpr(`(async () => {
    await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Row A", content: "a", language: "txt" }) });
    await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Row B", content: "b", language: "txt" }) });
  })()`);
  clicked = await clickEl(await evalExpr(rectExpr(`document.getElementById("mobileNotesSync")`)));
  await sleep(1000);
  const rowsBefore = await evalExpr(`document.querySelectorAll(".mobile-note-row").length`);
  const delRect = await evalExpr(rectExpr(`Array.from(document.querySelectorAll('.mobile-note-row-wrap .mobile-note-delete')).find((b) => /Row A/.test(b.closest(".mobile-note-row-wrap").textContent || ""))`));
  clicked = await clickEl(delRect);
  await sleep(1000);
  const rowsAfter = await evalExpr(`(() => ({
    count: document.querySelectorAll(".mobile-note-row").length,
    gone: !Array.from(document.querySelectorAll(".mobile-note-row")).some((r) => /Row A/.test(r.textContent || "")),
    sheet: !!(document.getElementById("mobileConfirmSheet") && !document.getElementById("mobileConfirmSheet").hidden),
  }))()`);
  record("per-row delete removes the row without a confirm sheet", rowsAfter && rowsAfter.count === rowsBefore - 1 && rowsAfter.gone && !rowsAfter.sheet, JSON.stringify({ rowsBefore, rowsAfter }));

  // mn8: Clear all rides the danger confirm sheet; Cancel keeps, Confirm clears.
  clicked = await clickEl(await evalExpr(rectExpr(`Array.from(document.querySelectorAll('#mobileNotesScreen button')).find((b) => /Clear all/.test(b.textContent || ""))`)));
  await sleep(600);
  const sheetShown = await evalExpr(`(() => {
    const sheet = document.getElementById("mobileConfirmSheet");
    return !!sheet && !sheet.hidden;
  })()`);
  record("clear-all opens the confirm sheet", sheetShown === true, `got ${sheetShown}`);
  clicked = await clickEl(await evalExpr(rectExpr(`Array.from(document.querySelectorAll('#mobileConfirmSheet button')).find((b) => /cancel/i.test(b.textContent || ""))`)));
  await sleep(800);
  const kept = await evalExpr(`document.querySelectorAll(".mobile-note-row").length`);
  record("cancel keeps the notes", kept >= 1, `rows ${kept}`);
  clicked = await clickEl(await evalExpr(rectExpr(`Array.from(document.querySelectorAll('#mobileNotesScreen button')).find((b) => /Clear all/.test(b.textContent || ""))`)));
  await sleep(600);
  clicked = await clickEl(await evalExpr(rectExpr(`Array.from(document.querySelectorAll('#mobileConfirmSheet button')).find((b) => /confirm/i.test(b.textContent || ""))`)));
  await sleep(1000);
  const cleared = await evalExpr(`(() => ({
    rows: document.querySelectorAll(".mobile-note-row").length,
    empty: /No notes yet/.test(document.getElementById("mobileNotesScreen").textContent || ""),
  }))()`);
  record("confirm clears every note", cleared && cleared.rows === 0 && cleared.empty, JSON.stringify(cleared));

  writeReport(outPath, recorder, { status: recorder.failed ? "failed" : "passed" });
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  process.exit(1);
});