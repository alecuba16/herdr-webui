// Real-browser acceptance checks for the file-explorer branch-changes
// highlight. Drives the actually-served app end to end: dashboard ->
// workspace open -> files mode -> tree rows, and verifies computed colors
// of the branch-only committed file row in both themes.
//
// Requirements: see run-branch-changes-e2e.sh (builds fixture repo, starts
// the isolated server + headless Chrome; this file runs inside that setup).
import { connectToPage, openApp } from './cdp-driver.mjs';

const REPO = process.env.ACCEPT_REPO;
const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
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
const title = await openApp(cdp, URL);
check('app loads (title present)', !!title, `title="${title}"`);

// Wait for app shell
await new Promise((r) => setTimeout(r, 2000));

// (dirty-write priority check) is written through the real HTTP API, the
// same one the editor uses. It is restored at the end of this script via
// `git checkout` by the runner (fixture repo is throwaway).

// 1) Open the fixture repo as a workspace (same modal flow as acceptance.mjs).
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
  const created = await cdp.evalExpr(`(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const input = document.getElementById('worktreeDiscoverPath');
    const label = document.getElementById('worktreeWorkspaceLabel');
    const err = document.getElementById('worktreeOpenError');
    if (!input || !label) return JSON.stringify({ err: 'no-fields' });
    setter.call(input, ${JSON.stringify(REPO)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setter.call(label, 'accept-repo');
    label.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
    const submit = document.getElementById('worktreeWorkspaceSubmit');
    if (!submit) return JSON.stringify({ err: 'no-submit' });
    submit.click();
    await new Promise(r => setTimeout(r, 3000));
    const modal = document.getElementById('worktreeOpenModal');
    return JSON.stringify({ modal: modal ? getComputedStyle(modal).display : 'absent', err: err ? err.textContent : '' });
  })()`, true);
  check('workspace created from fixture repo', created && created.includes('"modal":"none"'), String(created).slice(0, 160));
} else if (openResult === 'workspace-already-open') {
  check('workspace already open (prior run)', true);
} else {
  check('worktree open modal opens via dashboard button', false, String(openResult).slice(0, 120));
}

// 2) Switch to files mode and wait for the tree.
await cdp.evalExpr(`(() => {
  const btn = document.getElementById('fileWorkspaceToggle');
  if (btn) btn.click();
  return btn ? 'toggled' : 'no-file-toggle';
})()`);
await new Promise((r) => setTimeout(r, 3000));
const treeReady = await cdp.evalExpr(`!!document.querySelector('.herdr-file-tree .herdr-tree-row')`);
check('file tree renders in files mode', treeReady === true);
if (!treeReady) {
  console.error('tree never rendered; aborting');
  process.exit(1);
}

// 3) Expand src and collect row colors (dark theme first).
async function expandSrc() {
  return cdp.evalExpr(`(async () => {
    const src = [...document.querySelectorAll('.herdr-tree-row')].find(r => r.textContent.trim().startsWith('src/'));
    if (!src) return 'no-src';
    const caret = src.querySelector('.herdr-tree-caret');
    if (caret) caret.click(); else src.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 400));
      const branch = [...document.querySelectorAll('.herdr-tree-row')].find(r => r.textContent.trim().startsWith('branch_only.py'));
      if (branch) return 'expanded';
    }
    return 'no-branch-file';
  })()`, true);
}
const expanded = await expandSrc();
check('src expands and branch_only.py row appears', expanded === 'expanded', String(expanded));

// 4) Assert computed colors: branch file blue, untouched demo.py default.
async function rowColors() {
  return cdp.evalExpr(`(() => {
    const row = (name) => [...document.querySelectorAll('.herdr-tree-row')].find(r => r.textContent.trim().startsWith(name));
    const color = (r) => (r ? getComputedStyle(r).color : null);
    const cls = (r) => (r ? r.className : null);
    const branch = row('branch_only.py');
    const demo = row('demo.py');
    const readme = row('README.md');
    return JSON.stringify({
      branch: { cls: cls(branch), color: color(branch) },
      demo: { cls: cls(demo), color: color(demo) },
      readme: { cls: cls(readme), color: color(readme) },
    });
  })()`, true);
}
// 4) Assert computed colors. The app defaults to "auto"; headless Chrome
// has no prefers-color-scheme so the effective theme is light. Detect the
// effective theme instead of assuming, then assert the matching color pair.
const effective = await cdp.evalExpr(`(document.documentElement.dataset.herdrTheme || 'light')`);
const isDark = effective === 'dark';
const BLUE = isDark ? 'rgb(137, 180, 250)' : 'rgb(33, 80, 174)';
const FG = isDark ? 'rgb(205, 214, 244)' : 'rgb(76, 79, 105)';
const dark = JSON.parse(await rowColors());
check(
  `branch_only.py carries the git-changed class (${effective} theme)`,
  dark.branch && /git-changed/.test(dark.branch.cls || ''),
  `cls="${dark.branch && dark.branch.cls}"`,
);
check(
  `branch file row is blue ${BLUE} in ${effective} theme`,
  dark.branch && dark.branch.color === BLUE,
  `color=${dark.branch && dark.branch.color}`,
);
check(
  `untouched demo.py stays default fg in ${effective} theme`,
  dark.demo && dark.demo.color === FG,
  `color=${dark.demo && dark.demo.color}`,
);
check(
  `untouched README.md stays default fg in ${effective} theme`,
  dark.readme && dark.readme.color === FG,
  `color=${dark.readme && dark.readme.color}`,
);

// 4b) Priority: make demo.py dirty in the working tree. It is also committed
// on the branch (modified vs base), so it lands in both the branch diff and
// porcelain status; porcelain must win with the yellow modified color.
// Uses the same endpoint and payload the editor save button uses.
const writeStatus = await cdp.evalExpr(`(async () => {
  const cwd = (document.querySelector('.file-browser-subtitle') || {}).textContent || '';
  // Read the current hash via the real GET endpoint so the save payload
  // matches what the editor would send (hash-protected optimistic write).
  const q = new URLSearchParams({ cwd, path: 'src/demo.py', hash_only: 'true' });
  const cur = await fetch('/api/file-browser/file?' + q).then(r => r.json());
  const r = await fetch('/api/file-browser/file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, path: 'src/demo.py', content: 'print("dirty")\\n', expected_hash: cur.hash || '' }),
  });
  return r.status + ' ' + cwd;
})()`, true);
check('dirty write via real save API accepted', /^2\d\d /.test(writeStatus || ''), String(writeStatus));
// Trigger a tree refresh (re-enter files mode) so porcelain status reloads.
await cdp.evalExpr(`(() => {
  const files = document.getElementById('fileWorkspaceToggle');
  if (files) files.click();
  return 'refreshed';
})()`);
await new Promise((r) => setTimeout(r, 1200));
await cdp.evalExpr(`(() => {
  const files = document.getElementById('fileWorkspaceToggle');
  if (files) files.click();
  return 'refreshed';
})()`);
await new Promise((r) => setTimeout(r, 2500));
// The tree collapsed on the mode toggle; re-expand src so rows are visible.
const reexpanded = await expandSrc();
check('src re-expands after refresh', reexpanded === 'expanded', String(reexpanded));
const priorityColors = JSON.parse(await rowColors());
const MODIFIED = effective === 'dark' ? 'rgb(233, 208, 122)' : 'rgb(122, 77, 0)';
check(
  `dirty-and-committed demo.py keeps modified color, not blue (${effective})`,
  priorityColors.demo && priorityColors.demo.color === MODIFIED && /git-modified/.test(priorityColors.demo.cls || ''),
  `cls="${priorityColors.demo && priorityColors.demo.cls}" color=${priorityColors.demo && priorityColors.demo.color}`,
);
check(
  `branch-only file keeps blue while tree has dirty file (${effective})`,
  priorityColors.branch && priorityColors.branch.color === BLUE,
  `color=${priorityColors.branch && priorityColors.branch.color}`,
);

// 5) Switch to the other theme via the real toggle and re-check the pair.
// Toggle cycles auto -> dark -> light -> auto; from auto one click lands on
// dark, a second on light. Walk to the opposite of the current effective theme.
await cdp.evalExpr(`(() => {
  const t = document.getElementById('themeToggle');
  if (!t) return 'no-toggle';
  t.click();
  return 'toggled';
})()`);
await new Promise((r) => setTimeout(r, 400));
// From auto the first click sets dark; if we started light (auto), we are now
// dark. One more click would go light. Ensure we end on the opposite theme.
const nowTheme = await cdp.evalExpr(`(document.documentElement.dataset.herdrTheme || 'light')`);
if (nowTheme === effective) {
  await cdp.evalExpr(`document.getElementById('themeToggle').click()`);
  await new Promise((r) => setTimeout(r, 400));
}
const otherTheme = await cdp.evalExpr(`(document.documentElement.dataset.herdrTheme || 'light')`);
const BLUE2 = otherTheme === 'dark' ? 'rgb(137, 180, 250)' : 'rgb(33, 80, 174)';
const FG2 = otherTheme === 'dark' ? 'rgb(205, 214, 244)' : 'rgb(76, 79, 105)';
check(
  `theme switched to ${otherTheme} via toggle`,
  otherTheme !== effective,
  `was=${effective} now=${otherTheme}`,
);
// Theme switch can also re-render the tree collapsed; ensure src is open.
await new Promise((r) => setTimeout(r, 1200));
{
  const pre = JSON.parse(await rowColors());
  if (!pre.branch) await expandSrc();
}
const light = JSON.parse(await rowColors());
// demo.py is dirty since check 4b; expect the modified color, not default fg.
const MODIFIED2 = otherTheme === 'dark' ? 'rgb(233, 208, 122)' : 'rgb(122, 77, 0)';
check(
  `dirty demo.py keeps modified color in ${otherTheme} theme`,
  light.demo && light.demo.color === MODIFIED2,
  `color=${light.demo && light.demo.color}`,
);
check(
  `branch file row follows ${BLUE2} in ${otherTheme} theme`,
  light.branch && light.branch.color === BLUE2,
  `color=${light.branch && light.branch.color}`,
);
check(
  `untouched README.md stays default fg in ${otherTheme} theme`,
  light.readme && light.readme.color === FG2,
  `color=${light.readme && light.readme.color}`,
);
check(
  `branch row class survives theme switch`,
  light.branch && /git-changed/.test(light.branch.cls || ''),
  `cls="${light.branch && light.branch.cls}"`,
);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  process.exit(1);
}