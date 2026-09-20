// Real-browser acceptance checks for the recent-workspace direct panel open
// and per-workspace shell mode persistence (branch fix_recent).
//
// Drives the actually-served app end to end:
//   1. Open a real workspace via the real UI (sidebar create modal) so a
//      recent entry exists with real tab/pane ids.
//   2. Switch its shell mode to Git, close the workspace, confirm the shell
//      mode is persisted in localStorage under the path: fallback.
//   3. Reopen the SAME folder from the Recent workspaces section of the real
//      search palette (real click), and verify:
//        - the URL lands directly on /workspace/<id>/tab/<tab>/pane/<pane>
//        - the terminal pane is live (connected terminal id)
//        - the Git shell mode was restored for the reopened workspace
//
// Requirements (see scripts/e2e/README.md):
//   - a built herdr-webui binary
//   - a scratch repo fixture (git repo)
//   - headless Chrome on CDP_PORT
//   - the isolated server already running with E2E_BASE_URL pointing at it
import { connectToPage } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8791/';
if (!REPO) {
  console.error('ACCEPT_REPO (absolute path to the fixture git repo) is required');
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
await sleep(2500);

// ---------------------------------------------------------------- section 0
// App loads.
{
  const title = await evalApp('document.title');
  check('app loads (title present)', !!title, `title="${title}"`);
  await sleep(1500);
}

// ---------------------------------------------------------------- section 1
// Close any stale workspaces from prior runs via their real sidebar buttons.
{
  const closedPrior = await evalApp(`(async () => {
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const b = document.querySelector('[data-workspace-action="close"]');
      if (!b) break;
      b.click();
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
  })()`);
  if (closedPrior > 0) console.log(`closed ${closedPrior} stale workspace(s)`);
}

// ---------------------------------------------------------------- section 2
// Open a real workspace through the real UI flow a user takes: search
// palette -> "Open workspace" action -> smart modal -> fill folder and
// workspace name -> Create workspace. This is the flow that also records the
// server-side recents entry the Recent workspaces section reads.
{
  const opened = await evalApp(`(async () => {
    // Open the search palette (real header button).
    document.getElementById('headerActionsButton').click();
    await new Promise(r => setTimeout(r, 800));
    // Click the "Open workspace" action row (real palette action).
    const rows = Array.from(document.querySelectorAll('#searchPaletteResults .search-result'));
    const action = rows.find(r => (r.textContent || '').includes('Open workspace'));
    if (!action) return { error: 'no Open workspace action', rowTexts: rows.slice(0, 8).map(r => (r.textContent || '').trim().slice(0, 50)) };
    action.click();
    // The smart modal opens; wait for its path input.
    let modal = null;
    for (let i = 0; i < 20; i++) {
      modal = document.getElementById('worktreeOpenModal');
      if (modal && getComputedStyle(modal).display !== 'none') break;
      await new Promise(r => setTimeout(r, 150));
    }
    if (!modal) return { error: 'smart modal never opened' };
    // Fill the folder input.
    const pathInput = document.getElementById('worktreeDiscoverPath');
    if (!pathInput) return { error: 'no folder input' };
    pathInput.value = ${JSON.stringify(REPO)};
    pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    pathInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    // Fill the workspace name (the Create workspace section).
    const labelInput = document.getElementById('worktreeWorkspaceLabel');
    if (!labelInput) return { error: 'no workspace label input' };
    labelInput.value = ${JSON.stringify(REPO.split('/').pop())};
    labelInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    // Submit via the real Create workspace button.
    const submit = document.getElementById('worktreeWorkspaceSubmit');
    if (!submit) return { error: 'no submit button' };
    submit.click();
    await new Promise(r => setTimeout(r, 3000));
    return { ok: !!state.ws, ws: state.ws, path: location.pathname };
  })()`);
  check(
    'workspace opened via real smart modal',
    opened && !opened.error && opened.ok && opened.ws,
    JSON.stringify(opened),
  );
}

// ---------------------------------------------------------------- section 3
// Switch the shell mode to Git through the real mode button, verify
// persistence to localStorage, then verify the path: entry exists.
{
  const gitMode = await evalApp(`(async () => {
    const btn = document.getElementById('gitWorkspaceToggle');
    if (!btn) return { error: 'no gitWorkspaceToggle button' };
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    return {
      mode: currentWorkspaceShellMode(state.ws),
      storage: JSON.parse(localStorage.getItem('herdr-web-workspace-shell') || '{}'),
      ws: state.ws,
    };
  })()`);
  check(
    'git shell mode switch persists to localStorage',
    gitMode && !gitMode.error && gitMode.mode === 'git',
    JSON.stringify(gitMode && gitMode.error ? gitMode : { mode: gitMode && gitMode.mode, ws: gitMode && gitMode.ws }),
  );
  const storage = gitMode && gitMode.storage;
  const pathKey = 'path:' + REPO;
  check(
    'mode change writes a path: entry for the folder',
    storage && storage[pathKey] && storage[pathKey].mode === 'git',
    `pathKey=${pathKey} storage=${JSON.stringify(storage)}`,
  );
}

// ---------------------------------------------------------------- section 4
// Close the workspace (real sidebar close button + confirm), verify the id
// entry is pruned from storage while the path: entry survives.
let closedWs = null;
{
  closedWs = await evalApp(`(async () => {
    const ws = state.ws;
    const b = document.querySelector('[data-workspace-action="close"]');
    if (!b) return { error: 'no close button' };
    b.click();
    for (let j = 0; j < 20; j++) {
      const q = document.getElementById('questionModal');
      if (q && getComputedStyle(q).display === 'grid') break;
      await new Promise(r => setTimeout(r, 150));
    }
    const confirmBtn = document.getElementById('questionConfirm');
    if (confirmBtn) confirmBtn.click();
    await new Promise(r => setTimeout(r, 2500));
    return {
      ws,
      storage: JSON.parse(localStorage.getItem('herdr-web-workspace-shell') || '{}'),
    };
  })()`);
  const pathKey = 'path:' + REPO;
  const storage = closedWs && closedWs.storage;
  check(
    'closing drops the id entry but keeps the path: entry',
    storage && closedWs.ws && !(closedWs.ws in storage) && storage[pathKey] && storage[pathKey].mode === 'git',
    `ws=${closedWs && closedWs.ws} storage=${JSON.stringify(storage)}`,
  );
}

// ---------------------------------------------------------------- section 5
// Reopen from the real search palette Recent section: click the recent row,
// observe direct landing on the exact tab/pane and restored git mode.
{
  // Open the palette with the real header search button.
  const paletteOpened = await evalApp(`(async () => {
    const btn = document.getElementById('headerActionsButton');
    if (!btn) return { error: 'no headerActionsButton' };
    btn.click();
    // The recents list loads async after open and re-renders the palette;
    // wait until the Recent workspaces section appears (max ~5s).
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      const sections = Array.from(document.querySelectorAll('#searchPaletteResults .search-section'));
      if (sections.some((s) => (s.textContent || '').includes('Recent workspaces'))) break;
    }
    const pal = document.getElementById('searchPalette');
    const style = pal ? getComputedStyle(pal) : null;
    const sections = Array.from(document.querySelectorAll('#searchPaletteResults .search-section'));
    return { ok: !!pal && style.display !== 'none', sectionCount: sections.length, hasRecent: sections.some((s) => (s.textContent || '').includes('Recent workspaces')) };
  })()`);
  check('search palette opens via real button', paletteOpened && paletteOpened.ok, JSON.stringify(paletteOpened));
  check('recent workspaces section renders', paletteOpened && paletteOpened.hasRecent, JSON.stringify(paletteOpened));

  // Click the recent row for our repo (real .search-result row in the
  // Recent workspaces section).
  const clicked = await evalApp(`(async () => {
    const sections = Array.from(document.querySelectorAll('#searchPaletteResults .search-section'));
    const recentSection = sections.find((s) => (s.textContent || '').includes('Recent workspaces'));
    if (!recentSection) return { error: 'no Recent workspaces section', sectionCount: sections.length };
    const rows = Array.from(recentSection.querySelectorAll('.search-result'));
    const target = rows.find(r => (r.textContent || '').includes(${JSON.stringify(REPO.split('/').pop())}));
    if (!target) return { error: 'recent row not found', rowCount: rows.length, texts: rows.slice(0, 10).map(r => (r.textContent || '').trim().slice(0, 60)) };
    const disabled = target.classList.contains('search-result-disabled') || target.getAttribute('aria-disabled') === 'true';
    if (disabled) return { error: 'recent row disabled' };
    target.click();
    await new Promise(r => setTimeout(r, 3000));
    const shellEl = document.getElementById('terminalShell');
    return {
      path: location.pathname,
      ws: state.ws,
      tab: state.tab,
      pane: state.pane,
      mode: currentWorkspaceShellMode(state.ws),
      minimized: isWorkspaceShellMinimized(state.ws),
      terminalId: state.terminalId,
      shellDisplay: shellEl ? getComputedStyle(shellEl).display : null,
      gitVisible: !!(window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible()),
      gitEntries: !!(window.HerdrGitUi && window.HerdrGitUi.state && window.HerdrGitUi.state.entries && window.HerdrGitUi.state.entries.length),
    };
  })()`);
  check(
    'recent reopen lands directly on workspace+tab+pane',
    clicked && !clicked.error && clicked.ws && clicked.tab && clicked.pane &&
      clicked.path && clicked.path.includes('/workspace/') && clicked.path.includes('/tab/') && clicked.path.includes('/pane/'),
    JSON.stringify(clicked),
  );
  check(
    'reopened workspace restores git shell mode un-minimized',
    clicked && !clicked.error && clicked.mode === 'git' && clicked.minimized === false,
    `mode=${clicked && clicked.mode} minimized=${clicked && clicked.minimized} gitVisible=${clicked && clicked.gitVisible}`,
  );
  check(
    'terminal pane is live after reopen',
    clicked && !clicked.error && !!clicked.terminalId,
    `terminalId=${clicked && clicked.terminalId}`,
  );
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`== recent-workspace acceptance: ${results.length - failed.length}/${results.length} passed ==`);
if (failed.length) {
  console.log('FAILED checks:');
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);