// Real-browser acceptance check for the never-expire + explicit-logout work.
// Drives the actually-served app: login -> settings modal -> server settings
// -> Logout button -> confirm dialog -> back to the login page. Uses the
// same CDP driver as the other e2e scripts. Requires the validation server
// on 127.0.0.1:18787 (plain HTTP, localhost_no_auth off) and headless
// Chrome on CDP_PORT.
import { connectToPage, openApp } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:18787/';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || 'secret';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage();
const title = await openApp(cdp, URL);
check('login page served', /login/i.test(String(title)), `title=${title}`);

// Fill the login form and click the real submit button (onsubmit handler
// posts /api/login and reloads on success).
await cdp.evalExpr(`
  (() => {
    const user = document.querySelector('input[name="username"]');
    const pass = document.getElementById('password');
    if (!user || !pass) return 'no-login-form';
    user.value = ${JSON.stringify(USER)};
    pass.value = ${JSON.stringify(PASS)};
    document.getElementById('loginSubmit').click();
    return 'submitted';
  })()
`);
await sleep(2500);

const appLoaded = await cdp.evalExpr(
  `(() => ({ title: document.title, hasSettingsToggle: !!document.getElementById('settingsToggle') }))()`
);
check('app loaded after login', !/login/i.test(String(appLoaded.title)) && appLoaded.hasSettingsToggle, JSON.stringify(appLoaded));

// Open the settings modal through the real toggle button.
await cdp.evalExpr(`document.getElementById('settingsToggle')?.click() || 'missing'`);
await sleep(1200); // loadServerSettings fetch needs to finish and inject the HTML

const logoutBtn = await cdp.evalExpr(`
  (() => {
    const btn = document.getElementById('serverSettingsLogout');
    if (!btn) return 'no-button';
    const visible = btn.offsetParent !== null || btn.getClientRects().length > 0;
    const input = document.getElementById('optServerSessionExpiration');
    return {
      label: btn.textContent.trim(),
      visible: !!visible,
      sessionInput: input ? input.value : 'missing',
    };
  })()
`);
check(
  'Logout button present in server settings',
  typeof logoutBtn === 'object' && logoutBtn.visible,
  JSON.stringify(logoutBtn)
);
check(
  'session expiration field shows never (0)',
  typeof logoutBtn === 'object' && logoutBtn.sessionInput === '0',
  typeof logoutBtn === 'object' ? String(logoutBtn.sessionInput) : String(logoutBtn)
);

// Click Logout, expect the askQuestion confirm modal (not a native dialog).
await cdp.evalExpr(`document.getElementById('serverSettingsLogout').click()`);
await sleep(700);
const confirmState = await cdp.evalExpr(`
  (() => {
    const confirmBtn = document.getElementById('questionConfirm');
    const modal = confirmBtn ? confirmBtn.closest('.modal, .modal-backdrop') : null;
    const text = modal ? (modal.textContent || '') : '';
    return {
      confirmVisible: confirmBtn ? confirmBtn.offsetParent !== null : false,
      mentionsLogout: /log out/i.test(text),
      confirmLabel: confirmBtn ? confirmBtn.textContent.trim() : null,
    };
  })()
`);
check(
  'confirm dialog appears for logout',
  !!confirmState.confirmVisible && !!confirmState.mentionsLogout,
  JSON.stringify(confirmState)
);

// Confirm: the page should navigate back to the login page.
await cdp.evalExpr(`document.getElementById('questionConfirm')?.click() || 'no-confirm'`);
await sleep(2000);
const afterLogout = await cdp.evalExpr(
  `(() => ({ title: document.title, path: location.pathname, hasLoginForm: !!document.getElementById('login') }))()`
);
check(
  'back on login page after logout',
  /login/i.test(String(afterLogout.title)) || afterLogout.hasLoginForm,
  JSON.stringify(afterLogout)
);

// Reload must stay on the login page (session cookie is dead server-side too).
await openApp(cdp, URL);
await sleep(1000);
const afterReload = await cdp.evalExpr(
  `(() => ({ title: document.title, hasLoginForm: !!document.getElementById('login') }))()`
);
check(
  'reload stays on login page (session dead)',
  /login/i.test(String(afterReload.title)) || afterReload.hasLoginForm,
  JSON.stringify(afterReload)
);

cdp.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed}/${results.length} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);