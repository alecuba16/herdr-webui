// Real-browser acceptance checks for mobile file editing (IDE review B1).
// Boots the app, opens the mobile UI, and drives the full edit/save flow:
// open file -> Edit -> modify -> Save -> verify persisted on disk; plus the
// discard guard and the conflict (hash mismatch) path.
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8898/';
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

// Force the mobile UI the same way the existing acceptance script does.
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

let title = await cdp.evalExpr('document.title');
check('app loads (title present)', !!title, `title="${title}"`);
await new Promise((r) => setTimeout(r, 1000));

const evalx = (expr) => cdp.evalExpr(expr, true);

// Wait for the mobile shell to be present.
let mobileReady = false;
for (let i = 0; i < 20; i++) {
  mobileReady = await evalx('!!(window.HerdrMobile && document.getElementById("mobileScreen"))');
  if (mobileReady) break;
  await new Promise((r) => setTimeout(r, 300));
}
check('mobile shell present', mobileReady);
if (!mobileReady) process.exit(1);

// The e2e wrapper exports E2E_REPO with a scratch file inside.
const repoPath = process.env.E2E_REPO;
if (!repoPath) {
  console.log('FAIL  E2E_REPO not set; run via scripts/e2e/run-mobile-edit-e2e.sh');
  process.exit(1);
}

// Create a workspace pointing at the scratch repo, exactly like the desktop
// workspace-create modal does, then reload so the mobile shell picks it up.
const ws = await evalx(`(async () => { try { const r = await fetch('/api/workspaces', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({label: 'mobile-edit-e2e', cwd: ${JSON.stringify(repoPath)}})}); return await r.json(); } catch (e) { return {error:String(e)}; } })()`);
check('workspace created', !!(ws && ws.result && ws.result.workspace), JSON.stringify(ws).slice(0, 200));
await evalx('window.location.reload()');
await new Promise((r) => setTimeout(r, 2500));

// Go to the Files screen (production path: More -> Files card -> showScreen).
await evalx(`HerdrMobile.showScreen('more')`);
await new Promise((r) => setTimeout(r, 400));
const clicked = await evalx(`(() => {
  const cards = [...document.querySelectorAll('.mobile-more-card')];
  const filesCard = cards.find((c) => (c.textContent || '').includes('Files'));
  if (!filesCard) return false;
  filesCard.click();
  return true;
})()`);
check('Files card found in More screen', !!clicked);
await new Promise((r) => setTimeout(r, 800));
const filesHeader = await evalx('document.getElementById("mobileScreen").innerHTML.includes("Files")');
check('files screen opens', !!filesHeader);

// Open the scratch file via the module API (deterministic).
await evalx(`HerdrMobile.filesSelect(${JSON.stringify(encodeURIComponent('edit-target.txt'))})`);
await new Promise((r) => setTimeout(r, 800));
const preview = await evalx('document.getElementById("mobileScreen").innerHTML');
check('preview shows file', preview.includes('edit-target.txt'), preview.slice(0, 80));
check('Edit button present', preview.includes('filesStartEdit'));

// Enter edit mode.
await evalx('HerdrMobile.filesStartEdit()');
await new Promise((r) => setTimeout(r, 800));
let html = await evalx('document.getElementById("mobileScreen").innerHTML');
check('edit mode shows Save', html.includes('filesSaveFile'));
check('edit mode shows Cancel', html.includes('filesCancelEdit'));

// Type into the CodeMirror instance.
// CodeMirror keeps its own selection state; a real click at the last line is
// the reliable way to place the caret at the end before typing.
const caret = await evalx(`(() => {
  const cm = document.querySelector('#mobileFilePreview .cm-content');
  if (!cm) return 'no cm-content';
  cm.focus();
  const lines = cm.querySelectorAll('.cm-line');
  const last = lines[lines.length - 1];
  if (!last) return 'no lines';
  const rect = last.getBoundingClientRect();
  return JSON.stringify({ x: rect.left + Math.min(rect.width - 2, 8), y: rect.top + rect.height / 2 });
})()`);
check('editor focused', caret !== 'no cm-content' && caret !== 'no lines', String(caret));
if (caret && caret !== 'no cm-content' && caret !== 'no lines') {
  const { x, y } = JSON.parse(caret);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 300));
}

const before = await evalx(`(async () => { const r = await fetch('/api/file-browser/file?cwd=${encodeURIComponent(repoPath)}&path=edit-target.txt'); const j = await r.json(); return j.content; })()`);
await cdp.send('Input.insertText', { text: ' edited from mobile e2e' });
await new Promise((r) => setTimeout(r, 400));
const dirtyShown = await evalx(`(() => {
  const btn = document.getElementById('mobileFileSaveButton');
  if (!btn) return 'no button';
  return btn.textContent || '';
})()`);
check('dirty marker shown', String(dirtyShown).includes('●'), `save button text="${dirtyShown}"`);

// Save.
await evalx('HerdrMobile.filesSaveFile()');
await new Promise((r) => setTimeout(r, 1200));
const after = await evalx(`(async () => { const r = await fetch('/api/file-browser/file?cwd=${encodeURIComponent(repoPath)}&path=edit-target.txt'); const j = await r.json(); return j.content; })()`);
check('save persisted to disk', after === before + ' edited from mobile e2e', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
html = await evalx('document.getElementById("mobileScreen").innerHTML');
check('back to read-only after save', html.includes('filesStartEdit') && !html.includes('filesCancelEdit'));

// Conflict path: change the file on disk, then edit and save -> must show the conflict error.
// Overwrite the file on disk WITHOUT a hash expectation (field omitted -> None)
// so the external change actually lands and the UI's stale hash becomes wrong.
const bumped = await evalx(`(async () => { const r = await fetch('/api/file-browser/file', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cwd: ${JSON.stringify(repoPath)}, path: 'edit-target.txt', content: 'externally changed'})}); return await r.json(); })()`);
check('external change landed', !!(bumped && (bumped.hash || bumped.error === undefined)) && !bumped.error, JSON.stringify(bumped).slice(0, 160));
await evalx('HerdrMobile.filesStartEdit()');
await new Promise((r) => setTimeout(r, 600));
await (async () => {
  const pos = await evalx(`(() => {
    const cm = document.querySelector('#mobileFilePreview .cm-content');
    if (!cm) return null;
    cm.focus();
    const lines = cm.querySelectorAll('.cm-line');
    const last = lines[lines.length - 1];
    if (!last) return null;
    const rect = last.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + Math.min(rect.width - 2, 8), y: rect.top + rect.height / 2 });
  })()`);
  if (pos) {
    const { x, y } = JSON.parse(pos);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
})();
await cdp.send('Input.insertText', { text: ' X' });
await new Promise((r) => setTimeout(r, 300));
await evalx('HerdrMobile.filesSaveFile()');
await new Promise((r) => setTimeout(r, 1200));
html = await evalx('document.getElementById("mobileScreen").innerHTML');
const conflictShown = /hash mismatch|conflict|changed|reload/i.test(html);
const draftKept = html.includes('filesSaveFile') && html.includes('filesCancelEdit');
check('conflict surfaced, draft kept', conflictShown && draftKept, html.includes('mobile-error') ? html.slice(Math.max(0, html.indexOf('mobile-error') - 20), html.indexOf('mobile-error') + 160) : 'no error div');

// Discard guard: confirm dialog must block navigation.
await evalx('window.__confirmAnswers = [false]; window.confirm = () => window.__confirmAnswers.shift() !== false ? true : false');
await evalx('HerdrMobile.filesBackToTree()');
await new Promise((r) => setTimeout(r, 300));
html = await evalx('document.getElementById("mobileScreen").innerHTML');
check('declined discard keeps edit mode', html.includes('filesSaveFile'));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
  process.exitCode = 1;
}
// Close the CDP websocket explicitly: the driver keeps it open and the Node
// event loop would otherwise never drain (Chrome ignores SIGTERM teardown).
try { await cdp.close(); } catch (_) {}
process.exit(process.exitCode || 0);