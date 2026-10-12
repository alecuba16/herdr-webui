// Live-browser acceptance of theme propagation to already-open terminals.
//
// The node --test suites verify the module contracts against stubs, but the
// user-visible bug was wiring: open renderer surfaces keeping stale colors
// after a theme switch. This driver runs against the isolated e2e instance
// (own XDG_CONFIG_HOME/session) with a real headless Chrome and a real wterm
// renderer, and asserts the served app end to end, in BOTH layouts:
//   1. auto mode: flipping prefers-color-scheme (Emulation.setEmulatedMedia)
//      repaints the main terminal (wterm inline --term-bg/--term-fg change,
//      the setThemeColors delegation signal) and the body chrome.
//   2. manual theme changes (the real controls) cycle auto->dark->light and
//      every surface follows, including an open temporary terminal.
//   3. the temporary terminal (desktop: Ctrl+B, Shift+M key events; mobile:
//      the shared action registry through the search sheet) follows both
//      system and manual switches.
//
// Driven by scripts/e2e/run-theme-propagation-e2e.sh (see that file for the
// environment overrides). Pass --layout=mobile to run only the mobile pass;
// default runs desktop then mobile.

const ORIGIN = process.env.E2E_ORIGIN || "http://127.0.0.1:8899";
const CDP_PORT = process.env.CDP_PORT || "9225";
const LAYOUT = process.argv.includes("--layout=mobile") ? "mobile" : "all";

if (!process.env.E2E_ORIGIN) {
  console.error("E2E_ORIGIN must be set (use scripts/e2e/run-theme-propagation-e2e.sh)");
  process.exit(2);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res2, rej2) => {
          const msgId = ++id;
          pending.set(msgId, { res2, rej2 });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej2(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || "")}`));
        else res2(msg.result);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(layout, name, pass, detail) {
  const fullName = `[${layout}] ${name}`;
  results.push({ name: fullName, pass, detail: String(detail || "") });
  console.log(`${pass ? "PASS" : "FAIL"} ${fullName}${detail ? ` :: ${detail}` : ""}`);
}

const DARK_BG = "#11111b";
const LIGHT_BG = "#eff1f5";

const setScheme = (cdp, value) =>
  // CDP feature name is kebab-case; the camelCase spelling is silently
  // ignored, which looks exactly like a propagation bug.
  cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });

// Shared page plumbing: the main terminal host is #terminal in both layouts
// and the aux pane terminal container is .pane-terminal-aux .terminal.
const mainVarsExpr = `(() => {
  const host = document.getElementById("terminal");
  return {
    bg: host.style.getPropertyValue("--term-bg"),
    fg: host.style.getPropertyValue("--term-fg"),
    selection: host.style.getPropertyValue("--term-selection-bg"),
    bodyLight: document.body.classList.contains("light"),
  };
})()`;

const auxVarsExpr = `(() => {
  // The split-pane aux terminal replaced the old temp-terminal modal.
  // The pane fan-out promise lives on these surfaces now. The aux
  // container IS the wterm host (class pane-terminal-aux wterm). Rows
  // sit directly inside it, no nested .terminal wrapper.
  const host = document.querySelector(".pane-terminal-aux");
  return {
    bg: host ? host.style.getPropertyValue("--term-bg") : null,
    fg: host ? host.style.getPropertyValue("--term-fg") : null,
  };
})()`;

const rowsPromise = (hostSelector, scopeExpr) => `new Promise((resolve) => {
  const t0 = Date.now();
  const check = () => {
    const host = ${scopeExpr || `document.querySelector("${hostSelector}")`};
    const rows = host ? host.querySelectorAll(".term-row").length : 0;
    if (rows > 0) resolve({ rows, waited: Date.now() - t0 });
    else if (Date.now() - t0 > 20000) resolve({ rows: 0, waited: Date.now() - t0 });
    else setTimeout(check, 250);
  };
  check();
})`;

async function runPass(layout, cdp) {
  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "").slice(0, 300)}`);
    return r.result.value;
  };

  // Fresh load with the layout preference pinned (auto layout would follow
  // the viewport; the runner's desktop-size window is desktop anyway, but
  // pinning keeps the mobile pass deterministic in a wide window).
  // localStorage is blocked on about:blank, so navigate first, pin, reload.
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);
  await evalExpr(`localStorage.setItem("herdr-web-layout", ${JSON.stringify(layout)})`);
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);

  const layoutAttr = await evalExpr(`document.documentElement.dataset.herdrLayout`);
  record(layout, `${layout} layout loaded`, layoutAttr === layout, `data-herdr-layout=${layoutAttr}`);
  if (layoutAttr !== layout) throw new Error(`expected ${layout} layout, got ${layoutAttr}`);

  // Bootstraps: ensure a workspace exists and open it.
  const ensureWorkspace = `fetch("/api/workspaces").then((r) => r.json()).catch((e) => "err:" + e)`;
  let wsResp = await evalExpr(ensureWorkspace);
  let items = wsResp && wsResp.workspaces ? wsResp.workspaces : [];
  if (!items.length) {
    await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: "/tmp", label: "e2e-theme"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
    await sleep(1500);
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(2500);
    wsResp = await evalExpr(ensureWorkspace);
    items = wsResp && wsResp.workspaces ? wsResp.workspaces : [];
  }
  const opened = await evalExpr(`new Promise((resolve) => {
    let n = 0;
    const tries = () => {
      const link = document.querySelector("a.item[data-workspace-id]");
      const mobileRow = document.querySelector(".mobile-workspace-row .mobile-row");
      const target = ${JSON.stringify(layout)} === "mobile" ? mobileRow : link;
      if (target) { target.click(); resolve("clicked"); return; }
      if (n >= 40) { resolve("no workspace item"); return; }
      n += 1;
      setTimeout(tries, 250);
    };
    tries();
  })`);
  if (opened !== "clicked") throw new Error("could not open a workspace");

  const rowsReady = await evalExpr(rowsPromise(null, `document.getElementById("terminal")`));
  record(layout, "main terminal rendered rows", rowsReady.rows > 0, `rows=${rowsReady.rows} waited=${rowsReady.waited}ms`);
  if (!rowsReady.rows) throw new Error("main terminal never painted");

  // The real control that switches the theme mode. The desktop layout uses
  // the header toggle (cycle) and the settings select; mobile uses the
  // action registry (search sheet "Toggle theme") and the settings select.
  const setMode = async (mode) => {
    if (layout === "desktop") {
      await evalExpr(`(() => {
        const select = document.getElementById("optTheme");
        select.value = ${JSON.stringify(mode)};
        select.dispatchEvent(new Event("change"));
        return true;
      })()`);
    } else {
      await evalExpr(`HerdrMobile.setThemeMode(${JSON.stringify(mode)})`);
    }
  };

  // 1. Auto mode + system flip: the core propagation path the user reported.
  await setScheme(cdp, "dark");
  await sleep(300);
  await setMode("auto");
  await sleep(400);
  let before = await evalExpr(mainVarsExpr);
  record(layout, "auto mode follows system dark", before.bodyLight === false && before.bg === DARK_BG,
    `bodyLight=${before.bodyLight} bg=${before.bg}`);

  await setScheme(cdp, "light");
  await sleep(500);
  let after = await evalExpr(mainVarsExpr);
  record(layout, "system flip repaints open terminal (dark->light)",
    after.bodyLight === true && after.bg === LIGHT_BG,
    `bodyLight=${after.bodyLight} bg=${after.bg} (was ${before.bg})`);

  await setScheme(cdp, "dark");
  await sleep(500);
  after = await evalExpr(mainVarsExpr);
  record(layout, "system flip repaints open terminal (light->dark)",
    after.bodyLight === false && after.bg === DARK_BG,
    `bodyLight=${after.bodyLight} bg=${after.bg}`);

  // 2. Manual pin dark, then light: manual mode overrides the system (OS
  // stays dark throughout).
  await setMode("dark");
  await sleep(400);
  after = await evalExpr(mainVarsExpr);
  record(layout, "manual dark propagates (OS still dark)",
    after.bodyLight === false && after.bg === DARK_BG, `bg=${after.bg}`);

  await setMode("light");
  await sleep(400);
  after = await evalExpr(mainVarsExpr);
  record(layout, "manual light overrides system dark",
    after.bodyLight === true && after.bg === LIGHT_BG, `bg=${after.bg}`);

  // 2b. Desktop-only: the real header toggle button cycles
  // auto->dark->light->auto and every click propagates. Mobile has no
  // header toggle (its cycle control is the search-sheet action row,
  // covered by the setMode path plus the action-registry open below).
  if (layout === "desktop") {
    // Known starting point: mode auto, system dark.
    await setMode("auto");
    await sleep(300);
    await evalExpr(`document.getElementById("themeToggle").click()`);
    await sleep(400);
    let toggleMode = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
    after = await evalExpr(mainVarsExpr);
    record(layout, "header toggle cycles to dark", toggleMode === "dark" && after.bg === DARK_BG,
      `mode=${toggleMode} bg=${after.bg}`);

    await evalExpr(`document.getElementById("themeToggle").click()`);
    await sleep(400);
    toggleMode = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
    after = await evalExpr(mainVarsExpr);
    record(layout, "header toggle cycles to light", toggleMode === "light" && after.bg === LIGHT_BG,
      `mode=${toggleMode} bg=${after.bg}`);

    // Third click returns to auto; system is dark so dark wins again.
    await evalExpr(`document.getElementById("themeToggle").click()`);
    await sleep(400);
    toggleMode = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
    after = await evalExpr(mainVarsExpr);
    record(layout, "header toggle cycles back to auto (system dark)",
      toggleMode === "auto" && after.bg === DARK_BG,
      `mode=${toggleMode} bg=${after.bg}`);
  }

  // 2c. Mobile-only: the real search-sheet "Toggle theme" action row cycles
  // the mode through the shared action registry (the control a phone user
  // actually presses).
  if (layout === "mobile") {
    await setMode("auto");
    await sleep(300);
    const cycle = await evalExpr(`new Promise((resolve) => {
      const navBtn = document.querySelector('nav.mobile-nav button[data-screen="search"]');
      if (!navBtn) { resolve("no search nav button"); return; }
      navBtn.click();
      const t0 = Date.now();
      const findRow = () => {
        const rows = Array.from(document.querySelectorAll(".mobile-row"));
        const row = rows.find((r) => r.textContent.indexOf("Toggle theme") !== -1);
        if (!row) {
          if (Date.now() - t0 > 8000) { resolve("no toggle-theme row"); return; }
          setTimeout(findRow, 300);
          return;
        }
        row.click();
        resolve("clicked");
      };
      findRow();
    })`);
    await sleep(500);
    const modeNow = await evalExpr(`localStorage.getItem("herdr-web-theme") || "auto"`);
    after = await evalExpr(mainVarsExpr);
    record(layout, "toggle-theme action row cycles to dark",
      cycle === "clicked" && modeNow === "dark" && after.bg === DARK_BG,
      `cycle=${cycle} mode=${modeNow} bg=${after.bg}`);
  }

  // Restore the shared manual-light state for the aux pane pass below
  // (it opens on light and asserts a dark flip).
  await setMode("light");
  await sleep(400);
  after = await evalExpr(mainVarsExpr);
  if (after.bg !== LIGHT_BG) throw new Error(`expected light theme before aux pane pass, bg=${after.bg}`);

  // 3-6b. Aux pane terminal through the real user path. The split-pane
  // rework (b3db27a) replaced the temp-terminal modal with pane terminals,
  // so the fan-out parity promise now lives on the aux pane surface.
  // Mobile has no pane split: it loads no desktop scripts at all, so the
  // structural check below pins that single-surface fact instead.
  if (layout === "desktop") {
    // Real user path: Ctrl+B prefix then D splits right (the fresh leaf
    // starts empty and takes focus). Its strip + button then creates the
    // terminal tab routed into that leaf (newTabForPane sets the pending
    // placement), which mounts the aux terminal surface. Reused by the
    // strip-close round in 6b.
    const openAuxPane = () => evalExpr(`new Promise((resolve) => {
      const fire = (opts) => {
        const ev = new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, opts));
        document.dispatchEvent(ev);
      };
      fire({ code: "KeyB", key: "b", ctrlKey: true });
      setTimeout(() => {
        fire({ code: "KeyD", key: "d" });
        let n = 0;
        const check = () => {
          const panes = Array.from(document.querySelectorAll(".workspace-pane[data-pane-id]"));
          if (panes.length >= 2) {
            // The focused fresh pane is the split's new sibling: find the
            // pane whose strip has no terminal tab buttons.
            const fresh = panes.find((p) => !p.querySelector('.pane-tab[data-tab-kind="terminal"]'));
            const plus = fresh && fresh.querySelector('.pane-strip-button[aria-label="New panel"]');
            if (!fresh || !plus) { resolve("no fresh pane +"); return; }
            plus.click();
            const t0 = Date.now();
            const waitAux = () => {
              const aux = document.querySelector(".pane-terminal-aux");
              if (aux) { resolve("split"); return; }
              if (Date.now() - t0 > 15000) { resolve("no aux pane"); return; }
              setTimeout(waitAux, 250);
            };
            waitAux();
            return;
          }
          if (n >= 60) { resolve("no pane split"); return; }
          n += 1;
          setTimeout(check, 250);
        };
        check();
      }, 150);
    })`);
    const splitOk = await openAuxPane();
    record(layout, "aux pane terminal opened (split + new panel)", splitOk === "split", `got ${splitOk}`);
    if (splitOk !== "split") throw new Error(`aux pane did not split (${splitOk})`);

    const auxRows = await evalExpr(rowsPromise(null, `document.querySelector(".pane-terminal-aux")`));
    record(layout, "aux pane terminal rendered rows", auxRows.rows > 0, `rows=${auxRows.rows} waited=${auxRows.waited}ms`);
    if (!auxRows.rows) throw new Error("aux pane renderer never painted");

    before = await evalExpr(auxVarsExpr);
    record(layout, "aux pane terminal opens on the current (light) theme", before.bg === LIGHT_BG,
      `bg=${before.bg}`);

    // 4. Manual switch while the aux pane is open: fan-out must repaint it.
    // Current: manual light, OS dark. Switch to dark: both surfaces repaint.
    await setMode("dark");
    await sleep(400);
    after = await evalExpr(auxVarsExpr);
    record(layout, "manual switch repaints open aux pane terminal", after.bg === DARK_BG,
      `bg ${before.bg} -> ${after.bg}`);
    const mainAfterAux = await evalExpr(mainVarsExpr);
    record(layout, "manual switch repaints main terminal too", mainAfterAux.bg === DARK_BG,
      `bg=${mainAfterAux.bg}`);

    // 5. System flip while the aux pane is open, in auto mode.
    await setMode("auto");
    await sleep(300);
    after = await evalExpr(auxVarsExpr);
    record(layout, "auto mode returns aux pane terminal to system dark", after.bg === DARK_BG,
      `bg=${after.bg}`);
    await setScheme(cdp, "light");
    await sleep(500);
    after = await evalExpr(auxVarsExpr);
    record(layout, "system flip repaints open aux pane terminal (auto mode)", after.bg === LIGHT_BG,
      `bg=${after.bg}`);

    // 6. Close through the pane close shortcut, the real keyboard path.
    // Trusted CDP key events (synthetic KeyboardEvent cannot drive native
    // activation paths). After the + click the route tab lives in the fresh
    // pane and the route sync focuses it, so closePane acts on the fresh
    // pane: its tab migrates to the original pane, the shell follows the
    // route tab, and the aux surface in the original pane must dispose on
    // that ownership change. Ctrl+B prefix, then E.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, windowsVirtualKeyCode: 66, key: "b", code: "KeyB" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 66, key: "b", code: "KeyB" });
    await sleep(120);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 69, key: "e", code: "KeyE" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 69, key: "e", code: "KeyE" });
    const closedByKey = await evalExpr(`new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        const auxGone = !document.querySelector(".pane-terminal-aux");
        const paneCount = document.querySelectorAll(".workspace-pane[data-pane-id]").length;
        if (auxGone && paneCount <= 1) { resolve("closed"); return; }
        if (Date.now() - t0 > 10000) { resolve("stuck:aux=" + (!auxGone) + "/panes=" + paneCount); return; }
        setTimeout(check, 250);
      };
      check();
    })`);
    record(layout, "closePane shortcut disposes the aux surface", closedByKey === "closed", `got ${closedByKey}`);

    // 6b. Strip close round: the pointer path through the pane strip, with
    // the aux surface open again. Both real-user paths must behave the same.
    if (closedByKey === "closed") {
      const reopenOk = await openAuxPane();
      record(layout, "aux pane reopened for the strip close round", reopenOk === "split", `got ${reopenOk}`);
      if (reopenOk !== "split") throw new Error(`aux pane did not reopen (${reopenOk})`);
      await evalExpr(rowsPromise(null, `document.querySelector(".pane-terminal-aux")`));
    }
    const closedAux = await evalExpr(`new Promise((resolve) => {
      const panes = Array.from(document.querySelectorAll(".workspace-pane[data-pane-id]"));
      const aux = document.querySelector(".pane-terminal-aux");
      const owner = aux && panes.find((p) => p.contains(aux));
      if (!owner) { resolve("no owner pane"); return; }
      const btn = owner.querySelector('.pane-strip-button[aria-label="Close pane and move tabs to the other pane"]');
      if (!btn) { resolve("no close button"); return; }
      btn.click();
      setTimeout(() => {
        resolve(document.querySelector(".pane-terminal-aux") ? "still open" : "closed");
      }, 400);
    })`);
    record(layout, "aux pane closed through the strip", closedAux === "closed", `got ${closedAux}`);
  } else {
    // Structural single-surface check: mobile boots no desktop pane code
    // (app_boot.js swaps the script list), so no pane tree and no aux
    // surface can ever mount. If a future change breaks that contract,
    // this fails loudly instead of the theme pass silently skipping the
    // fan-out story.
    const structure = await evalExpr(`(() => ({
      paneNodes: document.querySelectorAll(".workspace-pane").length,
      auxNodes: document.querySelectorAll(".pane-terminal-aux").length,
      paneModule: typeof window.HerdrPaneTerminals,
      splitFn: typeof splitPaneRight,
    }))()`);
    record(layout, "mobile has no pane or aux surface by construction",
      structure.paneNodes === 0 && structure.auxNodes === 0 &&
        structure.paneModule === "undefined" && structure.splitFn === "undefined",
      `panes=${structure.paneNodes} aux=${structure.auxNodes} module=${structure.paneModule} split=${structure.splitFn}`);
  }

  // 7. The dead-var contract live: the selection background must sit on
  // --term-selection-bg (the name wterm.css reads), not --term-selection.
  const selectionVars = await evalExpr(`(() => {
    const host = document.getElementById("terminal");
    return {
      good: host.style.getPropertyValue("--term-selection-bg"),
      dead: host.style.getPropertyValue("--term-selection"),
    };
  })()`);
  record(layout, "selection var written to --term-selection-bg",
    !!selectionVars.good && !selectionVars.dead,
    `good=${selectionVars.good} dead=${selectionVars.dead}`);

  // 8. Computed paint check: the wterm host must actually paint the theme
  // background (inline var alone could lie if the CSS chain broke).
  // Compare the resolved rgb triple against --term-bg so a transparent
  // rgba(0,0,0,0) or a stale background cannot pass.
  const painted = await evalExpr(`(() => {
    const host = document.getElementById("terminal");
    const bg = host.style.getPropertyValue("--term-bg").trim();
    const m = bg.match(/^#([0-9a-f]{6})$/i);
    if (!m) return { match: false, bg, computed: "unparsable:" + bg };
    const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
    const computed = getComputedStyle(host).backgroundColor;
    return { match: computed === \`rgb(\${r}, \${g}, \${b})\`, bg, computed };
  })()`);
  record(layout, "terminal computes the theme background",
    !!painted.match, `--term-bg=${painted.bg} computed=${painted.computed}`);

  // 9. Desktop-only: custom theme colors through the real settings controls.
  // The customizer writes options.themeColors, applyTheme pushes them through
  // the adapter (wtermThemeColors int conversion -> setThemeColors). A custom
  // dark background must land on the open main terminal and survive the
  // customizer reset.
  if (layout === "desktop") {
    await setMode("dark");
    await sleep(300);
    const CUSTOM_BG = "#1a2b3c";
    const custom = await evalExpr(`new Promise((resolve) => {
      // Open the real settings modal the way the footer button does.
      const btn = document.getElementById("footerSettingsButton");
      if (!btn) { resolve("no settings button"); return; }
      btn.click();
      const t0 = Date.now();
      const waitInput = () => {
        const input = document.getElementById("optThemeColor-dark-background");
        if (!input) {
          if (Date.now() - t0 > 8000) { resolve("no customizer input"); return; }
          setTimeout(waitInput, 250);
          return;
        }
        input.value = "${CUSTOM_BG}";
        const apply = document.getElementById("themeColorsApply");
        if (!apply) { resolve("no apply button"); return; }
        apply.click();
        setTimeout(() => resolve("applied"), 600);
      };
      waitInput();
    })`);
    const customVars = await evalExpr(mainVarsExpr);
    record(layout, "custom theme color repaints open terminal",
      custom === "applied" && customVars.bg === CUSTOM_BG,
      `custom=${custom} bg=${customVars.bg}`);

    // Reset restores the defaults on the live surface.
    const reset = await evalExpr(`new Promise((resolve) => {
      const resetBtn = document.getElementById("themeColorsReset");
      if (!resetBtn) { resolve("no reset button"); return; }
      resetBtn.click();
      setTimeout(() => resolve("reset"), 600);
    })`);
    const resetVars = await evalExpr(mainVarsExpr);
    record(layout, "customizer reset restores default terminal colors",
      reset === "reset" && resetVars.bg === DARK_BG,
      `reset=${reset} bg=${resetVars.bg}`);

    // 9b. Profile apply through the real controls: a preset profile with a
    // distinct background (tokyo dark #1a1b26) must land on the live terminal.
    const profile = await evalExpr(`new Promise((resolve) => {
      const select = document.getElementById("themeColorProfile");
      if (!select) { resolve("no profile select"); return; }
      select.value = "tokyo";
      const apply = document.getElementById("themeColorsApplyProfile");
      if (!apply) { resolve("no apply profile button"); return; }
      apply.click();
      setTimeout(() => resolve("applied"), 600);
    })`);
    const profileVars = await evalExpr(mainVarsExpr);
    record(layout, "profile apply repaints terminal (tokyo dark)",
      profile === "applied" && profileVars.bg === "#1a1b26",
      `profile=${profile} bg=${profileVars.bg}`);

    // 9c. Boot path: the tokyo profile was persisted to localStorage; a full
    // reload must boot the renderer already themed with it (no default-color
    // flash waiting for a later applyTheme call).
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(2500);
    const reopened = await evalExpr(`new Promise((resolve) => {
      let n = 0;
      const tries = () => {
        const link = document.querySelector("a.item[data-workspace-id]");
        if (link) { link.click(); resolve("clicked"); return; }
        if (n >= 40) { resolve("no workspace item"); return; }
        n += 1;
        setTimeout(tries, 250);
      };
      tries();
    })`);
    const bootRows = await evalExpr(rowsPromise(null, `document.getElementById("terminal")`));
    const bootVars = await evalExpr(mainVarsExpr);
    record(layout, "reload boots terminal with persisted profile colors",
      reopened === "clicked" && bootRows.rows > 0 && bootVars.bg === "#1a1b26",
      `open=${reopened} rows=${bootRows.rows} bg=${bootVars.bg}`);

    // 9d. Renderer core switch: settings select -> live reconnect with the
    // other core -> propagation must still work on the re-created adapter.
    // Both cores share the WTerm renderer class in the bundle, but the
    // adapter is recreated by resetTerminalConnection, so the fan-in
    // (applyTheme -> term.setTheme) must bind to the new instance.
    const coreSwitch = await evalExpr(`new Promise((resolve) => {
      const btn = document.getElementById("footerSettingsButton");
      if (btn && document.getElementById("settingsModal").style.display === "none") btn.click();
      const t0 = Date.now();
      const waitSelect = () => {
        const select = document.getElementById("optTerminalCore");
        if (!select) {
          if (Date.now() - t0 > 8000) { resolve("no core select"); return; }
          setTimeout(waitSelect, 250);
          return;
        }
        select.value = "wterm";
        select.dispatchEvent(new Event("change"));
        resolve("switched");
      };
      waitSelect();
    })`);
    // The change handler resets and reconnects the terminal; wait for rows.
    // Light still uses the persisted tokyo profile here (9c reloaded with
    // it), so expect its light background, not the default palette.
    const TOKYO_LIGHT_BG = "#d5d6db";
    const coreRows = await evalExpr(rowsPromise(null, `document.getElementById("terminal")`));
    await setMode("light");
    await sleep(400);
    const coreVars = await evalExpr(mainVarsExpr);
    record(layout, "theme propagates after renderer core switch to wterm",
      coreSwitch === "switched" && coreRows.rows > 0 && coreVars.bg === TOKYO_LIGHT_BG,
      `switch=${coreSwitch} rows=${coreRows.rows} bg=${coreVars.bg}`);

    // Switch back to the default core so later passes and other layouts see
    // the stock configuration.
    await evalExpr(`(() => {
      const select = document.getElementById("optTerminalCore");
      if (!select) return "no select";
      select.value = "ghostty";
      select.dispatchEvent(new Event("change"));
      return "switched";
    })()`);
    await evalExpr(rowsPromise(null, `document.getElementById("terminal")`));

    // Reset back to defaults so the settings modal state is clean for the
    // teardown below (the modal survives the reload in server-rendered HTML,
    // the customizer inputs exist only after the modal is opened).
    await evalExpr(`new Promise((resolve) => {
      const btn = document.getElementById("footerSettingsButton");
      if (!btn) { resolve("no settings button"); return; }
      btn.click();
      const t0 = Date.now();
      const wait = () => {
        const resetBtn = document.getElementById("themeColorsReset");
        if (!resetBtn) {
          if (Date.now() - t0 > 8000) { resolve("no reset button"); return; }
          setTimeout(wait, 250);
          return;
        }
        resetBtn.click();
        setTimeout(() => resolve("reset"), 600);
      };
      wait();
    })`);

    // Close the settings modal for the teardown below.
    await evalExpr(`(() => {
      const modal = document.getElementById("settingsModal");
      if (modal) modal.style.display = "none";
      return true;
    })()`);
  }

  // 10. Mobile-only boot path: the persisted mode must apply to the
  // renderer on a cold load, not only through live switching. The current
  // mode is dark (set by the action-row cycle earlier); reload and reopen a
  // workspace, then the booted terminal must paint dark without any
  // additional switch.
  if (layout === "mobile") {
    await setMode("dark");
    await sleep(400);
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
    await sleep(2500);
    const reopened = await evalExpr(`new Promise((resolve) => {
      let n = 0;
      const tries = () => {
        const mobileRow = document.querySelector(".mobile-workspace-row .mobile-row");
        if (mobileRow) { mobileRow.click(); resolve("clicked"); return; }
        if (n >= 40) { resolve("no workspace item"); return; }
        n += 1;
        setTimeout(tries, 250);
      };
      tries();
    })`);
    const bootRows = await evalExpr(rowsPromise(null, `document.getElementById("terminal")`));
    const bootVars = await evalExpr(mainVarsExpr);
    record(layout, "reload boots mobile terminal with persisted dark mode",
      reopened === "clicked" && bootRows.rows > 0 && bootVars.bg === DARK_BG,
      `open=${reopened} rows=${bootRows.rows} bg=${bootVars.bg}`);
  }

  // Teardown: if a second pane still exists (a failed close above), merge
  // the layout back to one pane so the next layout pass starts clean.
  await evalExpr(`(() => {
    const panes = document.querySelectorAll(".workspace-pane[data-pane-id]");
    if (panes.length < 2) return "single";
    const pid = panes[panes.length - 1].dataset.paneId;
    if (typeof closePaneFor === "function") closePaneFor(encodeURIComponent(pid));
    return "merged";
  })()`);
  await sleep(300);
}

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  // The runner starts Chrome at about:blank; the first page target is the
  // tab to drive (the navigate below loads the app into it).
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target; open the app first (run-theme-propagation-e2e.sh does it)");
  const cdp = await attach(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");

  const passes = LAYOUT === "mobile" ? ["mobile"] : ["desktop", "mobile"];
  for (const layout of passes) {
    await runPass(layout, cdp);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length > 0 ? 1 : 0;
}

let exitCode = 0;
try {
  exitCode = (await main()) || 0;
} catch (e) {
  console.error("E2E ERROR:", e.message);
  results.push({ name: "script", pass: false, detail: e.message });
  exitCode = 1;
}
// The raw WebSocket keeps the event loop alive after main(); flush stdout
// then exit explicitly so the script always terminates.
process.stdout.write("", () => process.exit(exitCode));