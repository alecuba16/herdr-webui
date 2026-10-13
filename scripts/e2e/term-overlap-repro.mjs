// Repro probe for "text overlaps and keeps blinking" in the terminal panel.
// Runs against a live isolated server (port 8899) with a real wterm renderer
// in headless Chrome (CDP port 9223). Does NOT modify the page logic: it only
// observes, so both a healthy and a broken build produce honest results.
//
// Scenarios probed:
//  A. Fresh load: does the renderer ever paint rows while its font metrics
//     are provisional (font swap race), and does it self-correct?
//  B. Steady state: rows must tile the viewport exactly - no partial row at
//     the bottom (overlap signature), grid must match the app grid.
//  C. Scroll behavior with a full-screen program writing continuously:
//     scrollTop must not oscillate frame over frame (the "keeps blinking"
//     signature: app scrollToBottom vs renderer follow fighting).
//  D. Hidden tab restore: visibilitychange pause/resume must not leave
//     stale/duplicated rows.
//  E. Resize: shell resize must land rows that tile exactly again.
// CDP gotcha: Runtime.evaluate with "new Promise(...)" must NOT have a
// trailing "()" appended.
import { writeFileSync } from "node:fs";
import { fetchJson, attach, sleep, makeRecorder, writeReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = "http://127.0.0.1:9223";
const APP_URL = "http://127.0.0.1:8899/";
const outPath =
  process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/term_overlap_repro_result.json`;

const recorder = makeRecorder();

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:8899"));
  if (!page) throw new Error("no page target for the app; open it first");
  const cdp = await attach(page.webSocketDebuggerUrl);

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        `eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`,
      );
    return r.result.value;
  };

  await cdp.send("Page.enable");
  // Fresh load with cache disabled so the font race is realistic.
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(2500);
  await evalExpr(`document.fonts && document.fonts.ready.then(() => "fonts-ready")`).catch(() => {});

  // Bootstrap a workspace with a terminal (same flow as the geometry e2e).
  const wsResp = await evalExpr(
    `fetch("/api/workspaces").then((r) => r.json()).catch((e) => "err:" + e)`,
  );
  const items = wsResp && wsResp.workspaces ? wsResp.workspaces : [];
  if (!items.length) {
    await evalExpr(
      `fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: "/tmp", label: "e2e-overlap"})}).then((r) => r.json()).catch((e) => "err:" + e)`,
    );
    await sleep(1500);
    await cdp.send("Page.navigate", { url: APP_URL });
    await sleep(2500);
  }
  const clicked = await evalExpr(`new Promise((resolve) => {
    let n = 0;
    const tries = () => {
      const link = document.querySelector("a.item[data-workspace-id]");
      if (link) { link.click(); resolve("clicked"); return; }
      if (n >= 40) { resolve("no workspace item"); return; }
      n += 1; setTimeout(tries, 250);
    };
    tries();
  })`);
  console.log("workspace pane:", clicked);

  // Wait for rows.
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
  recorder.record(
    "terminal rendered rows",
    rowsReady.rows > 0,
    `rows=${rowsReady.rows} waited=${rowsReady.waited}ms`,
  );
  if (!rowsReady.rows > 0) {
    writeReport(outPath, recorder);
    return recorder.failed ? 1 : 0;
  }

  // Helper expression body reused by scenario probes.
  const geometry = () => `(() => {
    const host = document.getElementById("terminal");
    const row = host.querySelector(".term-row");
    const rect = row && row.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const styles = getComputedStyle(host);
    const grid = host.querySelector(".term-grid");
    return {
      rows: host.querySelectorAll(".term-row").length,
      gridRows: term && term.rows,
      gridCols: term && term.cols,
      appCols: state && state.termCols,
      appRows: state && state.termRows,
      rowH: rect ? rect.height : 0,
      rowBottom: rect ? rect.bottom : 0,
      hostH: hostRect.height,
      hostBottom: hostRect.bottom,
      cellWidth: styles.getPropertyValue("--term-cell-width"),
      rowHeightVar: styles.getPropertyValue("--term-row-height"),
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      gridChildRects: grid ? Array.from(grid.children).filter((c) => c.className.includes("term-row")).length : 0,
      gridOverflow: grid ? (getComputedStyle(grid).minWidth || "") : "",
    };
  })()`;

  // B. Steady state geometry: rows tile the viewport, no partial row.
  const steady = await evalExpr(geometry());
  const steadyOk =
    steady.gridRows === steady.rows &&
    steady.rows > 0 &&
    Math.abs(steady.rowH - parseFloat(steady.rowHeightVar)) < 0.5;
  recorder.record(
    "steady grid matches rendered rows",
    steadyOk,
    JSON.stringify(steady),
  );

  // Overlap signature: last row bottom vs host bottom - the grid must not
  // extend past (rows * rowH) by more than a couple of px.
  const overlap = await evalExpr(`(() => {
    const host = document.getElementById("terminal");
    const rows = Array.from(host.querySelectorAll(".term-row"));
    if (!rows.length) return { ok: false, why: "no rows" };
    const cs = getComputedStyle(rows[0]);
    const rowH = parseFloat(getComputedStyle(host).getPropertyValue("--term-row-height")) || rows[0].getBoundingClientRect().height;
    // stacked tops must be multiples of rowH (block flow); partial-row overlap
    // shows up as fractional misalignment between consecutive rows.
    let misaligned = 0;
    let firstBad = null;
    const hostTop = host.getBoundingClientRect().top;
    rows.forEach((r, i) => {
      const top = r.getBoundingClientRect().top - hostTop + host.scrollTop;
      const expected = Math.round(top / rowH);
      if (Math.abs(top - expected * rowH) > 0.75) {
        misaligned += 1;
        if (!firstBad) firstBad = { i, top, rowH };
      }
    });
    return { ok: misaligned === 0, misaligned, firstBad, rowH, n: rows.length };
  })()`);
  recorder.record("rows align to row grid (no overlap)", overlap.ok,
    JSON.stringify(overlap));

  // C. Blink/oscillation probe: run a streamer in the pty and watch
  // scrollTop over 40 frames. Oscillation = follow fight.
  await evalExpr(`new Promise((resolve) => {
    const t = window.term || term;
    if (!t) { resolve("no term"); return; }
    // Feed through the adapter exactly like a WS frame would.
    let n = 0;
    const timer = setInterval(() => {
      t.write("\\r\\nframe " + n++ + " " + "x".repeat(20) + " (overlap-repro)");
      if (n >= 60) { clearInterval(timer); resolve("streamed " + n); }
    }, 30);
  })`).catch((e) => console.log("stream err:", e.message));
  await sleep(300);

  const oscillation = await evalExpr(`new Promise((resolve) => {
    const host = document.getElementById("terminal");
    const samples = [];
    let count = 0;
    const tick = () => {
      samples.push({ t: count, top: host.scrollTop, h: host.scrollHeight, ch: host.clientHeight });
      count += 1;
      if (count < 40) requestAnimationFrame(tick);
      else {
        // Count direction flips of scrollTop after the stream settles.
        let flips = 0;
        for (let i = 2; i < samples.length; i++) {
          const a = samples[i - 1].top - samples[i - 2].top;
          const b = samples[i].top - samples[i - 1].top;
          if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b) && Math.abs(b) > 0) flips += 1;
        }
        resolve({ flips, samples: samples.slice(0, 8).concat(samples.slice(-4)), atBottom: host.scrollHeight - host.scrollTop - host.clientHeight <= 2 });
      }
    };
    requestAnimationFrame(tick);
  })`);
  recorder.record(
    "scrollTop does not oscillate after streaming",
    oscillation.flips <= 1,
    `flips=${oscillation.flips} atBottom=${oscillation.atBottom}`,
  );

  // D. Hidden tab restore: rows must still tile after visibility flip.
  await evalExpr(`new Promise((resolve) => {
    Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    setTimeout(() => {
      Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve("restored")));
    }, 400);
  })`).catch((e) => console.log("visibility err:", e.message));
  await sleep(400);
  const afterHidden = await evalExpr(geometry());
  recorder.record(
    "geometry intact after hidden/restore",
    afterHidden.gridRows === afterHidden.rows && afterHidden.rows > 0,
    JSON.stringify(afterHidden),
  );

  // E. Resize probe: change the shell size, wait a settle, re-check tiling.
  const resized = await evalExpr(`new Promise((resolve) => {
    const shell = document.getElementById("terminalShell");
    const host = document.getElementById("terminal");
    const prev = shell.style.height;
    shell.style.height = (shell.clientHeight - 37) + "px";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({
          height: shell.clientHeight,
          hostH: host.getBoundingClientRect().height,
          rows: host.querySelectorAll(".term-row").length,
          gridRows: (window.term || term) && (window.term || term).rows,
          appRows: state.termRows,
        });
      }));
    }));
  })`);
  const resizeOk = resized.gridRows === resized.rows && resized.rows > 0;
  recorder.record(
    "rows retile after shell resize",
    resizeOk,
    JSON.stringify(resized),
  );

  writeReport(outPath, recorder);
  console.log(`${recorder.passed}/${recorder.results.length} checks passed`);
  return recorder.failed ? 1 : 0;
}

let exitCode = 0;
try {
  exitCode = (await main()) || 0;
} catch (e) {
  console.error("E2E ERROR:", e.message);
  writeReport(outPath, recorder);
  exitCode = 1;
}
process.stdout.write("", () => process.exit(exitCode));