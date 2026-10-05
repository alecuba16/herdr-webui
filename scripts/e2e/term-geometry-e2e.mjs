// E2E check of the display-geometry revalidation fix on the isolated
// instance (port 8899, own XDG_CONFIG_HOME/session; headless Chrome on CDP
// port 9223). Verifies in a real browser with a real wterm renderer:
//  1. invalidateTerminalGeometry exists on the page; arming it consumes the
//     flag via the scheduled resize tick (wterm.fit called, caches dropped)
//     and lands on the app-owned grid; a second tick is a true no-op.
//  2. The drift detector reacts to a live --term-cell-width CSS change.
// CDP gotcha: Runtime.evaluate with "new Promise(...)" must NOT have a
// trailing "()" appended.
import { writeFileSync } from "node:fs";

const CDP_HTTP = "http://127.0.0.1:9223";
const APP_URL = "http://127.0.0.1:8899/";
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/term_geometry_e2e_result.json`;

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
    const listeners = [];
    ws.onopen = () => resolve({
      ws,
      send(method, params, sessionId) {
        return new Promise((res2, rej2) => {
          const msgId = ++id;
          pending.set(msgId, { res2, rej2 });
          ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
        });
      },
      on(method, handler) {
        listeners.push({ method, handler });
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
    ws.onerror = (e) => reject(new Error("ws error"));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function main() {
  // Resolve the page target.
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:8899"));
  if (!page) throw new Error("no page target for the app; open it first");
  const cdp = await attach(page.webSocketDebuggerUrl);

  // Always load fresh: the page may hold a bundle from a previous server
  // process, and the checks must run against the current binary's assets.
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  await sleep(1500);

  // 1. The fix is present on the page.
  const hasFix = await evalExpr(`typeof invalidateTerminalGeometry`);
  record("fix present: invalidateTerminalGeometry", hasFix === "function", `got ${hasFix}`);

  // Bootstrap: ensure a workspace exists, open its terminal pane (same
  // flow as the original repro script).
  const wsResp = await evalExpr(`fetch("/api/workspaces").then((r) => r.json()).catch((e) => "err:" + e)`);
  const items = wsResp && wsResp.workspaces ? wsResp.workspaces : [];
  if (!items.length) {
    await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: "/tmp", label: "e2e-geometry"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
    await sleep(1500);
    await cdp.send("Page.navigate", { url: APP_URL });
    await sleep(2500);
  }
  const clicked = await evalExpr(`new Promise((resolve) => {
    let n = 0;
    const tries = () => {
      const link = document.querySelector("a.item[data-workspace-id]");
      if (link) { link.click(); resolve("clicked " + link.getAttribute("data-workspace-id")); return; }
      if (n >= 40) { resolve("no workspace item"); return; }
      n += 1;
      setTimeout(tries, 250);
    };
    tries();
  })`);
  console.log("workspace pane:", clicked);

  // Terminal needs an attached pane. Use the existing repro flow: open
  // workspace, select a pane, wait for the terminal to render rows.
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
  record("terminal rendered rows", rowsReady.rows > 0, `rows=${rowsReady.rows} waited=${rowsReady.waited}ms`);

  if (rowsReady.rows > 0) {
    // 2. Baseline: --term-cell-width and rendered row geometry.
    const baseline = await evalExpr(`(() => {
      const host = document.getElementById("terminal");
      const row = host.querySelector(".term-row");
      return {
        cellWidth: getComputedStyle(host).getPropertyValue("--term-cell-width"),
        rowHeight: getComputedStyle(host).getPropertyValue("--term-row-height"),
        rowRectH: row.getBoundingClientRect().height,
        termCols: state.termCols,
        termRows: state.termRows,
        gridCols: term && term.cols,
        gridRows: term && term.rows,
      };
    })()`);
    console.log("baseline:", JSON.stringify(baseline));

    // 3. Arm the revalidation and let the tick consume it. The first tick
    //    after bootstrap may legitimately re-grid a stale grid (that is the
    //    fix working). Invariants: each tick lands on the app-owned grid
    //    (state.termCols x state.termRows) and a SECOND tick is a true
    //    no-op (grid and cell metric unchanged, flag consumed).
    const noop = await evalExpr(`new Promise((resolve) => {
      const tick = (cb) => requestAnimationFrame(() => requestAnimationFrame(cb));
      invalidateTerminalGeometry();
      tick(() => {
        const g1 = {
          cols: term && term.cols,
          rows: term && term.rows,
          cell: getComputedStyle(document.getElementById("terminal")).getPropertyValue("--term-cell-width"),
        };
        invalidateTerminalGeometry();
        tick(() => {
          resolve({
            flagAfter: terminalGeometryInvalidated,
            g1,
            g2: {
              cols: term && term.cols,
              rows: term && term.rows,
              cell: getComputedStyle(document.getElementById("terminal")).getPropertyValue("--term-cell-width"),
            },
            termCols: state.termCols,
            termRows: state.termRows,
          });
        });
      });
    })`);
    record("revalidation lands on app grid, second tick is a no-op",
      noop.g1.cols === noop.termCols && noop.g1.rows === noop.termRows
      && noop.g2.cols === noop.g1.cols && noop.g2.rows === noop.g1.rows
      && noop.g2.cell === noop.g1.cell && noop.flagAfter === false,
      `g1=${noop.g1.cols}x${noop.g1.rows} g2=${noop.g2.cols}x${noop.g2.rows} app=${noop.termCols}x${noop.termRows} cell ${noop.g1.cell}->${noop.g2.cell} consumed=${noop.flagAfter === false}`);

    // 4. Drift: poison --term-cell-width on the host and confirm the
    //    detector arms the flag (consumed by the next tick).
    const drift = await evalExpr(`new Promise((resolve) => {
      const host = document.getElementById("terminal");
      const before = getComputedStyle(host).getPropertyValue("--term-cell-width");
      host.style.setProperty("--term-cell-width", "30px");
      detectTerminalGeometryDrift();
      const armed = terminalGeometryInvalidated;
      host.style.removeProperty("--term-cell-width");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({ before, armed, flagAfter: terminalGeometryInvalidated });
      }));
    })`);
    record("drift detection arms on live --term-cell-width change", drift.armed === true,
      `before=${drift.before} armed=${drift.armed} consumed=${drift.flagAfter === false}`);

    // 5. No lingering timers: the tick consumed everything.
    const tail = await evalExpr(`(() => ({
      flag: terminalGeometryInvalidated,
      wanted: terminalResizeWanted,
      frame: terminalResizeFrame !== null,
    }))()`);
    record("scheduler quiet after ticks", tail.flag === false && tail.wanted === false && tail.frame === false,
      JSON.stringify(tail));
  }

  writeFileSync(outPath, JSON.stringify({ results }, null, 2));
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
  try { writeFileSync(outPath, JSON.stringify({ results }, null, 2)); } catch {}
  exitCode = 1;
}
// The raw WebSocket keeps the event loop alive after main(); flush stdout
// then exit explicitly so the script always terminates.
process.stdout.write("", () => process.exit(exitCode));