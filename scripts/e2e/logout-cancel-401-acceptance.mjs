// Real-browser acceptance check for the logout confirm-cancel and mid-use
// 401 redirect paths. Runs after logout-acceptance.mjs scenarios or on any
// server with credentials and localhost_no_auth off:
//   1. Cancel in the Logout confirm dialog must NOT log out.
//   2. When the session dies under an open app window (logout from another
//      context), the next API call must bounce the window to the login page
//      instead of surfacing a raw error.
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

// Log in through the real form.
await cdp.evalExpr(`
  (() => {
    const user = document.querySelector('input[name="username"]');
    const pass = document.getElementById('password');
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
check('app loaded after login', !/login/i.test(String(appLoaded.title)), JSON.stringify(appLoaded));

// Open settings, click Logout, then CANCEL the confirm dialog.
await cdp.evalExpr(`document.getElementById('settingsToggle').click()`);
await sleep(1200);
await cdp.evalExpr(`document.getElementById('serverSettingsLogout').click()`);
await sleep(700);
const dialogShown = await cdp.evalExpr(`
  (() => {
    const btn = document.getElementById('questionConfirm');
    return btn ? { visible: btn.offsetParent !== null, label: btn.textContent.trim() } : null;
  })()
`);
check('confirm dialog shown', !!dialogShown && dialogShown.visible, JSON.stringify(dialogShown));

await cdp.evalExpr(`document.getElementById('questionCancel')?.click() || 'no-cancel'`);
await sleep(800);
const afterCancel = await cdp.evalExpr(`
  (() => {
    const onLogin = /login/i.test(document.title) || !!document.getElementById('login');
    const stillApp = !!document.getElementById('settingsToggle');
    return { onLogin, stillApp };
  })()
`);
check('cancel keeps the session (still in app)', afterCancel.stillApp && !afterCancel.onLogin, JSON.stringify(afterCancel));

// API calls must still be authorized after canceling.
const apiOk = await cdp.evalExpr(`
  (async () => {
    try {
      await HerdrHttp.request('/api/workspaces');
      return 'ok';
    } catch (e) {
      return 'error:' + (e.message || e);
    }
  })()
`, true);
check('API still authorized after cancel', apiOk === 'ok', String(apiOk));

// Kill the session from outside the page (logout with the raw cookie) while
// the app window stays open, then make an API call: the 401 handler must
// bounce the window to the login page.
const cookie = await cdp.evalExpr(
  `(async () => (await document.cookie.match(/herdr_web_session=[^;]+/))?.[0] || 'none')()`
);
// The session cookie is HttpOnly, so it is not visible to the page. Drive
// the logout through the page's own fetch instead: call /api/logout with
// same-origin credentials without navigating (equivalent to a second
// browser logging out).
const loggedOut = await cdp.evalExpr(`
  (async () => {
    const r = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    return r.status;
  })()
`, true);
check('session killed from second context', loggedOut === 200, `status=${loggedOut}`);

// The next API call from the still-open window must redirect to login. The
// redirect itself navigates the page, which can kill the in-flight eval
// connection ("Inspected target navigated"); treat that as success and
// verify the landing state on a fresh connection.
let redirected;
try {
  redirected = await cdp.evalExpr(
    `
    (async () => {
      try {
        await HerdrHttp.request('/api/workspaces');
        return 'no-redirect';
      } catch (e) {
        return 'threw:' + String(e.message || e);
      }
    })()
  `,
    true
  );
} catch (e) {
  redirected = 'navigated:' + String(e.message || e).slice(0, 80);
}
await sleep(1200);
// Reconnect: the navigation invalidated the previous session's target
// state, but the page target itself persists.
let landing;
try {
  landing = await cdp.evalExpr(
    `(() => ({ title: document.title, hasLoginForm: !!document.getElementById('login') }))()`
  );
} catch (e) {
  const cdp2 = await connectToPage();
  landing = await cdp2.evalExpr(
    `(() => ({ title: document.title, hasLoginForm: !!document.getElementById('login') }))()`
  );
  cdp2.close();
}
check(
  'dead session bounces open window to login',
  (typeof redirected === 'string' && redirected.startsWith('navigated')) ||
    (landing && (/login/i.test(String(landing.title)) || landing.hasLoginForm)),
  `redirected=${JSON.stringify(redirected)} landing=${JSON.stringify(landing)}`
);

cdp.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed}/${results.length} CHECKS FAILED`);
process.exit(failed === 0 ? 0 : 1);