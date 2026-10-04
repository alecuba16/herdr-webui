// Shared design-6 setup for the lens-switch scripts (paint/visual/
// widths/theme). The Chat|Terminal switch only shows on supported-agent
// panes with a non-null agent_session (design section 6), so a plain
// shell pane hides it. These helpers flip the pane into a deterministic
// seeded jcode pane first, reusing the proven lens-chat pattern:
//
//   1. read the pane's real shell pid off the screen (echo $$)
//   2. seed a synthetic jcode session whose last_pid IS that shell pid
//      (resolution step 1: process-tree unique hit)
//   3. flip the pane label to jcode with detectable on-screen text
//      (pane.agent_status_changed -> scheduleRefresh -> /api/agents
//      resolves the seeded session -> the switch appears)
//
// ORDER MATTERS: seed BEFORE the label flip. state.agents only
// refreshes on events (the builtin event hub has no periodic
// snapshot), so seeding after the flip would leave the page on a
// stale agents list forever.
//
// The store lives under the ISOLATED HOME booted by run-stack.sh
// (LENS_SWITCH_STORE env, default derives from XDG_CONFIG_HOME's
// parent), never the user's real ~/.jcode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function storeDir() {
  if (process.env.LENS_SWITCH_STORE) return process.env.LENS_SWITCH_STORE;
  // run-stack.sh puts the isolated HOME next to the xdg dir.
  const xdg = process.env.XDG_CONFIG_HOME || '';
  if (xdg) return path.join(path.dirname(xdg), '.jcode', 'sessions');
  return path.join(os.homedir(), '.jcode', 'sessions');
}

export async function typeText(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch });
  }
}

export async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
}

export async function focusTerminal(cdp) {
  return cdp.evalExpr(`(() => {
    const t = document.querySelector('#terminal textarea, #terminal');
    if (t) t.focus();
    return !!t;
  })()`, true);
}

// Reads the pane's shell pid off the rendered screen. The pid echo must
// happen BEFORE the label flip so its output stays above the label text
// and the flip does not scroll it away.
export async function readShellPid(cdp, { timeoutMs = 10000 } = {}) {
  await focusTerminal(cdp);
  await typeText(cdp, 'echo SHPID=$$');
  await pressEnter(cdp);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await cdp.evalExpr(`(() => {
      const t = (document.querySelector('#terminal') || {textContent: ''}).textContent;
      const m = t.match(/SHPID=(\\d+)/);
      return m ? m[1] : null;
    })()`, true);
    if (pid) return pid;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Seeds one synthetic session whose working_dir matches the workspace
// cwd (LENS_SWITCH_REPO/ACCEPT_ROOT) and whose last_pid is the pane's
// live shell pid: process-tree unique hit, resolution step 1. The
// cwd is resolved to its PHYSICAL path because the resolver
// string-compares the lsof-resolved live cwd (always physical) against
// working_dir — a logical path (macOS /tmp symlink) never matches.
export function seedSession({ pid, cwd }) {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  const realCwd = fs.realpathSync(cwd);
  const sessionId = `lensswitch_${Date.now()}`;
  const file = path.join(dir, `session_${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    working_dir: realCwd,
    last_pid: Number(pid),
    status: 'Active',
    messages: [{
      id: `message_${Date.now()}_seed_user1`,
      role: 'user',
      timestamp: '2026-10-04T10:00:00.000000Z',
      display_role: 'user',
      content: [{ type: 'text', text: 'LENS_SWITCH_Q1 seeded switch check' }],
    }, {
      id: `message_${Date.now()}_seed_asst1`,
      role: 'assistant',
      timestamp: '2026-10-04T10:00:01.000000Z',
      display_role: 'assistant',
      content: [{ type: 'text', text: 'LENS_SWITCH_A1 seeded switch check answer' }],
    }],
  }));
  return { sessionId, file };
}

// Reads the pane's shell physical cwd off the rendered screen (pwd -P):
// the resolver compares the lsof-resolved live cwd (always physical)
// against the seeded working_dir, so the seed must be exactly what the
// shell reports — not the workspace path the script may assume.
export async function readShellPwd(cdp, { timeoutMs = 10000 } = {}) {
  await focusTerminal(cdp);
  await typeText(cdp, 'echo SWPWD=$(pwd -P)');
  await pressEnter(cdp);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pwd = await cdp.evalExpr(`(() => {
      const t = (document.querySelector('#terminal') || {textContent: ''}).textContent;
      // The raw command echo contains the unexpanded SWPWD=$(pwd -P);
      // only the executed output has SWPWD=/... so anchor on the slash.
      const all = String(t).split(/SWPWD=/).slice(1);
      const hit = all.find((s) => s.startsWith('/'));
      if (!hit) return null;
      return hit.split(/\\s/)[0];
    })()`, true);
    if (pwd) return pwd;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Flips the pane label to jcode (detection matches panes whose visible
// text contains "jcode") and waits until the agents row reports the
// seeded session resolvable. Returns the session row, or null.
export async function flipToJcodePane(cdp, { expectSessionId, timeoutMs = 15000 } = {}) {
  await typeText(cdp, 'echo jcode lens switch e2e pane');
  await pressEnter(cdp);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await cdp.evalExpr(`(() => {
      const a = (state.agents || []).find(x => x.pane_id === state.pane);
      if (!a) return null;
      const s = a.agent_session;
      if (!s || !s.resolvable) return null;
      return { kind: s.kind, sid: s.session_id };
    })()`, true);
    if (row && (!expectSessionId || row.sid === `session_${expectSessionId}`)) return row;
    if (Date.now() > deadline) return row; // last seen row (may be null)
    await new Promise((r) => setTimeout(r, 400));
  }
}
