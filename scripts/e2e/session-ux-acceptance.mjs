// Session-management UX acceptance checks: drives the actually-served app in
// headless Chrome over CDP and verifies the audited behaviors end to end:
//   - fresh browser lands on built-in backend (mandatory default)
//   - footer session button shows "session · built-in" with the accent color
//   - session picker rows carry backend color classes
//   - session manager opens/closes via the new ✕ button and backdrop click
//   - external Herdr offer state matches the installed herdr (0.9.0 here)
//   - switching to an external herdr session flips label + colors
//   - closing a stale session (socket gone) returns ok + already_stopped and
//     the UI keeps the clean close message (no offline auto-open overwrite)
//   - mobile layout renders the backend badge with matching colors
//   - light (latte) theme renders the backend colors with its own palette
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8899/';
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

// ---------- Desktop layout ----------
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

let title = await cdp.evalExpr('document.title');
if (!title || title === 'Privacy error' || String(title).includes('Privacy')) {
  await cdp.evalExpr('window.location.href = "' + URL + '"');
  await new Promise((r) => setTimeout(r, 2000));
}
check('app loads (title present)', !!(await cdp.evalExpr('document.title')));

// Fresh browser: no stored backend, must land on built-in with "session · built-in".
const fresh = await cdp.evalExpr(`(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const versions = await fetch('/api/versions').then((r) => r.json());
  const button = document.getElementById('footerSessionButton');
  const styles = button ? getComputedStyle(button) : null;
  return {
    stored: localStorage.getItem('herdr-session-backend'),
    backendMode: versions.backend_mode,
    currentBackend: versions.current_backend,
    herdrInstall: versions.herdr_install || null,
    footerText: button ? button.textContent : '',
    footerClass: button ? button.className : '',
    footerColor: styles ? styles.color : '',
  };
})()`, true);
check(
  'fresh browser lands on built-in and footer shows "default · built-in"',
  fresh.stored === 'builtin'
    && fresh.backendMode === 'builtin'
    && /built-in/.test(fresh.footerText || ''),
  `stored=${fresh.stored} mode=${fresh.backendMode} footer="${fresh.footerText}"`,
);
check(
  'footer button carries backend-builtin class and non-default color',
  /backend-builtin/.test(fresh.footerClass || '')
    && !!fresh.footerColor && fresh.footerColor !== 'rgb(0, 0, 0)',
  `class="${fresh.footerClass}" color=${fresh.footerColor}`,
);

// Session picker: open via the footer button's own onclick (real UI path).
const manager = await cdp.evalExpr(`(async () => {
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 800));
  const m = document.getElementById('sessionManager');
  const rows = [...document.querySelectorAll('#sessionList .session-line')];
  const herdrBtn = document.getElementById('newHerdrSessionTarget');
  const closeBtn = document.getElementById('sessionManagerClose');
  const builtinBtn = document.getElementById('newBuiltinSessionTarget');
  return {
    visible: m && getComputedStyle(m).display !== 'none',
    title: document.getElementById('sessionManagerTitle').textContent,
    currentLabel: document.getElementById('sessionCurrentLabel').textContent,
    rowClasses: rows.map((r) => r.className),
    pillClasses: [...document.querySelectorAll('#sessionList .status-pill')].map((p) => p.className),
    herdrHidden: herdrBtn ? herdrBtn.hidden : null,
    herdrDisabled: herdrBtn ? herdrBtn.disabled : null,
    builtinHidden: builtinBtn ? builtinBtn.hidden : null,
    closePresent: !!closeBtn,
  };
})()`, true);
check(
  'session manager opens with backend-aware current label and close button',
  manager.visible === true
    && /built-in/.test(manager.currentLabel || '')
    && manager.closePresent === true,
  `visible=${manager.visible} current="${manager.currentLabel}" close=${manager.closePresent}`,
);
const herdrCompatible = manager.herdrInstallCompatible
  || (fresh.herdrInstall && fresh.herdrInstall.compatible);
check(
  'external Herdr offer matches installed herdr compatibility (0.9.0 => visible)',
  manager.herdrHidden === !herdrCompatible,
  `herdrHidden=${manager.herdrHidden} installCompatible=${herdrCompatible} install=${fresh.herdrInstall && fresh.herdrInstall.version}`,
);
check(
  'session rows carry backend color classes',
  manager.rowClasses.some((c) => /backend-builtin/.test(c)) === true,
  `rows=[${manager.rowClasses.join(' | ')}]`,
);
check(
  'backend pills carry backend color classes',
  manager.pillClasses.some((c) => /backend-(builtin|herdr)/.test(c)) === true,
  `pills=[${manager.pillClasses.join(' | ')}]`,
);

// Close via the new ✕ button.
const closedByX = await cdp.evalExpr(`(async () => {
  document.getElementById('sessionManagerClose').click();
  await new Promise((r) => setTimeout(r, 200));
  const m = document.getElementById('sessionManager');
  return m && getComputedStyle(m).display === 'none';
})()`, true);
check('✕ button closes the session manager', closedByX === true);

// Backdrop click closes (click on the manager itself, outside the card).
const closedByBackdrop = await cdp.evalExpr(`(async () => {
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 600));
  const m = document.getElementById('sessionManager');
  const card = m.querySelector('.session-card');
  const mRect = m.getBoundingClientRect();
  const ev = new MouseEvent('click', { bubbles: true, clientX: mRect.left + 4, clientY: mRect.bottom - 4 });
  Object.defineProperty(ev, 'target', { value: m });
  m.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 200));
  return getComputedStyle(m).display === 'none';
})()`, true);
check('backdrop click closes the session manager', closedByBackdrop === true);

// Switch to an external herdr session through the real picker row (if offered).
if (manager.herdrHidden === false) {
  const switched = await cdp.evalExpr(`(async () => {
    document.getElementById('footerSessionButton').click();
    await new Promise((r) => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('#sessionList .session-line')];
    const row = rows.find((r) => /backend-herdr/.test(r.className));
    if (!row) return { found: false };
    row.click();
    await new Promise((r) => setTimeout(r, 2000));
    const button = document.getElementById('footerSessionButton');
    return {
      found: true,
      stored: localStorage.getItem('herdr-session-backend'),
      footerText: button.textContent,
      footerClass: button.className,
    };
  })()`, true);
  check(
    'picking an external herdr row switches footer label to "· Herdr" and class to backend-herdr',
    switched.found === true
      && switched.stored === 'external-herdr'
      && /Herdr/.test(switched.footerText || '')
      && /backend-herdr/.test(switched.footerClass || ''),
    `stored=${switched.stored} footer="${switched.footerText}" class="${switched.footerClass}"`,
  );
  // Return to built-in so the run leaves a clean state.
  await cdp.evalExpr(`(async () => {
    document.getElementById('footerSessionButton').click();
    await new Promise((r) => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('#sessionList .session-line')];
    const row = rows.find((r) => /backend-builtin/.test(r.className));
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 1500));
  })()`, true);
} else {
  check('external herdr row not offered (no compatible install); skipped switch check', true, `herdrHidden=${manager.herdrHidden}`);
}

// ---------- Stale session close ----------
// A session whose backend died without removing its row (crash, kill -9 ->
// socket file gone) must close cleanly instead of returning a 502 ENOENT
// error, and the UI must show the clean already-stopped message. The runner
// creates the stale session directory as a fixture (run-e2e.sh); the server
// discovers it as a known external session row with no live socket.
const staleApi = await cdp.evalExpr(`(async () => {
  // API check first: closing the stale row through the server API must
  // report ok + already_stopped, not a 502 ENOENT error.
  const res = await fetch('/api/session/close', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'stale-probe', backend: 'external-herdr' }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
})()`, true);
check(
  'closing a stale (socket gone) external session returns ok already_stopped',
  staleApi.status === 200
    && !!(staleApi.body && staleApi.body.ok)
    && staleApi.body.already_stopped === true,
  `status=${staleApi.status} body=${JSON.stringify(staleApi.body)}`,
);

// UI check: target the stale row through the real picker, press its Close
// button (the real closeCurrentSession path), and the manager must show the
// clean already-stopped message. The follow-up refresh must not overwrite
// it with the offline manager (the app retargets the server's default
// backend after closing).
const staleUi = await cdp.evalExpr(`(async () => {
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 900));
  const rows = [...document.querySelectorAll('#sessionList .session-line')];
  const row = rows.find((r) => /stale-probe/.test(r.textContent));
  if (!row) return { found: false };
  row.click();
  await new Promise((r) => setTimeout(r, 1500));
  const buttons = [...document.querySelectorAll('#sessionList .session-button.danger')];
  const closeBtn = buttons.find((b) => /Close/.test(b.textContent));
  if (!closeBtn) return { found: true, closeBtn: false };
  window.confirm = () => true;
  closeBtn.click();
  await new Promise((r) => setTimeout(r, 1200));
  const m = document.getElementById('sessionManager');
  return {
    found: true,
    closeBtn: true,
    visible: m && getComputedStyle(m).display !== 'none',
    title: document.getElementById('sessionManagerTitle').textContent,
    text: document.getElementById('sessionManagerText').textContent,
    stored: localStorage.getItem('herdr-session-backend'),
  };
})()`, true);
check(
  'closing a stale session via the UI shows the clean already-stopped message',
  staleUi.found === true
    && staleUi.closeBtn === true
    && staleUi.visible === true
    && staleUi.title === 'Session closed'
    && /not running/.test(staleUi.text || ''),
  `found=${staleUi.found} title="${staleUi.title}" text="${staleUi.text}" stored=${staleUi.stored}`,
);
// Return to the built-in session so later checks run on the default backend.
await cdp.evalExpr(`(async () => {
  const rows = [...document.querySelectorAll('#sessionList .session-line')];
  const row = rows.find((r) => /backend-builtin/.test(r.className) && !/stale-probe/.test(r.textContent));
  if (row) row.click();
  await new Promise((r) => setTimeout(r, 1200));
  return true;
})()`, true);

// ---------- Mobile layout ----------
// The mobile bundle loads its script chain after navigation; poll for the
// badge instead of fixed sleeps (fixed waits raced the bundle load and
// produced a false FAIL).
await cdp.evalExpr('localStorage.setItem("herdr-web-layout", "mobile")');
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 1500));
const mobile = await cdp.evalExpr(`(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const badge = document.getElementById('mobileBackendBadge');
    if (badge && document.documentElement.dataset.herdrLayout === 'mobile') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const badge = document.getElementById('mobileBackendBadge');
  const styles = badge ? getComputedStyle(badge) : null;
  return {
    layout: document.documentElement.dataset.herdrLayout,
    badgePresent: !!badge,
    badgeText: badge ? badge.textContent : '',
    badgeClass: badge ? badge.className : '',
    badgeColor: styles ? styles.color : '',
  };
})()`, true);
check(
  'mobile layout renders backend badge "built-in" with accent-family color',
  mobile.layout === 'mobile'
    && mobile.badgePresent
    && /built-in/.test(mobile.badgeText || '')
    && /backend-builtin/.test(mobile.badgeClass || '')
    && !!mobile.badgeColor,
  `layout=${mobile.layout} text="${mobile.badgeText}" class="${mobile.badgeClass}" color=${mobile.badgeColor}`,
);
// The hidden attribute must actually hide the New Herdr offer: a CSS
// display rule on .session-button previously defeated it (real-browser
// regression caught by this suite).
const hiddenCheck = await cdp.evalExpr(`(async () => {
  localStorage.setItem('herdr-web-layout', 'desktop');
  location.reload();
  return true;
})()`, true);
await new Promise((r) => setTimeout(r, 2000));
const hidden = await cdp.evalExpr(`(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const install = await fetch('/api/versions').then((r) => r.json());
  const compatible = install.herdr_install && install.herdr_install.compatible;
  const herdrBtn = document.getElementById('newHerdrSessionTarget');
  if (!herdrBtn) return { present: false };
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 900));
  return {
    present: true,
    compatible,
    hiddenAttr: herdrBtn.hidden,
    computedHidden: getComputedStyle(herdrBtn).display === 'none',
  };
})()`, true);
check(
  'New Herdr offer hidden state matches herdr compatibility in the real DOM',
  hidden.present === true
    && hidden.hiddenAttr === !hidden.compatible
    && (hidden.compatible || hidden.computedHidden === true),
  `compatible=${hidden.compatible} hiddenAttr=${hidden.hiddenAttr} computedHidden=${hidden.computedHidden}`,
);
await cdp.evalExpr('localStorage.removeItem("herdr-web-layout")');

// ---------- Light theme (latte) ----------
// The --backend-* palette has separate dark (mocha) and light (latte) values;
// verify the light variants actually render in the real browser.
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 1500));
await cdp.evalExpr('localStorage.setItem("herdr-web-theme", "light")');
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));
const lightBuiltin = await cdp.evalExpr(`(async () => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (document.getElementById('footerSessionButton')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const button = document.getElementById('footerSessionButton');
  const styles = button ? getComputedStyle(button) : null;
  return {
    light: document.body.classList.contains('light'),
    footerText: button ? button.textContent : '',
    footerColor: styles ? styles.color : '',
  };
})()`, true);
check(
  'light theme: body.light active and builtin footer keeps latte accent rgb(25, 87, 210)',
  lightBuiltin.light === true
    && /built-in/.test(lightBuiltin.footerText || '')
    && lightBuiltin.footerColor === 'rgb(25, 87, 210)',
  `light=${lightBuiltin.light} footer="${lightBuiltin.footerText}" color=${lightBuiltin.footerColor}`,
);
const lightHerdr = await cdp.evalExpr(`(async () => {
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 900));
  const rows = [...document.querySelectorAll('#sessionList .session-line')];
  const row = rows.find((r) => /backend-herdr/.test(r.className));
  if (!row) return { found: false };
  row.click();
  await new Promise((r) => setTimeout(r, 2500));
  const button = document.getElementById('footerSessionButton');
  const styles = button ? getComputedStyle(button) : null;
  return { found: true, text: button.textContent, color: styles ? styles.color : '' };
})()`, true);
check(
  'light theme: herdr footer switches to latte mauve rgb(136, 57, 239)',
  lightHerdr.found === true
    && /Herdr/.test(lightHerdr.text || '')
    && lightHerdr.color === 'rgb(136, 57, 239)',
  `found=${lightHerdr.found} text="${lightHerdr.text}" color=${lightHerdr.color}`,
);
const lightMobile = await cdp.evalExpr(`(async () => {
  document.getElementById('footerSessionButton').click();
  await new Promise((r) => setTimeout(r, 800));
  const rows = [...document.querySelectorAll('#sessionList .session-line')];
  const row = rows.find((r) => /backend-builtin/.test(r.className));
  if (row) row.click();
  await new Promise((r) => setTimeout(r, 1500));
  localStorage.setItem('herdr-web-layout', 'mobile');
  location.reload();
  return true;
})()`, true);
await new Promise((r) => setTimeout(r, 2500));
const lightMobileBadge = await cdp.evalExpr(`(async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const badge = document.getElementById('mobileBackendBadge');
    if (badge && document.documentElement.dataset.herdrLayout === 'mobile') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const badge = document.getElementById('mobileBackendBadge');
  const styles = badge ? getComputedStyle(badge) : null;
  return {
    light: document.body.classList.contains('light'),
    text: badge ? badge.textContent : '',
    color: styles ? styles.color : '',
  };
})()`, true);
check(
  'light theme: mobile badge renders builtin in latte accent rgb(25, 87, 210)',
  lightMobileBadge.light === true
    && /built-in/.test(lightMobileBadge.text || '')
    && lightMobileBadge.color === 'rgb(25, 87, 210)',
  `light=${lightMobileBadge.light} text="${lightMobileBadge.text}" color=${lightMobileBadge.color}`,
);
// Restore theme/layout/backend so the run leaves a clean state.
await cdp.evalExpr(`(async () => {
  localStorage.setItem('herdr-web-theme', 'auto');
  localStorage.removeItem('herdr-web-layout');
  return true;
})()`, true);

// ---------- Summary ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} session UX acceptance checks passed`);
await cdp.close();
if (failed.length) {
  process.exit(1);
}