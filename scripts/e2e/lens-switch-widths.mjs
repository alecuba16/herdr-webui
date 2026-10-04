// Viewport-width sweep for the Chat|Terminal switch (occlusion fix
// follow-up): the switch must stay the top hit target in Chat view at
// narrow window widths too, where the lens content column and the
// composer compete for space.
// Design 6: the switch only shows on jcode panes with a resolvable
// agent_session, so the pane is flipped into a seeded jcode pane first
// (lens-switch-helpers); the sweep then runs against that pane.
import { connectToPage } from './cdp-driver.mjs';
import { readShellPid, readShellPwd, seedSession, flipToJcodePane } from './lens-switch-helpers.mjs';

const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8798/';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

const created = await cdp.evalExpr(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'lens-widths', cwd: ${JSON.stringify(process.env.ACCEPT_ROOT || '.')} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`, true);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `wsId=${wsId}`);
if (!wsId) process.exit(1);
await cdp.evalExpr(`go(${JSON.stringify(wsId)})`);
await sleep(2000);

let attached = false;
for (let i = 0; i < 20 && !attached; i++) {
  attached = !!(await cdp.evalExpr(`(() => !!(state.terminalId && document.querySelectorAll('#terminal .term-row').length))()`, true));
  if (!attached) await sleep(500);
}
check('terminal attached', attached);
if (!attached) process.exit(1);

// Design-6 setup: shell pid -> seeded session -> jcode label flip. The
// sweep needs the switch visible, which only happens on the jcode pane.
const pid = await readShellPid(cdp);
check('read shell pid off the screen', !!pid, `pid=${pid}`);
if (!pid) process.exit(1);
const shellCwd = await readShellPwd(cdp);
check('read shell cwd off the screen', !!shellCwd, `cwd=${shellCwd}`);
if (!shellCwd) process.exit(1);
const { sessionId } = seedSession({ pid, cwd: shellCwd });
const sessionRow = await flipToJcodePane(cdp, { expectSessionId: sessionId });
check('seeded session resolves after jcode label flip',
  !!sessionRow && sessionRow.sid === `session_${sessionId}`, JSON.stringify(sessionRow));
if (!sessionRow) process.exit(1);

for (const [width, height] of [[1600, 1000], [1280, 800], [1024, 768], [800, 600]]) {
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
  await sleep(400);

  // Ensure Chat view is ON for this width (flip from whatever state).
  await cdp.evalExpr(`if (!HerdrLens.isActive()) document.getElementById('lensToggleChat').click()`, true);
  await sleep(400);

  const probe = await cdp.evalExpr(`(() => {
    const sw = document.getElementById('terminalLensSwitch');
    const lens = document.getElementById('terminalLens');
    if (!sw || !lens) return null;
    const r = sw.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      visible: r.width > 0 && r.height > 0,
      onScreen: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
      hitInSwitch: !!(hit && (hit === sw || sw.contains(hit))),
      hitDesc: hit ? (hit.id || hit.className || hit.tagName) : 'none',
      vw: innerWidth, vh: innerHeight,
    };
  })()`, true);
  check(`switch hittable in Chat view at ${width}x${height}`,
    !!probe && probe.visible && probe.onScreen && probe.hitInSwitch,
    JSON.stringify(probe));

  // And clicking it at this width actually returns to Terminal.
  const before = await cdp.evalExpr('HerdrLens.isActive()', true);
  await cdp.evalExpr(`document.getElementById('lensToggleTerminal').click()`, true);
  await sleep(300);
  const after = await cdp.evalExpr('HerdrLens.isActive()', true);
  check(`clicking Terminal works at ${width}x${height}`,
    before === true && after === false, `before=${before} after=${after}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);