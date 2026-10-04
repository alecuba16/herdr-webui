// Real-browser acceptance checks for the structured chat lens
// (phase 2, jcode transcript mode). Runs against the stack booted by
// run-lens-chat-e2e.sh: isolated server with its own HOME and an
// empty jcode store that this script seeds directly.
//
// Flow:
//   1. create workspace, attach, read the pane's shell pid off the
//      screen (echo $$)
//   2. seed a synthetic jcode session whose last_pid IS that shell pid
//      BEFORE the label flip (resolution step 1: process-tree unique
//      hit). ORDER MATTERS: state.agents only refreshes when an event
//      fires (pane.agent_status_changed on the label flip triggers
//      scheduleRefresh); there is no periodic snapshot on the builtin
//      event hub, so seeding after the flip would leave the page on a
//      stale agents list forever
//   3. flip the pane label to jcode with detectable on-screen text:
//      the status event refreshes /api/agents and the seeded session
//      resolves, making the switch visible
//   4. lens renders seeded turns: user card, assistant text, thinking
//      row, tool row
//   5. journal append mid-test: the 2s poll must sync in place, keep
//      expansion state, and keep fetched full output
//   6. refusal: re-seed with a working_dir that cannot match the pane
//      -> the open lens's own poll catches the 404, switch stays
//      visible, lens shows refusal copy
//   7. zero terminal-socket churn across the whole run
import fs from 'node:fs';
import path from 'node:path';
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8797/';
const STORE = process.env.LENS_CHAT_STORE;
if (!STORE) {
  console.error('LENS_CHAT_STORE (isolated .jcode/sessions dir) is required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalApp(expr) {
  return cdp.evalExpr(expr, true);
}
async function typeText(text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch });
  }
}
async function pressEnter() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');

// Socket probe: the lens polls over fetch, never over the terminal socket.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  (() => {
    globalThis.__wsProbe = { opens: 0 };
    const NativeWS = WebSocket;
    const WrappedWS = function (url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      if (String(url).includes('/ws/terminal?')) {
        globalThis.__wsProbe.opens += 1;
      }
      return ws;
    };
    try {
      WrappedWS.prototype = NativeWS.prototype;
      Object.setPrototypeOf(WrappedWS, NativeWS);
      WrappedWS.OPEN = NativeWS.OPEN;
      WrappedWS.CONNECTING = NativeWS.CONNECTING;
      WrappedWS.CLOSING = NativeWS.CLOSING;
      WrappedWS.CLOSED = NativeWS.CLOSED;
      window.WebSocket = WrappedWS;
    } catch (e) {}
  })();
` });

await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

// 1. Create the workspace over the API and select it.
const created = await evalApp(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'lens-chat', cwd: ${JSON.stringify(process.env.LENS_CHAT_REPO || '.')} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && created.result && created.result.workspace
  && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);

await evalApp(`go(${JSON.stringify(wsId)})`);
await sleep(1000);

let attached = null;
for (let i = 0; i < 20 && !attached; i++) {
  attached = await evalApp(`(() => {
    if (!state.terminalId) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId };
  })()`);
  if (!attached) await sleep(500);
}
check('terminal attached with rendered rows', !!attached);
if (!attached) process.exit(1);
await sleep(1500);
const baselineOpens = (await evalApp('globalThis.__wsProbe.opens')) || 0;

// 2. Read the pane's shell pid off the screen, then flip the pane to a
//    jcode-labeled pane with detectable on-screen text. ORDER MATTERS:
//    the pid echo must come first so its output is above the label
//    text and the label flip does not scroll it away.
const focusTerm = () => evalApp(`(() => {
  const t = document.querySelector('#terminal textarea, #terminal');
  if (t) t.focus();
  return !!t;
})()`);
await focusTerm();
await typeText('echo SHPID=$$');
await pressEnter();
let pidLine = null;
for (let i = 0; i < 20 && !pidLine; i++) {
  pidLine = await evalApp(`(() => {
    const t = (document.querySelector('#terminal') || {textContent: ''}).textContent;
    const m = t.match(/SHPID=(\\d+)/);
    return m ? m[1] : null;
  })()`);
  if (!pidLine) await sleep(500);
}
check('read shell pid off the screen', !!pidLine, `pid=${pidLine}`);
if (!pidLine) process.exit(1);

// 3. Seed the synthetic session BEFORE the label flip: the flip fires
//    pane.agent_status_changed (agent None->jcode) which triggers a
//    frontend refresh of /api/agents. With the store already seeded, that
//    refresh resolves the session and unhides the switch. The structured
//    lens's own 2s poll re-verifies per tick, but the gate (state.agents)
//    only updates on events, so seeding after the flip would never
//    propagate on the builtin event hub (no periodic snapshot).
function seedSession({ sessionId, pid, cwd, resolvable }) {
  fs.mkdirSync(STORE, { recursive: true });
  const sessionFile = path.join(STORE, `session_${sessionId}.json`);
  if (resolvable) {
    const messages = [
      { id: `message_${Date.now()}_seed_user1`, role: 'user', timestamp: '2026-10-04T10:00:00.000000Z', display_role: 'user',
        content: [{ type: 'text', text: 'LENS_CHAT_Q1 say jcode lens e2e first answer' }] },
      { id: `message_${Date.now()}_seed_asst1`, role: 'assistant', timestamp: '2026-10-04T10:00:01.000000Z', display_role: 'assistant',
        content: [
          { type: 'reasoning', text: 'LENS_CHAT_THINK_1 thinking about the answer' },
          { type: 'text', text: 'LENS_CHAT_A1 jcode lens e2e first answer' },
        ] },
    ];
    fs.writeFileSync(sessionFile, JSON.stringify({
      working_dir: cwd,
      last_pid: Number(pid),
      status: 'Active',
      messages,
    }));
  } else {
    // Refusal: evidence pointing at a cwd that cannot match any pane.
    fs.writeFileSync(sessionFile, JSON.stringify({
      working_dir: '/definitely/not/the/pane/cwd',
      last_pid: Number(pid),
      status: 'Active',
      messages: [],
    }));
  }
  return sessionFile;
}

const SESS = 'lenschat_' + Date.now();
const repo = process.env.LENS_CHAT_REPO || '.';
const seededPath = seedSession({ sessionId: SESS, pid: pidLine, cwd: repo, resolvable: true });

// jcode-labeled pane: the detection classifies a pane whose visible
// text contains "jcode" as a jcode agent pane (builtin_backend
// detect_agent_label_from_text). A bare comment keeps the shell usable.
// This flip is the event that refreshes state.agents and resolves the
// already-seeded session.
await typeText('echo jcode lens e2e session ready');
await pressEnter();
await sleep(2500);

// 4. Poll until the api row reports the seeded session (the flip's
//    status event drives the refresh; the poll covers slow machines).
let sessionRow = null;
for (let i = 0; i < 30 && !sessionRow; i++) {
  sessionRow = await evalApp(`(() => {
    const a = (state.agents || []).find(x => x.pane_id === state.pane);
    if (!a) return null;
    const s = a.agent_session;
    if (!s || !s.resolvable) return null;
    return { kind: s.kind, sid: s.session_id };
  })()`);
  if (!sessionRow) await sleep(500);
}
check('agent_session resolves to seeded session',
  !!sessionRow && sessionRow.sid === `session_${SESS}`,
  JSON.stringify(sessionRow));
if (!sessionRow) process.exit(1);

// 5. Switch visible on the jcode pane (design 6).
const swVisible = await evalApp(`(() => {
  const n = document.getElementById('terminalLensSwitch');
  return { hidden: n ? n.hidden : null, agent: ((state.agents||[]).find(x=>x.pane_id===state.pane)||{}).agent };
})()`);
check('switch visible on jcode pane (design 6)',
  !!swVisible && swVisible.hidden === false && swVisible.agent === 'jcode',
  JSON.stringify(swVisible));

// 6. Open the lens: structured turns from the seeded conversation.
await evalApp(`HerdrLens.toggle()`);
await sleep(1000);
const lensShape = await evalApp(`(() => {
  const lens = document.getElementById('terminalLens');
  if (!lens || lens.hidden) return null;
  const content = lens.querySelector('.terminal-lens-content');
  return {
    text: content ? content.textContent.slice(0, 2000) : '',
    userCards: lens.querySelectorAll('.lens-turn-user').length,
    thinkingRows: lens.querySelectorAll('.lens-thinking').length,
    toolRows: lens.querySelectorAll('.lens-tool').length,
    textRows: lens.querySelectorAll('.lens-text').length,
  };
})()`);
check('structured lens renders seeded turns',
  !!lensShape
    && lensShape.text.includes('LENS_CHAT_Q1')
    && lensShape.text.includes('LENS_CHAT_A1')
    && lensShape.userCards >= 1,
  JSON.stringify(lensShape && { cards: lensShape.userCards, think: lensShape.thinkingRows, tools: lensShape.toolRows, text: lensShape.text.slice(0, 80) }));
check('thinking row rendered from reasoning block',
  !!lensShape && lensShape.thinkingRows >= 1,
  `thinkingRows=${lensShape && lensShape.thinkingRows}`);

// 7. Journal append mid-flight: append a new turn to the journal and
//    wait for the 2s poll. The new turn must appear IN PLACE (same
//    pane, same lens) without a full re-open.
//    Journal lines are jcode's envelope shape: a bare message object
//    would be skipped by load_session_messages (non-message entries
//    carry no append_messages).
const journalPath = path.join(STORE, `session_${SESS}.journal.jsonl`);
fs.appendFileSync(journalPath, JSON.stringify({
  append_messages: [{
    id: `message_${Date.now()}_seed_asst2`,
    role: 'assistant',
    timestamp: '2026-10-04T10:00:02.000000Z',
    display_role: 'assistant',
    content: [{ type: 'text', text: 'LENS_CHAT_A2 jcode lens e2e second answer' }],
  }],
}) + '\n');
let appended = false;
for (let i = 0; i < 30 && !appended; i++) {
  const t = await evalApp(`(document.getElementById('terminalLens') || {textContent:''}).textContent`);
  appended = t.includes('LENS_CHAT_A2');
  if (!appended) await sleep(500);
}
check('journal append syncs into open lens via poll', appended);

// 7. Expansion state survives poll renders: no rows were replaced, the
//    turn count only grew (in-place sync keeps keyed rows).
const stableRows = await evalApp(`(() => {
  const lens = document.getElementById('terminalLens');
  const rows = lens ? lens.querySelectorAll('[data-part-key]').length : 0;
  return rows;
})()`);
check('in-place sync keeps keyed rows', stableRows >= 2, `rows=${stableRows}`);

// 9. Refusal shape: re-seed with a non-matching cwd -> resolvable:false.
//    Switch must STAY visible (design 6) and the lens shows the refusal
//    copy instead of turns. The lens's own 2s poll re-fetches and gets a
//    404/transcript_missing, so no frontend refresh is needed here.
seedSession({ sessionId: SESS, pid: pidLine, cwd: '/definitely/not/the/pane/cwd', resolvable: false });
let refusalShown = false;
for (let i = 0; i < 30 && !refusalShown; i++) {
  refusalShown = await evalApp(`(() => {
    const lens = document.getElementById('terminalLens');
    const sw = document.getElementById('terminalLensSwitch');
    if (!lens || lens.hidden) return false;
    const t = lens.textContent || '';
    return t.includes('No jcode conversation found for this panel yet')
      && sw && sw.hidden === false;
  })()`);
  if (!refusalShown) await sleep(500);
}
check('refusal keeps switch visible and shows refusal copy', refusalShown);

// 10. Socket churn: zero across the whole structured run.
const finalOpens = (await evalApp('globalThis.__wsProbe.opens')) || 0;
check('structured lens opened zero terminal sockets', finalOpens === baselineOpens,
  `baseline=${baselineOpens} final=${finalOpens}`);

const failed = results.filter(r => !r.ok).length;
console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed}/${results.length} checks FAILED`);
process.exit(failed === 0 ? 0 : 1);