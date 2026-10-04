// Real-browser acceptance checks for the chat composer (server-side
// submit, ux parity with upstream herdr-web-ui).
//
// Drives the actually-served desktop app end to end:
//   - a workspace attaches with a live shell pane
//   - a `cat` is left reading stdin in the pane so anything the server
//     pastes echoes back verbatim (round-trip proof through the real
//     server route, NOT the browser's own typing path)
//   - the lens opens; the composer appears; typing + Send POSTs to
//     /api/panes/{id}/submit; the server pastes bracketed + Enter after
//     the gap; the echo appears in the terminal; the box clears
//   - per-pane draft survives a pane switch and back
//   - a blocked pane (jcode-style question dialog) refuses the submit
//     server-side with agent_blocked: the note shows, the draft stays
//   - the lens closing hides the composer again
//
// The submit goes through the paneId the UI tracks (state.pane).
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_ROOT;
const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8796/';
if (!REPO) {
  console.error('ACCEPT_ROOT (absolute scratch dir, must exist) is required');
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

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

// Create a workspace and select it so the terminal attaches.
const created = await evalApp(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'composer-e2e', cwd: ${JSON.stringify(REPO)} }),
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
    if (!state.terminalId || !state.pane) return null;
    const rows = document.querySelectorAll('#terminal .term-row');
    if (!rows.length) return null;
    return { terminalId: state.terminalId, pane: state.pane };
  })()`);
  if (!attached) await sleep(500);
}
check('terminal attached with rendered rows and pane id', !!attached,
  JSON.stringify(attached));
if (!attached) process.exit(1);
const paneId = attached.pane;

// Leave a cat reading stdin: everything the server pastes echoes back,
// so the composer's submit is observable in the terminal text.
const focusTerm = async () => evalApp(`(() => {
  const t = document.querySelector('#terminal textarea')
    || document.querySelector('#terminal [contenteditable]')
    || document.querySelector('#terminal');
  if (!t) return false;
  t.focus();
  return document.activeElement === t;
})()`);
const typeText = async (text) => {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char', text: ch, key: ch, unmodifiedText: ch,
    });
  }
};
const pressEnter = async () => {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
};
await focusTerm();
await typeText('cat');
await pressEnter();
await sleep(600);

// Open the lens: the composer must appear.
await evalApp(`HerdrLens && HerdrLens.setLens ? HerdrLens.setLens(true) : null`);
await sleep(600);
const composerShown = await evalApp(`(() => {
  HerdrComposer.sync();
  const node = document.getElementById('terminalComposer');
  if (!node) return null;
  return { hidden: node.hidden, hasInput: !!node.querySelector('#terminalComposerInput') };
})()`);
check('lens open shows the composer with a textarea',
  !!composerShown && composerShown.hidden === false && composerShown.hasInput,
  JSON.stringify(composerShown));
if (!composerShown || !composerShown.hasInput) process.exit(1);

// Type into the composer through the real DOM (input events fire the
// draft store), then submit through the real route.
await evalApp(`(() => {
  const input = document.querySelector('#terminalComposerInput');
  input.value = 'hello from composer\\nsecond line';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
// Submit via the Send button's real DOM path.
await evalApp(`(() => {
  const btn = document.querySelector('#terminalComposerSend');
  btn.click();
  return true;
})()`);
// The server types the paste + Enter (gap 300ms) and cat echoes it.
// The lens covers the grid while open, and covered rendering pauses wterm
// paints (0161c0f): the echo bytes land in the bridge but the DOM stays
// frozen until the lens closes. Reading the grid with the lens open can
// never see the echo, so close it first — which also verifies the unpause
// repaint contract: the grid must catch up from the bridge after close.
await evalApp(`HerdrLens.setLens(false)`);
let echoSeen = false;
let echoDebug = '';
for (let i = 0; i < 40 && !echoSeen; i++) {
  const t = await evalApp(`((document.querySelector('#terminal') || {textContent:''}).textContent || '')`);
  echoSeen = /hello from composer[\s\S]*second line/.test(t);
  echoDebug = JSON.stringify(t.slice(-400));
  if (!echoSeen) await sleep(500);
}
check('submit pasted the message into the pane (cat echoes it)', echoSeen,
  echoDebug.slice(0, 200));
// The composer lives inside the lens: reopen it for the remaining checks.
await evalApp(`HerdrLens.setLens(true)`);
await sleep(400);

// The box clears after a successful send.
await sleep(300);
const afterSend = await evalApp(`(() => ({
  value: document.querySelector('#terminalComposerInput').value,
  noteHidden: document.querySelector('#terminalComposerNote').hidden,
}))()`);
check('box clears after successful send',
  afterSend && afterSend.value === '' && afterSend.noteHidden === true,
  JSON.stringify(afterSend));

// Per-pane draft: type a draft, switch to a second workspace's pane,
// then come back.
await evalApp(`(() => {
  const input = document.querySelector('#terminalComposerInput');
  input.value = 'draft kept across switch';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
const created2 = await evalApp(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'composer-e2e-2', cwd: ${JSON.stringify(REPO)} }),
    });
    const j = await r.json();
    go(j.result.workspace.workspace_id);
    return j.result.workspace.workspace_id;
  } catch (e) { return { error: String(e) }; }
})()`);
await sleep(1500);
let secondPane = null;
for (let i = 0; i < 20 && !(secondPane && secondPane.pane); i++) {
  secondPane = await evalApp(`(() => ({ pane: state.pane, ws: state.ws }))()`);
  if (!(secondPane && secondPane.pane)) await sleep(500);
}
check('switched to a second workspace pane',
  secondPane && secondPane.pane && secondPane.pane !== paneId,
  JSON.stringify(secondPane));
// Composer box shows the second pane's (empty) draft.
const boxSecond = await evalApp(`(() => ({
  value: document.querySelector('#terminalComposerInput').value }))()`);
check('second pane starts with an empty draft',
  boxSecond && boxSecond.value === '', JSON.stringify(boxSecond));
// Go back to the first workspace pane.
await evalApp(`go(${JSON.stringify(wsId)})`);
await sleep(1500);
const restored = await evalApp(`(() => {
  HerdrComposer.sync();
  return {
    pane: state.pane,
    value: document.querySelector('#terminalComposerInput').value };
})()`);
check('first pane draft restored after switching back',
  restored && restored.pane === paneId && restored.value === 'draft kept across switch',
  JSON.stringify(restored));
// Clear the draft so later checks start clean.
await evalApp(`(() => {
  const input = document.querySelector('#terminalComposerInput');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  HerdrComposer.drafts.delete(state.pane);
  return true;
})()`);
await sleep(200);

// Blocked refusal: print a jcode-style question dialog so the backend
// classifies the pane blocked, then try to submit; the server refuses
// with agent_blocked, the note shows, the draft stays.
await focusTerm();
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
await sleep(400); // ctrl-c ends cat
const dialogShellText = [
  'permission needed: allow the tool to run now?',
  '> 1. Allow once',
  '> 2. Always allow',
  '> 3. Deny',
  '↑↓ select · esc cancel',
].join('\\n');
await typeText(`printf '%b\\n' '${dialogShellText}' && read answer`);
await pressEnter();
await sleep(500);
let blocked = false;
for (let i = 0; i < 40 && !blocked; i++) {
  await evalApp('HerdrPromptCards.evaluate()');
  blocked = !!(await evalApp(`(() => HerdrPromptCards.paneBlocked())()`));
  if (!blocked) await sleep(500);
}
check('pane flips blocked after the question dialog', blocked);
if (!blocked) process.exit(1);

// Try to submit while blocked.
await evalApp(`(() => {
  const input = document.querySelector('#terminalComposerInput');
  input.value = 'must be refused';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = document.querySelector('#terminalComposerSend');
  btn.click();
  return true;
})()`);
let refusal = null;
for (let i = 0; i < 30 && !refusal; i++) {
  refusal = await evalApp(`(() => {
    const note = document.querySelector('#terminalComposerNote');
    if (!note || note.hidden) return null;
    return {
      text: note.textContent,
      value: document.querySelector('#terminalComposerInput').value,
    };
  })()`);
  if (!refusal) await sleep(400);
}
check('blocked submit refused server-side with the server-owned note',
  !!refusal && refusal.text ===
    'Not sent: the agent is waiting for an answer in the terminal. Answer it first.',
  JSON.stringify(refusal));
check('draft kept after the refusal', refusal && refusal.value === 'must be refused',
  JSON.stringify(refusal && refusal.value));
// Nothing of the refused message may have reached the pane.
const paneText = await evalApp(`((document.querySelector('#terminal') || {textContent:''}).textContent || '')`);
check('refused message never reached the pane',
  !/must be refused/.test(paneText), '');

// Feed the pending read so the pane un-blocks cleanly.
await focusTerm();
await typeText('1');
await pressEnter();
await sleep(800);

// Lens off hides the composer.
await evalApp(`HerdrLens.setLens(false)`);
await sleep(400);
const hiddenAfterLensOff = await evalApp(`(() => {
  HerdrComposer.sync();
  const node = document.getElementById('terminalComposer');
  return node ? node.hidden : null;
})()`);
check('lens close hides the composer', hiddenAfterLensOff === true,
  `hidden=${hiddenAfterLensOff}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('FAILED checks:');
  for (const f of failed) console.error(`  - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
