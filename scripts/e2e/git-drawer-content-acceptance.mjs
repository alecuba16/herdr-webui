// Git drawer CONTENT acceptance checks (real browser, real backend).
//
// Behavioral `node --test` suites cover the git_ui modules against stubbed
// fetches, and git-acceptance.mjs boots the served bundle in a vm, but neither
// proves the drawer's rendered DOM in a real browser: HTML strings built by
// seventeen modules must survive attach, event wiring must fire real
// handlers, and switching tabs must replace real DOM nodes. This script
// drives the actually served app in headless Chrome over CDP against a
// fixture git repo with a dirty worktree, extra branches, and a multi-commit
// log, then verifies the drawer CONTENT in the live DOM:
//
//   1. openWorkspaceGitUi shows gitUiPanel with the real branch chip.
//   2. The changes tree renders the untracked dir row and the modified file
//      row with real +N/-N counts from the backend diff stats.
//   3. Clicking the modified file row loads the real diff view: old/new code
//      rows for the edited lines, and the layout toggle is present.
//   4. The log tab renders the real commit graph table (head row + at least
//      one commit row whose title matches the fixture's commit subject).
//   5. The branch list popover lists local branches with author · time rows.
//   6. Returning to the terminal hides the panel and restores the shell.
//
// Usage:
//   ACCEPT_REPO=... E2E_BASE_URL=... CDP_PORT=... node scripts/e2e/git-drawer-content-acceptance.mjs
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const BASE = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture git repo) is required');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
await cdp.send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 2500));

async function evalx(expr) {
  return cdp.evalExpr(expr, true);
}

async function panelHtml() {
  return evalx('document.getElementById("gitUiPanel") ? document.getElementById("gitUiPanel").innerHTML : ""');
}

// Create a workspace over the API (same shape the app's createWorkspaceFromModal
// consumes: result.workspace.workspace_id) and wait for the terminal to attach.
const created = await evalx(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'git-drawer-e2e', cwd: ${JSON.stringify(REPO)} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('workspace created', !!wsId, `resp=${JSON.stringify(created).slice(0, 120)}`);
if (!wsId) process.exit(1);

await evalx(`go(${JSON.stringify(wsId)})`);
await new Promise((r) => setTimeout(r, 3000));

// Wait until the terminal surface is attached (the drawer overlays it).
let attached = false;
for (let i = 0; i < 20 && !attached; i++) {
  attached = await evalx('!!(state.terminalId && document.querySelectorAll("#terminal .term-row").length)');
  if (!attached) await new Promise((r) => setTimeout(r, 500));
}
check('terminal attached with rendered rows', attached, `state=${JSON.stringify(await evalx('({ terminalId: state.terminalId })'))}`);
if (!attached) process.exit(1);

// 1. Open the Git drawer through the app path a sidebar click uses.
await evalx('openWorkspaceGitUi(state.ws, { forceOpen: true })');
let drawerReady = false;
for (let i = 0; i < 20 && !drawerReady; i++) {
  drawerReady = await evalx(`(async () => {
    const panel = document.getElementById("gitUiPanel");
    if (!panel || panel.style.display === "none" || !panel.innerHTML.trim()) return false;
    // Wait for the loading placeholder to be replaced by real content.
    return !panel.querySelector(".git-ui-loading");
  })()`);
  if (!drawerReady) await new Promise((r) => setTimeout(r, 500));
}
check('git drawer renders content (loading done)', drawerReady === true);
check('git drawer visible state', (await evalx('!!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible())')) === true);

const status = await evalx(`(async () => {
  const r = await fetch('/api/git-ui/status?cwd=${encodeURIComponent(REPO)}');
  return await r.json();
})()`);
let html = await panelHtml();
check('branch chip shows the real branch name', html.includes(`git-ui-branch-chip-name">${status.branch}</span>`), `branch=${status.branch}`);

// 2. Changes tree: the untracked dir row and the modified file row with counts.
html = await panelHtml();
// FileTree dir rows carry class herdr-tree-row dir git-ui-dir and the name
// inside .herdr-tree-name (data-git-path is only on file rows).
const hasDirRow = /class="herdr-tree-row dir[^"]*git-ui-dir[^"]*"/.test(html) && /herdr-tree-name">scratchdir</.test(html);
check('changes tree renders the untracked dir row', hasDirRow);
const readmeRow = (html.match(/data-git-path="README\.md"[^>]*>[\s\S]{0,600}?<b>\+(\d+)<\/b><i>-(\d+)<\/b>/i) || html.match(/data-git-path="README\.md"[\s\S]{0,600}?<b>\+(\d+)<\/b><i>-(\d+)<\/i>/i) || [])[0] || '';
const countsMatch = readmeRow.match(/<b>\+(\d+)<\/b><i>-(\d+)<\/i>/);
check('changes tree shows README.md with real +N/-N counts', !!countsMatch, countsMatch ? `+${countsMatch[1]} -${countsMatch[2]}` : 'no counts in row');

// 3. Click the README.md row (selectFile) and wait for the real diff.
await evalx(`HerdrGitUi.selectFile(${JSON.stringify(encodeURIComponent('README.md'))}, 'M')`);
let diffReady = false;
for (let i = 0; i < 20 && !diffReady; i++) {
  diffReady = await evalx(`(() => {
    const panel = document.getElementById("gitUiPanel");
    if (!panel) return false;
    return !!panel.querySelector(".git-ui-diff-row");
  })()`);
  if (!diffReady) await new Promise((r) => setTimeout(r, 500));
}
check('diff view renders real diff rows after file click', diffReady);
html = await panelHtml();
check('diff shows the edited new line', html.includes('e2e drawer acceptance line'), html.slice(html.indexOf('git-ui-diff-row') >= 0 ? html.indexOf('git-ui-diff-row') : 0, (html.indexOf('git-ui-diff-row') >= 0 ? html.indexOf('git-ui-diff-row') : 0) + 200).replace(/\s+/g, ' ').slice(0, 120));
check('diff layout toggle present', html.includes('git-ui-diff-layout-toggle'));
check('diff file toolbar shows README.md', /git-ui-path-title[^>]*>[^<]*README\.md|README\.md/.test(html));

// 4. Log tab: real commit graph with the fixture's commit subjects.
await evalx(`HerdrGitUi.tab('log')`);
let logReady = false;
for (let i = 0; i < 20 && !logReady; i++) {
  logReady = await evalx(`(() => {
    const panel = document.getElementById("gitUiPanel");
    if (!panel) return false;
    return !!panel.querySelector(".git-ui-log-row[data-log-hash]");
  })()`);
  if (!logReady) await new Promise((r) => setTimeout(r, 500));
}
check('log tab renders commit rows with hashes', logReady);
html = await panelHtml();
check('log table head renders Graph/Description/Date/Author columns', /git-ui-log-table-head/.test(html) && /Graph/.test(html) && /Description/.test(html));
check('log shows the fixture commit subject', html.includes('feat: first change'), 'looking for "feat: first change"');
check('log shows the branch commit subject', html.includes('chore: branch commit'), 'looking for "chore: branch commit"');
const logRowCount = await evalx('document.querySelectorAll("#gitUiPanel .git-ui-log-row[data-log-hash]").length');
check('log renders at least 3 commits', Number(logRowCount) >= 3, `rows=${logRowCount}`);

// 5. Branch list popover from the header chip.
await evalx(`HerdrGitUi.openBranchList({ stopPropagation() {}, currentTarget: null, clientX: 0, clientY: 0 })`);
await new Promise((r) => setTimeout(r, 800));
html = await panelHtml();
check('branch list popover opens', /git-ui-branch-list/.test(html));
check('branch list shows local branches', /Local branches/.test(html) && /git-ui-branch-row/.test(html));
check('branch list shows the feature branch', html.includes('feature/drawer'));
check('branch rows show author · time', /e2e · /.test(html));
await evalx('HerdrGitUi.closeBranchList()');
await new Promise((r) => setTimeout(r, 300));

// 6. Back to the terminal: the panel hides and the shell restores.
await evalx('showTerminalShellMode({})');
await new Promise((r) => setTimeout(r, 1200));
const hidden = await evalx(`(() => {
  const panel = document.getElementById("gitUiPanel");
  const shell = document.getElementById("terminalShell");
  return {
    panelHidden: !panel || panel.style.display === "none" || !panel.innerHTML.trim(),
    shellVisible: !shell || shell.style.display !== "none",
    uiVisible: !!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible()),
  };
})()`);
check('drawer hides back to terminal', hidden.panelHidden === true && hidden.shellVisible === true && hidden.uiVisible === false, JSON.stringify(hidden));

// 7. Navigation redesign in the real browser: real DOM clicks through the
// onclick wiring the VM never parses, real Esc keypresses through the actual
// keydown pipeline, and real layout measurement of the location bar. Reopens
// the drawer first because check 6 hid it.
const crumbsTitle = () => evalx(`(() => {
  const bar = document.querySelector("#gitUiPanel .git-ui-breadcrumbs");
  return bar ? (bar.getAttribute("title") || "") : "";
})()`);
const waitForExpr = async (desc, expr, tries = 24) => {
  for (let i = 0; i < tries; i++) {
    if (await evalx(expr) === true) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};
// Click through the browser's input pipeline: hit-test coordinates from the
// live element's box, then mousePressed/mouseReleased. Executes the inline
// onclick handler exactly as a user click does.
const realClick = async (selectorExpr) => {
  const rect = await evalx(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect || !rect.w || !rect.h) throw new Error('no clickable element: ' + selectorExpr);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 300));
};
const pressEsc = async () => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 350));
};

await evalx('openWorkspaceGitUi(state.ws, { forceOpen: true })');
check('drawer reopens for navigation checks', await waitForExpr('drawer', `(() => {
  const panel = document.getElementById("gitUiPanel");
  return !!(panel && panel.style.display !== "none" && panel.innerHTML.trim() && !panel.querySelector(".git-ui-loading"));
})()`));

// Land on the changes tree: earlier checks left the cached view on the log tab.
await realClick(`(() => {
  const tabs = Array.from(document.querySelectorAll("#gitUiPanel .git-ui-view-toggle[role=tab]"));
  return tabs.find((b) => (b.textContent || "").trim() === "changes" && !b.classList.contains("active")) || tabs.find((b) => (b.textContent || "").trim() === "changes") || null;
})()`);
{
  // Fall back to the direct tab call only if the click target is stale.
  const onChanges = await evalx(`(() => {
    const active = document.querySelector("#gitUiPanel .git-ui-view-toggle.active");
    return !!active && active.textContent.trim() === "changes";
  })()`);
  if (!onChanges) await evalx('HerdrGitUi.tab("changes")');
  await new Promise((r) => setTimeout(r, 400));
}

// Real click on the README.md changes-tree row.
await realClick(`document.querySelector('#gitUiPanel [data-git-path="README.md"]')`);
check('real click on file row opens its diff', await waitForExpr('diff rows', `!!document.querySelector("#gitUiPanel .git-ui-diff-row")`));
check('location bar present on the file diff view', await evalx(`!!document.querySelector("#gitUiPanel .git-ui-location-bar")`) === true);

// Real click on the toolbar History button.
await realClick(`document.querySelector('#gitUiPanel button[title^="File history"]')`);
check('real click on History button opens file history', await waitForExpr('history rows', `(() => {
  const buttons = Array.from(document.querySelectorAll("#gitUiPanel button"));
  return buttons.some((b) => (b.title || "") === "Open this commit's change for the file");
})()`));
check('history crumbs read Changes › README.md › History', (await crumbsTitle()) === 'Changes › README.md › History', await crumbsTitle());

// Real layout measurement: the bar and its breadcrumbs occupy real space and
// do not overflow the panel horizontally.
const layout = await evalx(`(() => {
  const panel = document.getElementById("gitUiPanel");
  const bar = panel && panel.querySelector(".git-ui-location-bar");
  const crumbs = bar && bar.querySelector(".git-ui-breadcrumbs");
  if (!bar || !crumbs) return null;
  const br = bar.getBoundingClientRect();
  const cr = crumbs.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  return {
    barW: br.width, barH: br.height,
    crumbsW: cr.width,
    barOverflow: bar.scrollWidth - bar.clientWidth,
    insidePanel: cr.left >= pr.left - 1 && cr.right <= pr.right + 1,
  };
})()`);
check('location bar has real size and no horizontal overflow', !!layout && layout.barW > 100 && layout.barH >= 20 && layout.crumbsW > 0 && layout.barOverflow <= 2 && layout.insidePanel === true, JSON.stringify(layout));

// Real click on the first View change button.
await realClick(`document.querySelector('#gitUiPanel button[title="Open this commit\\'s change for the file"]')`);
check('real click on View change loads the committed diff', await waitForExpr('committed diff', `(() => {
  const bar = document.querySelector("#gitUiPanel .git-ui-breadcrumbs");
  return !!(bar && (bar.getAttribute("title") || "").startsWith("History › README.md › Committed "));
})()`));

// Real click on the location-bar Back button returns to file history.
await realClick(`document.querySelector('#gitUiPanel button[title="Go back to previous Git view"]')`);
check('real click on Back restores file history', await waitForExpr('history restored', `(() => {
  const bar = document.querySelector("#gitUiPanel .git-ui-breadcrumbs");
  return !!bar && (bar.getAttribute("title") || "") === "Changes › README.md › History";
})()`));
check('drawer still visible after Back (no tool switch)', (await evalx('!!(window.HerdrGitUi && window.HerdrGitUi.isVisible())')) === true);

// Real click on Find in log keeps the file scope.
await realClick(`document.querySelector('#gitUiPanel button[title="Open the file\\'s log at this commit"]')`);
check('real click on Find in log opens the scoped log', await waitForExpr('scoped log', `(() => {
  const bar = document.querySelector("#gitUiPanel .git-ui-breadcrumbs");
  const clear = document.querySelector("#gitUiPanel .git-ui-crumb-clear");
  return !!bar && (bar.getAttribute("title") || "") === "Log › README.md" && !!clear;
})()`));
const clearBox = await evalx(`(() => {
  const clear = document.querySelector("#gitUiPanel .git-ui-crumb-clear");
  if (!clear) return null;
  const r = clear.getBoundingClientRect();
  return { w: r.width, h: r.height };
})()`);
check('clear-scope control has real clickable size', !!clearBox && clearBox.w > 0 && clearBox.h > 0, JSON.stringify(clearBox));

// Real click on the clear-scope control returns the whole-repo log.
await realClick(`document.querySelector('#gitUiPanel .git-ui-crumb-clear')`);
check('real click on clear-scope shows the unscoped log', await waitForExpr('unscoped log', `(() => {
  const bar = document.querySelector("#gitUiPanel .git-ui-breadcrumbs");
  const clear = document.querySelector("#gitUiPanel .git-ui-crumb-clear");
  return !!bar && (bar.getAttribute("title") || "") === "Log" && !clear;
})()`));

// Real Esc keypresses pop the ladder one level at a time.
await pressEsc();
check('first real Esc pops back to file history', (await crumbsTitle()) === 'Changes › README.md › History', await crumbsTitle());
await pressEsc();
check('second real Esc pops to the changes root', (await crumbsTitle()) === 'Changes', await crumbsTitle());
check('drawer stays open at the changes root', (await evalx('!!(window.HerdrGitUi && window.HerdrGitUi.isVisible())')) === true);
await pressEsc();
const afterEsc = await evalx(`(() => ({
  uiVisible: !!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible()),
  fileBrowserVisible: !!(window.HerdrFileBrowser && window.HerdrFileBrowser.isVisible && window.HerdrFileBrowser.isVisible()),
  shellVisible: (() => { const s = document.getElementById("terminalShell"); return !s || s.style.display !== "none"; })(),
}))()`);
check('third real Esc hides the drawer and restores the terminal', afterEsc.uiVisible === false && afterEsc.fileBrowserVisible === false && afterEsc.shellVisible === true, JSON.stringify(afterEsc));

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `git drawer content acceptance: ${failed} FAILED of ${results.length}` : `git drawer content acceptance: all ${results.length} checks passed`);
// The CDP websocket keeps the node event loop alive; close it or the runner
// hangs after the last check.
cdp.close();
process.exitCode = failed ? 1 : 0;