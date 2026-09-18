// Live PTY env check: spawn a builtin pane through the real served app,
// type a printf of the image-hint env, and print what the pane sees.
// Usage: E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/term_env_check.mjs
import { connectToPage } from './cdp-driver.mjs';

const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8894/';
const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 1500));
// Mirror the other acceptance scripts: touch localStorage, reload.
await cdp.evalExpr(`(() => { const opts = JSON.parse(localStorage.getItem('herdr-web-options') || '{}'); localStorage.setItem('herdr-web-options', JSON.stringify(opts)); })()`, true);
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

// Wait for the app JS to expose go().
let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  ready = await cdp.evalExpr(`typeof go === 'function'`, true);
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.error('FAIL: app JS never exposed go()');
  process.exit(1);
}

const ws = await cdp.evalExpr(`fetch('/api/workspaces', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({cwd:'/tmp'})}).then(r=>r.json())`, true);
const wsId = ws.result && ws.result.workspace && ws.result.workspace.workspace_id;
if (!wsId) {
  console.error('FAIL: workspace not created: ' + JSON.stringify(ws).slice(0, 200));
  process.exit(1);
}
await cdp.evalExpr(`go(${JSON.stringify(wsId)})`, true);

// Wait for the terminal to attach, then type the env printf.
await new Promise((r) => setTimeout(r, 3000));
await cdp.evalExpr(`(() => { const el = document.getElementById('terminal'); const a = el && el.__herdrTerminalAdapter; if (a) a.focus(); const ta = el && el.querySelector('textarea'); if (ta) ta.focus(); })()`, true);
await new Promise((r) => setTimeout(r, 200));
await cdp.send('Input.insertText', { text: `printf 'TP=%s KID=%s TERM=%s' "$TERM_PROGRAM" "$KITTY_WINDOW_ID" "$TERM"` });
await new Promise((r) => setTimeout(r, 200));
await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

let found = null;
for (let i = 0; i < 20 && !found; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const text = await cdp.evalExpr(`((document.querySelector('#terminal .term-grid') || {}).textContent || '')`, true);
  // The shell echoes the typed command itself (literal %s placeholders), so
  // take the LAST match: command output comes after the echo. Values end at
  // a space, quote, or end-of-line (zsh prompts may append % right after).
  const all = String(text).match(/TP=\S* KID=\S* TERM=[\w.-]*/g) || [];
  const last = all[all.length - 1];
  if (last && !/%s/.test(last)) found = last;
}
if (!found) {
  console.error('FAIL: env printf never appeared in the pane');
  process.exit(1);
}
console.log('PANE ENV:', found);
const [, tp, kid, term] = found.match(/TP=(\S*) KID=(\S*) TERM=([\w.-]*)/);
const ok = tp === 'ghostty' && kid === '' && term === 'xterm-256color';
console.log(ok ? 'ENV HINTS LIVE CHECK: PASS' : 'ENV HINTS LIVE CHECK: FAIL');
process.exit(ok ? 0 : 1);