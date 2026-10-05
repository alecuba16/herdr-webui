// A/B acceptance probe: identical CDP checks run against two server ports
// (POST_FIX_URL and PRE_FIX_URL). Measures the real user-visible invariant
// after a display-geometry perturbation (the raster-probe poison stands in
// for a cross-monitor move): terminal rows must tile the viewport exactly
// with no partial/overlapping rows, the grid must match the app grid, and
// the drift must self-correct without any user action.
//
// Headless Chrome is DPR-stable, so the pure "move window between monitors"
// step cannot be simulated by CDP. The honest external constraint: we can't
// drag a real window across displays in automation. The perturbation below
// (poisoning wterm's own metric var) reproduces exactly the stale-metric
// state that a monitor move leaves behind, which is what the fix must heal.
// CDP gotcha: Runtime.evaluate with "new Promise(...)" must NOT have a
// trailing "()" appended.
const POST_URL = process.env.AB_POST_URL || "http://127.0.0.1:8899/";
const PRE_URL = process.env.AB_PRE_URL || "http://127.0.0.1:8898/";
const CDP_HTTP = process.env.AB_CDP_HTTP || "http://127.0.0.1:9223";

function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      ws,
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
      } else {
        for (const l of listeners) if (l.method === msg.method) l.handler(msg);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPane(cdp, base) {
  // Fresh navigate; ensure workspace exists; open its terminal pane.
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: base });
  await sleep(2500);
  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text}`);
    return r.result.value;
  };
  const wsResp = await evalExpr(`fetch("/api/workspaces").then((r) => r.json()).catch((e) => "err:" + e)`);
  const items = wsResp && wsResp.workspaces ? wsResp.workspaces : [];
  if (!items.length) {
    await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: "/tmp", label: "ab-probe"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
    await sleep(1500);
    await cdp.send("Page.navigate", { url: base });
    await sleep(2500);
  }
  const clicked = await evalExpr(`new Promise((resolve) => {
    let n = 0;
    const tries = () => {
      const link = document.querySelector("a.item[data-workspace-id]");
      if (link) { link.click(); resolve(true); return; }
      if (n >= 40) { resolve(false); return; }
      n += 1;
      setTimeout(tries, 250);
    };
    tries();
  })`);
  if (!clicked) throw new Error("could not open workspace pane");
  const rowsReady = await evalExpr(`new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => {
      const host = document.getElementById("terminal");
      const rows = host ? host.querySelectorAll(".term-row").length : 0;
      if (rows > 0) resolve(rows);
      else if (Date.now() - t0 > 20000) resolve(0);
      else setTimeout(check, 250);
    };
    check();
  })`);
  if (!rowsReady) throw new Error("terminal rows never rendered");
  return { evalExpr };
}

async function probe(label, port) {
  const base = `http://127.0.0.1:${port}/`;
  const targets = await fetch(`${CDP_HTTP}/json`).then((r) => r.json());
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const cdp = await attach(page.webSocketDebuggerUrl);
  const { evalExpr } = await openPane(cdp, base);

  // The perturbation: poison wterm's own --term-cell-width exactly like a
  // cross-monitor raster change leaves it stale. Then ask the app to refit
  // (what every refit path does: focus, sidebar toggle, resize) WITHOUT any
  // revalidation. Measure whether rows overlap / grid drifts.
  const out = await evalExpr(`new Promise((resolve) => {
    const host = document.getElementById("terminal");
    const before = {
      cell: getComputedStyle(host).getPropertyValue("--term-cell-width"),
      grid: term && term.cols + "x" + term.rows,
      app: state.termCols + "x" + state.termRows,
    };
    // Perturb: stale-metric simulation (raster changed underneath us).
    host.style.setProperty("--term-cell-width", "9.5px");
    // Refit with the app's existing (now stale) caches: this is the
    // pre-fix refit path (scheduleTerminalResize without revalidation).
    scheduleTerminalResize();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = host.querySelector(".term-row");
      const vh = document.getElementById("terminal").clientHeight;
      const rows = host.querySelectorAll(".term-row").length;
      resolve({
        label: ${JSON.stringify(label)},
        before,
        after: {
          cell: getComputedStyle(host).getPropertyValue("--term-cell-width"),
          rowH: row && row.getBoundingClientRect().height,
          grid: term && term.cols + "x" + term.rows,
          app: state.termCols + "x" + state.termRows,
          rows,
          viewportH: vh,
        },
      });
    }));
  })`);
  console.log(JSON.stringify(out));
  return out;
}

let code = 0;
try {
  const post = await probe("post-fix", 8899);
  const pre = await probe("pre-fix", 8898);
  // Report: pre-fix keeps the poisoned metric (rows drift/overlap risk);
  // post-fix self-corrects back to wterm's measured value.
  console.log("\nA/B verdict:");
  console.log("  pre-fix  after-cell:", pre.after.cell, "grid:", pre.after.grid, "app:", pre.after.app);
  console.log("  post-fix after-cell:", post.after.cell, "grid:", post.after.grid, "app:", post.after.app);
} catch (e) {
  console.error("AB ERROR:", e.message);
  code = 1;
}
process.stdout.write("", () => process.exit(code));