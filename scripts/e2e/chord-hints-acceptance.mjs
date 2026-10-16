// Chord-hints acceptance probe: asserts the live shortcut chords on the
// real served app. Covers the three surfaces the shortcut audit fixed:
// palette action row hints, the help line under the actions list, the
// sidebar toggle tooltip, and the hint toast fired by a prefix-run toggle.
import { fetchJson, attach, sleep, makeRecorder, writeReport, writeCrashReport } from "./cdp-driver-helpers.mjs";

const APP_URL = process.env.APP_URL || "http://127.0.0.1:8911/";
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9229";
const OUT = process.argv[2];

// Send a full key press through CDP so the app's real keydown listeners
// run, the same path a user's keyboard takes.
async function pressKey(cdp, { key, code, ctrl = false, shift = false }) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const base = { key, code, windowsVirtualKeyCode: code === "KeyB" ? 66 : code === "KeyS" ? 83 : code === "Escape" ? 27 : 191 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...base });
}

async function main() {
  const recorder = makeRecorder();
  const version = await fetchJson(`${CDP_HTTP}/json/version`);
  const pages = await fetchJson(`${CDP_HTTP}/json/list`);
  const page = pages.find((p) => p.type === "page");
  const cdp = await attach(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result && r.result.value;
  };

  await cdp.send("Page.navigate", { url: APP_URL });
  await sleep(1500);

  // 1. Sidebar toggle tooltip carries the live chord after boot.
  const tooltip = await evalJs(`(() => {
    const b = document.getElementById("sidebarToggle");
    return b ? b.title : "(missing)";
  })()`);
  recorder.record("sidebar toggle tooltip carries the live chord", /Ctrl\+B then B/.test(String(tooltip)), `got ${tooltip}`);

  // 2. Open the palette with the real prefix chord (Ctrl+B then /), the
  // exact keys a user presses, then read the rendered action rows.
  await pressKey(cdp, { key: "b", code: "KeyB", ctrl: true });
  await sleep(80);
  await pressKey(cdp, { key: "/", code: "Slash" });
  await sleep(500);
  const rows = await evalJs(`(() => {
    const palette = document.getElementById("searchPalette");
    if (!palette) return "(no palette)";
    const spans = Array.from(palette.querySelectorAll("span.kbd")).map((s) => s.textContent.trim());
    return spans.join(" | ");
  })()`);
  recorder.record("palette action rows render live chords", /Ctrl\+B then B/.test(String(rows)) && /Ctrl\+B then S/.test(String(rows)), `got ${rows}`);
  recorder.record("palette rows show no stale fake chords", !String(rows).includes("g s"), `got ${rows}`);

  // 3. Help line under the actions list.
  const help = await evalJs(`(() => {
    const el = document.querySelector("#searchPalette .search-help");
    return el ? el.textContent : "(no help line)";
  })()`);
  recorder.record("help line lists live chords", /Ctrl\+B then/.test(String(help)), `got ${String(help).slice(0, 160)}`);

  // Close the palette the way a user does: Escape through the palette's
  // own keydown path.
  await pressKey(cdp, { key: "Escape", code: "Escape" });
  await sleep(200);

  // 4. Hint toast fires with the same chord on a real prefix-run toggle:
  // arm the prefix and press B, the exact keys that toggle the sidebar.
  await sleep(300);
  await pressKey(cdp, { key: "b", code: "KeyB", ctrl: true });
  await sleep(80);
  await pressKey(cdp, { key: "b", code: "KeyB" });
  await sleep(200);
  const toast = await evalJs(`(() => {
    const t = document.querySelector(".shortcut-hint-toast");
    if (!t) return "(no toast)";
    return [t.querySelector(".shortcut-hint-toast-label"), t.querySelector(".shortcut-hint-toast-prefix"), t.querySelector(".shortcut-hint-toast-key")].map((n) => (n ? n.textContent : "")).join(" / ");
  })()`);
  recorder.record("hint toast echoes the toggle with its chord", /Toggle sidebar\s*\/\s*Ctrl\+B\s*\/\s*B/.test(String(toast)), `got ${toast}`);

  // 5. Restore the sidebar so later suites see the expanded default.
  await pressKey(cdp, { key: "b", code: "KeyB", ctrl: true });
  await sleep(80);
  await pressKey(cdp, { key: "b", code: "KeyB" });

  writeReport(OUT, recorder, { app: APP_URL, chrome: version.Browser });
  if (recorder.failed) {
    console.error(`FAIL chord-hints: ${recorder.failed} check(s) failed`);
    process.exit(1);
  }
  console.log(`OK chord-hints: ${recorder.passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  writeCrashReport(OUT, err, { app: APP_URL });
  console.error(`CRASH chord-hints: ${err && err.message ? err.message : String(err)}`);
  process.exit(2);
});