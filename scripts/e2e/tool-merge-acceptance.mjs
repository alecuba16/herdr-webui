// Live-DOM acceptance for the consecutive same-name tool merge
// (merge_consecutive_tool_blocks). The unit tests pin the render logic in
// the vm harness; this driver boots the actually served bundle in
// headless Chrome and checks the merged layout against the REAL DOM:
// one head with the xN badge, tail rows as brief-only list items, each
// tail expandable, the text interlude breaking the run, and the open
// state surviving a real poll tick. A fixture jcode session (isolated
// HOME) feeds the transcript through the real conversation route; a
// fake jcode process keeps the pane resolvable. Server + Chrome are
// started by run-tool-merge-e2e.sh.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9224";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8899/";
const REPO = process.env.REPO;
const outPath = process.argv[2] || `${process.env.JCODE_SCRATCH_DIR || "."}/tool_merge_result.json`;

if (!REPO) {
  console.error("REPO must be set (use scripts/e2e/run-tool-merge-e2e.sh)");
  process.exit(2);
}

const recorder = makeRecorder();
const record = recorder.record.bind(recorder);

async function main() {
  const targets = await fetchJson(`${CDP_HTTP}/json`);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(new URL(APP_URL).origin));
  if (!page) throw new Error(`no page target for ${APP_URL}; open it first`);
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  const evalExpr = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || "")}`);
    return r.result.value;
  };

  const reload = async (url) => {
    await cdp.send("Page.navigate", { url: url || APP_URL });
    await sleep(3000);
  };

  await reload();

  const made = await evalExpr(`fetch("/api/workspaces", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({cwd: ${JSON.stringify(REPO)}, label: "tool-merge"})}).then((r) => r.json()).catch((e) => "err:" + e)`);
  const wsId = made && made.result && made.result.workspace ? made.result.workspace.workspace_id : null;
  if (!wsId) throw new Error("no workspace_id in create response: " + JSON.stringify(made).slice(0, 300));
  record("workspace created on fixture repo", true, wsId);
  await reload(`${APP_URL}session/default/workspace/${wsId}`);

  const switchState = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const node = document.getElementById("terminalLensSwitch");
      if (node && !node.hidden) { resolve("visible"); return; }
      if (Date.now() - started > 20000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("chat lens switch visible on jcode pane", switchState === "visible", `got ${switchState}`);
  if (switchState !== "visible") throw new Error("lens switch never appeared");

  await evalExpr(`document.getElementById("lensToggleChat").click()`);
  const lensReady = await evalExpr(`new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const lens = document.getElementById("terminalLens");
      const content = lens && lens.querySelector(".terminal-lens-content");
      if (content && content.querySelector(".lens-tool-head")) { resolve("ready"); return; }
      if (Date.now() - started > 20000) resolve("timeout"); else setTimeout(check, 400);
    };
    check();
  })`);
  record("lens opens and renders the fixture turns", lensReady === "ready", `got ${lensReady}`);
  if (lensReady !== "ready") throw new Error("lens never rendered turns");

  // Layout: the fixture assistant turn carries bash, bash, text, bash.
  // Expected: ONE merged head with x3 covering the first run (bash x3
  // before the text breaks it? No: run is [bash, bash, text, bash] so
  // the run is bash x2, text breaks it, then a separate bash head).
  const layout = await evalExpr(`(() => {
    const content = document.querySelector(".terminal-lens-content");
    const heads = [...content.querySelectorAll(".lens-tool-head")];
    const counts = heads.map((h) => h.querySelector(".lens-tool-count") ? h.querySelector(".lens-tool-count").textContent : null);
    const tailRows = [...content.querySelectorAll("div.lens-tool-run-item")].map((r) => ({
      key: r.getAttribute("data-part-key"),
      brief: r.textContent.trim(),
      toggle: r.hasAttribute("data-toggle-tool"),
      tabindex: r.getAttribute("tabindex"),
    }));
    const nameCount = content.textContent.split("bash").length - 1;
    return {
      headCount: heads.length,
      counts,
      tailCount: tailRows.length,
      tailRows,
      // The tool NAME appears once per head only (tails are brief-only).
      headNames: heads.map((h) => h.querySelector(".lens-tool-name").textContent),
    };
  })()`);
  record("two heads render (run + post-text bash)", layout.headCount === 2, `heads ${layout.headCount}`);
  record("first head carries x2 run badge", layout.counts[0] === "\u00d72", `badge ${JSON.stringify(layout.counts[0])}`);
  record("second head has no badge (run of one)", layout.counts[1] === null, `badge ${JSON.stringify(layout.counts[1])}`);
  record("one tail row under the first head", layout.tailCount === 1, `tails ${layout.tailCount}`);
  record("tail keeps its part key", layout.tailRows[0] && layout.tailRows[0].key === "1:1:bash", `key ${layout.tailRows[0] && layout.tailRows[0].key}`);
  record("tail is keyboard-focusable and togglable", layout.tailRows[0] && layout.tailRows[0].tabindex === "0" && layout.tailRows[0].toggle === true, JSON.stringify(layout.tailRows[0] && { t: layout.tailRows[0].tabindex, g: layout.tailRows[0].toggle }));
  record("tail brief is the command text", layout.tailRows[0] && layout.tailRows[0].brief.includes("rg missing-symbol"), `brief ${layout.tailRows[0] && layout.tailRows[0].brief}`);
  record("head names carry bash once each", layout.headNames.every((n) => n === "bash") && layout.headNames.length === 2, JSON.stringify(layout.headNames));

  // Click-through (R-35): the tail expands its OWN output. An expanded
  // tail re-renders in the full row form, so its own head shows
  // aria-expanded=true too; the RUN head (part key 1:0) is the one that
  // must stay collapsed.
  const expanded = await evalExpr(`(() => {
    const tail = document.querySelector("div.lens-tool-run-item");
    tail.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        const content = document.querySelector(".terminal-lens-content");
        const open = content.querySelector('.lens-tool.lens-tool-open[data-part-key="1:1:bash"]');
        const runHead = content.querySelector('.lens-tool-head[data-toggle-tool="1:0:bash"]');
        resolve({
          tailOpened: !!open,
          output: open ? open.querySelector(".lens-tool-output").textContent.trim() : null,
          runHeadStillCollapsed: runHead ? runHead.getAttribute("aria-expanded") === "false" : null,
        });
      }, 600);
    });
  })()`);
  record("tail click expands its own output", expanded.tailOpened === true, JSON.stringify(expanded).slice(0, 120));
  record("expanded output is the tail's own bytes", expanded.output === "rg: no matches found", `output ${JSON.stringify(expanded.output)}`);
  record("the run head stays collapsed", expanded.runHeadStillCollapsed === true, `collapsed ${expanded.runHeadStillCollapsed}`);

  // Poll stability: wait one real poll tick (2s cadence) and re-check
  // the merged layout did not churn. With the tail OPEN, its full row
  // form carries its own head, so head count is 3 while open: the
  // invariants are unique keys, the tail's open row still present, and
  // the tail's OWN head still expanded.
  await sleep(4500);
  const stable = await evalExpr(`(() => {
    const content = document.querySelector(".terminal-lens-content");
    const keys = [...content.querySelectorAll("[data-part-key]")].map((r) => r.getAttribute("data-part-key"));
    const openTail = content.querySelector('.lens-tool-open[data-part-key="1:1:bash"]');
    return {
      totalRows: keys.length,
      dupes: keys.length !== new Set(keys).size,
      openTailSurvives: !!openTail,
      openTailOutput: openTail ? openTail.querySelector(".lens-tool-output").textContent.trim() : null,
      runHeadCount: content.querySelectorAll('.lens-tool-head[data-toggle-tool="1:0:bash"]').length,
    };
  })()`);
  record("no duplicate part rows after a poll tick", stable.dupes === false, `rows ${stable.totalRows}, dupes ${stable.dupes}`);
  record("open tail survives the poll", stable.openTailSurvives === true, `open ${stable.openTailSurvives}`);
  record("open tail keeps its output across the poll", stable.openTailOutput === "rg: no matches found", `output ${JSON.stringify(stable.openTailOutput)}`);
  record("run head not duplicated", stable.runHeadCount === 1, `run heads ${stable.runHeadCount}`);

  writeReport(outPath, recorder);
  console.log(`report: ${outPath}`);
  // The CDP websocket keeps the event loop alive; exit explicitly.
  process.exit(recorder.failed ? 1 : 0);
}

main().catch((err) => {
  writeCrashReport(outPath, recorder, err);
  console.error(err.stack || err);
  process.exit(1);
});