// Real-browser acceptance checks for the desktop file explorer edit-mode rework.
// Drives the actually-served app end to end: dashboard -> workspace create ->
// files mode -> open file -> edit / lock / save, and verifies disk persistence.
//
// Requirements (see scripts/e2e/README.md):
//   - a built herdr-webui binary
//   - a scratch repo fixture with src/demo.py
//   - headless Chrome on CDP_PORT
//   - the server already running (start-e2e.sh) with E2E_BASE_URL pointing at it
import { connectToPage } from './cdp-driver.mjs';
import { readFileSync } from 'node:fs';

const REPO = process.env.ACCEPT_REPO;
const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture git repo) is required');
  process.exit(2);
}
const DEMO_FILE = `${REPO}/src/demo.py`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
// Navigate (self-signed cert accepted via CDP flag above).
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

let title = await cdp.evalExpr('document.title');
if (!title || title === 'Privacy error' || String(title).includes('Privacy')) {
  // accept interstitial
  await cdp.evalExpr('window.location.href = "' + URL + '"');
  await new Promise((r) => setTimeout(r, 2000));
  title = await cdp.evalExpr('document.title');
}
check('app loads (title present)', !!title, `title="${title}"`);

// Wait for app shell
await new Promise((r) => setTimeout(r, 2000));

// 0) Close any stale workspace(s) from prior runs via their real sidebar close buttons.
const closedPrior = await cdp.evalExpr(`(async () => {
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const b = document.querySelector('[data-workspace-action="close"]');
    if (!b) break;
    b.click();
    // The app asks via its in-app question modal; confirm it.
    for (let j = 0; j < 20; j++) {
      const q = document.getElementById('questionModal');
      if (q && getComputedStyle(q).display === 'grid') break;
      await new Promise(r => setTimeout(r, 150));
    }
    const confirmBtn = document.getElementById('questionConfirm');
    if (confirmBtn) confirmBtn.click();
    await new Promise(r => setTimeout(r, 2000));
    n++;
  }
  return n;
})()`, true);
if (closedPrior > 0) console.log(`closed ${closedPrior} stale workspace(s) via real sidebar buttons`);

// 1) Open workspace: if the dashboard is shown use its button; else a workspace already exists.
const openResult = await cdp.evalExpr(`(async () => {
  const dash = !!document.querySelector('.project-dashboard-card');
  if (!dash) return 'workspace-already-open';
  const btns = [...document.querySelectorAll('button')];
  const pick = btns.find(b => (b.textContent || '').includes('Open workspace or worktree'));
  if (!pick) return 'no-pick';
  pick.click();
  await new Promise(r => setTimeout(r, 800));
  const modal = document.getElementById('worktreeOpenModal');
  return modal ? getComputedStyle(modal).display : 'absent';
})()`, true);
if (openResult === 'grid') {
  check('worktree open modal opens via dashboard button', true);
  const wsResult = await cdp.evalExpr(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const input = document.getElementById('worktreeDiscoverPath');
    const label = document.getElementById('worktreeWorkspaceLabel');
    const err = document.getElementById('worktreeOpenError');
    if (!input || !label) return 'no-fields';
    setter.call(input, ${JSON.stringify(REPO)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setter.call(label, 'accept-repo');
    label.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    const submit = document.getElementById('worktreeWorkspaceSubmit');
    if (!submit) return 'no-submit';
    submit.click();
    await new Promise(r => setTimeout(r, 3000));
    const modal = document.getElementById('worktreeOpenModal');
    return JSON.stringify({ modal: modal ? getComputedStyle(modal).display : 'absent', err: err ? err.textContent : '' });
  })()`, true);
  check('workspace created from folder', wsResult && wsResult.includes('"modal":"none"'), String(wsResult).slice(0, 160));
} else if (openResult === 'workspace-already-open') {
  check('workspace already open (prior run)', true);
} else {
  check('worktree open modal opens via dashboard button', false, String(openResult).slice(0, 120));
}

// 2) Switch shell to files mode via the real toggle, then wait for the tree.
await cdp.evalExpr(`(() => {
  const btn = document.getElementById('fileWorkspaceToggle');
  if (btn) { btn.click(); return 'toggled'; }
  return 'no-file-toggle';
})()`);
await new Promise((r) => setTimeout(r, 2500));
const treeReady = await cdp.evalExpr(`!!document.querySelector('.herdr-file-tree .herdr-tree-row')`);
check('file tree renders after switching to files mode', treeReady === true);

// Open src/demo.py from the tree: expand src, then click demo.py
const treeState = await cdp.evalExpr(`(async () => {
  const subtitle = document.querySelector('.file-browser-subtitle');
  const rows0 = [...document.querySelectorAll('.herdr-tree-row')].map(r => r.textContent.trim());
  const src = [...document.querySelectorAll('.herdr-tree-row')].find(r => r.textContent.trim().startsWith('src/'));
  if (!src) return JSON.stringify({ subtitle: subtitle ? subtitle.textContent : null, rows: rows0.slice(0, 8), found: false });
  // Dir rows expand via caret click (single click is disabled in the desktop tree).
  const caret = src.querySelector('.herdr-tree-caret');
  if (caret) caret.click(); else src.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  let demo = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    demo = [...document.querySelectorAll('.herdr-tree-row')].find(r => r.textContent.trim().startsWith('demo.py'));
    if (demo) break;
  }
  if (!demo) return JSON.stringify({ subtitle: subtitle ? subtitle.textContent : null, found: true, demo: false, rows: [...document.querySelectorAll('.herdr-tree-row')].map(r => r.textContent.trim()).slice(0, 10) });
  demo.click();
  await new Promise(r => setTimeout(r, 2500));
  return JSON.stringify({ subtitle: subtitle ? subtitle.textContent : null, found: true, demo: true });
})()`, true);
const treeParsed = (() => { try { return JSON.parse(treeState || '{}'); } catch { return { raw: treeState }; } })();
check('acceptance repo tree loaded', treeParsed.subtitle === REPO && treeParsed.demo === true, JSON.stringify(treeParsed).slice(0, 200));

// 1. Lock toggle present in toolbar
const lockPresent = await cdp.evalExpr(`!!document.querySelector('.file-browser-lock-toggle')`);
check('lock toggle renders in toolbar', lockPresent === true);

// 2. File opens editable by default (CodeMirror contenteditable=true)
const editableDefault = await cdp.evalExpr(`(() => {
  const cm = document.querySelector('.file-browser-pane .cm-content, .file-browser-pane [contenteditable]');
  return cm ? cm.getAttribute('contenteditable') : 'no-editor';
})()`);
check('file opens editable by default', editableDefault === 'true', `contenteditable="${editableDefault}"`);

// 3. Lock flips to read-only and back
const lockRound = await cdp.evalExpr(`(async () => {
  const btn = document.querySelector('.file-browser-lock-toggle');
  if (!btn) return 'no-button';
  btn.click();
  await new Promise(r => setTimeout(r, 800));
  const btn2 = document.querySelector('.file-browser-lock-toggle');
  const cmAfterLock = document.querySelector('.file-browser-pane .cm-content, .file-browser-pane [contenteditable]');
  const lockedEditable = cmAfterLock ? cmAfterLock.getAttribute('contenteditable') : 'none';
  const active = btn2 ? btn2.classList.contains('active') : null;
  return JSON.stringify({ lockedEditable, active });
})()`, true);
const lockParsed = (() => { try { return JSON.parse(lockRound || '{}'); } catch { return { raw: lockRound }; } })();
check('lock click makes editor read-only', lockParsed.lockedEditable === 'false', JSON.stringify(lockParsed));
check('lock button shows active state when locked', lockParsed.active === true);

const unlockRound = await cdp.evalExpr(`(async () => {
  const btn = document.querySelector('.file-browser-lock-toggle');
  btn.click();
  await new Promise(r => setTimeout(r, 800));
  const btn2 = document.querySelector('.file-browser-lock-toggle');
  const cm = document.querySelector('.file-browser-pane .cm-content, .file-browser-pane [contenteditable]');
  return JSON.stringify({ editable: cm ? cm.getAttribute('contenteditable') : 'none', active: btn2 ? btn2.classList.contains('active') : null });
})()`, true);
const unlockParsed = (() => { try { return JSON.parse(unlockRound || '{}'); } catch { return { raw: unlockRound }; } })();
check('unlock click restores editing', unlockParsed.editable === 'true', JSON.stringify(unlockParsed));
check('lock button inactive when unlocked', unlockParsed.active === false);

// 4. Type an edit -> dirty dot appears on the tab
const typed = await cdp.evalExpr(`(async () => {
  const cm = document.querySelector('.file-browser-pane .cm-content');
  if (!cm) return 'no-cm';
  cm.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(cm);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('insertText', false, '# acceptance edit\\n');
  await new Promise(r => setTimeout(r, 1200));
  const dot = !!document.querySelector('.file-browser-open-tab .file-browser-tab-dirty');
  return JSON.stringify({ ok, dot });
})()`, true);
const typedParsed = (() => { try { return JSON.parse(typed || '{}'); } catch { return { raw: typed }; } })();
check('dirty dot appears on tab after edit', typedParsed.dot === true, JSON.stringify(typedParsed).slice(0, 120));

// 5. Cmd+S saves and clears dirty; content persisted to disk
await cdp.evalExpr(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
  return 'dispatched';
})()`);
await new Promise((r) => setTimeout(r, 2500));
const afterSave = await cdp.evalExpr(`(() => {
  const dot = !!document.querySelector('.file-browser-open-tab .file-browser-tab-dirty');
  const cm = document.querySelector('.file-browser-pane .cm-content, .file-browser-pane [contenteditable]');
  return JSON.stringify({ dot, editable: cm ? cm.getAttribute('contenteditable') : 'none' });
})()`);
const saveParsed = (() => { try { return JSON.parse(afterSave || '{}'); } catch { return { raw: afterSave }; } })();
check('dirty dot cleared after Cmd+S save', saveParsed.dot === false, JSON.stringify(saveParsed));
check('file stays editable after save', saveParsed.editable === 'true');

// 6. On-disk file actually contains the edit
const onDisk = readFileSync(DEMO_FILE, 'utf8');
check('saved content persisted to disk', onDisk.includes('# acceptance edit'), JSON.stringify(onDisk.slice(0, 80)));

// 7. Lock with dirty prompts confirm; discard works
await cdp.evalExpr(`(async () => {
  window.__acceptConfirm = null;
  window.confirm = (msg) => { window.__acceptConfirm = msg; return true; };
  const cm = document.querySelector('.file-browser-pane .cm-content');
  cm.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(cm);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, '# dirty-again\\n');
  // Wait until the dirty dot actually appears (editor onChange landed).
  for (let i = 0; i < 20; i++) {
    if (document.querySelector('.file-browser-open-tab .file-browser-tab-dirty')) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const btn = document.querySelector('.file-browser-lock-toggle');
  btn.click();
  return 'locked-with-dirty';
})()`, true);
await new Promise((r) => setTimeout(r, 1200));
const lockDirty = await cdp.evalExpr(`(() => {
  const dot = !!document.querySelector('.file-browser-open-tab .file-browser-tab-dirty');
  const cm = document.querySelector('.file-browser-pane .cm-content, .file-browser-pane [contenteditable]');
  return JSON.stringify({ dot, editable: cm ? cm.getAttribute('contenteditable') : 'none', confirmMsg: window.__acceptConfirm });
})()`);
const lockDirtyParsed = (() => { try { return JSON.parse(lockDirty || '{}'); } catch { return { raw: lockDirty }; } })();
check('locking dirty file asked for confirmation', typeof lockDirtyParsed.confirmMsg === 'string' && lockDirtyParsed.confirmMsg.includes('Discard unsaved changes'), lockDirtyParsed.confirmMsg);
check('lock discards draft and clears dirty dot', lockDirtyParsed.dot === false && lockDirtyParsed.editable === 'false', JSON.stringify(lockDirtyParsed));

// 8. Cmd+S on locked file does not change disk
const diskBefore = readFileSync(DEMO_FILE, 'utf8');
await cdp.evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))`);
await new Promise((r) => setTimeout(r, 1200));
const diskAfter = readFileSync(DEMO_FILE, 'utf8');
check('Cmd+S on locked file does not write disk', diskBefore === diskAfter);

cdp.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} acceptance checks passed`);
if (failed.length) { console.log('FAILED:', failed.map(f => f.name).join(', ')); process.exit(1); }