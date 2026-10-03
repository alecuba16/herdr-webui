// Behavior tests for the shared action registry (src/assets/shared/actions.js):
// kbd hints, render buttons, and the ">" action-only candidate filter added
// on the ux_improvements branch. Runs the module in a vm context with a
// minimal DOM-less global.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./shared/actions.js", import.meta.url), "utf8");

function loadRegistry() {
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  return ctx.HerdrActionRegistry;
}

test("kbdHint renders the kbd span for actions with a shortcut", () => {
  const registry = loadRegistry();
  const sidebar = registry.action("toggle-sidebar");
  assert.equal(sidebar.kbd, "g s");
  assert.equal(
    registry.kbdHint(sidebar),
    '<span class="kbd" aria-hidden="true">g s</span>',
  );
});

test("kbdHint returns empty for actions without a shortcut", () => {
  const registry = loadRegistry();
  const theme = registry.action("toggle-theme");
  assert.equal(theme.kbd, undefined);
  assert.equal(registry.kbdHint(theme), "");
});

test("kbdHint can be suppressed via options and escapes the shortcut", () => {
  const registry = loadRegistry();
  const settings = registry.action("settings");
  assert.equal(registry.kbdHint(settings, { kbd: false }), "");
  const hostile = { kbd: '<img onerror="x">' };
  const hint = registry.kbdHint(hostile);
  assert.ok(!hint.includes("<img"), "kbd hint must escape the shortcut text");
  assert.ok(hint.includes("&lt;img"), "escaped entities present");
});

test("renderButtons emits one onclick button per action", () => {
  const registry = loadRegistry();
  const actions = registry.candidates(">", { platform: "desktop" });
  const html = registry.renderButtons(actions);
  assert.ok(html.includes('class="action-card"'));
  assert.ok(html.includes("onclick=\"runSearchAction('toggle-theme')\""));
  assert.ok(html.includes("<strong>Toggle theme</strong>"));
  // Every desktop action got a button.
  for (const action of actions) {
    assert.ok(html.includes(`'${action.action}'`), `button for ${action.action}`);
  }
  // Custom renderer name and class pass through.
  const custom = registry.renderButtons([registry.action("settings")], {
    buttonClass: "tile",
    run: "doThing",
  });
  assert.ok(custom.includes('class="tile"'));
  assert.ok(custom.includes("onclick=\"doThing('settings')\""));
});

test("candidates '>' filter lists actions only, desktop surface", () => {
  const registry = loadRegistry();
  // Cross-realm arrays fail deepEqual identity checks; compare serialized.
  const ids = (rows) => JSON.stringify(rows.map((a) => a.action));
  assert.equal(
    ids(registry.candidates(">", { platform: "desktop" })),
    JSON.stringify([
      "open-workspace",
      "temp-terminal",
      "sessions",
      "toggle-sidebar",
      "toggle-theme",
      "settings",
    ]),
  );
  // Mobile never sees the desktop-only sidebar toggle.
  const mobile = registry.candidates("", { platform: "mobile" }).map((a) => a.action);
  assert.ok(!mobile.includes("toggle-sidebar"));
  assert.ok(mobile.includes("toggle-theme"));
  // ">temp" narrows to the matching action only ("term" also matches the
  // settings subtitle which mentions "terminal").
  const narrowed = registry.candidates(">temp", { platform: "desktop" }).map((a) => a.action);
  assert.equal(JSON.stringify(narrowed), JSON.stringify(["temp-terminal"]));
});

test("candidates respects requiresWorkspace and includeMenuOnly gates", () => {
  const registry = loadRegistry();
  const noWorkspace = registry.candidates("", { platform: "desktop", hasWorkspace: false });
  for (const action of noWorkspace) {
    assert.ok(!action.requiresWorkspace, `${action.action} must not require a workspace`);
  }
  const withWorkspace = registry.candidates("", { platform: "desktop", hasWorkspace: true });
  assert.ok(
    withWorkspace.length >= noWorkspace.length,
    "hasWorkspace can only add rows",
  );
  // menuOnly rows are hidden unless explicitly requested.
  const menuOnly = registry.all().filter((a) => a.menuOnly);
  if (menuOnly.length) {
    const plain = registry.candidates("", { platform: "desktop", hasWorkspace: true });
    for (const hidden of menuOnly) {
      if (hidden.surfaces.includes("desktop")) {
        assert.ok(
          !plain.some((a) => a.action === hidden.action),
          `menuOnly ${hidden.action} hidden by default`,
        );
      }
    }
  }
});