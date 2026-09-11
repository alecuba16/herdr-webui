// Real-browser acceptance for the mobile settings rollback chips.
import { connectToPage } from './cdp-driver.mjs';

const URL = process.env.E2E_BASE_URL || 'https://127.0.0.1:8892/';
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
// Narrow viewport makes app_boot resolve the mobile layout automatically.
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
});
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));
let title = await cdp.evalExpr('document.title');
if (!title || /privacy|127\.0\.0\.1|localhost/i.test(String(title))) {
  // The cert interstitial blocks page-level navigation (CSP), so retry
  // via a CDP navigate.
  await cdp.send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 2500));
  title = await cdp.evalExpr('document.title');
}
if (/privacy|127\.0\.0\.1|localhost/i.test(String(title))) {
  // One more nudge: some Chrome builds need a second same-origin load.
  await cdp.send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 2500));
  title = await cdp.evalExpr('document.title');
}
await new Promise((r) => setTimeout(r, 1000));

const layout = await cdp.evalExpr('document.documentElement.dataset.herdrLayout');
check('mobile layout loads', layout === 'mobile', `layout=${layout} title=${title}`);

await cdp.evalExpr('HerdrMobile.showScreen("settings")');
await new Promise((r) => setTimeout(r, 400));
let html = await cdp.evalExpr('document.getElementById("mobileScreen").innerHTML');
check(
  'no rollback chip before changes',
  !html.includes('data-rollback-id="worktreeDefaultDirectory"'),
);

await cdp.evalExpr('HerdrMobile.setWorktreeDefaultDirectory("/tmp/scu-e2e")');
await new Promise((r) => setTimeout(r, 400));
html = await cdp.evalExpr('document.getElementById("mobileScreen").innerHTML');
check(
  'rollback chip appears after change',
  html.includes('data-rollback-id="worktreeDefaultDirectory"'),
);
const saved = JSON.parse(
  await cdp.evalExpr('localStorage.getItem("herdr-web-options")'),
);
check('mobile change persisted', saved.worktreeDefaultDirectory === '/tmp/scu-e2e');

await cdp.evalExpr('HerdrMobile.rollbackSetting("worktreeDefaultDirectory")');
await new Promise((r) => setTimeout(r, 400));
html = await cdp.evalExpr('document.getElementById("mobileScreen").innerHTML');
check(
  'chip cleared after rollback',
  !html.includes('data-rollback-id="worktreeDefaultDirectory"'),
);
const savedAfter = JSON.parse(
  await cdp.evalExpr('localStorage.getItem("herdr-web-options")'),
);
check('mobile rollback restored baseline', savedAfter.worktreeDefaultDirectory === '');

// Re-entering Settings must re-capture the open-time baseline: after
// navigating away and back, a change rolls back to the fresh snapshot.
await cdp.evalExpr('HerdrMobile.showScreen("home")');
await cdp.evalExpr('HerdrMobile.showScreen("settings")');
await new Promise((r) => setTimeout(r, 400));
await cdp.evalExpr('HerdrMobile.setWorktreeDefaultDirectory("/tmp/scu-reentry")');
await new Promise((r) => setTimeout(r, 400));
await cdp.evalExpr('HerdrMobile.rollbackSetting("worktreeDefaultDirectory")');
await new Promise((r) => setTimeout(r, 400));
const savedReentry = JSON.parse(
  await cdp.evalExpr('localStorage.getItem("herdr-web-options")'),
);
check(
  're-entry rollback restores fresh baseline',
  savedReentry.worktreeDefaultDirectory === '',
  `saved=${savedReentry.worktreeDefaultDirectory}`,
);

// Cleanup: restore auto layout and clear the device emulation for later
// checks on the same target.
await cdp.evalExpr('localStorage.setItem("herdr-web-layout", "auto")');
await cdp.send('Emulation.clearDeviceMetricsOverride');
const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);