// Font-race probe v2: block the terminal webfont with Fetch BEFORE the page
// boots (navigate with font interception armed), measure wterm metrics with
// the fallback font, then unblock, force-load the real font (warm, no adapter
// recreate), and measure again. Answers: does wterm re-measure when the font
// swap lands after init? Any horizontal overlap?
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9223";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";

async function fetchJson(url) { const r = await fetch(url); return r.json(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1:8899"));
  if (!page) throw new Error("no app page target; open one first");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Fetch.requestPaused") {
      ws.send(JSON.stringify({ id: ++id, method: "Fetch.failRequest", params: { requestId: m.params.requestId, errorReason: "Failed" } }));
    }
  };
  const send = (m, p) => { id += 1; ws.send(JSON.stringify({ id, method: m, params: p || {} })); return id; };
  const call = (m, p) => new Promise((res) => { const i = send(m, p); pending.set(i, res); });
  const evalx = async (expr) => {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + " " + JSON.stringify(r.result.exceptionDetails.exception?.description || ""));
    return r.result ? r.result.result.value : undefined;
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const measure = `(() => {
    const host = document.getElementById("terminal");
    if (!host) return { err: "no host", loc: location.href };
    const row = host.querySelector(".term-row");
    const span = row && row.querySelector("span");
    const style = getComputedStyle(host);
    return {
      cellWidth: style.getPropertyValue("--term-cell-width"),
      rowHeight: style.getPropertyValue("--term-row-height"),
      rows: host.querySelectorAll(".term-row").length,
      fontCheck: document.fonts.check("14px \\"Herdr JetBrainsMono Nerd Font Mono\\""),
      fontComputed: style.fontFamily.slice(0, 60),
      rowRectH: row ? row.getBoundingClientRect().height : null,
      spanW: span ? span.getBoundingClientRect().width : null,
      gridRows: (window.term || term) ? (window.term || term).rows : null,
    };
  })()`;

  // Phase 1: fonts blocked, fresh boot. Navigate AWAY first so the blocked
  // fetch cannot poison a previous load, then back in with fonts failing.
  await call("Fetch.enable", { patterns: [{ urlFilter: "JetBrainsMono", requestStage: "Request" }] });
  await evalx(`location.href = "about:blank"`);
  await sleep(600);
  await evalx(`location.href = "${APP_URL}"`);
  await sleep(3500);
  // Open the workspace if the terminal host has no rows yet.
  await evalx(`new Promise((resolve) => {
    const link = document.querySelector("a.item[data-workspace-id]");
    if (link) link.click();
    resolve("clicked");
  })`).catch(() => {});
  await sleep(2500);
  const blocked = await evalx(measure);
  console.log("blocked-font:", JSON.stringify(blocked));

  // Phase 2: unblock, load the font warm (no reload, no adapter recreate).
  await call("Fetch.disable", {});
  await evalx(`document.fonts.load("14px \\"Herdr JetBrainsMono Nerd Font Mono\\"").then(() => document.fonts.ready.then(() => "loaded"))`).catch((e) => console.log("fontload:", e.message));
  await sleep(800);
  const afterSwap = await evalx(measure);
  console.log("after-warm-swap:", JSON.stringify(afterSwap));

  // Phase 3: geometry overlap check with the swapped font. If wterm kept the
  // fallback cell width while painting webfont glyphs, spans overflow their
  // advance and lines visually overlap horizontally.
  const overlap = await evalx(`(() => {
    const host = document.getElementById("terminal");
    const rows = Array.from(host.querySelectorAll(".term-row"));
    const style = getComputedStyle(host);
    const cellW = parseFloat(style.getPropertyValue("--term-cell-width")) || 0;
    let overlapped = 0, firstBad = null;
    rows.forEach((r, i) => {
      const spans = r.querySelectorAll(":scope > span");
      spans.forEach((s) => {
        const cols = parseFloat(getComputedStyle(s).getPropertyValue("--term-span-cols")) || 1;
        const expected = cols * cellW;
        const actual = s.getBoundingClientRect().width;
        if (expected > 0 && actual > expected + 0.5) {
          overlapped += 1;
          if (!firstBad) firstBad = { row: i, expected, actual };
        }
      });
    });
    return { overlapped, firstBad, cellW };
  })()`);
  console.log("span-overlap:", JSON.stringify(overlap));

  // Phase 4: force one wterm re-render tick (what the app does after font
  // load via refreshTerminalAfterFontLoad -> applyTerminalFont -> invalidate
  // caches) to see if the app-side fix path corrects the metrics.
  const corrected = await evalx(`new Promise((resolve) => {
    const t = window.term || term;
    if (!t || !t.wterm || typeof t.wterm.fit !== "function") { resolve("no fit"); return; }
    try { t.wterm.fit(); } catch (e) {}
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const host = document.getElementById("terminal");
      const style = getComputedStyle(host);
      resolve({
        cellWidth: style.getPropertyValue("--term-cell-width"),
        rowHeight: style.getPropertyValue("--term-row-height"),
        gridRows: t.rows,
        appRows: state.termRows,
      });
    }));
  })`);
  console.log("after-fit:", JSON.stringify(corrected));
  process.exit(0);
}
main().catch((e) => { console.error("E2E ERROR:", e.message); process.exit(1); });