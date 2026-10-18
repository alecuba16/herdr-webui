// Real-DOM acceptance for the mobile composer-in-keybar unit and the
// Ctrl+Enter chord key. The runner (run-mobile-chord-e2e.sh) boots an
// isolated server plus its own headless Chrome over CDP; this driver
// forces the mobile layout and drives the real served bundle:
//
//   mc1  composer nests inside #mobileKeyBar (parent id + containment,
//        keybar inside #mobileToolbarKeys)
//   mc2  Keys toggle folds/unfolds keybar and composer together, fab
//        aria-pressed tracks the state
//   mc3  row1 keeps the classic 8 keys, row2 leads with ctrl-enter,
//        21 keys total
//   mc4  live tap on ctrl-enter: kitty flags read through the pane's own
//        bridge, the exact renderer-matching chord bytes captured at the
//        app boundary (sendControlKey), the same bytes observed on the
//        terminal input WebSocket, and the pane executes the pending
//        line (fresh prompt line in the bridge grid)
//
// Instrumentation runs via Page.addScriptToEvaluateOnNewDocument before
// any app JS: window.HerdrTerminalRenderer.create is wrapped to capture
// the live adapter (the mobile module does not export it), window.
// HerdrMobileTerminal.create is wrapped to capture sendControlKey
// payloads, and WebSocket.send is wrapped on terminal sockets to capture
// outgoing frames. Byte payloads (Uint8Array) must decode via
// TextDecoder.decode(view) - NOT positional (buffer, offset, len) args:
// that form throws and silently drops every input frame.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9331";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8931/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/mobile_chord_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-mobile-chord-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
};

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // Instrument BEFORE any app JS runs on every load. Same wrapping shape the
  // scratch validation used: capture adapter, sendControlKey payloads, and
  // terminal WS frames. Byte capture must decode views, not positional args.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__herdrCapture = { adapter: null, sent: [], termUrls: [], sockets: [], ctrl: [] };
      Object.defineProperty(window, "HerdrMobileTerminal", {
        configurable: true,
        get() { return origTermMod; },
        set(v) {
          origTermMod = v;
          if (v && typeof v.create === "function") {
            const origCreate = v.create;
            v.create = function (...args) {
              const mod = origCreate.apply(this, args);
              if (mod && typeof mod.sendControlKey === "function") {
                const origSck = mod.sendControlKey;
                mod.sendControlKey = function (data) {
                  window.__herdrCapture.ctrl.push(String(data));
                  return origSck.apply(this, arguments);
                };
              }
              return mod;
            };
          }
        },
      });
      let origTermMod = null;
      Object.defineProperty(window, "HerdrTerminalRenderer", {
        configurable: true,
        get() { return origRenderer; },
        set(v) {
          origRenderer = v;
          if (v && typeof v.create === "function") {
            const origCreate = v.create;
            v.create = async function (...args) {
              const adapter = await origCreate.apply(this, args);
              window.__herdrCapture.adapter = adapter;
              return adapter;
            };
          }
        },
      });
      let origRenderer = null;
      const OrigWS = window.WebSocket;
      const patchedWS = function (url, protocols) {
        const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
        if (typeof url === "string" && url.includes("/ws/terminal")) {
          window.__herdrCapture.termUrls.push(url);
          window.__herdrCapture.sockets.push(ws);
          const origSend = ws.send.bind(ws);
          const dec = new TextDecoder();
          ws.send = function (data) {
            try {
              let text = "";
              if (typeof data === "string") text = data;
              else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = dec.decode(data);
              if (text) window.__herdrCapture.sent.push(text);
            } catch (_) {}
            return origSend(data);
          };
        }
        return ws;
      };
      patchedWS.prototype = OrigWS.prototype;
      patchedWS.OPEN = OrigWS.OPEN;
      patchedWS.CONNECTING = OrigWS.CONNECTING;
      patchedWS.CLOSED = OrigWS.CLOSED;
      patchedWS.CLOSING = OrigWS.CLOSING;
      try { window.WebSocket = patchedWS; } catch (_) {}
    `,
  });

  // Phone viewport so auto-layout would pick mobile even without the
  // explicit preference; the preference alone is the deterministic part.
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  } catch { /* degrade */ }

  await evalJs(cdp, `localStorage.setItem("herdr-web-layout", "mobile")`);
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);
  const booted = await evalJs(cdp, `!!document.querySelector(".mobile-nav") && !document.querySelector(".herdr-skeleton")`);
  record("mobile shell booted", booted);
  if (!booted) throw new Error("mobile shell never booted");

  // Open the fixture repo workspace through the real API, then reload so
  // the boot path resolves the recent workspace (mirrors keyboard-guards).
  const opened = await evalJs(
    cdp,
    `(async () => {
      const r = await fetch("/api/recent-workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: ${JSON.stringify(REPO)} }) });
      const j = await r.json();
      return !!(j.result || j).workspace;
    })()`,
  );
  record("workspace opened", opened);
  if (!opened) throw new Error("workspace open failed");

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);
  const homeRows = await evalJs(cdp, `document.querySelectorAll(".mobile-workspace-row .mobile-row").length`);
  if (!homeRows) {
    await evalJs(cdp, `(() => { const b = document.querySelector('.mobile-nav button[data-screen="home"]'); if (b) b.click(); return !!b; })()`);
    await sleep(600);
    await evalJs(cdp, `(() => { const rows = [...document.querySelectorAll(".mobile-workspace-row .mobile-row")]; if (rows.length) rows[0].click(); return rows.length; })()`);
    await sleep(800);
  }
  await evalJs(cdp, `(() => { const b = document.querySelector('.mobile-nav button[data-screen="terminal"]'); if (b) b.click(); return !!b; })()`);
  await sleep(800);

  // mc1: composer nests inside the keybar unit.
  const nesting = await evalJs(
    cdp,
    `(() => {
      const composer = document.querySelector("#mobileComposer");
      const keybar = document.querySelector("#mobileKeyBar");
      if (!composer || !keybar) return { ok: false, composer: !!composer, keybar: !!keybar };
      const keysToolbar = document.querySelector("#mobileToolbarKeys");
      return {
        ok: composer.parentElement === keybar && keybar.contains(composer) && !!keysToolbar && keysToolbar.contains(keybar),
        parent: composer.parentElement && composer.parentElement.id,
        inKeybar: keybar.contains(composer),
        keybarInToolbar: !!keysToolbar && keysToolbar.contains(keybar),
      };
    })()`,
  );
  record(
    "composer nests inside keybar",
    !!nesting && nesting.ok,
    JSON.stringify(nesting),
  );

  // mc2: Keys toggle folds/unfolds keybar and composer together, aria tracks.
  // The fab mirrors state.toolbarOpen and the fold hides #mobileToolbar; the
  // keybar DOM persists while folded, so assert the flip, not a starting state.
  const toggle = await evalJs(
    cdp,
    `(() => {
      const fab = document.getElementById("mobileKeysFab");
      if (!fab || !window.HerdrMobile || !HerdrMobile.toggleToolbar) return null;
      const toolbar = document.getElementById("mobileToolbar");
      const before = { aria: fab.getAttribute("aria-pressed"), hidden: toolbar ? toolbar.hidden : null };
      HerdrMobile.toggleToolbar();
      const afterFlip1 = { aria: fab.getAttribute("aria-pressed"), hidden: toolbar ? toolbar.hidden : null };
      HerdrMobile.toggleToolbar();
      const afterFlip2 = { aria: fab.getAttribute("aria-pressed"), hidden: toolbar ? toolbar.hidden : null };
      return { before, afterFlip1, afterFlip2 };
    })()`,
  );
  const toggleOk =
    !!toggle &&
    toggle.afterFlip1.aria !== toggle.before.aria &&
    toggle.afterFlip1.hidden !== toggle.before.hidden &&
    toggle.afterFlip2.aria === toggle.before.aria &&
    toggle.afterFlip2.hidden === toggle.before.hidden;
  record(
    "keys toggle folds keybar and composer",
    toggleOk,
    JSON.stringify(toggle),
  );

  // mc3: row layout contract.
  const rows = await evalJs(
    cdp,
    `(() => {
      const row1 = [...document.querySelectorAll("#mobileKeyBar .mobile-keybar-row")[0].querySelectorAll(".mobile-keybar-key")];
      const row2 = [...document.querySelectorAll("#mobileKeyBar .mobile-keybar-row")[1].querySelectorAll(".mobile-keybar-key")];
      const all = [...document.querySelectorAll("#mobileKeyBar .mobile-keybar-key")];
      return {
        row1: row1.map((k) => k.dataset.key),
        row2: row2.map((k) => k.dataset.key),
        total: all.length,
      };
    })()`,
  );
  const row1Ok = rows && rows.row1.length === 8 && rows.row1.every((k) => k !== "ctrl-enter");
  const row2Ok = rows && rows.row2.length > 0 && rows.row2[0] === "ctrl-enter";
  record("row1 classic keys", !!row1Ok, JSON.stringify(rows && rows.row1));
  record("row2 leads ctrl-enter", !!row2Ok, JSON.stringify(rows && rows.row2 && rows.row2.slice(0, 3)));
  record("21 keys total", rows && rows.total === 21, "total=" + (rows && rows.total));

  // Open the keys toolbar if it is folded so the tap target is live.
  await evalJs(
    cdp,
    `(() => {
      const keys = document.querySelector("#mobileToolbarKeys");
      if (keys && !keys.querySelector("#mobileKeyBar")) HerdrMobile.toggleToolbar();
      return true;
    })()`,
  );
  await sleep(400);

  // Wait for the renderer adapter and an OPEN terminal socket.
  const capture = await evalJs(
    cdp,
    `(async () => {
      for (let i = 0; i < 40 && !window.__herdrCapture.adapter; i++) await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 40 && !window.__herdrCapture.sockets.some((s) => s.readyState === 1); i++) await new Promise((r) => setTimeout(r, 250));
      const adapter = window.__herdrCapture.adapter;
      const core = adapter && adapter.wterm && adapter.wterm.bridge ? adapter.wterm.bridge : null;
      return {
        adapter: !!adapter,
        kitty: core && core.kittyKeyboardFlags ? core.kittyKeyboardFlags() : 0,
        openSocket: window.__herdrCapture.sockets.some((s) => s.readyState === 1),
      };
    })()`,
  );
  record("bridge captured", !!capture && capture.adapter);
  record("kitty flags readable", !!capture && typeof capture.kitty === "number", "flags=" + (capture && capture.kitty));
  record("terminal socket OPEN", !!capture && capture.openSocket);
  if (!capture || !capture.adapter) throw new Error("adapter never captured");

  const frameCountBefore = await evalJs(cdp, `(window.__herdrCapture.sent.length)`);
  const ctrlBefore = await evalJs(cdp, `(window.__herdrCapture.ctrl.length)`);

  // mc4: live tap on the chord key. The whole chain from the onclick handler
  // through sendControlKey to ws.send is synchronous, so the tap eval
  // itself returns the frame deltas.
  const tap = await evalJs(
    cdp,
    `(() => {
      const b = document.querySelector('#mobileKeyBar .mobile-keybar-key[data-key="ctrl-enter"]');
      if (!b) return null;
      const sentBefore = window.__herdrCapture.sent.length;
      const ctrlBefore = window.__herdrCapture.ctrl.length;
      b.click();
      return {
        ctrlDelta: window.__herdrCapture.ctrl.length - ctrlBefore,
        ctrlLast: window.__herdrCapture.ctrl[window.__herdrCapture.ctrl.length - 1] || null,
        sentDelta: window.__herdrCapture.sent.length - sentBefore,
        sentLast: window.__herdrCapture.sent[window.__herdrCapture.sent.length - 1] || null,
      };
    })()`,
  );
  const want = capture.kitty > 0 ? "[13;5u" : "\r";
  record(
    "chord bytes at app boundary",
    !!tap && tap.ctrlDelta === 1 && tap.ctrlLast === want,
    "want=" + JSON.stringify(want) + " kitty=" + capture.kitty + " tap=" + JSON.stringify(tap),
  );
  record(
    "chord bytes on input WS",
    !!tap && tap.sentDelta >= 1 && tap.sentLast === want,
    "sentLast=" + JSON.stringify(tap && tap.sentLast),
  );

  // Pane-side confirm: the chord executes the pending line and a fresh
  // prompt line appears in the bridge grid (starship clock line).
  await sleep(1500);
  const freshPrompt = await evalJs(
    cdp,
    `(async () => {
      const adapter = window.__herdrCapture.adapter;
      const core = adapter && adapter.wterm && adapter.wterm.bridge ? adapter.wterm.bridge : null;
      if (!core) return -1;
      let prompts = 0;
      for (let i = 0; i < 20; i++) {
        prompts = 0;
        try {
          if (core.usingAltScreen && core.usingAltScreen()) return -1;
          const cols = core.getCols(), rows = core.getRows();
          for (let r = 0; r < rows; r++) {
            let text = "";
            for (let c = 0; c < cols; c++) {
              const cell = core.getCell(r, c);
              if (!cell || cell.width === 0 || cell.spacerHead) continue;
              text += cell.chars || String.fromCodePoint(cell.char || 32);
            }
            if (/❯[ ]*[0-9]{1,2}:[0-9]{2}:[0-9]{2}[ ]*$/.test(text.trim())) prompts += 1;
          }
        } catch (_) { return -1; }
        if (prompts >= 2) return prompts;
        await new Promise((r2) => setTimeout(r2, 300));
      }
      return prompts;
    })()`,
  );
  record(
    "fresh prompt line after chord",
    freshPrompt >= 2,
    "prompts=" + freshPrompt,
  );

  writeReport(outPath, recorder);
  console.log(recorder.failed ? "DRIVER FAILED" : "DRIVER PASSED");
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((error) => {
  writeCrashReport(outPath, recorder, error);
  console.error("driver crashed:", error);
  process.exit(1);
});
