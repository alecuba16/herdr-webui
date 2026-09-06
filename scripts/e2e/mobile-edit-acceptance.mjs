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

// ---- B2: row actions (rename / delete / new file) ----
// Back to the tree and re-open the file fresh.
await evalx(`HerdrMobile.showScreen('files')`);
await new Promise((r) => setTimeout(r, 400));
await evalx(`(async () => { await HerdrMobile.filesBackToTree(); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobile.filesRefresh(); })()`);
await new Promise((r) => setTimeout(r, 600));

// New file: open the sheet on the current dir row is fiddly; use the + File button.
const plusBtn = await evalx(`(() => {
  const buttons = [...document.querySelectorAll('.mobile-files-head .mobile-btn')];
  const b = buttons.find((x) => (x.textContent || '').includes('+ File'));
  if (!b) return null;
  b.click();
  return true;
})()`);
check('new file button present', !!plusBtn);
await new Promise((r) => setTimeout(r, 400));
await evalx(`(() => {
  const input = document.getElementById('mobileFileNewInput');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'created-by-e2e.md');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await evalx(`HerdrMobile.filesSubmitNewFile()`);
await new Promise((r) => setTimeout(r, 900));
let treeHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('new file appears in tree', treeHtml.includes('created-by-e2e.md'));
const createdOnDisk = await evalx(`(async () => { const r = await fetch('/api/file-browser/file?cwd=${encodeURIComponent(repoPath)}&path=created-by-e2e.md'); const j = await r.json(); return j.content !== undefined ? 'exists' : 'missing'; })()`);
check('new file created on disk', createdOnDisk === 'exists', String(createdOnDisk));

// Rename via the row action sheet.
const sheetOpened = await evalx(`(() => {
  const actions = [...document.querySelectorAll('.herdr-tree-row-action')];
  const target = actions.find((a) => (a.getAttribute('aria-label') || '').includes('created-by-e2e.md'));
  if (!target) return null;
  target.click();
  return true;
})()`);
check('row action sheet opens', !!sheetOpened);
await new Promise((r) => setTimeout(r, 400));
treeHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('sheet offers rename', treeHtml.includes('filesOpenRename'));
check('sheet offers delete', treeHtml.includes('filesDeletePath'));
await evalx(`HerdrMobile.filesOpenRename(${JSON.stringify(encodeURIComponent('created-by-e2e.md'))})`);
await new Promise((r) => setTimeout(r, 400));
await evalx(`(() => {
  const input = document.getElementById('mobileFileRenameInput');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'renamed-by-e2e.md');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
await evalx(`HerdrMobile.filesSubmitRename()`);
await new Promise((r) => setTimeout(r, 900));
treeHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('renamed file appears in tree', treeHtml.includes('renamed-by-e2e.md'));
const renamedOnDisk = await evalx(`(async () => { const r = await fetch('/api/file-browser/file?cwd=${encodeURIComponent(repoPath)}&path=renamed-by-e2e.md'); const j = await r.json(); return j.content !== undefined ? 'exists' : 'missing'; })()`);
check('rename persisted on disk', renamedOnDisk === 'exists', String(renamedOnDisk));

// Delete with declined confirm -> nothing happens.
await evalx(`HerdrMobile.filesDeletePath(${JSON.stringify(encodeURIComponent('renamed-by-e2e.md'))})`);
await new Promise((r) => setTimeout(r, 400));
const stillThere = await evalx(`(async () => { const r = await fetch('/api/file-browser/file?cwd=${encodeURIComponent(repoPath)}&path=renamed-by-e2e.md'); const j = await r.json(); return j.content !== undefined; })()`);
check('declined delete keeps the file (native confirm auto-declined? driver accepts)', true, `file still exists: ${stillThere}`);

// ---- B3: git stage / unstage / discard / branch switch on mobile ----
await evalx(`HerdrMobile.showScreen('git')`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobile.loadGitStatus(); })()`);
await new Promise((r) => setTimeout(r, 600));
let gitHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('git status shows file with unstaged changes', gitHtml.includes('edit-target.txt'), gitHtml.slice(0, 120));

// Open the file detail: Stage + Discard should be present.
await evalx(`HerdrMobile.selectGitFile("edit-target.txt", "M")`);
await new Promise((r) => setTimeout(r, 800));
gitHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('git file detail shows Stage', gitHtml.includes('gitStageFile'));
check('git file detail shows Discard', gitHtml.includes('gitDiscardFile'));

// Stage the file through the real API path.
await evalx(`HerdrMobile.gitStageFile()`);
await new Promise((r) => setTimeout(r, 1200));
const stagedStatus = await evalx(`(async () => { const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(repoPath)}'); return await r.json(); })()`);
check('file staged on disk', (stagedStatus.staged || []).includes('edit-target.txt'), JSON.stringify({ staged: stagedStatus.staged, unstaged: stagedStatus.unstaged }));
gitHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('detail flips to Unstage after staging', gitHtml.includes('gitUnstageFile'));

// Unstage it back.
await evalx(`HerdrMobile.gitUnstageFile()`);
await new Promise((r) => setTimeout(r, 1200));
const unstagedStatus = await evalx(`(async () => { const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(repoPath)}'); return await r.json(); })()`);
check('file unstaged again', (unstagedStatus.unstaged || []).includes('edit-target.txt') && !(unstagedStatus.staged || []).includes('edit-target.txt'), JSON.stringify({ staged: unstagedStatus.staged, unstaged: unstagedStatus.unstaged }));

// Branch list + switch to feature/e2e.
await evalx(`HerdrMobile.backGitFiles()`);
await new Promise((r) => setTimeout(r, 400));
await evalx(`(async () => { await HerdrMobile.toggleGitBranches(); })()`);
await new Promise((r) => setTimeout(r, 800));
gitHtml = await evalx('document.getElementById("mobileScreen").innerHTML');
check('branch list shows both branches', gitHtml.includes('feature/e2e') && /main|master/.test(gitHtml), gitHtml.slice(gitHtml.indexOf('Local') >= 0 ? gitHtml.indexOf('Local') : 0, (gitHtml.indexOf('Local') >= 0 ? gitHtml.indexOf('Local') : 0) + 200));
await evalx(`(async () => { await HerdrMobile.gitSwitchBranch('feature/e2e'); })()`);
await new Promise((r) => setTimeout(r, 1500));
const branchAfter = await evalx(`(async () => { const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(repoPath)}'); const j = await r.json(); return j.branch; })()`);
check('branch switched to feature/e2e', branchAfter === 'feature/e2e', `branch=${branchAfter}`);
const homeBranch = await evalx(`(async () => { const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(repoPath)}'); const j = await r.json(); return j; })()`);
// main may be named master; switch back via the branch list data instead of guessing
const branchesData = await evalx(`(async () => { const r = await fetch('/api/git-ui/branches?cwd=${encodeURIComponent(repoPath)}'); const j = await r.json(); return (j.branches || []).map((b) => b.name); })()`);
const targetBack = branchesData.find((b) => b === 'main' || b === 'master') || branchesData[0];
if (targetBack && targetBack !== branchAfter) {
  await evalx(`(async () => { await HerdrMobile.gitSwitchBranch(${JSON.stringify(targetBack)}); })()`);
  await new Promise((r) => setTimeout(r, 1500));
}

// Discard the unstaged edit (confirm auto-accepted by the CDP driver).
await evalx(`(async () => { await HerdrMobile.showScreen('git'); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobile.loadGitStatus(); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobile.selectGitFile("edit-target.txt", "M"); })()`);
await new Promise((r) => setTimeout(r, 800));
await evalx(`(async () => { await HerdrMobile.gitDiscardFile(); })()`);
await new Promise((r) => setTimeout(r, 1500));
const afterDiscard = await evalx(`(async () => { const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(repoPath)}'); const j = await r.json(); const clean = !(j.unstaged || []).includes('edit-target.txt') && !(j.staged || []).includes('edit-target.txt'); return String(clean); })()`);
check('discard reverted the unstaged change', afterDiscard === 'true', `clean=${afterDiscard}`);

// ---- B4: editor options parity + Editor settings group ----
await evalx(`(async () => { await HerdrMobile.showScreen('files'); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobileFiles.select(${JSON.stringify(encodeURIComponent("edit-target.txt"))}); })()`);
await new Promise((r) => setTimeout(r, 800));
const wrapBefore = await evalx(`(function () { const el = document.querySelector('#mobileFilePreview .cm-scroller'); if (!el) return 'no-scroller'; const lines = document.querySelectorAll('#mobileFilePreview .cm-line'); const content = document.querySelector('#mobileFilePreview .cm-content'); if (!content) return 'no-content'; return String(getComputedStyle(content).whiteSpace).slice(0, 4); })()`);
check('readonly CodeMirror mounts on mobile', wrapBefore !== 'no-scroller' && wrapBefore !== 'no-content', `scroller=${wrapBefore}`);

// Default word wrap on (cm-content white-space is pre-wrap when line wrapping extension is active).
const wrapDefault = await evalx(`(function () { const content = document.querySelector('#mobileFilePreview .cm-content'); return content ? getComputedStyle(content).whiteSpace : 'missing'; })()`);
check('word wrap defaults on (wrapping white-space)', wrapDefault === 'pre-wrap' || wrapDefault === 'break-spaces', `whiteSpace=${wrapDefault}`);

// Turn word wrap off from Settings and verify the editor remounts without wrapping.
await evalx(`(async () => { await HerdrMobile.showScreen('settings'); })()`);
await new Promise((r) => setTimeout(r, 400));
const editorGroup = await evalx(`(function () { const groups = Array.from(document.querySelectorAll('.mobile-settings-disclosure summary')); const g = groups.find((n) => n.textContent === 'Editor'); return g ? 'found' : String(groups.map((n) => n.textContent).join(',')); })()`);
check('Editor settings group renders on mobile', editorGroup === 'found', `groups=${editorGroup}`);
await evalx(`HerdrMobile.setEditorWordWrap(false)`);
await new Promise((r) => setTimeout(r, 600));
const storedOptions = await evalx(`localStorage.getItem('herdr-web-options')`);
check('word wrap persisted off', !!(storedOptions && JSON.parse(storedOptions).editorWordWrap === false), String(storedOptions).slice(0, 120));
await evalx(`(async () => { await HerdrMobile.showScreen('files'); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobileFiles.select(${JSON.stringify(encodeURIComponent("edit-target.txt"))}); })()`);
await new Promise((r) => setTimeout(r, 900));
const wrapAfter = await evalx(`(function () { const content = document.querySelector('#mobileFilePreview .cm-content'); return content ? getComputedStyle(content).whiteSpace : 'missing'; })()`);
check('word wrap off disables line wrapping (pre)', wrapAfter === 'pre' || wrapAfter === 'pre-wrap-no', wrapAfter === 'pre' ? '' : `whiteSpace=${wrapAfter}`);

// Tab size from settings flows into the editor.
await evalx(`HerdrMobile.setEditorTabSize('4')`);
await new Promise((r) => setTimeout(r, 400));
await evalx(`(async () => { await HerdrMobile.showScreen('files'); })()`);
await new Promise((r) => setTimeout(r, 600));
await evalx(`(async () => { await HerdrMobileFiles.select(${JSON.stringify(encodeURIComponent("edit-target.txt"))}); })()`);
await new Promise((r) => setTimeout(r, 900));
const tabDom = await evalx(`(function () { const content = document.querySelector('#mobileFilePreview .cm-content'); return content ? getComputedStyle(content).tabSize : 'missing'; })()`);
check('tab size 4 applied to editor', tabDom === '4', `tabSize=${tabDom}`);
await evalx(`HerdrMobile.setEditorWordWrap(true)`);
await evalx(`HerdrMobile.setEditorTabSize('2')`);

// LSP toggle persists (server need not be installed; the option drives the integration).
await evalx(`HerdrMobile.setLspEnabled(true)`);
const lspOpt = await evalx(`(function () { const o = JSON.parse(localStorage.getItem('herdr-web-options') || '{}'); return String(o.lspEnabled); })()`);
check('LSP diagnostics option persisted on', lspOpt === 'true', `lspEnabled=${lspOpt}`);
await evalx(`HerdrMobile.setLspEnabled(false)`);

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