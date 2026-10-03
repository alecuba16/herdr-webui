// Multi-viewer terminal acceptance: the shared attach hub (ux overhaul
// phase 5) must fan one backend attach out to every browser viewer.
//
// Two real page targets in one Chrome open the SAME workspace/terminal:
//   1. Viewer 1 attaches and types a marker; the echo proves a live PTY.
//   2. Viewer 2 joins the SAME terminal (same session backend + ws + tab
//      + pane): the hub must reuse the attach (no second backend
//      connection) and viewer 2's FIRST paint must contain viewer 1's
//      earlier output (replay snapshot delivered before live events).
//   3. A marker typed via viewer 2 must appear in BOTH viewers (fan-out).
//   4. Viewer 1 keeps a healthy socket across viewer 2's full lifecycle
//      (join + close): its own socket must not reconnect (stability under
//      sibling churn; the old per-WS attach would have been torn down or
//      taken over here).
//
// Usage: ACCEPT_REPO=... E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/multi-viewer-acceptance.mjs
import { connectToPage, connectToTarget, createTarget, openApp, closeTargetViaBrowser } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const REPO = process.env.ACCEPT_REPO;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture git repo) is required');
  process.exit(2);
}

const MARKER1 = 'HERDR_MULTI_V1_' + Date.now();
const MARKER2 = 'HERDR_MULTI_V2_' + Date.now();

const viewer1 = await connectToPage();
const title1 = await openApp(viewer1, URL);
check('viewer 1 loads the app', !!title1 && !/privacy|error/i.test(String(title1)), `title="${title1}"`);

// Hook a /ws/terminal open/close counter in viewer 1 BEFORE attaching, so
// sibling churn is measured against its own socket lifecycle.
await viewer1.evalExpr(`(() => {
  window.__termOpens = 0;
  window.__termCloses = 0;
  const OrigWS = window.WebSocket;
  window.WebSocket = function (url) {
    const ws = new OrigWS(url);
    if (String(url).includes('/ws/terminal?')) {
      window.__termOpens++;
      ws.addEventListener('close', () => { window.__termCloses++; });
    }
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(window.WebSocket, OrigWS);
  for (const k of Object.getOwnPropertyNames(OrigWS)) {
    try { window.WebSocket[k] = OrigWS[k]; } catch (_) {}
  }
  return true;
})()`);

// Create the workspace and select it in viewer 1.
const created = await viewer1.evalExpr(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'multi-viewer-e2e', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`, true);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);

await viewer1.evalExpr(`go(${JSON.stringify(wsId)})`);

// Wait for the terminal to attach in viewer 1.
let attached1 = null;
for (let i = 0; i < 30 && !attached1; i++) {
  attached1 = await viewer1.evalExpr(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, backend: currentSessionBackend ? currentSessionBackend() : 'n/a' };
  })()`);
  if (!attached1) await new Promise((r) => setTimeout(r, 500));
}
check('viewer 1 terminal attached with rendered rows', !!attached1, `state=${JSON.stringify(attached1)}`);
if (!attached1) process.exit(1);
// The first attach settles (the frontend fits the shell, possibly churning
// one extra socket during initial grid negotiation). What must NOT happen
// is further churn: baseline the counter once the echo round-trips and
// assert zero additional opens/closes across viewer 2's full lifecycle.

// Type a marker through viewer 1's terminal and wait for the echo.
await viewer1.send('Input.insertText', { text: `echo ${MARKER1}` });
await viewer1.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (ta) { ta.focus(); }
  return true;
})()`);
// Press Enter through the terminal surface (same path as a real keypress).
await viewer1.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (!ta) return false;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  ta.dispatchEvent(new KeyboardEvent('keydown', opts));
  ta.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
})()`);
let echoed1 = false;
let tail1 = '';
for (let i = 0; i < 30 && !echoed1; i++) {
  tail1 = await viewer1.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-400)`);
  // Echo shows the command line; the executed output shows the marker once.
  echoed1 = tail1.includes(MARKER1) && (tail1.match(new RegExp(MARKER1, 'g')) || []).length >= 2;
  if (!echoed1) await new Promise((r) => setTimeout(r, 300));
}
check('viewer 1 input reaches the PTY and echoes the marker', echoed1, tail1.slice(-160));
if (!echoed1) process.exit(1);
const baselineOpens = await viewer1.evalExpr('window.__termOpens');
const baselineCloses = await viewer1.evalExpr('window.__termCloses');
check('viewer 1 socket settled after first attach', baselineOpens >= 1, `opens=${baselineOpens}`);

// Viewer 2: a real second page target on the same URL/session/workspace.
const target2 = await createTarget(URL);
const viewer2 = await connectToTarget(target2.webSocketDebuggerUrl);
await openApp(viewer2, URL);
await viewer2.evalExpr(`go(${JSON.stringify(wsId)})`);
let attached2 = null;
for (let i = 0; i < 40 && !attached2; i++) {
  attached2 = await viewer2.evalExpr(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId };
  })()`);
  if (!attached2) await new Promise((r) => setTimeout(r, 500));
}
check('viewer 2 attaches to the same terminal', !!attached2 && attached2.terminalId === attached1.terminalId,
  `v1=${attached1 && attached1.terminalId} v2=${attached2 && attached2.terminalId}`);

// Replay: viewer 2's FIRST painted content must already contain viewer 1's
// earlier output (the hub delivers the replay snapshot before live events).
let replayOk = false;
let firstPaint = '';
for (let i = 0; i < 30 && !firstPaint; i++) {
  firstPaint = await viewer2.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '')`);
  if (!firstPaint) await new Promise((r) => setTimeout(r, 300));
}
replayOk = firstPaint.includes(MARKER1);
check('viewer 2 first paint contains viewer 1 output (replay)', replayOk,
  `paintLen=${firstPaint.length} hasMarker=${firstPaint.includes(MARKER1)}`);

// Fan-out: type through viewer 2, both viewers must show the new marker.
await viewer2.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (ta) { ta.focus(); return true; }
  return false;
})()`);
await viewer2.send('Input.insertText', { text: `echo ${MARKER2}` });
await viewer2.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (!ta) return false;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  ta.dispatchEvent(new KeyboardEvent('keydown', opts));
  ta.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
})()`);
let saw2in1 = false, saw2in2 = false, tailv1 = '', tailv2 = '';
for (let i = 0; i < 30 && !(saw2in1 && saw2in2); i++) {
  tailv1 = await viewer1.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-400)`);
  tailv2 = await viewer2.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-400)`);
  saw2in1 = tailv1.includes(MARKER2);
  saw2in2 = (tailv2.match(new RegExp(MARKER2, 'g')) || []).length >= 2;
  if (!(saw2in1 && saw2in2)) await new Promise((r) => setTimeout(r, 300));
}
check('fan-out: viewer 2 typing appears in viewer 2', saw2in2, tailv2.slice(-160));
check('fan-out: viewer 2 typing appears in viewer 1', saw2in1, tailv1.slice(-160));

// Viewer 1 socket stability across viewer 2's full lifecycle: joining and
// leaving a sibling must not reconnect viewer 1 (shared attach untouched).
await closeTargetViaBrowser(target2.id);
await new Promise((r) => setTimeout(r, 2500)); // past the 1.5s teardown grace
const socketStats = await viewer1.evalExpr('({ opens: window.__termOpens, closes: window.__termCloses })');
check(
  'viewer 1 socket survives viewer 2 join+leave without reconnect',
  socketStats.opens === baselineOpens && socketStats.closes === baselineCloses,
  `baseline {opens:${baselineOpens} closes:${baselineCloses}} after {opens:${socketStats.opens} closes:${socketStats.closes}}`,
);

// Viewer 1 can still drive the terminal after sibling churn.
await viewer1.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (ta) { ta.focus(); }
  return true;
})()`);
await viewer1.send('Input.insertText', { text: `echo HERDR_POST_CHURN_${Date.now()}` });
await viewer1.evalExpr(`(() => {
  const ta = document.querySelector('#terminal textarea');
  if (!ta) return false;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  ta.dispatchEvent(new KeyboardEvent('keydown', opts));
  ta.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
})()`);
let postChurn = false;
for (let i = 0; i < 30 && !postChurn; i++) {
  tail1 = await viewer1.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '').trim().slice(-400)`);
  postChurn = /HERDR_POST_CHURN_/.test(tail1) && (tail1.match(/HERDR_POST_CHURN_/g) || []).length >= 2;
  if (!postChurn) await new Promise((r) => setTimeout(r, 300));
}
check('viewer 1 terminal still interactive after sibling churn', postChurn, tail1.slice(-160));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} multi-viewer checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
}
try { await viewer1.close(); } catch (_) {}
try { await viewer2.close(); } catch (_) {}
process.exit(failed.length ? 1 : 0);
