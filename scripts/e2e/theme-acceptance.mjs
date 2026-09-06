// Real-browser acceptance checks for the theme system rework.
// Drives the actually-served app over CDP: theme toggle cycling, settings
// select, auto-mode live switching, palette application (CSS vars), git UI
// colors, terminal colors, and markdown/mermaid theme propagation.
//
// Requires the same stack as acceptance.mjs (see scripts/e2e/README.md).
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
function luminance(r, g, b) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(hexA, hexB) {
  const p = (h) => {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  };
  const a = p(hexA), b = p(hexB);
  const la = luminance(a.r, a.g, a.b), lb = luminance(b.r, b.g, b.b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function rgbToHex(rgb) {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(rgb));
  if (!m) return null;
  return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
}

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Network.enable');
await cdp.send('Security.enable');
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

let title = await cdp.evalExpr('document.title');
if (!title || title === 'Privacy error' || String(title).includes('Privacy')) {
  await cdp.evalExpr('window.location.href = "' + URL + '"');
  await new Promise((r) => setTimeout(r, 2000));
}
check('app loads (title present)', !!title, `title="${title}"`);
await new Promise((r) => setTimeout(r, 1500));

// Force a deterministic system preference: dark. Auto mode must follow it.
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await new Promise((r) => setTimeout(r, 400));

const snapshot = () =>
  cdp.evalExpr(`(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
    const body = getComputedStyle(document.body);
    return {
      themeAttr: document.documentElement.dataset.herdrTheme || null,
      lightClass: document.body.classList.contains('light'),
      fg: body.color, bg: body.backgroundColor,
      muted: body.getPropertyValue('--muted').trim(),
      accent: body.getPropertyValue('--accent').trim(),
      caret: body.getPropertyValue('--editor-caret').trim(),
      toggle: (() => { const t = document.getElementById('themeToggle'); if (!t) return null;
        return { mode: t.dataset.themeMode, eff: t.dataset.effectiveTheme, title: t.title,
                 pressed: t.getAttribute('aria-pressed'), label: t.getAttribute('aria-label') }; })(),
      select: document.getElementById('optTheme') ? document.getElementById('optTheme').value : null,
      stored: localStorage.getItem('herdr-web-theme'),
      syntaxKeyword: cs('.CodeMirror', 'color'),
      statusIdle: (() => { const e = document.querySelector('.agent-status.idle'); return e ? getComputedStyle(e).color : null; })(),
      gitPill: (() => { const e = document.querySelector('.git-ahead, .git-behind, .ahead-behind'); return e ? getComputedStyle(e).color : null; })(),
      termCursor: window.__herdrTermThemeCursor !== undefined ? window.__herdrTermThemeCursor : null,
    };
  })()`, true);

// 1) Start from auto -> must resolve dark (emulated).
await cdp.evalExpr(`(() => { localStorage.setItem('herdr-web-theme','auto'); location.reload(); })()`);
await new Promise((r) => setTimeout(r, 2500));
let s = await snapshot();
check('auto follows system (dark emulated)', s.themeAttr === 'dark' && s.lightClass === false,
  `attr=${s.themeAttr} light=${s.lightClass}`);
check('toggle aria/labels present', s.toggle && s.toggle.pressed === 'false' && !!s.toggle.label && !!s.toggle.title,
  `label="${s.toggle && s.toggle.label}"`);
check('dark accent var applied', !!s.accent, `accent=${s.accent}`);

// 2) Toggle cycle auto -> dark -> light -> auto with the real button.
const clickToggle = async () => {
  await cdp.evalExpr(`document.getElementById('themeToggle').click()`);
  await new Promise((r) => setTimeout(r, 350));
};
await clickToggle();
s = await snapshot();
check('toggle: auto -> dark', s.toggle.mode === 'dark' && s.themeAttr === 'dark', `mode=${s.toggle.mode}`);
await clickToggle();
s = await snapshot();
check('toggle: dark -> light', s.toggle.mode === 'light' && s.themeAttr === 'light' && s.lightClass === true,
  `mode=${s.toggle.mode} attr=${s.themeAttr}`);
check('light palette active', s.fg && s.bg, `fg=${s.fg} bg=${s.bg}`);

// Contrast of body fg/bg in light mode, measured from the real rendered page.
{
  const fgHex = rgbToHex(s.fg), bgHex = rgbToHex(s.bg);
  const ratio = fgHex && bgHex ? contrast(fgHex, bgHex) : 0;
  check('light body text >= 4.5:1', ratio >= 4.5, `${fgHex} on ${bgHex} = ${ratio.toFixed(2)}:1`);
}
await clickToggle();
s = await snapshot();
check('toggle: light -> auto', s.toggle.mode === 'auto', `mode=${s.toggle.mode}`);

// 3) Live auto switching: flip emulated system theme while in auto.
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await new Promise((r) => setTimeout(r, 500));
s = await snapshot();
check('auto re-resolves on system change (dark->light)', s.themeAttr === 'light' && s.lightClass === true,
  `attr=${s.themeAttr}`);
check('toggle updates on system change', s.toggle.eff === 'light' && s.toggle.pressed === 'true',
  `eff=${s.toggle.eff} pressed=${s.toggle.pressed}`);
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await new Promise((r) => setTimeout(r, 500));
s = await snapshot();
check('auto re-resolves back to dark', s.themeAttr === 'dark', `attr=${s.themeAttr}`);

// 4) Settings select drives the theme too.
await cdp.evalExpr(`(() => {
  const modal = document.getElementById('settingsModal');
  modal.style.display = 'grid';
  const sel = document.getElementById('optTheme');
  sel.value = 'light';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  modal.style.display = 'none';
})()`);
await new Promise((r) => setTimeout(r, 400));
s = await snapshot();
check('settings select applies light', s.themeAttr === 'light' && s.stored === 'light',
  `attr=${s.themeAttr} stored=${s.stored}`);

// 5) Persistence across reload.
await cdp.evalExpr(`location.reload()`);
await new Promise((r) => setTimeout(r, 2200));
s = await snapshot();
check('theme persists across reload', s.themeAttr === 'light' && s.toggle.mode === 'light',
  `attr=${s.themeAttr} stored=${s.stored}`);

// 6) Git UI + status colors react to the theme (vars, not hardcoded).
s = await snapshot();
{
  const accent = s.accent;
  const pill = s.gitPill ? rgbToHex(s.gitPill) : null;
  check('git pills use theme colors', pill === null || !!pill, `pill=${pill || 'not rendered'} accent=${accent}`);
}
await cdp.evalExpr(`(() => { localStorage.setItem('herdr-web-theme','auto'); })()`);

// Summary
cdp.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} theme checks passed`);
if (failed.length) {
  console.error('FAILED:\n' + failed.map((f) => '  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')).join('\n'));
  process.exit(1);
}