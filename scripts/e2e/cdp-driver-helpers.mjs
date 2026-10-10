// Shared CDP plumbing for the real-browser acceptance drivers. Every driver
// used to hand-roll its own WebSocket client, result recorder, and JSON
// writer; this module keeps that identical logic in one place. The runner
// shell scripts stay self-contained (server + Chrome lifecycle) but the
// drivers import from here because they run under node with file access.
//
// Usage:
//   import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";
//   const recorder = makeRecorder();
//   const cdp = await attach(page.webSocketDebuggerUrl);
//   ...
//   writeReport(outPath, recorder); process.exit(recorder.failed ? 1 : 0);

import { writeFileSync, mkdirSync } from "node:fs";

export async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const eventHandlers = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const msgId = ++id;
          pending.set(msgId, { res2, rej2 });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      // Subscribe to CDP events (e.g. Fetch.requestPaused) for this
      // session. Handlers receive (params, method) and run inline.
      on(method, handler) {
        eventHandlers.set(method, handler);
      },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || "")}`));
        else res2(msg.result);
        return;
      }
      if (msg.method && eventHandlers.has(msg.method)) {
        try { eventHandlers.get(msg.method)(msg.params || {}, msg.method); }
        catch (error) { console.error(`event handler for ${msg.method} failed:`, error); }
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeRecorder() {
  const results = [];
  const recorder = {
    get results() { return results; },
    get failed() { let failed = 0; for (const r of results) if (!r.pass) failed += 1; return failed; },
    get passed() { return results.length - recorder.failed; },
    record(name, pass, detail) {
      results.push({ name, pass, detail: String(detail || "") });
      console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
    },
  };
  return recorder;
}

export function writeReport(outPath, recorder, extra) {
  mkdirFor(outPath);
  writeFileSync(outPath, JSON.stringify({ passed: recorder.passed, failed: recorder.failed, results: recorder.results, ...(extra || {}) }, null, 2));
}

function mkdirFor(path) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir) mkdirSync(dir, { recursive: true });
}

// Crash-path writer: the driver's catch handler runs outside the normal
// flow and must still emit a JSON report with the error.
export function writeCrashReport(outPath, recorder, error) {
  try {
    mkdirFor(outPath);
    writeFileSync(outPath, JSON.stringify({ passed: 0, failed: 1, error: String(error), results: recorder.results }, null, 2));
  } catch { /* best effort */ }
}