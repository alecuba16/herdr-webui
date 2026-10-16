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

test("kbdHint resolves the chord through the registered resolver", () => {
  const registry = loadRegistry();
  const sidebar = registry.action("toggle-sidebar");
  // No resolver: the static-kbd fallback stays empty for shortcutId rows.
  assert.equal(sidebar.kbd, undefined);
  assert.equal(registry.kbdHint(sidebar), "");
  registry.setChordResolver((id) => `Ctrl+B then ${id}`);
  assert.equal(
    registry.kbdHint(sidebar),
    '<span class="kbd" aria-hidden="true">Ctrl+B then sidebar</span>',
  );
  // The settings action pairs with webuiShortcuts.settings the same way.
  const settings = registry.action("settings");
  assert.equal(
    registry.kbdHint(settings),
    '<span class="kbd" aria-hidden="true">Ctrl+B then settings</span>',
  );
  // Resolver returning nothing (unknown shortcut id) hides the hint.
  registry.setChordResolver(() => "");
  assert.equal(registry.kbdHint(sidebar), "");
  registry.setChordResolver(null);
  assert.equal(registry.kbdHint(sidebar), "", "null resolver restores the static fallback");
});

test("registry has no duplicate action ids per surface", () => {
  const registry = loadRegistry();
  for (const platform of ["desktop", "mobile"]) {
    const ids = registry.candidates("", { platform, hasWorkspace: true }).map((a) => a.action);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `${platform} candidates must be unique: ${ids}`);
  }
});

test("kbdHint returns empty for actions without a shortcut", () => {
  const registry = loadRegistry();
  const theme = registry.action("toggle-theme");
  assert.equal(theme.kbd, undefined);
  assert.equal(registry.kbdHint(theme), "");
});

test("workspace actions resolve their chord through the registry resolver", () => {
  const registry = loadRegistry();
  // These rows run real prefix actions (Ctrl+B N/T): open workspace and
  // create worktree. The palette row and the toast must agree on the
  // chord, so they resolve the same shortcutId the runSearchAction hint
  // map uses. The mobile-only discover-worktrees row keeps no id: its
  // surface renders no chords.
  const chords = {
    newWorkspace: "Ctrl+B then N",
    createWorktree: "Ctrl+B then T",
  };
  registry.setChordResolver((id) => chords[id] || "");
  const desktop = registry.candidates(">", { platform: "desktop", hasWorkspace: true });
  for (const [id, chord] of Object.entries(chords)) {
    const row = desktop.find((a) => a.shortcutId === id);
    assert.ok(row, `${id} row present on desktop`);
    assert.equal(
      registry.kbdHint(row),
      `<span class="kbd" aria-hidden="true">${chord}</span>`,
    );
  }
  // Mobile keeps its full row set (touch surface, no kbd rendering there)
  // and the dedupe holds after the new shortcutIds.
  const mobile = registry.candidates("", { platform: "mobile", hasWorkspace: true }).map((a) => a.action);
  assert.ok(mobile.includes("discover-worktrees"));
  assert.equal(mobile.filter((id) => id === "settings").length, 1);
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
  // Settings appears exactly once on mobile (the old duplicate row is gone).
  assert.equal(
    mobile.filter((id) => id === "settings").length,
    1,
    `mobile settings must be unique: ${mobile}`,
  );
  // ">sess" narrows to the sessions tool only.
  const narrowed = registry.candidates(">sess", { platform: "desktop" }).map((a) => a.action);
  assert.equal(JSON.stringify(narrowed), JSON.stringify(["sessions"]));
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