// Real-browser acceptance check for the mobile logout path. The mobile
// layout is forced via the herdr-web-layout localStorage key, then the flow
// is: login -> mobile Settings -> Data section -> Logout (native confirm,
// auto-accepted by the CDP driver) -> back to the login page.
// Requires the validation server on 127.0.0.1:18787 and headless Chrome
// on CDP_PORT.
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
// Force the mobile layout before the app boots.
await cdp.evalExpr(`localStorage.setItem('herdr-web-layout', 'mobile')`);
const title = await openApp(cdp, URL);
check('login page served', /login/i.test(String(title)), `title=${title}`);

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

const mobileLoaded = await cdp.evalExpr(
  `(() => ({
    layout: document.documentElement.dataset.herdrLayout,
    title: document.title,
    hasHerdrMobile: typeof window.HerdrMobile === 'object' && typeof window.HerdrMobile.logout === 'function',
  }))()`
);
check(
  'mobile layout loaded with HerdrMobile.logout',
  mobileLoaded.layout === 'mobile' && mobileLoaded.hasHerdrMobile,
  JSON.stringify(mobileLoaded)
);

// Navigate to the Settings screen. Mobile screens are usually switched via
// a nav element; find any control labeled Settings.
const navResult = await cdp.evalExpr(`
  (() => {
    const btn = document.getElementById('mobileSettings');
    if (btn) { btn.click(); return 'clicked'; }
    return 'not-found';
  })()
`);
check('settings screen opened', !navResult.includes('not-found'), String(navResult));
await sleep(1200);

const logoutBtn = await cdp.evalExpr(`
  (() => {
    const candidates = [...document.querySelectorAll('button, [onclick]')]
      .filter((el) => (el.getAttribute('onclick') || '').includes('HerdrMobile.logout'));
    if (!candidates.length) return 'no-button';
    return { label: candidates[0].textContent.trim(), count: candidates.length };
  })()
`);
check(
  'mobile Logout button present',
  typeof logoutBtn === 'object',
  JSON.stringify(logoutBtn)
);

// Click Logout: the native confirm() is auto-accepted by the driver, then
// the page must land on the login form.
let dialogText = '';
cdp.onEvent((msg) => {
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogText = msg.params?.message || '';
  }
});
await cdp.evalExpr(`
  (() => {
    const el = [...document.querySelectorAll('[onclick]')]
      .find((e) => (e.getAttribute('onclick') || '').includes('HerdrMobile.logout'));
    if (!el) return 'no-button';
    el.click();
    return 'clicked';
  })()
`);
await sleep(2500);
check('logout confirm dialog shown to user', /log out/i.test(dialogText), `dialog="${dialogText}"`);

const afterLogout = await cdp.evalExpr(
  `(() => ({ title: document.title, hasLoginForm: !!document.getElementById('login') }))()`
);
check(
  'back on login page after mobile logout',
  /login/i.test(String(afterLogout.title)) || afterLogout.hasLoginForm,
  JSON.stringify(afterLogout)
);

// Cleanup: reset the layout preference so later runs start clean.
await cdp.evalExpr(`localStorage.removeItem('herdr-web-layout')`);
cdp.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed}/${results.length} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);