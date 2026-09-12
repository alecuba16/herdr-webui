// Tests for the shared attention module (agent sorting + stuck-working
// dismissals) and the mobile parity features that build on it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const attentionSource = readFileSync(new URL("./shared/attention.js", import.meta.url), "utf8");
const optionsSource = readFileSync(new URL("./shared/options.js", import.meta.url), "utf8");

function context({ options = {}, storage = new Map() } = {}) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Array,
    Math,
    Number,
    String,
    Error,
    Set,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  if (Object.keys(options).length) {
    sandbox.localStorage.setItem("herdr-web-options", JSON.stringify(options));
  }
  vm.runInContext(optionsSource, ctx);
  vm.runInContext(attentionSource, ctx);
  return ctx;
}

const agent = (status, extra = {}) => ({
  workspace_id: "w1",
  tab_id: "t1",
  pane_id: "p1",
  terminal_id: "term-1",
  agent_status: status,
  name: status,
  ...extra,
});

describe("shared attention module", () => {
  it("loads and exposes its API", () => {
    const ctx = context();
    assert.ok(ctx.HerdrAttention, "HerdrAttention global must exist");
    assert.equal(typeof ctx.HerdrAttention.sortAgents, "function");
    assert.equal(typeof ctx.HerdrAttention.createDismissals, "function");
    assert.equal(typeof ctx.HerdrAttention.statusClass, "function");
  });

  it("maps status to class with unknown fallback", () => {
    const ctx = context();
    assert.equal(ctx.HerdrAttention.statusClass("done"), "done");
    assert.equal(ctx.HerdrAttention.statusClass("blocked"), "blocked");
    assert.equal(ctx.HerdrAttention.statusClass(null), "unknown");
    assert.equal(ctx.HerdrAttention.statusClass(""), "unknown");
  });

  it("floats blocked then done when sort mode is off", () => {
    const ctx = context({ options: {} });
    const sorted = ctx.HerdrAttention.sortAgents([
      agent("working"),
      agent("done"),
      agent("blocked"),
      agent("idle"),
    ]);
    assert.deepEqual(
      sorted.map((a) => a.agent_status),
      ["blocked", "done", "idle", "working"],
    );
  });

  it("sorts by custom group order in attention mode", () => {
    const ctx = context({
      options: { agentSortMode: "attention", agentStatusOrder: ["working", "blocked", "done", "idle", "other"] },
    });
    const sorted = ctx.HerdrAttention.sortAgents([
      agent("blocked"),
      agent("done"),
      agent("working"),
    ]);
    assert.deepEqual(
      sorted.map((a) => a.agent_status),
      ["working", "blocked", "done"],
    );
  });

  it("applies the working-first preset in attention_inverted mode without stored order", () => {
    const ctx = context({ options: { agentSortMode: "attention_inverted" } });
    const sorted = ctx.HerdrAttention.sortAgents([
      agent("idle"),
      agent("done"),
      agent("blocked"),
      agent("working"),
    ]);
    assert.deepEqual(
      sorted.map((a) => a.agent_status),
      ["blocked", "working", "done", "idle"],
    );
  });

  it("normalizes partial custom orders by appending missing groups", () => {
    const ctx = context();
    const order = ctx.HerdrAttention.normalizeAgentStatusOrder(["done", "bogus"]);
    assert.deepEqual([...order], ["done", "blocked", "idle", "other", "working"]);
  });
});

describe("stuck-working dismissals", () => {
  function dismissalsFor(ctx) {
    return ctx.HerdrAttention.createDismissals({
      getOptions: () => ctx.HerdrOptions.read(),
      localStorage: ctx.localStorage,
      onRender: null,
    });
  }

  it("dismisses and restores a working agent", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    const working = agent("working");
    assert.equal(d.isWorkingDismissed(working), false);
    d.dismiss(working);
    assert.equal(d.isWorkingDismissed(working), true);
    d.restore(working);
    assert.equal(d.isWorkingDismissed(working), false);
  });

  it("shares storage with the desktop key", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    d.dismiss(agent("working"));
    const raw = ctx.localStorage.getItem("herdr-web-working-dismissals");
    assert.ok(raw, "dismissal must persist to the shared storage key");
    assert.deepEqual(JSON.parse(raw)["term-1"].signature.split("|").slice(0, 4), ["w1", "t1", "p1", "term-1"]);
  });

  it("does not dismiss non-working agents", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    d.dismiss(agent("blocked"));
    assert.equal(d.isWorkingDismissed(agent("blocked")), false);
  });

  it("clears dismissal when the agent status changes", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    const working = agent("working");
    d.dismiss(working);
    d.cleanup([agent("working", { name: "renamed" })]);
    assert.equal(d.isWorkingDismissed(working), false);
  });

  it("cleanup drops stale dismissal keys", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    d.dismiss(agent("working"));
    d.cleanup([]);
    assert.equal(d.isWorkingDismissed(agent("working")), false);
  });

  it("clearForTerminal removes one terminal override", () => {
    const ctx = context({ options: {} });
    const d = dismissalsFor(ctx);
    d.dismiss(agent("working"));
    d.clearForTerminal("term-1");
    assert.equal(d.isWorkingDismissed(agent("working")), false);
  });

  it("respects the workingDismissMinutes TTL", () => {
    const ctx = context({ options: { workingDismissMinutes: 1 } });
    const d = dismissalsFor(ctx);
    const working = agent("working");
    d.dismiss(working);
    assert.equal(d.isWorkingDismissed(working), true);
    // Backdate the stored dismissal past the 1-minute TTL, then read through
    // a fresh instance (the module caches its own snapshot).
    const raw = JSON.parse(ctx.localStorage.getItem("herdr-web-working-dismissals"));
    raw["term-1"].dismissedAt = Date.now() - 2 * 60 * 1000;
    ctx.localStorage.setItem("herdr-web-working-dismissals", JSON.stringify(raw));
    const stale = dismissalsFor(ctx);
    assert.equal(stale.isWorkingDismissed(working), false);
  });

  it("disables dismissals when stuckWorkingEnabled is false", () => {
    const ctx = context({ options: { stuckWorkingEnabled: false } });
    const d = dismissalsFor(ctx);
    const working = agent("working");
    d.dismiss(working);
    assert.equal(d.isWorkingDismissed(working), false);
  });
});

describe("mobile parity feature guards", () => {
  const worktreesSource = readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");
  const bootSource = readFileSync(new URL("./app_boot.js", import.meta.url), "utf8");

  it("boot loads shared/attention.js before layout bundles", () => {
    const scriptsIndex = bootSource.indexOf("loadScriptsSequentially([");
    assert.ok(scriptsIndex > 0, "boot must have a sequential script list");
    const scripts = bootSource.slice(scriptsIndex);
    const attentionIndex = scripts.indexOf("/assets/shared/attention.js");
    const httpIndex = scripts.indexOf("/assets/shared/http.js");
    const mobileIndex = scripts.indexOf("/assets/mobile/");
    const desktopIndex = scripts.indexOf("/assets/desktop/");
    assert.ok(attentionIndex > httpIndex, "attention.js loads after http.js");
    assert.ok(mobileIndex === -1 || attentionIndex < mobileIndex, "attention.js loads before mobile bundles");
    assert.ok(desktopIndex === -1 || attentionIndex < desktopIndex, "attention.js loads before desktop bundles");
  });

  it("mobile search lives in its own module loaded before app.js", () => {
    const searchSource = readFileSync(new URL("./mobile/search.js", import.meta.url), "utf8");
    assert.match(searchSource, /globalThis\.HerdrMobileSearchModule = \{ create: createMobileSearch \}/);
    assert.match(searchSource, /searchDisabledFn\(\)\) return/);
    // The module must not be wired inside app.js's render path; app.js only
    // instantiates it and delegates open().
    const mobileIndex = bootSource.indexOf("/assets/mobile/search.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(mobileIndex > -1 && mobileIndex < appIndex, "search.js loads before app.js");
  });

  it("mobile git lives in its own module loaded before app.js", () => {
    const gitSource = readFileSync(new URL("./mobile/git.js", import.meta.url), "utf8");
    assert.match(gitSource, /globalThis\.HerdrMobileGitModule = \{ create: createMobileGit \}/);
    assert.match(gitSource, /async function loadGitStatus\(\)/);
    assert.match(gitSource, /confirmFn\(`Discard all uncommitted changes/);
    const gitIndex = bootSource.indexOf("/assets/mobile/git.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(gitIndex > -1 && gitIndex < appIndex, "git.js loads before app.js");
  });

  it("mobile sessions live in their own module loaded before app.js", () => {
    const sessionsSource = readFileSync(new URL("./mobile/sessions.js", import.meta.url), "utf8");
    assert.match(sessionsSource, /globalThis\.HerdrMobileSessionsModule = \{ create: createMobileSessions \}/);
    assert.match(sessionsSource, /confirmFn\(`Close current/);
    // switchSession stays synchronous, matching the original closure.
    assert.match(sessionsSource, /function switchSession\(name, backend\) \{/);
    assert.ok(!/async function switchSession/.test(sessionsSource), "switchSession must stay sync");
    const sessionsIndex = bootSource.indexOf("/assets/mobile/sessions.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(sessionsIndex > -1 && sessionsIndex < appIndex, "sessions.js loads before app.js");
  });

  it("mobile events socket lives in its own module loaded before app.js", () => {
    const eventsSource = readFileSync(new URL("./mobile/events.js", import.meta.url), "utf8");
    assert.match(eventsSource, /globalThis\.HerdrMobileEventsModule = \{ create: createMobileEvents \}/);
    assert.match(eventsSource, /wsUrl\("\/ws\/events"\)/);
    assert.match(eventsSource, /scheduleEventReconnect\(\)/);
    const eventsIndex = bootSource.indexOf("/assets/mobile/events.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(eventsIndex > -1 && eventsIndex < appIndex, "events.js loads before app.js");
  });

  it("mobile screen renderers live in their own module loaded before app.js", () => {
    const screensSource = readFileSync(new URL("./mobile/screens.js", import.meta.url), "utf8");
    assert.match(screensSource, /globalThis\.HerdrMobileScreensModule = \{ create: createMobileScreens \}/);
    assert.match(screensSource, /getWorkingDismissals\(\)/);
    assert.match(screensSource, /HerdrMobile\.dismissWorkingAgent/);
    const screensIndex = bootSource.indexOf("/assets/mobile/screens.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(screensIndex > -1 && screensIndex < appIndex, "screens.js loads before app.js");
  });

  it("mobile panel and terminal renderers live in their own module loaded before app.js", () => {
    const panelsSource = readFileSync(new URL("./mobile/panels.js", import.meta.url), "utf8");
    assert.match(panelsSource, /globalThis\.HerdrMobilePanelsModule = \{ create: createMobilePanels \}/);
    assert.match(panelsSource, /getMobileTerminal\(\)\.destroy\(true\)/);
    assert.match(panelsSource, /renderTerminalTabsWithAdd/);
    assert.match(appSource, /mobilePanels\.renderPanels\(\)/);
    assert.match(appSource, /mobilePanels\.renderTerminalScreen\(screen\)/);
    const panelsIndex = bootSource.indexOf("/assets/mobile/panels.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(panelsIndex > -1 && panelsIndex < appIndex, "panels.js loads before app.js");
  });

  it("mobile workspace/meta selectors live in their own module loaded before app.js", () => {
    const workmetaSource = readFileSync(new URL("./mobile/workmeta.js", import.meta.url), "utf8");
    assert.match(workmetaSource, /globalThis\.HerdrMobileWorkmetaModule = \{ create: createMobileWorkmeta \}/);
    assert.match(workmetaSource, /state\.worktreeRows\.find/);
    assert.match(workmetaSource, /samePath\(row\.path, workspace\.worktree\.checkout_path\)/);
    assert.match(appSource, /return mobileWorkmeta\.contextMeta\(workspace\)/);
    assert.match(appSource, /return mobileWorkmeta\.worktreeForWorkspace\(workspace\)/);
    const workmetaIndex = bootSource.indexOf("/assets/mobile/workmeta.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(workmetaIndex > -1 && workmetaIndex < appIndex, "workmeta.js loads before app.js");
  });

  it("mobile theme/viewport helpers live in their own module loaded before app.js", () => {
    const themeSource = readFileSync(new URL("./mobile/theme.js", import.meta.url), "utf8");
    assert.match(themeSource, /globalThis\.HerdrMobileThemeModule = \{ create: createMobileTheme \}/);
    assert.match(themeSource, /mobile-keyboard-open/);
    assert.match(themeSource, /herdr-tree-indent/);
    assert.match(themeSource, /herdr-web-theme/);
    assert.match(themeSource, /getBrowserFaviconError\(\)/);
    assert.match(appSource, /mobileTheme\.updateMobileViewport\(\)/);
    assert.match(appSource, /mobileTheme\.applyTheme\(\)/);
    const themeIndex = bootSource.indexOf("/assets/mobile/theme.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(themeIndex > -1 && themeIndex < appIndex, "theme.js loads before app.js");
  });

  it("mobile workspace actions live in their own module loaded before app.js", () => {
    const actionsSource = readFileSync(new URL("./mobile/actions.js", import.meta.url), "utf8");
    assert.match(actionsSource, /globalThis\.HerdrMobileActionsModule = \{ create: createMobileActions \}/);
    assert.match(actionsSource, /confirmFn\(`Close panel "\$\{label\}"\?`\)/);
    assert.match(actionsSource, /state\.gitStatus = null/);
    assert.match(actionsSource, /getMobileTerminal\(\)\.connect\(\)/);
    assert.match(appSource, /mobileActions\.selectWorkspace\(id\)/);
    assert.match(appSource, /await mobileActions\.createPanel\(\)/);
    const actionsIndex = bootSource.indexOf("/assets/mobile/actions.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(actionsIndex > -1 && actionsIndex < appIndex, "actions.js loads before app.js");
  });

  it("mobile session/backend helpers live in their own module loaded before app.js", () => {
    const backendSource = readFileSync(new URL("./mobile/backend.js", import.meta.url), "utf8");
    assert.match(backendSource, /globalThis\.HerdrMobileBackendModule = \{ create: createMobileBackend \}/);
    assert.match(backendSource, /herdrErrorOfferPending/);
    assert.match(backendSource, /confirmFn\(/);
    assert.match(backendSource, /getMobileEvents && getMobileEvents\(\)/);
    assert.match(backendSource, /closeEventWs\(\)/);
    assert.match(appSource, /mobileBackend\.handleHerdrErrorFrame\(raw\)/);
    assert.match(appSource, /mobileBackend\.syncSessionBackendFromServer\(\)/);
    const backendIndex = bootSource.indexOf("/assets/mobile/backend.js");
    const appIndex = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(backendIndex > -1 && backendIndex < appIndex, "backend.js loads before app.js");
  });

  it("worktrees module exposes recent workspace actions", () => {
    assert.match(worktreesSource, /loadRecent/);
    assert.match(worktreesSource, /openRecent/);
    assert.match(worktreesSource, /removeRecent/);
    assert.match(worktreesSource, /clearRecent/);
    assert.match(worktreesSource, /\/api\/recent-workspaces/);
  });

  it("worktrees screen renders the recent section", () => {
    assert.match(worktreesSource, /Recent workspaces<\/summary>/);
  });

  it("settings expose sound scope, agent sort, stuck working, and no-sleep", () => {
    for (const needle of [
      "setSoundScope",
      "setAgentSortMode",
      "setStuckWorkingEnabled",
      "setWorkingDismissMinutes",
      "setNoSleepMode",
      "/api/no-sleep",
    ]) {
      assert.ok(settingsSource.includes(needle), `settings must define ${needle}`);
    }
  });

  it("agent rows expose dismiss and undo working actions", () => {
    const screensSource = readFileSync(new URL("./mobile/screens.js", import.meta.url), "utf8");
    assert.match(screensSource, /dismissWorkingAgent/);
    assert.match(screensSource, /restoreWorkingAgent/);
    assert.match(screensSource, /HerdrMobile\.dismissWorkingAgent/);
    assert.match(screensSource, /HerdrMobile\.restoreWorkingAgent/);
    assert.match(appSource, /dismissWorkingAgent: \(\.\.\.args\) => mobileScreens\.dismissWorkingAgent/);
  });

  it("no nested interactive elements inside mobile-row buttons", () => {
    // Interactive content inside <button> is invalid HTML (WHATWG) and
    // browser handling of activation/click bubbling differs; row actions
    // must be span elements like the desktop agent sidebar uses.
    const rowSources = [appSource, readFileSync(new URL("./mobile/screens.js", import.meta.url), "utf8"), readFileSync(new URL("./mobile/panels.js", import.meta.url), "utf8")];
    const rowMatches = rowSources.flatMap((source) => source.match(/<button class="mobile-row[^"]*"[^>]*>[\s\S]*?<\/button>/g) || []);
    assert.ok(rowMatches.length > 0, "mobile rows must exist");
    for (const row of rowMatches) {
      const opens = (row.match(/<button/g) || []).length;
      assert.equal(opens, 1, `nested button in row: ${row.slice(0, 120)}`);
    }
  });

  it("recent workspace rows pass raw paths through jsArg", () => {
    // encodeURIComponent does not escape quotes, so onclick strings built
    // with quoted encodeURIComponent payloads break on paths like /tmp/o'brien.
    assert.ok(!worktreesSource.includes("openRecentWorkspace('${"), "recent open must not use quoted encodeURIComponent");
    assert.ok(!worktreesSource.includes("removeRecentWorkspace('${"), "recent remove must not use quoted encodeURIComponent");
    assert.match(worktreesSource, /openRecentWorkspace\(\$\{jsArg\(item\.path\)\}\)/);
    assert.match(worktreesSource, /removeRecentWorkspace\(\$\{jsArg\(item\.path\)\}\)/);
  });

  it("terminal output clears dismissed working overrides", () => {
    const terminalSource = readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8");
    assert.match(terminalSource, /onTerminalOutput/);
    assert.match(appSource, /onTerminalOutput: \(\.\.\.args\) => mobileScreens\.clearDismissedWorkingForTerminal/);
    assert.match(readFileSync(new URL("./mobile/screens.js", import.meta.url), "utf8"), /clearForTerminal\(terminalId\)/);
  });
});