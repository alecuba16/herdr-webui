// Real-browser acceptance checks for the settings confirm/rollback UX.
// Drives the actually-served desktop app end to end:
//   1. Open Settings, edit a text-like setting (exploration dir) without
//      confirming: localStorage must NOT change, pencil + rollback visible.
//   2. Press Enter: value saves, pencil/rollback hide, Applied badge flashes.
//   3. Edit again and click the pencil: same result.
//   4. Edit again and click the rollback arrow: baseline restored, not saved.
//   5. Change a select (agent sorting): saves immediately, rollback arrow
//      visible, arrow click restores baseline value and persists it.
//   6. Notification volume slider: saves immediately, rollback restores.
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
// A previous run on this target (e.g. the mobile acceptance) may have
// left a device metrics override active, and the bare headless window can
// be narrower than the app's 760px mobile breakpoint. Pin a desktop-sized
// viewport so the desktop layout (and settingsModal) always renders.
await cdp
  .send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  .catch(() => {});
await cdp.send('Page.navigate', { url: URL });
await new Promise((r) => setTimeout(r, 2500));

let title = await cdp.evalExpr('document.title');
if (!title || /privacy|127\.0\.0\.1|localhost/i.test(String(title))) {
  // The cert interstitial blocks page-level navigation (CSP), so retry
  // via a CDP navigate; the bypass cert flag applies from the second load.
  await cdp.send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 2500));
  title = await cdp.evalExpr('document.title');
}
check('app loads', !!title && !/privacy|127\.0\.0\.1|localhost/i.test(String(title)), `title=${title}`);

// Wait for the app to be wired, then open the settings modal the same way
// the settingsToggle click handler does. The modal is rendered by the app
// shell during boot, so poll until it exists.
async function waitFor(expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const value = await cdp.evalExpr(expr);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const modalReady = await waitFor('document.getElementById("settingsModal") ? "ready" : ""');
check('settings modal exists after boot', modalReady === 'ready', `modal=${modalReady}`);
await cdp.evalExpr('(function(){const m=document.getElementById("settingsModal");m.style.display="grid";if(typeof prepareSettingsModalOpen==="function")prepareSettingsModalOpen();})()');
await new Promise((r) => setTimeout(r, 500));
let modalVisible = await cdp.evalExpr(
  'document.getElementById("settingsModal").style.display',
);
check('settings modal opens', modalVisible === 'grid', `display=${modalVisible}`);

async function savedOptions() {
  return JSON.parse(
    await cdp.evalExpr(
      '(window.HerdrOptions ? JSON.stringify(window.HerdrOptions.read()) : localStorage.getItem("herdr-web-options"))',
    ),
  );
}

function visible(id) {
  return cdp.evalExpr(
    `(function(){const el=document.getElementById(${JSON.stringify(id)});if(!el)return null;const cs=getComputedStyle(el);return cs.display==="none"||cs.visibility==="hidden"?"hidden":"visible";})()`,
  );
}

// --- 1. Text-like edit without confirm must NOT save.
const before = await savedOptions();
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optExplorationDefaultDirectory");el.focus();el.value="~/e2e-pending";el.dispatchEvent(new Event("input",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
const pendingSaved = await savedOptions();
check(
  'text edit does not save until confirm',
  pendingSaved.explorationDefaultDirectory === before.explorationDefaultDirectory,
  `saved=${pendingSaved.explorationDefaultDirectory}`,
);
const pencilVisible = await visible('confirmPencil');
const rowPending = await cdp.evalExpr(
  '(function(){const el=document.getElementById("optExplorationDefaultDirectory");const row=el.closest(".option");return row.className;})()',
);
check(
  'row marked pending with chrome',
  String(rowPending).includes('settings-pending'),
  `rowClass=${rowPending}`,
);

// Pencil and rollback live inside the row (no ids), query by class.
const chromeCount = await cdp.evalExpr(
  '(function(){const row=document.getElementById("optExplorationDefaultDirectory").closest(".option");const p=row.querySelector(".settings-confirm-pencil");const rb=row.querySelector(".settings-rollback");return {pencil:p?(p.style.display==="none"?"hidden":"visible"):"missing",rollback:rb?(rb.style.display==="none"?"hidden":"visible"):"missing",pencilTitle:p?p.title:""};})()',
);
check('pencil visible while pending', chromeCount.pencil === 'visible', JSON.stringify(chromeCount));
check('rollback visible while pending', chromeCount.rollback === 'visible');
check(
  'pencil hover hint',
  chromeCount.pencilTitle === 'Enter or press to confirm',
  `title=${chromeCount.pencilTitle}`,
);

// --- 2. Enter commits.
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optExplorationDefaultDirectory");el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
const afterEnter = await savedOptions();
check(
  'Enter commits the text setting',
  afterEnter.explorationDefaultDirectory === '~/e2e-pending',
  `saved=${afterEnter.explorationDefaultDirectory}`,
);
const chromeAfterCommit = await cdp.evalExpr(
  '(function(){const row=document.getElementById("optExplorationDefaultDirectory").closest(".option");const p=row.querySelector(".settings-confirm-pencil");const rb=row.querySelector(".settings-rollback");return {pencil:p?p.style.display:"none",rollback:rb?rb.style.display:"none",pending:row.className};})()',
);
check(
  'chrome hidden after commit',
  chromeAfterCommit.pencil === 'none' && chromeAfterCommit.rollback === 'none',
  JSON.stringify(chromeAfterCommit),
);

// --- 3. Edit again and click the pencil button.
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optExplorationDefaultDirectory");el.value="~/e2e-pencil";el.dispatchEvent(new Event("input",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 200));
await cdp.evalExpr(
  '(function(){const row=document.getElementById("optExplorationDefaultDirectory").closest(".option");row.querySelector(".settings-confirm-pencil").click();})()',
);
await new Promise((r) => setTimeout(r, 300));
const afterPencil = await savedOptions();
check(
  'pencil click commits',
  afterPencil.explorationDefaultDirectory === '~/e2e-pencil',
  `saved=${afterPencil.explorationDefaultDirectory}`,
);

// --- 4. Edit and roll back without saving.
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optExplorationDefaultDirectory");el.value="~/e2e-rolled";el.dispatchEvent(new Event("input",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 200));
await cdp.evalExpr(
  '(function(){const row=document.getElementById("optExplorationDefaultDirectory").closest(".option");row.querySelector(".settings-rollback").click();})()',
);
await new Promise((r) => setTimeout(r, 300));
const afterRollback = await savedOptions();
const inputAfterRollback = await cdp.evalExpr(
  'document.getElementById("optExplorationDefaultDirectory").value',
);
check(
  'rollback restores baseline value',
  inputAfterRollback === afterPencil.explorationDefaultDirectory,
  `input=${inputAfterRollback}`,
);
check(
  'rollback leaves saved options untouched',
  afterRollback.explorationDefaultDirectory === afterPencil.explorationDefaultDirectory,
  `saved=${afterRollback.explorationDefaultDirectory}`,
);

// --- 5. Select applies immediately; rollback restores baseline.
const selectBefore = await savedOptions();
const agentBaseline = selectBefore.agentSortMode || 'off';
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optAgentSortMode");el.value="attention";el.dispatchEvent(new Event("change",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
const selectAfter = await savedOptions();
check(
  'select saves immediately',
  selectAfter.agentSortMode === 'attention',
  `saved=${selectAfter.agentSortMode}`,
);
const selectChrome = await cdp.evalExpr(
  '(function(){const row=document.getElementById("optAgentSortMode").closest(".option");const p=row.querySelector(".settings-confirm-pencil");const rb=row.querySelector(".settings-rollback");return {pencil:!!p,rollback:rb?rb.style.display:"none"};})()',
);
check(
  'select row shows rollback arrow only',
  !selectChrome.pencil && selectChrome.rollback !== 'none',
  JSON.stringify(selectChrome),
);
await cdp.evalExpr(
  '(function(){const row=document.getElementById("optAgentSortMode").closest(".option");row.querySelector(".settings-rollback").click();})()',
);
await new Promise((r) => setTimeout(r, 300));
const selectRolled = await savedOptions();
const selectValue = await cdp.evalExpr(
  'document.getElementById("optAgentSortMode").value',
);
check(
  'select rollback restores baseline and persists it',
  selectRolled.agentSortMode === agentBaseline && selectValue === agentBaseline,
  `saved=${selectRolled.agentSortMode} value=${selectValue}`,
);

// --- 6. Range slider saves immediately; rollback restores baseline.
const volBefore = await savedOptions();
const volBaseline = typeof volBefore.notificationVolume === 'number' ? volBefore.notificationVolume : 0.24;
await cdp.evalExpr(
  '(function(){const el=document.getElementById("optNotificationVolume");el.value=90;el.dispatchEvent(new Event("input",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
const volAfter = await savedOptions();
check('range slider saves immediately', Math.abs(volAfter.notificationVolume - 0.9) < 0.001, `saved=${volAfter.notificationVolume}`);
await cdp.evalExpr(
  '(function(){const row=document.getElementById("optNotificationVolume").closest(".option");const rb=row.querySelector(".settings-rollback");if(rb)rb.click();})()',
);
await new Promise((r) => setTimeout(r, 300));
const volRolled = await savedOptions();
const volValue = await cdp.evalExpr(
  'document.getElementById("optNotificationVolume").value',
);
check(
  'range rollback restores baseline',
  Math.abs(volRolled.notificationVolume - volBaseline) < 0.001 &&
    String(Math.round(volBaseline * 100)) === String(volValue),
  `saved=${volRolled.notificationVolume} value=${volValue} baseline=${volBaseline}`,
);

// --- 7. Reopening Settings re-reads open-time baselines.
// Commit a select change so the saved value moves, close the modal, reopen:
// the rollback arrow must NOT appear for the newly saved value, and a later
// rollback must restore the latest open-time baseline, not a stale one.
await cdp.evalExpr(
  '(function(){const s=document.getElementById("optAgentSortMode");s.value="attention_inverted";s.dispatchEvent(new Event("change",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
await cdp.evalExpr(
  '(function(){document.getElementById("settingsModal").style.display="none";const m=document.getElementById("settingsModal");m.style.display="grid";if(typeof prepareSettingsModalOpen==="function")prepareSettingsModalOpen();})()',
);
await new Promise((r) => setTimeout(r, 500));
const reopenChrome = JSON.parse(
  await cdp.evalExpr(
    '(function(){const row=document.getElementById("optAgentSortMode").closest(".option");const rb=row.querySelector(".settings-rollback");return JSON.stringify({visible: rb ? String(rb.style.display||"")!=="none" : false, pending: row.className.includes("settings-pending")});})()',
  ),
);
check(
  'reopen clears chrome for freshly saved value',
  reopenChrome.visible === false && reopenChrome.pending === false,
  JSON.stringify(reopenChrome),
);
// Change to another value, roll back: restore must target the latest
// open-time baseline (attention_inverted), not the very first one (off).
await cdp.evalExpr(
  '(function(){const s=document.getElementById("optAgentSortMode");s.value="attention";s.dispatchEvent(new Event("change",{bubbles:true}));})()',
);
await new Promise((r) => setTimeout(r, 300));
await cdp.evalExpr(
  '(function(){const row=document.getElementById("optAgentSortMode").closest(".option");const rb=row.querySelector(".settings-rollback");if(rb)rb.click();})()',
);
await new Promise((r) => setTimeout(r, 300));
const reopenSaved = await savedOptions();
const reopenValue = await cdp.evalExpr(
  'document.getElementById("optAgentSortMode").value',
);
check(
  'rollback after reopen restores latest open-time baseline',
  reopenSaved.agentSortMode === 'attention_inverted' &&
    reopenValue === 'attention_inverted',
  `saved=${reopenSaved.agentSortMode} value=${reopenValue}`,
);

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);