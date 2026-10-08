// Live-browser acceptance of theme propagation to already-open terminals.
//
// The node --test suites verify the module contracts against stubs, but the
// user-visible bug was wiring: open renderer surfaces keeping stale colors
// after a theme switch. This driver runs against the isolated e2e instance
// (own XDG_CONFIG_HOME/session) with a real headless Chrome and a real wterm
// renderer, and asserts the served app end to end:
//   1. auto mode: flipping prefers-color-scheme (Emulation.setEmulatedMedia)
//      repaints the main terminal (wterm inline --term-bg/--term-fg change,
//      the setThemeColors delegation signal) and the body chrome.
//   2. manual toggle clicks (the real button) cycle auto->dark->light and
//      every surface follows, including an open temporary terminal.
//   3. the temporary terminal (Ctrl+B, Shift+M through real key events)
//      follows both system and manual switches.
//
// Driven by scripts/e2e/run-theme-propagation-e2e.sh (see that file for the
// environment overrides).

const ORIGIN = process.env.E2E_ORIGIN || "http://127.0.0.1:8899";
const CDP_PORT = process.env.CDP_PORT || "9225";

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
function record(name, pass, detail) {
  results.push({ name, pass, detail: String(detail || "") });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

const DARK_BG = "#11111b";
const LIGHT_BG = "#eff1f5";

async function main() {
  const targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`);
  // The runner starts Chrome at about:blank; the first page target is the
  // tab to drive (the navigate below loads the app into it).
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target; open the app first (run-theme-propagation-e2e.sh does it)");
  const cdp = await attach(page.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  await sleep(2500);

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "").slice(0, 300)}`);
    return r.result.value;
  };

  // Bootstraps: ensure a workspace exists, open its terminal pane, and wait
  // for the real wterm renderer to paint rows.
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
      if (link) { link.click(); resolve("clicked"); return; }
      if (n >= 40) { resolve("no workspace item"); return; }
      n += 1;
      setTimeout(tries, 250);
    };
    tries();
  })`);
  if (opened !== "clicked") throw new Error("could not open a workspace");

  const rowsReady = await evalExpr(`new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const host = document.getElementById("terminal");
      const rows = host ? host.querySelectorAll(".term-row").length : 0;
      if (rows > 0) resolve({ rows, waited: Date.now() - t0 });
      else if (Date.now() - t0 > 20000) resolve({ rows: 0, waited: Date.now() - t0 });
      else setTimeout(check, 250);
    };
    check();
  })`);
  record("main terminal rendered rows", rowsReady.rows > 0, `rows=${rowsReady.rows} waited=${rowsReady.waited}ms`);
  if (!rowsReady.rows) throw new Error("main terminal never painted");

  const mainVars = () => `(() => {
    const host = document.getElementById("terminal");
    return {
      bg: host.style.getPropertyValue("--term-bg"),
      fg: host.style.getPropertyValue("--term-fg"),
      selection: host.style.getPropertyValue("--term-selection-bg"),
      bodyLight: document.body.classList.contains("light"),
    };
  })()`;

  // 1. Auto mode + system flip: the core propagation path the user reported.
  // themeMode -> auto through the real settings select, then flip the emulated
  // OS scheme. The effective theme must follow and the wterm renderer must
  // repaint (setThemeColors writes inline --term-bg/--term-fg).
  // CDP feature name is kebab-case (camelCase is silently ignored).
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(300);
  await evalExpr(`(() => {
    const select = document.getElementById("optTheme");
    select.value = "auto";
    select.dispatchEvent(new Event("change"));
    return true;
  })()`);
  await sleep(400);
  let before = await evalExpr(mainVars());
  record("auto mode follows system dark", before.bodyLight === false && before.bg === DARK_BG,
    `bodyLight=${before.bodyLight} bg=${before.bg}`);

  // Flip to light through the OS (no UI interaction): propagation must repaint.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(500);
  let after = await evalExpr(mainVars());
  record("system flip repaints open terminal (dark->light)", after.bodyLight === true && after.bg === LIGHT_BG,
    `bodyLight=${after.bodyLight} bg=${after.bg} (was ${before.bg})`);

  // And back to dark: the reverse direction.
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  after = await evalExpr(mainVars());
  record("system flip repaints open terminal (light->dark)", after.bodyLight === false && after.bg === DARK_BG,
    `bodyLight=${after.bodyLight} bg=${after.bg}`);

  // 2. Manual toggle: the real button cycles auto->dark->light->auto. Current
  // state: mode=auto with system dark. One click -> dark (bg must stay dark,
  // now pinned instead of following the system).
  await evalExpr(`document.getElementById("themeToggle").click()`);
  await sleep(400);
  let mode = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
  after = await evalExpr(mainVars());
  record("manual toggle pins dark", mode === "dark" && after.bodyLight === false && after.bg === DARK_BG,
    `mode=${mode} bg=${after.bg}`);

  // Second click -> light: the surface must repaint light while the system
  // is still dark (manual overrides the OS).
  await evalExpr(`document.getElementById("themeToggle").click()`);
  await sleep(400);
  mode = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
  after = await evalExpr(mainVars());
  record("manual toggle to light propagates", mode === "light" && after.bodyLight === true && after.bg === LIGHT_BG,
    `mode=${mode} bg=${after.bg}`);

  // 3. Temporary terminal: open through the real keyboard path (prefix then
  // Shift+M), wait for its renderer, and assert it follows the next switch.
  const tempOpen = await evalExpr(`new Promise((resolve) => {
    const done = (msg) => resolve(msg);
    const fire = (opts) => {
      const ev = new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, opts));
      document.dispatchEvent(ev);
      return ev;
    };
    fire({ code: "KeyB", key: "b", ctrlKey: true });
    setTimeout(() => {
      fire({ code: "KeyM", key: "M", shiftKey: true });
      let n = 0;
      const check = () => {
        const modal = document.querySelector(".temp-terminal-backdrop");
        if (modal) { done("opened"); return; }
        if (n >= 60) { done("no modal"); return; }
        n += 1;
        setTimeout(check, 250);
      };
      check();
    }, 150);
  })`);
  record("temporary terminal opened via shortcut", tempOpen === "opened", `got ${tempOpen}`);
  if (tempOpen !== "opened") throw new Error("temp terminal did not open");

  const tempRows = await evalExpr(`new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const modal = document.querySelector(".temp-terminal-backdrop");
      const host = modal && modal.querySelector(".terminal");
      const rows = host ? host.querySelectorAll(".term-row").length : 0;
      if (rows > 0) resolve({ rows, waited: Date.now() - t0 });
      else if (Date.now() - t0 > 20000) resolve({ rows: 0, waited: Date.now() - t0 });
      else setTimeout(check, 250);
    };
    check();
  })`);
  record("temporary terminal rendered rows", tempRows.rows > 0, `rows=${tempRows.rows} waited=${tempRows.waited}ms`);
  if (!tempRows.rows) throw new Error("temp terminal renderer never painted");

  const tempVars = () => `(() => {
    const modal = document.querySelector(".temp-terminal-backdrop");
    const host = modal && modal.querySelector(".terminal");
    return {
      bg: host ? host.style.getPropertyValue("--term-bg") : null,
      fg: host ? host.style.getPropertyValue("--term-fg") : null,
    };
  })()`;

  before = await evalExpr(tempVars());
  record("temp terminal opens on the current (light) theme", before.bg === LIGHT_BG,
    `bg=${before.bg}`);

  // Manual switch while the temp terminal is open: fan-out must repaint it.
  // Current: manual light. One click -> auto; system is dark, so dark wins.
  await evalExpr(`document.getElementById("themeToggle").click()`);
  await sleep(400);
  after = await evalExpr(tempVars());
  record("manual switch repaints open temp terminal", after.bg === DARK_BG,
    `bg ${before.bg} -> ${after.bg}`);
  const mainAfterTemp = await evalExpr(mainVars());
  record("manual switch repaints main terminal too", mainAfterTemp.bg === DARK_BG,
    `bg=${mainAfterTemp.bg}`);

  // System flip while the temp terminal is open. The last click landed the
  // mode on auto (light -> auto) with the system dark; flip the OS to light
  // and both surfaces must follow.
  const modeBeforeFlip = await evalExpr(`document.getElementById("themeToggle").dataset.themeMode`);
  if (modeBeforeFlip !== "auto") throw new Error(`expected auto mode before system flip, got ${modeBeforeFlip}`);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await sleep(500);
  after = await evalExpr(tempVars());
  record("system flip repaints open temp terminal (auto mode)",
    modeBeforeFlip === "auto" && after.bg === LIGHT_BG,
    `mode=${modeBeforeFlip} bg=${after.bg}`);

  // 4. Minimized temp session keeps following: minimize, flip, restore, the
  // restored surface shows the new theme.
  await evalExpr(`(document.querySelector(".temp-terminal-backdrop .temp-terminal-minimize") || {}).click?.()`);
  await sleep(400);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await sleep(500);
  const restored = await evalExpr(`new Promise((resolve) => {
    const bar = document.querySelector(".temp-terminal-restore-bar");
    const btn = bar && bar.querySelector(".temp-terminal-restore");
    if (!btn) { resolve("no restore bar"); return; }
    btn.click();
    const t0 = Date.now();
    const check = () => {
      const modal = document.querySelector(".temp-terminal-backdrop");
      const host = modal && modal.querySelector(".terminal");
      if (modal && host && host.querySelectorAll(".term-row").length > 0) {
        resolve({ bg: host.style.getPropertyValue("--term-bg") });
        return;
      }
      if (Date.now() - t0 > 5000) { resolve("rows gone"); return; }
      setTimeout(check, 200);
    };
    check();
  })`);
  record("restored minimized temp terminal shows current theme",
    restored && restored.bg === DARK_BG, `bg=${restored && restored.bg}`);

  // Teardown: close the temp terminal through its close confirmation flow.
  await evalExpr(`(document.querySelector(".temp-terminal-backdrop .temp-terminal-close") || {}).click?.()`);
  await sleep(400);
  await evalExpr(`(() => {
    const confirm = document.querySelector(".temp-terminal-confirm .btn-danger, .temp-terminal-confirm button");
    if (confirm) confirm.click();
    return !!confirm;
  })()`);

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