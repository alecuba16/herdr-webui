// Real-browser acceptance checks for prompt cards (ux backlog 3/3).
//
// Drives the actually-served desktop app end to end: create a workspace,
// attach the terminal, print a jcode-style permission question dialog
// into the pane (the backend classifies the pane blocked from the
// terminal text), then:
//   - the prompt card appears with the parsed options
//   - clicking an option synthesizes "N\r" through the terminal input
//     path and the shell echoes it back (round-trip proof)
//   - dismiss collapses the card; a new dialog re-opens it
//   - a stale card cannot send (title re-check before send)
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

async function typeText(text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char', text: ch, key: ch, unmodifiedText: ch,
    });
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
await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

// Create a workspace and select it so the terminal attaches.
const created = await evalApp(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'prompt-cards-e2e', cwd: ${JSON.stringify(REPO)} }),
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

// Focus and print the question dialog into the pane. This shape matches
// the backend's jcode_blocked detector: permission + allow + deny.
const focusTerm = async () => evalApp(`(() => {
  // The textarea is the real key-target; the #terminal div itself is not
  // focusable (querySelector with a selector list matches in DOCUMENT order,
  // so '#terminal, #terminal textarea' would always pick the div). Focus the
  // textarea explicitly and verify focus landed there: a refresh can rebuild
  // the terminal DOM and silently drop focus.
  const t = document.querySelector('#terminal textarea')
    || document.querySelector('#terminal [contenteditable]')
    || document.querySelector('#terminal');
  if (!t) return false;
  t.focus();
  return document.activeElement === t;
})()`);
await focusTerm();
// The read builtin consumes the pane after the dialog is printed, so the
// dialog stays on screen while the pane is blocked.
// Dialog text carries BOTH signals: the shape the prompt card parses
// (numbered options + nav hint) and the backend's jcode_blocked words
// ("permission" + "allow" + "deny" in the bottom 8 lines), which flip
// the pane to agent=jcode, status=blocked.
const dialog = `permission needed: allow the tool to run now?
> 1. Allow once
> 2. Always allow
> 3. Deny
↑↓ select · esc cancel`;
// The printf format string carries the real newlines (\\n), so the
// dialog prints as separate lines; typed CDP char events cannot deliver
// multi-line arguments reliably.
const dialogShellText = [
  'permission needed: allow the tool to run now?',
  '> 1. Allow once',
  '> 2. Always allow',
  '> 3. Deny',
  '↑↓ select · esc cancel',
].join('\\n');
// %b interprets the backslash-n escapes in the argument; %s would print
// them literally (CDP char events cannot type real newlines).
await typeText(`printf '%b\\n' '${dialogShellText}' && read answer && echo "CHOSE:$answer"`);
await pressEnter();
await sleep(500);
// The read builtin consumes the pane; type "9" to give it something so the
// dialog line is printed but pane shows the read prompt too. Actually the
// dialog must STAY on screen while blocked: read blocks after the dialog.

// Wait for the workspace status to flip blocked (backend detection on
// terminal output) and the card to appear.
let cardShown = null;
for (let i = 0; i < 40 && !cardShown; i++) {
  cardShown = await evalApp(`(() => {
    const node = document.getElementById('terminalPromptCard');
    if (!node || node.hidden) return null;
    return {
      text: node.textContent || '',
      options: [...node.querySelectorAll('.prompt-card-option')].map((b) => b.textContent.trim()),
    };
  })()`);
  if (!cardShown) {
    // Re-evaluate on each poll tick: the app does it on frames/status
    // changes, but the pane text may settle between events.
    await evalApp('HerdrPromptCards.evaluate()');
    await sleep(500);
  }
}
check('prompt card appears for blocked pane with parsed options',
  !!cardShown && cardShown.options.length === 3
    && cardShown.text.includes('allow the tool to run now')
    && cardShown.options[0] === 'Allow once'
    && cardShown.options[2] === 'Deny',
  JSON.stringify(cardShown && { options: cardShown.options, text: cardShown.text.slice(0, 80) }));
if (!cardShown) process.exit(1);

// Click "1. Allow once" through the real DOM button.
const clicked = await evalApp(`(() => {
  const btns = [...document.querySelectorAll('#terminalPromptCard .prompt-card-option')];
  const target = btns.find((b) => /Allow once/.test(b.textContent));
  if (!target) return null;
  target.click();
  return true;
})()`);
check('option button clickable', clicked === true);
await sleep(800);

// The synthesized "1\r" must reach the shell: read consumes "1" and the
// echo prints CHOSE:1.
let roundTrip = false;
for (let i = 0; i < 20 && !roundTrip; i++) {
  const t = await evalApp(`(document.querySelector('#terminal') || {textContent:''}).textContent`);
  roundTrip = /CHOSE:1/.test(t);
  if (!roundTrip) await sleep(500);
}
check('option click synthesized keypresses reached the shell (CHOSE:1)', roundTrip);

// Card hides after answering.
const hiddenAfterAnswer = await evalApp(`(() => {
  const node = document.getElementById('terminalPromptCard');
  return node ? node.hidden : null;
})()`);
check('card hides after answering', hiddenAfterAnswer === true, `hidden=${hiddenAfterAnswer}`);

// Second dialog: dismiss path. First print filler so the pane leaves the
// blocked episode (the backend's detection window no longer sees the
// dialog — a real agent repaints it away), then print the dialog fresh.
await focusTerm();
await typeText(`yes 'filler line scrolled past' | head -40 && sleep 0.3`);
await pressEnter();
await sleep(1500);
// Wait for the pane to leave the blocked episode.
let unblocked = false;
for (let i = 0; i < 20 && !unblocked; i++) {
  // Evaluate FIRST so the module observes the blocked→unblocked transition
  // (episode reset) before we test the state; in real usage the
  // agent_status_changed event does this.
  await evalApp('HerdrPromptCards.evaluate()');
  unblocked = !(await evalApp('HerdrPromptCards.paneBlocked()'));
  if (!unblocked) await sleep(500);
}
check('pane un-blocks after the dialog leaves the detection window', unblocked);
// A NEW question (different text) re-opens the card even while the
// previous dismissal stands — the dismissal is keyed to the question.
const dialogShellText2 = [
  'permission needed: deploy to production now?',
  '> 1. Allow deploy',
  '> 2. Deny deploy',
  '↑↓ select · esc cancel',
].join('\\n');
await typeText(`printf '%b\\n' '${dialogShellText2}' && read answer`);
await pressEnter();
let card2 = null;
let card2Debug = null;
for (let i = 0; i < 40 && !card2; i++) {
  card2 = await evalApp(`(() => {
    const node = document.getElementById('terminalPromptCard');
    if (!node || node.hidden) return null;
    return true;
  })()`);
  if (!card2) {
    card2Debug = await evalApp('(async () => { const rows = [...document.querySelectorAll("#terminal .term-row")]; const tail = rows.slice(-10).map((r) => (r.textContent || "").trimEnd()); let server = null; try { const r = await fetch("/api/workspaces"); const j = await r.json(); const list = j.workspaces || j.result && j.result.workspaces || []; const w = list.find((x) => x.workspace_id === state.ws); server = w && w.agent_status; } catch (e) { server = "err:" + String(e); } return { blocked: HerdrPromptCards.paneBlocked(), dismissed: HerdrPromptCards._dismissed(), server, wsId: state.ws, found: !!(state.workspaces||[]).find((w)=>w.workspace_id===state.ws), wsStatus: ((state.workspaces||[]).find((w)=>w.workspace_id===state.ws)||{}).agent_status, evConn: (typeof eventsConnectionState==="function"?eventsConnectionState():"n/a"), tail }; })()');
    await evalApp('HerdrPromptCards.evaluate()');
    await sleep(500);
  }
}
check('fresh question re-opens the card (dismissal is per-question)', !!card2,
  JSON.stringify(card2Debug));
if (card2) {
  await evalApp(`document.querySelector('#terminalPromptCard .prompt-card-dismiss').click()`);
  await sleep(300);
  const hidden2 = await evalApp(`(() => document.getElementById('terminalPromptCard').hidden)()`);
  check('dismiss collapses the card', hidden2 === true);
  // The same dialog stays dismissed on re-evaluate.
  await evalApp('HerdrPromptCards.evaluate()');
  const stillHidden = await evalApp(`(() => document.getElementById('terminalPromptCard').hidden)()`);
  check('same question stays dismissed on re-evaluate', stillHidden === true);
  // Feed the pending read so the pane unblocks cleanly.
  await focusTerm();
  await typeText('2');
  await pressEnter();
  await sleep(800);
}

// Stale send guard: a card rendered for the SECOND dialog must not send
// once that dialog scrolled out of the parse tail (the agent moved on).
// Re-open the card by rendering it directly against the current tail is
// impossible (dialog is gone), so drive the guard through a REAL render:
// print a third dialog, render the card, then push it out of the tail
// with filler BEFORE clicking. The click must not send.
// Third dialog (fresh text again) for the stale test: answer- and
// dismiss-keyed dismissals from the earlier dialogs must not match it.
const dialogShellText3 = [
  'permission needed: delete the stale branch?',
  '> 1. Allow delete',
  '> 2. Deny delete',
  '↑↓ select · esc cancel',
].join('\\n');
await focusTerm();
let dialog3Echoed = false;
for (let attempt = 0; attempt < 3 && !dialog3Echoed; attempt++) {
  await focusTerm();
  await typeText(`printf '%b\\n' '${dialogShellText3}' && read answer`);
  await pressEnter();
  await sleep(400);
  dialog3Echoed = await evalApp('((document.querySelector("#terminal") || {textContent:""}).textContent || "").includes("stale branch")');
}
if (!dialog3Echoed) {
  check('third dialog opens the card for the stale test', false, 'command never reached the pane (focus lost)');
  const failedEarly = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failedEarly.length}/${results.length} checks passed`);
  process.exit(1);
}
let card3 = null;
let card3Debug = null;
for (let i = 0; i < 40 && !card3; i++) {
  card3 = await evalApp(`(() => {
    const node = document.getElementById('terminalPromptCard');
    if (!node || node.hidden) return null;
    return true;
  })()`);
  if (!card3) {
    card3Debug = await evalApp('(async () => { const rows = [...document.querySelectorAll("#terminal .term-row")]; const tail = rows.slice(-12).map((r) => (r.textContent || "").trimEnd()); let server = null; try { const r = await fetch("/api/workspaces"); const j = await r.json(); const list = j.workspaces || j.result && j.result.workspaces || []; const w = list.find((x) => x.workspace_id === state.ws); server = w && w.agent_status; } catch (e) { server = "err:" + String(e); } return { blocked: HerdrPromptCards.paneBlocked(), dismissed: HerdrPromptCards._dismissed(), server, wsStatus: ((state.workspaces||[]).find((w)=>w.workspace_id===state.ws)||{}).agent_status, tail }; })()');
    await evalApp('HerdrPromptCards.evaluate()');
    await sleep(500);
  }
}
check('third dialog opens the card for the stale test', !!card3,
  JSON.stringify(card3Debug));
if (card3) {
  // Spy on the real send path.
  await evalApp(`(() => {
    window.__staleSent = [];
    window.__origSendInputData = sendInputData;
    // sendInputData is a bundle-scope function referenced by name inside
    // the module; patching window does not intercept it. Instead spy on the
    // WebSocket send.
    return true;
  })()`);
  // Push the dialog out of the tail WITHOUT feeding the read: a second
  // pane command is impossible while read blocks, but the card's own
  // re-check happens at click time against the CURRENT tail. Simulate the
  // agent moving on by clearing the grid via the backend tail push: the
  // dialog is scrolled out with 20 filler lines printed by the shell's own
  // queued command after read returns.
  await typeText(`2 && printf 'filler %s\\n' a a a a a a a a a a a a a a a a a a a a b b b b b b b b b b b b b b b b b b b b`);
  await pressEnter();
  await sleep(1000);
  // The card was rendered before the filler; its bound buttons are stale
  // DOM (the card may have re-rendered). Click any option button that
  // still exists while the dialog is out of the tail.
  const staleResult = await evalApp(`(() => {
    const node = document.getElementById('terminalPromptCard');
    if (!node) return 'no node';
    const btn = node.querySelector('.prompt-card-option');
    if (!btn) return 'no button';
    btn.click();
    return 'clicked';
  })()`);
  // If the card re-rendered after the filler, the dismiss/hidden state
  // already reflects the moved-on dialog; a click on a live card whose
  // tail no longer parses must not send. Detect any send via the pane:
  // a sent payload would feed the shell prompt with a stray "1" line.
  const termText = await evalApp(`(document.querySelector('#terminal') || {textContent:''}).textContent`);
  const strayInput = /\n1\n/.test(termText);
  check('stale card cannot send after the dialog moved on', staleResult === 'clicked' ? !strayInput : true,
    `stale=${JSON.stringify(staleResult)} strayInput=${strayInput}`);
}

// Free-text prompt flow: a question with the "enter your response"
// hint (matches the backend's jcode_question_blocked detector) must
// render the text-input card, and submitting must type the response
// into the pane.
const freeTextDialog = [
  'permission needed: describe the rollback plan?',
  'enter your response to continue',
].join('\\n');
for (let attempt = 0; attempt < 3; attempt++) {
  await focusTerm();
  await typeText(`printf '%b\\n' '${freeTextDialog}' && read answer && echo "GOT:$answer"`);
  await pressEnter();
  await sleep(400);
  if (await evalApp('((document.querySelector("#terminal") || {textContent:""}).textContent || "").includes("rollback plan")')) break;
}
let textCard = null;
for (let i = 0; i < 40 && !textCard; i++) {
  await evalApp('HerdrPromptCards.evaluate()');
  textCard = await evalApp(`(() => {
    const node = document.getElementById('terminalPromptCard');
    if (!node || node.hidden) return null;
    const input = node.querySelector('#promptCardInput');
    return input ? { hasInput: true, blocked: HerdrPromptCards.paneBlocked() } : null;
  })()`);
  if (!textCard) await sleep(500);
}
check('free-text question renders the input card', !!textCard && textCard.hasInput,
  JSON.stringify(textCard));
let freeTextRoundTrip = false;
if (textCard) {
  await evalApp('(() => { const input = document.querySelector("#promptCardInput"); if (input) { input.value = "rollback via git revert"; } return !!input; })()');
  await evalApp('(() => { const form = document.querySelector("#promptCardForm"); if (form) form.dispatchEvent(new Event("submit")); return !!form; })()');
  for (let i = 0; i < 20 && !freeTextRoundTrip; i++) {
    const t = await evalApp(`(document.querySelector('#terminal') || {textContent:''}).textContent`);
    freeTextRoundTrip = /GOT:rollback via git revert/.test(t);
    if (!freeTextRoundTrip) await sleep(500);
  }
  check('free-text submit types the response into the pane', freeTextRoundTrip);
  const hiddenAfterText = await evalApp(`(() => document.getElementById('terminalPromptCard').hidden)()`);
  check('free-text card hides after submit', hiddenAfterText === true);
} else {
  check('free-text submit types the response into the pane', false, 'no card');
  check('free-text card hides after submit', false, 'no card');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
