// Full live audit of keyboard guard attributes on every mobile text input.
// Boots the app on the isolated server, walks each surface, and dumps the
// guard attributes actually present in the live DOM. Exits 1 on any missing
// guard on a text input/textarea.
const ORIGIN = process.env.E2E_ORIGIN || "https://localhost:8899";
const CDP_PORT = process.env.CDP_PORT || "9223";
const REPO = process.env.E2E_REPO || "";
if (!REPO) { console.error("E2E_REPO must point at the fixture repo (see run-keyboard-guards-e2e.sh)"); process.exit(2); }

const REQUIRED = ["autocomplete=off", "autocorrect=off", "autocapitalize=none", "spellcheck=false", "writingsuggestions=false", "translate=no"];
const GUARD_ATTRS = ["autocomplete", "autocorrect", "autocapitalize", "spellcheck", "writingsuggestions", "translate"];
// enterkeyhint values the platform spec defines; anything else is a typo.
const VALID_HINTS = new Set(["enter", "done", "go", "next", "previous", "search", "send"]);
// Exact enterkeyhint per checked surface (from the guarded call sites).
// A wrong hint here is a UX bug the presence check cannot catch.
const EXPECTED_HINTS = {
  "terminal textarea": "send",
  "wterm core textarea": "send",
  "search sheet input": "search",
  "git commit title": "done",
  "file rename sheet input": "done",
  "file new-file sheet input": "done",
  "workspace rename input": "done",
  "settings filter": "search",
  // hintless by design: git commit body, worktree flows, session name,
  // settings text fields → expect NO enterkeyhint attribute.
  "git commit body": null,
  "worktrees discover path": null,
  "session name input": null,
  // Worktree create fields are hintless by design (inputAttrs() with no arg).
  "worktrees create field #1": null,
  "worktrees create field #2": null,
  "worktrees create field #3": null,
  "worktrees create field #4": null,
  // Settings text inputs (hintless by design):
  "settings worktree dir input": null,
  "settings exploration dir input": null,
  "settings terminal font input": null,
};

let ws; let seq = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalJs(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200)}`);
  return r.result.value;
}
async function waitFor(expr, label, timeout = 12000) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try { ok = !!(await evalJs(`(${expr})`)); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}
async function tap(sel) {
  const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  if (!ok) throw new Error(`tap: no element ${sel}`);
}
function guardsOf(elExpr) {
  return evalJs(`(() => { const el = ${elExpr}; if (!el) return null;
    return { ${GUARD_ATTRS.map((a) => `${a}: el.getAttribute(${JSON.stringify(a)})`).join(", ")}, enterkeyhint: el.getAttribute("enterkeyhint"), tag: el.tagName.toLowerCase() };
  })()`);
}

// Open a drawer item by its visible title so reordering the drawer list
// never breaks the audit (the nth-child positions shifted when the temp
// overlay items were removed).
async function tapDrawerItem(title) {
  const ok = await evalJs(`(() => { const item = [...document.querySelectorAll('.mobile-drawer-item')].find(x => /${title}/.test((x.querySelector('strong')||{}).textContent || '')); if (!item) return false; item.click(); return true; })()`);
  if (!ok) throw new Error(`tap: no drawer item matching ${title}`);
}

const failures = [];
function check(surface, selector, elExpr) {
  return guardsOf(elExpr).then((g) => {
    if (!g) { failures.push(`${surface} (${selector}): ELEMENT NOT FOUND`); console.log(`FAIL ${surface}: element missing`); return; }
    const missing = [];
    if (g.autocomplete !== "off") missing.push("autocomplete");
    if (g.autocorrect !== "off") missing.push("autocorrect");
    if (g.autocapitalize !== "none") missing.push("autocapitalize");
    if (g.spellcheck !== "false") missing.push("spellcheck");
    if (g.writingsuggestions !== "false") missing.push("writingsuggestions");
    if (g.translate !== "no") missing.push("translate");
    if (missing.length) { failures.push(`${surface}: missing ${missing.join(",")}`); console.log(`FAIL ${surface}: missing ${missing.join(",")}`); return; }
    const expected = EXPECTED_HINTS[surface];
    if (expected === undefined) { console.log(`OK   ${surface}: all 6 guards${g.enterkeyhint ? ` + enterkeyhint=${g.enterkeyhint}` : ""} (hint not pinned)`); return; }
    if (expected === null) {
      if (g.enterkeyhint !== null) { failures.push(`${surface}: expected NO enterkeyhint, got ${g.enterkeyhint}`); console.log(`FAIL ${surface}: expected NO enterkeyhint, got ${g.enterkeyhint}`); return; }
      console.log(`OK   ${surface}: all 6 guards + no enterkeyhint (pinned)`); return;
    }
    if (g.enterkeyhint !== expected) { failures.push(`${surface}: expected enterkeyhint=${expected}, got ${g.enterkeyhint}`); console.log(`FAIL ${surface}: expected enterkeyhint=${expected}, got ${g.enterkeyhint}`); return; }
    console.log(`OK   ${surface}: all 6 guards + enterkeyhint=${g.enterkeyhint} (pinned)`);
  });
}

async function main() {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${ORIGIN}/session/default` });
  await sleep(2000);
  // The desktop audit (or the app itself) may have persisted a desktop layout
  // preference; force mobile before app_boot reads it.
  await evalJs(`localStorage.setItem('herdr-web-layout', 'mobile')`);
  await send("Page.navigate", { url: `${ORIGIN}/session/default` });
  await sleep(2000);
  await waitFor(`!!document.querySelector('.mobile-nav') && !document.querySelector('.herdr-skeleton')`, "boot settled");

  // Ensure a workspace is open so the terminal screen + composer exist.
  // The extended e2e suite closes its workspaces when it finishes, so Home
  // can legitimately start empty. If no workspace row is present, open the
  // main repo via the recents API, then RELOAD the page so boot state
  // includes it (deterministic, no reliance on the events websocket).
  let rows = await evalJs(`(() => { return [...document.querySelectorAll('.mobile-workspace-row .mobile-row')].length; })()`);
  if (!rows) {
    const open = await fetch(`${ORIGIN}/api/recent-workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: REPO }),
    }).then((r) => r.json()).catch(() => null);
    const wsId = open && (open.result || open).workspace && (open.result || open).workspace.workspace_id;
    if (!wsId) throw new Error("cannot open main repo workspace");
    await send("Page.navigate", { url: `${ORIGIN}/session/default` });
    await sleep(2200);
    await waitFor(`(() => { return [...document.querySelectorAll('.mobile-workspace-row .mobile-row')].some(r => (r.getAttribute('onclick')||'').includes(${JSON.stringify(wsId)})); })()`, "repo row on home after reload", 15000);
    rows = 1;
  }
  // Activate the first workspace row (Home screen shows them after boot).
  await tap('.mobile-nav button[data-screen="home"]');
  await sleep(400);
  await evalJs(`(() => { const rows = [...document.querySelectorAll('.mobile-workspace-row .mobile-row')]; const t = rows.find(r => (r.querySelector('strong')||{}).textContent === 'repo') || rows[0]; if (t) t.click(); return true; })()`);
  await tap('.mobile-nav button[data-screen="terminal"]');
  await sleep(800);
  // Cold servers can take well over 12s to spawn the first shell pane
  // after a restart; re-tap the terminal screen once mid-wait so a slow
  // boot state transition does not read as a missing terminal.
  let terminalMounted = false;
  for (let waited = 0; waited < 30000; waited += 1000) {
    terminalMounted = !!(await evalJs(`(() => { return !!document.querySelector('#terminal textarea'); })()`));
    if (terminalMounted) break;
    if (waited === 12000) await tap('.mobile-nav button[data-screen="terminal"]');
    await sleep(1000);
  }
  if (!terminalMounted) throw new Error("terminal textarea never mounted (30s)");

  // 1. Terminal IME textarea on the terminal screen (typing goes straight
  //    into the terminal; the wterm shell owns the guarded textarea).
  await check("terminal textarea", "#terminal textarea", `document.querySelector('#terminal textarea')`);

  // 2. wterm core: switch the terminal renderer to wterm, reload, audit its textarea.
  await tap('.mobile-nav button[data-screen="more"]');
  await waitFor(`!!document.querySelector('.mobile-drawer-item')`, "drawer");
  await tapDrawerItem("Settings");
  await sleep(600);
  const coreBefore = await evalJs(`(() => { try { return (JSON.parse(localStorage.getItem('herdr-web-options')||'{}').terminalCore) || 'ghostty'; } catch (_) { return 'ghostty'; } })()`);
  await evalJs(`(() => { const sel = [...document.querySelectorAll('select')].find(s => (s.getAttribute('onchange')||'').includes('setTerminalCore')); if (!sel) return false; sel.value = 'wterm'; sel.onchange({ target: sel }); return true; })()`);
  await sleep(500);
  const coreSet = await evalJs(`(() => { try { return (JSON.parse(localStorage.getItem('herdr-web-options')||'{}').terminalCore) || ''; } catch (_) { return ''; } })()`);
  if (coreSet !== "wterm") { failures.push(`wterm core switch did not persist (got ${coreSet})`); console.log(`FAIL wterm core switch: got ${coreSet}`); }
  else console.log("OK   wterm core switch persists (HerdrMobile.setTerminalCore exported)");
  // Reload with the routed workspace URL so the terminal remounts under wterm.
  // selectWorkspace pushes the bare /workspace/<ws> URL first; refresh()
  // repairs the route with tab/pane segments asynchronously, and on a
  // cold backend that repair can take seconds. Reloading the bare URL
  // boots to Home (boot-clean rule) and the terminal never mounts, so
  // wait for the repaired route first.
  await waitFor(`!!location.pathname.match(/\\/tab\\//)`, "route repair after workspace tap", 10000).catch(() => {});
  const routeUrl = await evalJs(`location.href`);
  await send("Page.navigate", { url: routeUrl.startsWith("about:") || !routeUrl.includes("/workspace/") ? `${ORIGIN}/session/default` : routeUrl });
  await sleep(2500);
  await waitFor(`(() => { return !!document.getElementById('terminal') || !!document.querySelector('.mobile-screen textarea'); })()`, "terminal after wterm switch", 15000);
  await check("wterm core textarea", "textarea under terminal", `document.querySelector('#terminal textarea') || document.querySelector('.mobile-screen textarea') || document.querySelector('textarea')`);

  // Switch back to ghostty to leave the default as it was.
  await evalJs(`(() => { try { const o = JSON.parse(localStorage.getItem('herdr-web-options')||'{}'); o.terminalCore = 'ghostty'; o.terminalCoreGhosttyMigrated = true; localStorage.setItem('herdr-web-options', JSON.stringify(o)); } catch (_) {} return true; })()`);
  await sleep(200);

  // 3. Search sheet input.
  await send("Page.navigate", { url: `${ORIGIN}/session/default` });
  await sleep(2000);
  await waitFor(`!!document.querySelector('.mobile-nav')`, "boot after reload");
  await tap('.mobile-nav button[data-screen="search"]');
  await sleep(700);
  await check("search sheet input", "#mobileSearchInput", `document.getElementById('mobileSearchInput')`);

  // 4. Git commit sheet title + body. Stage a file via the API first so
  // the Commit staged button is enabled, then open the sheet.
  const repoCwd = REPO;
  await fetch(`${ORIGIN}/api/git-ui/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: repoCwd, paths: ["readme.md"] }),
  }).catch(() => null);
  await sleep(300);
  await tap('.mobile-nav button[data-screen="git"]');
  await sleep(900);
  const commitOpen = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Commit staged/.test(x.textContent)); if (!b) return false; if (b.disabled) return "disabled"; b.click(); return true; })()`);
  if (commitOpen === true) {
    await sleep(400);
    await check("git commit title", "#mobileCommitTitle", `document.getElementById('mobileCommitTitle')`);
    await check("git commit body", "#mobileCommitBody", `document.getElementById('mobileCommitBody')`);
    await evalJs(`HerdrMobile.closeCommitSheet()`);
  } else {
    failures.push(`git commit sheet did not open (${commitOpen})`);
    console.log(`FAIL git commit sheet: ${commitOpen}`);
  }

  // 5. Worktrees discover + create fields.
  await tap('.mobile-nav button[data-screen="more"]');
  await waitFor(`!!document.querySelector('.mobile-drawer-item')`, "drawer");
  await tapDrawerItem("Worktrees");
  await sleep(600);
  await check("worktrees discover path", "flow input", `document.querySelector('.mobile-worktree-flow .mobile-settings-group input')`);
  const createOpen = await evalJs(`(() => { const d = document.querySelector('.mobile-worktree-flow details.mobile-disclosure'); if (d) d.open = true; return !!d; })()`);
  if (!createOpen) { failures.push("worktrees create: disclosure with create fields not found"); console.log("FAIL worktrees create: disclosure with create fields not found"); }
  else {
    await sleep(200);
    const createInputs = await evalJs(`(() => { const d = document.querySelector('.mobile-worktree-flow details.mobile-disclosure'); return d ? [...d.querySelectorAll('input')].length : 0; })()`);
    if (createInputs !== 4) { failures.push(`worktrees create: expected 4 create inputs, found ${createInputs}`); console.log(`FAIL worktrees create: expected 4 create inputs, found ${createInputs}`); }
    for (let i = 0; i < createInputs; i++) {
      await check(`worktrees create field #${i + 1}`, `create input ${i + 1}`, `document.querySelectorAll('.mobile-worktree-flow details.mobile-disclosure input')[${i}]`);
    }
  }

  // 6. Sessions name input.
  await tap('.mobile-nav button[data-screen="more"]');
  await waitFor(`!!document.querySelector('.mobile-drawer-item')`, "drawer");
  await tapDrawerItem("Sessions");
  await sleep(600);
  const sessOpen = await evalJs(`(() => { const d = [...document.querySelectorAll('.mobile-section details')].find(x => /Create new session/.test(x.textContent)); if (d) d.open = true; return !!d; })()`);
  if (sessOpen) {
    await sleep(200);
    await check("session name input", "sessions input", `(() => { const d = [...document.querySelectorAll('.mobile-section details')].find(x => /Create new session/.test(x.textContent)); return d ? d.querySelector('input') : null; })()`);
  }

  // 7. Settings filter + directory/font text inputs.
  await tap('.mobile-nav button[data-screen="more"]');
  await waitFor(`!!document.querySelector('.mobile-drawer-item')`, "drawer");
  await tapDrawerItem("Settings");
  await sleep(600);
  await check("settings filter", "filter input", `document.querySelector('.mobile-settings-filter input')`);
  const settingsInputs = await evalJs(`(() => { const groups = [...document.querySelectorAll('.mobile-settings-group')]; const g = groups.find(x => /Workspaces/.test(x.textContent)); if (g) g.open = true; const t = groups.find(x => /Terminal/.test(x.textContent)); if (t) t.open = true; return true; })()`);
  await sleep(200);
  await check("settings worktree dir input", "worktree dir input", `(() => { const g = [...document.querySelectorAll('.mobile-settings-group')].find(x => /Worktree default directory/.test(x.textContent || '')); if (!g) return null; const label = [...g.querySelectorAll('label')].find(l => /Worktree default directory/.test(l.textContent || '')); return label ? label.querySelector('input') : null; })()`);
  await check("settings exploration dir input", "exploration dir input", `(() => { const g = [...document.querySelectorAll('.mobile-settings-group')].find(x => /Exploration default directory/.test(x.textContent || '')); if (!g) return null; const label = [...g.querySelectorAll('label')].find(l => /Exploration default directory/.test(l.textContent || '')); return label ? label.querySelector('input') : null; })()`);
  await check("settings terminal font input", "terminal font input", `(() => { const g = [...document.querySelectorAll('.mobile-settings-group')].find(x => /Terminal font/.test(x.textContent || '')); if (!g) return null; const label = [...g.querySelectorAll('label')].find(l => /Terminal font/.test(l.textContent || '')); return label ? label.querySelector('input') : null; })()`);

  // 8. File browser rename sheet: open Files, tap a file row's action (⋯)
  // button, then Rename in the action sheet.
  await tap('.mobile-nav button[data-screen="files"]');
  await sleep(600);
  const actionOpened = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('.herdr-tree-row')];
    const file = rows.find(r => {
      const n = (r.querySelector('.herdr-tree-name')||{}).textContent || "";
      return /readme|\.md|\.txt/.test(n) && r.querySelector('.herdr-tree-row-action');
    });
    if (!file) return "no-file-row";
    file.querySelector('.herdr-tree-row-action').click();
    return true;
  })()`);
  if (actionOpened === true) {
    await sleep(400);
    const renameOpened = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^Rename$/.test((x.textContent||'').trim()) && x.offsetParent); if (!b) return false; b.click(); return true; })()`);
    if (renameOpened) {
      await sleep(400);
      await check("file rename sheet input", "#mobileFileRenameInput", `document.getElementById('mobileFileRenameInput')`);
      await evalJs(`HerdrMobile.filesCancelRename && HerdrMobile.filesCancelRename()`);
    } else { failures.push("file rename sheet did not open"); console.log("FAIL file rename sheet: no Rename button"); }
  } else {
    failures.push(`file action sheet did not open (${actionOpened})`);
    console.log(`FAIL file action sheet: ${actionOpened}`);
  }

  // 9. Workspace rename sheet from Home rows.
  await tap('.mobile-nav button[data-screen="home"]');
  await sleep(500);
  const wsRename = await evalJs(`(() => { const b = document.querySelector('.mobile-workspace-row button[aria-label*="Rename"], .mobile-workspace-row .mobile-icon-btn'); if (b) { b.click(); return true; } return false; })()`);
  if (wsRename) {
    await sleep(400);
    await check("workspace rename input", "#mobileRenameInput", `document.getElementById('mobileRenameInput')`);
    await evalJs(`HerdrMobile.cancelRenameWorkspace && HerdrMobile.cancelRenameWorkspace()`);
  } else console.log("SKIP workspace rename: button not found by that selector");

  // EXHAUSTIVE SWEEP: visit every drawer screen and enumerate EVERY
  // text-like input/textarea in the live DOM, not just the hardcoded list
  // above. Number inputs get the numeric keypad (no word suggestions) but
  // the claim "every text input" must be proven by enumeration, and some
  // devices spawn text keyboards for number inputs too.
  const sweepScreens = [
    ["terminal", null],
    ["home", null],
    ["agents", 1], ["panels", 2], ["worktrees", 3], ["files", 4],
    ["git", 5], ["sessions", 6], ["settings", 7],
  ];
  const reg = new Map(); // key -> screens seen on
  for (const [name, drawerIndex] of sweepScreens) {
    let tapped = false;
    if (drawerIndex === null) {
      tapped = await evalJs(`(() => { const el = document.querySelector('.mobile-nav button[data-screen="${name}"]'); if (!el) return false; el.click(); return true; })()`);
    } else {
      await evalJs(`(() => { const el = document.querySelector('.mobile-nav button[data-screen="more"]'); if (!el) return false; el.click(); return true; })()`);
      await waitFor(`!!document.querySelector('.mobile-drawer-item')`, `drawer for ${name}`);
      tapped = await evalJs(`(() => { const items = document.querySelectorAll('.mobile-drawer-item'); const el = items[${drawerIndex - 1}]; if (!el) return false; el.click(); return true; })()`);
    }
    if (!tapped) { console.log(`SWEEP SKIP ${name}: nav not found`); continue; }
    await sleep(500);
    // Open all <details> disclosures on this screen so nested inputs render.
    await evalJs(`(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); return true; })()`);
    await sleep(300);
    const found = await evalJs(`(() => {
      const root = document.querySelector('.mobile-app') || document;
      const els = [...root.querySelectorAll('input, textarea')].filter(el => {
        if (el.type === "checkbox" || el.type === "radio" || el.type === "range" || el.type === "button" || el.type === "submit") return false;
        if (el.type === "password") return false;
        const cls = el.className || "";
        if (cls.includes("mobile-hidden-input")) return false;
        return true;
      });
      return els.map(el => {
        const key = el.id || el.name || ((el.getAttribute('placeholder') || '') + '|' + el.type);
        const outer = el.outerHTML.slice(0, el.outerHTML.indexOf('>') + 1);
        return { key, tag: el.tagName.toLowerCase(), type: el.type, outer, guards: {
          autocomplete: el.getAttribute('autocomplete'),
          autocorrect: el.getAttribute('autocorrect'),
          autocapitalize: el.getAttribute('autocapitalize'),
          spellcheck: el.getAttribute('spellcheck'),
          writingsuggestions: el.getAttribute('writingsuggestions'),
          translate: el.getAttribute('translate'),
        }, enterkeyhint: el.getAttribute('enterkeyhint') };
      });
    })()`);
    let screenCount = 0;
    for (const item of found || []) {
      screenCount++;
      const g = item.guards;
      const missing = [];
      if (g.autocomplete !== "off") missing.push("autocomplete");
      if (g.autocorrect !== "off") missing.push("autocorrect");
      if (g.autocapitalize !== "none") missing.push("autocapitalize");
      if (g.spellcheck !== "false") missing.push("spellcheck");
      if (g.writingsuggestions !== "false") missing.push("writingsuggestions");
      if (g.translate !== "no") missing.push("translate");
      if (item.enterkeyhint && !VALID_HINTS.has(item.enterkeyhint)) missing.push(`enterkeyhint=${item.enterkeyhint} (invalid value)`);
      if (missing.length) {
        failures.push(`SWEEP ${name}/${item.key} (${item.tag} type=${item.type}): missing ${missing.join(",")}`);
        console.log(`FAIL SWEEP ${name}/${item.key} (${item.tag} type=${item.type}): missing ${missing.join(",")}`);
      } else {
        // Duplicate-attribute check: the HTML parser keeps the FIRST value of a
        // duplicated attribute, so a stray hardcoded guard before ${inputAttrs}
        // would silently override it. Parse the tag open and flag any repeated
        // attribute name.
        const attrNames = [...item.outer.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
        const dupes = attrNames.filter((a, i) => attrNames.indexOf(a) !== i);
        if (dupes.length) {
          failures.push(`SWEEP ${name}/${item.key}: duplicate attributes ${[...new Set(dupes)].join(",")}`);
          console.log(`FAIL SWEEP ${name}/${item.key}: duplicate attributes ${[...new Set(dupes)].join(",")}`);
        } else {
          reg.set(item.key, (reg.get(item.key) || []).concat(name));
        }
      }
    }
    console.log(`SWEEP ${name}: ${screenCount} input(s) enumerated, ${reg.size} unique keys so far`);
  }
  console.log(`SWEEP REGISTRY: ${[...reg.keys()].sort().join(", ")}`);

  // New-file sheet: the sweep can't open it automatically (needs a
  // context), but the "+ File" button in the Files header opens it directly.
  {
    await evalJs(`(() => { const el = document.querySelector('.mobile-nav button[data-screen="more"]'); if (el) el.click(); return true; })()`);
    await waitFor(`!!document.querySelector('.mobile-drawer-item')`, "drawer for files");
    await evalJs(`(() => { const items = document.querySelectorAll('.mobile-drawer-item'); if (items[3]) items[3].click(); return true; })()`);
    await sleep(600);
    const opened = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\+ File$/.test((x.textContent||'').trim())); if (!b) return false; b.click(); return true; })()`);
    if (opened) {
      await sleep(400);
      await check("file new-file sheet input", "#mobileFileNewInput", `document.getElementById('mobileFileNewInput')`);
      await evalJs(`HerdrMobile.filesCancelNewFile()`);
    } else console.log("SKIP file new-file sheet: + File button not found");
  }

  console.log("");
  if (failures.length) {
    console.log(`AUDIT FAILED (${failures.length}):`);
    failures.forEach((f) => console.log(` - ${f}`));
    process.exit(1);
  }
  console.log("AUDIT PASSED: every live text input carries the full keyboard guard set");
  process.exit(0);
}

main().catch((e) => { console.error("AUDIT ERROR:", e.message); process.exit(1); });