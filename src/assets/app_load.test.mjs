import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { deepEqual, doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function element(id = "") {
  return {
    id,
    classList: {
      add() {},
      contains() {
        return false;
      },
      toggle() {},
    },
    style: { setProperty() {} },
    dataset: {},
    value: "",
    checked: false,
    focused: false,
    selected: false,
    textContent: "",
    innerHTML: "",
    title: "",
    setAttribute(name, value) {
      this[name] = value;
    },
    closest() {
      return this;
    },
    insertAdjacentHTML() {},
    insertBefore() {},
    appendChild() {},
    replaceWith() {},
    remove() {},
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
    addEventListener() {},
    getBoundingClientRect() {
      return { bottom: 100, height: 100, left: 0, top: 0, width: 100 };
    },
    querySelector() {
      return element();
    },
    querySelectorAll() {
      return [];
    },
  };
}

function context() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const localStorage = new Map();
  const ctx = {
    console,
    TextEncoder,
    URLSearchParams,
    clearTimeout,
    setInterval() {},
    setTimeout(fn) {
      return 1;
    },
    document: {
      body: getElement("body"),
      title: "",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    window: null,
    globalThis: null,
    xterm: { Terminal: class {} },
    WebSocket: class {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    addEventListener() {},
    prompt: () => null,
    confirm: () => true,
  };
  ctx.terminal = getElement("terminal");
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadWorkspaceSearch(ctx) {
  vm.runInContext(readFileSync(new URL("./shared/core.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(
    readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8"),
    ctx,
  );
}

describe("app bundle load", () => {
  let source;
  let gitUiSource;
  let gitLogSource;
  let gitActionsSource;
  let gitSettingsSource;
  let gitUiLogCss;
  let fileBrowserSource;
  let desktopWorkspacesCss;
  let readmeDoc;
  let installationDoc;
  let desktopTerminalSource;
  let appBootSource;

  beforeEach(() => {
    desktopTerminalSource = readFileSync(new URL("./desktop/app_js/terminal.js", import.meta.url), "utf8");
    appBootSource = readFileSync(new URL("./app_boot.js", import.meta.url), "utf8");
    const desktopAppSource = [
      "./desktop/app_js/core.js",
      "./desktop/app_js/panel_switcher.js",
      "./desktop/app_js/render.js",
      "./desktop/app_js/terminal.js",
      "./desktop/app_js/worktrees.js",
      "./desktop/app_js/shortcuts.js",
      "./desktop/app_js/workspace_create.js",
      "./desktop/app_js/bindings.js",
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("");
    source =
      readFileSync(new URL("./shared/core.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./shared/actions.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./shared/terminal_scroll.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./desktop/search.js", import.meta.url), "utf8") +
      "\n" +
      desktopAppSource;
    gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
    gitLogSource = readFileSync(new URL("./desktop/git_ui/log.js", import.meta.url), "utf8");
    gitActionsSource = readFileSync(new URL("./desktop/git_ui/actions.js", import.meta.url), "utf8");
    gitSettingsSource = readFileSync(new URL("./desktop/git_ui/settings.js", import.meta.url), "utf8");
    gitUiLogCss = readFileSync(new URL("./desktop/git_ui/log.css", import.meta.url), "utf8");
    fileBrowserSource = readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8");
    desktopWorkspacesCss = readFileSync(new URL("./desktop/app_css/workspaces.css", import.meta.url), "utf8");
    readmeDoc = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    installationDoc = readFileSync(new URL("../../docs/installation.md", import.meta.url), "utf8");
  });

  it("loads without initialization-order ReferenceError", () => {
    doesNotThrow(() => vm.runInContext(source, context()));
  });

  it("defines project-first dashboard and command-palette actions", () => {
    match(source, /function renderProjectDashboard\(\)/);
    match(source, /Start with a project/);
    match(source, /function searchActionCandidates\(query\)/);
    match(source, /HerdrActionRegistry\.candidates/);
    match(source, /Open workspace or worktree/);
    match(source, /Temporary terminal/);
    match(source, /runSearchAction\(result\.action\)/);
  });

  it("returns desktop UX actions from a single command-palette candidate path", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const actionNames = (query) => Array.from(ctx.searchActionCandidates(query), (action) => action.action);
    deepEqual(
      actionNames(""),
      ["open-workspace", "discover-worktrees", "temp-terminal", "sessions"],
    );
    deepEqual(
      actionNames("session"),
      ["sessions"],
    );
    deepEqual(
      actionNames("nonsense"),
      [],
    );
  });

  it("wires desktop project dashboard and command actions to expected launchers", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const dashboard = ctx.renderProjectDashboard();

    match(dashboard, /runSearchAction\('open-workspace'\)/);
    match(dashboard, /openSearchPalette\(\)/);
    match(dashboard, /Actions menu/);
    ok(!dashboard.includes("runSearchAction('temp-terminal')"));
    ok(!dashboard.includes("runSearchAction('sessions')"));
    match(source, /if \(action === "open-workspace" \|\| action === "discover-worktrees"\) openWorktreeOpenModal\(selectedWorkspaceRepoPath\(\), true\);/);
    match(source, /else if \(action === "temp-terminal" && tempTerminal\) tempTerminal\.open\(\);/);
    match(source, /else if \(action === "sessions"\) showSessionManager\(\);/);
    match(source, /else if \(action === "files"\) openWorkspaceFileBrowser\(state\.ws\);/);
    match(source, /else if \(action === "git"\) openWorkspaceGitUi\(state\.ws\);/);
  });

  it("uses one unified header Actions launcher instead of separate plus and temporary terminal buttons", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
    const ctx = context();
    vm.runInContext(source, ctx);

    ok(html.includes('id="headerActionsButton"'));
    ok(html.includes(">Actions<"));
    equal(html.includes('id="newWs"'), false);
    equal(html.includes('id="tempTerminalToggle"'), false);
    match(source, /headerActions\.onclick = \(\) => openSearchPalette\(\);/);
    ok(!source.includes('id="tempTerminalToggle"'));

    ctx.setupSessionChrome();
    const button = ctx.document.getElementById("headerActionsButton");
    equal(button.title, "Search and actions (Ctrl+B then /)");
    button.onclick();
    equal(ctx.document.getElementById("searchPalette").style.display, "grid");
  });

  it("adds configured shortcut labels to desktop tooltips", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({
      globalShortcutPrefix: "Ctrl+Q",
      webuiShortcuts: { help: "Shift+Slash", settings: "KeyS", newWorkspace: "KeyN", sidebar: "KeyB", newPanel: "KeyP", closePanel: "KeyX", closeWorkspace: "Shift+KeyX", removeWorktree: "Delete" },
    }));
    vm.runInContext(source, ctx);
    ctx.applyOptions();

    equal(ctx.document.getElementById("shortcutsToggle").title, "Shortcuts (Ctrl+Q then Shift+/)");
    equal(ctx.document.getElementById("settingsToggle").title, "Settings (Ctrl+Q then S)");
    equal(ctx.document.getElementById("headerActionsButton").title, "Search and actions (Ctrl+Q then /)");
    equal(ctx.document.getElementById("sidebarToggle").title, "Hide sidebar (Ctrl+Q then B)");
    equal(ctx.document.getElementById("tempTerminalMinimize").title, "Minimize temporary terminal (Ctrl+Q then Shift+M)");

    vm.runInContext(`
      state.ws = "w1";
      state.tab = "t1";
      state.tabs = [{ workspace_id: "w1", tab_id: "t1", label: "Shell" }];
    `, ctx);
    ok(ctx.renderPanelField().includes('title="New panel (Ctrl+Q then P)"'));
    ok(ctx.renderPanelField().includes('title="Close current panel (Ctrl+Q then X)"'));

    const actions = ctx.selectedWorkspaceActionButtons({ workspace_id: "w1", worktree: { checkout_path: "/tmp/wt", is_linked_worktree: true } });
    ok(actions.includes('Ctrl+Q then Shift+X'));
    ok(actions.includes('Ctrl+Q then Delete'));
  });

  it("adds configured shortcut labels to Git tooltips", () => {
    match(gitUiSource, /function titleWithGitShortcut\(title, action\)/);
    match(gitUiSource, /titleWithGitShortcut\("Refresh", "refresh"\)/);
    match(gitUiSource, /titleWithGitShortcut\("Change Git directory or switch branch", "branch"\)/);
    match(gitUiSource, /titleWithGitShortcut\("File history", "history"\)/);
    match(gitUiSource, /titleWithGitShortcut\("Blame", "blame"\)/);
  });

  it("shows project dashboard and hides terminal shell when no workspace exists", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const dashboard = ctx.document.getElementById("projectDashboard");
    const shell = ctx.document.getElementById("terminalShell");

    ctx.syncProjectDashboard();

    equal(dashboard.hidden, false);
    equal(shell.hidden, true);
    ok(dashboard.innerHTML.includes("Start with a project"));
    ok(dashboard.innerHTML.includes("Open workspace or worktree"));
    ok(dashboard.innerHTML.includes("Actions menu"));
    ok(!dashboard.innerHTML.includes("Start a shell without creating"));
  });

  it("hides project dashboard when Git or file drawer is visible without a workspace", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const dashboard = ctx.document.getElementById("projectDashboard");
    const shell = ctx.document.getElementById("terminalShell");

    ctx.window.HerdrGitUi = { isVisible: () => true };
    ctx.window.HerdrFileBrowser = { isVisible: () => false };
    ctx.syncProjectDashboard();
    equal(dashboard.hidden, true);
    equal(shell.hidden, false);

    ctx.window.HerdrGitUi = { isVisible: () => false };
    ctx.window.HerdrFileBrowser = { isVisible: () => true };
    ctx.syncProjectDashboard();
    equal(dashboard.hidden, true);
    equal(shell.hidden, false);

    ctx.window.HerdrFileBrowser = { isVisible: () => false };
    ctx.syncProjectDashboard();
    equal(dashboard.hidden, false);
    equal(shell.hidden, true);
  });

  it("keeps file history header scoped to selected files", () => {
    match(gitUiSource, /function renderFileToolbar\(activeTab\) \{\n\s+const view = active\(\) \|\| \{\};/);
    match(gitUiSource, /const history = view\.file \? `<button class="git-ui-btn \$\{activeTab === "history" \? "active" : ""\}" title="\$\{esc\(titleWithGitShortcut\("File history", "history"\)\)\}" onclick="HerdrGitUi\.tab\('history'\)">History<\/button>` : "";/);
    equal([...gitLogSource.matchAll(/git-ui-log-scope-head/g)].length, 1);
  });

  it("hides only large file diffs by default", () => {
    match(gitUiSource, /const LARGE_FILE_DIFF_LINE_LIMIT = 500;/);
    match(gitUiSource, /Large diffs are not rendered by default\./);
    match(gitUiSource, /Diff hidden to keep large change sets responsive\./);
    match(gitUiSource, /loadLargeDiff\(file, kind\)/);
    ok(!gitUiSource.includes("Select a file from left list to render its changes."));
    ok(!gitUiSource.includes("Large change set hidden"));
  });

  it("defines Git UI changes-list Escape navigation", () => {
    match(gitUiSource, /window\.addEventListener\("keydown", handleKeydown, true\);/);
    match(gitUiSource, /if \(tab === "changes"\) \{\n\s+this\.showChangesList\(\);\n\s+return;\n\s+\}/);
    match(gitUiSource, /if \(state\.commitModal\) \{\n\s+saveDraftFromDom\(\);\n\s+state\.commitModal = null;/);
    match(gitUiSource, /Hide Git UI\?/);
    match(gitUiSource, /function isChangesListView\(view\)/);
  });

  it("defaults and migrates terminal overflow scrollbars off", () => {
    match(source, /const defaultOptions = \{\n\s+overflow: false,/);
    match(source, /stored\.overflow === true && stored\.terminalOverflowOptIn !== true/);
    match(source, /options\.terminalOverflowOptIn = true;/);
  });

  it("refits terminal when overflow toggle changes", () => {
    match(source, /el\("optOverflow"\)\.onchange = \(\) => \{[\s\S]*?applyOptions\(\);[\s\S]*?requestAnimationFrame\(refitTerminal\)/);
    match(source, /if \(typeof fitTerminalShell === "function"\) fitTerminalShell\(\);/);
    match(source, /if \(typeof fitTerminalSurface === "function"\) fitTerminalSurface\(\);/);
  });

  it("keeps terminal surface min sizes mode-aware", () => {
    match(source, /if \(options\.overflow\) \{\n\s+terminal\.style\.width = width \+ "px";/);
    match(source, /terminal\.style\.minWidth = "0";\n\s+terminal\.style\.minHeight = "0";/);
    ok(!source.includes('terminal.querySelector(".xterm")'));
    ok(!source.includes('x.style.'));
    match(source, /shellStyle\.display === "none" \|\|\n\s+shellStyle\.visibility === "hidden" \|\|\n\s+\(shellRects && shellRects\.length === 0\)/);
    match(source, /function fitTerminalShell\(\) \{[\s\S]*?shell\.clientWidth \|\| rect\.width[\s\S]*?shell\.clientHeight \|\| rect\.height[\s\S]*?\};\n\}/);
    match(source, /function browserTerminalSize\(\) \{[\s\S]*?const shellSize = fitTerminalShell\(\);\n\s+if \(!shellSize\) return null;/);
    ok(!source.includes('terminal.style.height = "100%"'));
    ok(!source.includes('terminal.querySelector(".xterm-screen")'));
    ok(!source.includes('terminal.querySelector(".xterm-viewport")'));
    ok(!source.includes('terminal.querySelector(".xterm-rows")'));
    ok(!source.includes('shell.style.width ='));
    match(desktopTerminalSource, /fontFamily: terminalFontFamily\(\)/);
    match(desktopTerminalSource, /refreshTerminalAfterFontLoad\(target\)/);
    match(source, /theme: terminalTheme\(\)/);
    match(source, /term\.options\.theme = terminalTheme\(\)/);
    match(source, /term\.setOption\("theme", terminalTheme\(\)\)/);
  });

  it("keeps desktop terminal scrolling delegated to vanilla xterm", () => {
    const terminalCss = readFileSync(new URL("./desktop/app_css/terminal.css", import.meta.url), "utf8");

    ok(!terminalCss.includes(".terminal .xterm"));
    ok(!terminalCss.includes("xterm-selection"));
    ok(!terminalCss.includes("xterm-cursor"));
    match(terminalCss, /\.terminal-shell \{[\s\S]*?overflow: hidden;/);
    match(terminalCss, /\.terminal \{[\s\S]*?height: 100%;/);
    ok(!terminalCss.match(/\.terminal \.xterm-rows[\s\S]*?height: 100% !important;/));
    ok(!terminalCss.match(/\.terminal \.xterm-rows[\s\S]*?overflow: hidden !important;/));
    ok(!source.includes('el("terminalShell").addEventListener("contextmenu"'));
    match(desktopTerminalSource, /terminal\.addEventListener\("wheel", handleTerminalWheel, \{ passive: false, capture: true \}\);/);
    match(desktopTerminalSource, /terminal\.addEventListener\("touchstart", handleTerminalTouchStart, \{ passive: true, capture: true \}\);/);
    match(desktopTerminalSource, /terminal\.addEventListener\("touchmove", handleTerminalTouchMove, \{ passive: false, capture: true \}\);/);
    match(desktopTerminalSource, /terminal\.addEventListener\("touchend", handleTerminalTouchEnd, \{ passive: true, capture: true \}\);/);
    ok(!desktopTerminalSource.includes("attachCustomWheelEventHandler"));
    match(desktopTerminalSource, /e\.key === "PageUp" \|\| e\.key === "PageDown"/);
    match(desktopTerminalSource, /scrollTerminalLines\(\n\s+e\.key === "PageUp"/);
    ok(!desktopTerminalSource.includes("scrollBrowserOverflow"));
    ok(!source.includes("Option+Wheel"));
    match(desktopTerminalSource, /const stepLines = Math\.max\(1, Number\(options\.scrollLines\) \|\| 1\);/);
    match(desktopTerminalSource, /terminalWheelDeltaPixels \+= e\.deltaY;[\s\S]*?Math\.abs\(terminalWheelDeltaPixels\) < rowHeight/);
    match(desktopTerminalSource, /function scrollTerminalLines\(lines\) \{[\s\S]*?state\.backendMode === "builtin"[\s\S]*?term\.scrollLines\(Math\.trunc\(lines\)\);[\s\S]*?if \(sendBackendScroll\(lines\)\) \{[\s\S]*?updateTerminalScrollbackEstimate\(lines\);[\s\S]*?!terminalUsesNormalBuffer\(\)[\s\S]*?term\.scrollLines\(Math\.trunc\(lines\)\);/);
    match(desktopTerminalSource, /function sendBackendScroll\(lines\) \{[\s\S]*?state\.backendMode === "builtin"[\s\S]*?type: "scroll"[\s\S]*?direction: lines < 0 \? "up" : "down"/);
    match(desktopTerminalSource, /function setTerminalFollowPaused\(paused\) \{[\s\S]*?button\.hidden = !paused;/);
    match(desktopTerminalSource, /function updateTerminalScrollbackEstimate\(lines\) \{[\s\S]*?terminalScrollbackOffsetEstimate[\s\S]*?setTerminalFollowPaused\(terminalScrollbackOffsetEstimate > 0\);/);
    match(desktopTerminalSource, /shell\.addEventListener\("mouseup", \(\) => autoCopyTerminalSelection\(\{ allowFallback: true \}\), true\);/);
    match(desktopTerminalSource, /term\.onSelectionChange\(\(\) => \{[\s\S]*?autoCopyTerminalSelection\(\{ allowFallback: false \}\);/);
    ok(!desktopTerminalSource.includes("term.onScroll"));
    ok(!desktopTerminalSource.includes("term.scrollToLine"));
    ok(!desktopTerminalSource.includes("const shouldPreserve"));
    match(desktopTerminalSource, /shell\.scrollTop = 0;\n\s+shell\.scrollLeft = 0;/);
    match(desktopTerminalSource, /function sendBackendTail\(\) \{[\s\S]*?for \(let i = 0; i < 120; i \+= 1\)[\s\S]*?sendBackendScroll\(200\)/);
    match(desktopTerminalSource, /function scrollTerminalToBottom\(focus = true\) \{[\s\S]*?sendBackendTail\(\);[\s\S]*?setTerminalFollowPaused\(false\);[\s\S]*?term\.scrollToBottom\(\);/);
    match(desktopTerminalSource, /ws\.onopen = \(\) => \{[\s\S]*?scrollTerminalToBottom\(false\);/);
  });

  it("auto-copies non-empty terminal selections to the browser clipboard", async () => {
    const ctx = context();
    const writes = [];
    ctx.navigator.clipboard.writeText = async (text) => {
      writes.push(text);
    };
    vm.runInContext(source, ctx);

    const first = await vm.runInContext(`
      term = { getSelection() { return "copy me"; } };
      autoCopyTerminalSelection();
    `, ctx);
    const duplicate = await vm.runInContext("autoCopyTerminalSelection();", ctx);
    await vm.runInContext(`
      term = { getSelection() { return ""; } };
      autoCopyTerminalSelection();
    `, ctx);
    const afterClear = await vm.runInContext(`
      term = { getSelection() { return "copy me"; } };
      autoCopyTerminalSelection();
    `, ctx);

    equal(first, true);
    equal(duplicate, true);
    equal(afterClear, true);
    deepEqual(writes, ["copy me", "copy me"]);
  });

  it("falls back to execCommand copy when clipboard writeText is unavailable", async () => {
    const ctx = context();
    const commands = [];
    ctx.navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
    ctx.document.execCommand = (command) => {
      commands.push(command);
      return true;
    };
    vm.runInContext(source, ctx);

    const delayed = await vm.runInContext(`
      term = { getSelection() { return "fallback text"; } };
      autoCopyTerminalSelection({ allowFallback: false });
    `, ctx);
    const copied = await vm.runInContext(`
      term = { getSelection() { return "fallback text"; } };
      autoCopyTerminalSelection();
    `, ctx);

    equal(delayed, false);
    equal(copied, true);
    deepEqual(commands, ["copy"]);
  });

  it("keeps Git UI keyboard input away from the terminal", () => {
    match(gitUiSource, /Git drawer owns keyboard while visible/);
    match(gitUiSource, /event\.stopImmediatePropagation/);
    match(gitUiSource, /function handleGitShortcut\(event, view\)/);
    match(gitUiSource, /function isGitShortcutPrefix\(event\)/);
    match(gitUiSource, /function gitShortcutPrefixLabel\(\)/);
    match(gitUiSource, /function shortcutFilePath\(event, view\)/);
    match(gitUiSource, /DEFAULT_GIT_SHORTCUTS/);
    match(gitUiSource, /gitShortcutMap\(\)/);
    match(gitUiSource, /activateTreeItem\(event\)/);
    match(gitUiSource, /role="treeitem" tabindex="0" data-git-path=/);
    match(source, /HerdrGitUi\.isVisible\(\)\)\n\s+return false;/);
  });

  it("renders shortcut editor with collision detection", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.shortcutsModalHtml();

    match(html, /id="shortcutEditor"/);
    match(html, /Help &amp; Shortcuts/);
    match(html, /Functionality map/);
    match(html, /Keyboard shortcuts/);
    match(html, /Workspaces show open roots\/worktrees; agents list status/);
    match(html, /Wheel, touch, and PageUp\/PageDown scroll the Herdr backend when available; built-in backend uses xterm local scroll/);
    match(html, /file rows use license-safe type glyphs while folders stay plain except for Git status colors/);
    match(html, /Header search .* is the single search entry point for workspaces\/worktrees, file names, folder names, and file contents/);
    match(html, /File\/folder and content search run in the backend for the focused workspace\/worktree, lazy-load pages, preserve parent folders for path context/);
    match(html, /use Settings to enable sections and sort their order/);
    match(html, /Content results show as grouped files with highlighted match text, match-case and regex options, colored matched-line context/);
    match(html, /configurable default expanded\/collapsed file groups/);
    match(html, /Git-style arrow controls for more context above\/below/);
    match(html, /opening at the matched line with editor highlight/);
    match(html, /same CodeMirror editor surface as edit mode but stay read-only until Edit is pressed/);
    match(html, /line numbers show by default/);
    match(html, /fold controls work for supported languages/);
    match(html, /editor find supports match case and regex/);
    match(html, /edit mode enables replace/);
    match(html, /syntax\/search colors use shared theme tokens/);
    match(html, /Search selections, selected files, split panes, and unsaved edit drafts stay attached to each open workspace\/worktree while switching panels/);
    match(html, /priority red deleted, yellow modified, green new/);
    match(html, /Git selector opens repo tools for diff, stage\/unstage, discard, commit modal, commit & push, pull, push with force fallback, tag push option, rebase, conflicts, stash, branches, cleanup, and worktree prune/);
    match(html, /Changes, log, stash, and cleanup use one exclusive segmented toggle/);
    match(html, /file filter sits below the action toolbar/);
    match(html, /cleanup uses the shared broom icon/);
    match(html, /Prefix then \/ or the header magnifier opens one palette for workspaces, repos, worktrees, labels, agents, panels, file\/folder results, and file-content matches/);
    match(html, /Alt\+F selects files, Alt\+D selects folders, Alt\+1\/2\/3 toggles sections, and Alt\+↑\/↓ expands content context/);
    match(html, /Alt\+F\/Alt\+D inside the palette to switch file or folder search, Alt\+1\/2\/3 to collapse or expand search sections, and Alt\+↑\/↓ to expand selected content-match context/);
    match(source, /DEFAULT_WEBUI_SHORTCUTS/);
    match(source, /tempTerminalToggle: "Shift\+KeyM"/);
    match(source, /Open\/minimize\/restore temporary terminal/);
    match(source, /Open, minimize, or restore the temporary terminal/);
    match(source, /Temporary terminal captures Tab\/Backspace and normal input while open; Ctrl\+G detaches it through the close confirmation; \$\{escapeHtml\(globalShortcutPrefixLabel\(\)\)\} then Shift\+M opens, minimizes, or restores it/);
    match(readFileSync(new URL("../../docs/features.md", import.meta.url), "utf8"), /Ctrl\+B` then `Shift\+M` opens, minimizes to the corner restore pill, or restores the same live temporary terminal/);
    match(source, /removeWorktreeAlt: "Backspace"/);
    match(source, /removeWorktreeAlt: \(\) =>/);
    match(source, /DEFAULT_GIT_SHORTCUTS/);
    match(source, /function shortcutCollisionFor\(scope, action, key\)/);
    match(source, /data-shortcut-record/);
    match(source, /Shortcut conflict with:/);
    match(source, /optFileContentSearchDefaultExpanded/);
  });

  it("uses the WebUI prefix shortcut to manage temporary terminals", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext(`
      const modal = document.getElementById("tempTerminalModal");
      modal.style.display = "grid";
      tempTerminal = {
        visible: true,
        minimized: 0,
        opened: 0,
        isVisible() { return this.visible; },
        minimize() { this.minimized += 1; this.visible = false; modal.style.display = "none"; },
        open() { this.opened += 1; this.visible = true; modal.style.display = "grid"; },
      };
    `, ctx);

    const key = (code, key, extra = {}) => ({
      code,
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      propagationStopped: false,
      immediateStopped: false,
      target: ctx.document.body,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediateStopped = true; },
      ...extra,
    });

    let prefix = key("KeyB", "b", { ctrlKey: true });
    ctx.handleGlobalShortcut(prefix);
    equal(prefix.defaultPrevented, true);
    let shortcut = key("KeyM", "M", { shiftKey: true });
    ctx.handleGlobalShortcut(shortcut);
    equal(shortcut.defaultPrevented, true);
    equal(vm.runInContext("tempTerminal.minimized", ctx), 1);
    equal(vm.runInContext("tempTerminal.opened", ctx), 0);

    prefix = key("KeyB", "b", { ctrlKey: true });
    ctx.handleGlobalShortcut(prefix);
    shortcut = key("KeyM", "M", { shiftKey: true });
    ctx.handleGlobalShortcut(shortcut);
    equal(vm.runInContext("tempTerminal.minimized", ctx), 1);
    equal(vm.runInContext("tempTerminal.opened", ctx), 1);

    vm.runInContext(`document.getElementById("tempTerminalModal").style.display = "grid"; tempTerminal.visible = true;`, ctx);
    prefix = key("KeyB", "b", { ctrlKey: true });
    ctx.handleGlobalShortcut(prefix);
    const settings = key("KeyS", "s");
    ctx.handleGlobalShortcut(settings);
    equal(ctx.document.getElementById("settingsModal").style.display, undefined);
    equal(vm.runInContext("tempTerminal.minimized", ctx), 1);
  });

  it("keeps Git prefix shortcuts collision-free with WebUI prefix keys", () => {
    const webuiKeys = new Set([...source.matchAll(/case "([^"]+)":/g)].map((match) => match[1]));
    const gitKeys = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyC", "KeyL", "KeyR", "KeyG", "KeyY", "KeyU", "KeyD", "KeyZ", "KeyH", "KeyM", "KeyE", "KeyO", "KeyV", "KeyI", "Digit0"];
    equal(gitKeys.filter((key) => webuiKeys.has(key)).join(","), "");
  });

  it("defines Git cleanup tab and maintenance endpoints", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ok(!gitUiSource.includes("git-ui-cleanup-tab-icon"));
    match(gitUiSource, /renderGitViewTabs/);
    match(gitUiSource, /git-ui-view-toggle/);
    ok(gitUiSource.indexOf("Worktree actions") < gitUiSource.indexOf("git-ui-file-filter"));
    match(readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8"), /git-ui-view-toggle-group/);
    ok(!gitUiSource.includes("broom.svg"));
    match(gitUiSource, /scanCleanup/);
    match(gitUiSource, /selectAllCleanup/);
    match(gitUiSource, /Delete selected/);
    match(gitUiSource, /isNotGitRepositoryMessage/);
    match(gitUiSource, /markNoGitRepository\(view\)/);
    match(gitUiSource, /not_git_repository: true/);
    match(gitUiSource, /cleanupOnly \? "" : `<div class="git-ui-toolbar">/);
    match(gitUiSource, /const filterInput = sideFileCount\(view\)/);
    match(gitUiSource, /const fileList = cleanupOnly \? "" : `\$\{filterInput\}\$\{fileSections\}`;/);
    match(gitUiSource, /disabledReason = "Open a Git repository to use this view"/);
    const gitLayoutCss = readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8");
    match(gitLayoutCss, /\.git-ui-btn:disabled \{[\s\S]*?background: var\(--panel2\);[\s\S]*?color: var\(--muted\);/);
    match(gitLayoutCss, /\.git-ui-view-toggle:disabled \{[\s\S]*?background: var\(--panel2\);[\s\S]*?color: var\(--muted\);/);
    match(gitLayoutCss, /\.git-ui-modal label \{[\s\S]*?box-sizing: border-box;[\s\S]*?width: 100%;/);
    match(gitLayoutCss, /\.git-ui-input,[\s\S]*?\.git-ui-textarea,[\s\S]*?\.git-ui-select \{[\s\S]*?box-sizing: border-box;[\s\S]*?min-width: 0;[\s\S]*?width: 100%;/);
    match(gitUiSource, /\/api\/git-ui\/cleanup-scan/);
    match(gitUiSource, /\/api\/git-ui\/branch-delete/);
    match(gitUiSource, /\/api\/git-ui\/worktree-remove/);
    match(gitUiSource, /openCommitModal\(\)/);
    match(gitUiSource, /Stage changes before committing/);
    match(gitUiSource, /gitCommitIncludeBody/);
    match(gitUiSource, /gitUiPushTags/);
    match(gitUiSource, /Open PR/);
    ok(!gitUiSource.includes("openForcePushModal"));
    ok(!gitUiSource.includes("HerdrGitUi.tab('commit')"));
    ok(!gitUiSource.includes('onclick="HerdrGitUi.toggleStageAll()'));
  });

  it("offers conflict buttons for HEAD, parent, and remote sides", () => {
    match(gitUiSource, /renderConflictOperationActions/);
    match(gitUiSource, /aria-label="Conflict operation actions"/);
    match(gitUiSource, /Rebase<\/span>\$\{action\("Continue", "rebase-continue"\)\}\$\{action\("Skip", "rebase-skip"\)\}\$\{action\("Abort", "rebase-abort", true\)\}/);
    match(gitUiSource, /Merge<\/span>\$\{action\("Continue", "merge-continue"\)\}\$\{action\("Abort", "merge-abort", true\)\}/);
    match(gitUiSource, /Cherry-pick<\/span>\$\{action\("Continue", "cherry-pick-continue"\)\}\$\{action\("Abort", "cherry-pick-abort", true\)\}/);
    match(gitUiSource, /operationActions = renderConflictOperationActions\(\)/);
    match(gitUiSource, /Use HEAD/);
    match(gitUiSource, /Use parent/);
    match(gitUiSource, /Use remote/);
    match(gitUiSource, /HerdrGitUi\.resolve\('\$\{arg\(file\)\}','base'\)/);
    match(gitUiSource, /title="Use parent\/base version"/);
    match(gitUiSource, /title="Use remote\/incoming side"/);
    match(gitUiSource, /Mark resolved \(stage\)/);
    match(gitUiSource, /Stage this manually edited file as resolved/);
    match(gitUiSource, /After editing a conflicted file manually/);
    ok(!gitUiSource.includes(">Use branch</button>"));
    const gitLayoutCss = readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8");
    match(gitLayoutCss, /\.git-ui-conflict-file-actions \{[\s\S]*?flex-wrap: wrap;/);
  });

  it("uses a single selected-log reset modal and clear rebase wording", () => {
    match(gitActionsSource, /openSelectedResetModal\(\)/);
    match(gitActionsSource, /title="Rebase current changes over the selected commit"/);
    match(gitActionsSource, />Rebase…<\/button>/);
    match(gitActionsSource, /options\.allowRewrite/);
    ok(!gitActionsSource.includes("Reset soft</button><button"));
    match(gitUiSource, /renderResetSelectedModal/);
    match(gitUiSource, /renderCompareSelectedModal/);
    match(gitUiSource, /Compare selected commit/);
    match(gitUiSource, /Previous version shows the selected commit diff against its parent/);
    match(gitUiSource, /compareSelectedWithPrevious/);
    match(gitUiSource, /await this\.showHistoryCommit\(hash\)/);
    match(gitUiSource, /compareSelectedWithCurrent/);
    match(gitUiSource, /await this\.compareCommits\(hash, "\."\)/);
    match(gitUiSource, /Soft reset/);
    match(gitUiSource, /Hard reset/);
    match(gitUiSource, /selectedLogToolbar\(selected, \{ allowRewrite: currentMode\(\) === "changes", selectedBranch \}\)/);
    match(gitUiSource, /function commitPreviewSection/);
    match(gitUiSource, /Committed files/);
    match(gitUiSource, /loadSelectedCommitPreview\(view, view\.selectedLogCommits\[0\]\)/);
    match(gitUiSource, /base=\$\{encodeURIComponent\(`\$\{hash\}\^`\)\}/);
    match(gitUiSource, /openFileHistory\(cwd, path\)/);
    match(gitUiSource, /state\.visible && active\(\) && samePath\(active\(\)\.cwd, cwd\)/);
    match(gitUiSource, /view\.tab = "history";/);
    match(gitUiSource, /function fileViewStateLabel\(view, activeTab\)/);
    match(gitUiSource, /function captureNavigationSnapshot\(view, label\)/);
    match(gitUiSource, /function pushNavigationSnapshot\(view, label\)/);
    match(gitUiSource, /async function restoreNavigationSnapshot\(view, snapshot\)/);
    match(gitUiSource, /const labels = stack\.map\(\(item\) => item\.label \|\| "Git"\)\.concat\(currentNavigationLabel\(view\)\);/);
    match(gitUiSource, /const visible = stack\.length > 2/);
    match(gitUiSource, /\{ label: "…", ellipsis: true \}/);
    match(gitUiSource, /class="git-ui-breadcrumb-ellipsis" title="\$\{esc\(title\)\}"/);
    match(gitUiSource, /<span class="git-ui-breadcrumbs" title="\$\{esc\(title\)\}">/);
    match(gitUiLogCss, /\.git-ui-breadcrumb-sep \{[\s\S]*?font-size: 10px;/);
    match(gitUiLogCss, /\.git-ui-breadcrumb-ellipsis \{[\s\S]*?font-size: 11px;/);
    match(gitUiSource, /function renderNavigationTrail\(view\)/);
    match(gitUiSource, /onclick="HerdrGitUi\.goBack\(\)"/);
    match(gitUiSource, /pushNavigationSnapshot\(view\);\n\s+startHistoryCommitCompare\(view, hash\);/);
    match(gitUiSource, /if \(!\(view\.fileBackTarget && view\.fileBackTarget\.type === "log"\)\) pushNavigationSnapshot\(view\);/);
    match(gitUiSource, /view\.navigationStack = \[\];/);
    match(gitUiSource, /async goBack\(\)/);
    match(gitUiSource, /await restoreNavigationSnapshot\(view, snapshot\);/);
    match(gitUiSource, /History · \$\{view\.file\}/);
    match(gitUiSource, /Committed file · \$\{view\.file \|\| "file"\} · \$\{historicalFileCommitLabel\(view\)\}/);
    match(gitUiSource, /title="Back to file view" onclick="HerdrGitUi\.backToFileView\(\)"/);
    match(gitUiSource, /title="Back to file history" onclick="HerdrGitUi\.backToFileHistory\(\)"/);
    match(gitUiSource, /title="Back" onclick="HerdrGitUi\.backFromFileView\(\)"/);
    match(gitUiSource, /committed file<\/button>/);
    match(gitUiSource, /view\.temporaryHistoryCompare = !!view\.file;/);
    match(gitUiSource, /view\.historyCommitHash = hash;/);
    match(gitUiSource, /view\.fileBackTarget = \{ type: "log", hash \};/);
    match(gitUiSource, /const committedSelection = view\.temporaryHistoryCompare \|\| \(view\.fileBackTarget && view\.fileBackTarget\.type === "log"\);/);
    match(gitUiSource, /section\(`Committed files \$\{historicalFileCommitLabel\(view\)\}`/);
    match(gitUiSource, /view\.compareFilePaths = \[view\.file\];/);
    match(gitUiSource, /async backToFileHistory\(\)/);
    match(gitUiSource, /async backToFileView\(\)/);
    match(gitUiSource, /async backFromFileView\(\)/);
    match(gitUiSource, /view\.tab = "log";/);
    match(gitUiSource, /view\.selectedLogCommits = \[backTarget\.hash\];/);
    match(gitUiSource, /window\.HerdrFileBrowser\.openAt\(\{ workspace_id: state\.activeKey \|\| `git-file-history:\$\{cwd\}`/);
    match(gitUiSource, /view\.historySource = "file-browser";/);
    match(gitUiSource, /const compare = activeTab !== "history" && currentMode\(\) !== "changes"/);
    match(gitUiSource, /const ref = currentMode\(\) === "changes" \? "working" : \(view\.compareTarget \|\| "HEAD"\);/);
    match(gitUiSource, /ref_name=\$\{encodeURIComponent\(ref\)\}/);
    match(gitUiSource, /blame unavailable/);
    match(gitUiSource, /function sideFileCount\(view\)/);
    match(gitUiSource, /const filterInput = sideFileCount\(view\)/);
    match(gitUiSource, /const fileList = cleanupOnly \? "" : `\$\{filterInput\}\$\{fileSections\}`;/);
    match(gitUiSource, /status\.conflicted, status\.staged, status\.unstaged, status\.untracked/);
    match(gitUiSource, /Fetch selected branch before rebasing/);
    match(gitUiSource, /pull_first: pullFirst/);
    ok(!gitUiSource.includes('/api/git-ui/pull", { cwd: view.cwd, mode: "ff-only", branch }'));
  });

  it("gates stash tab by stash count and offers log tagging", () => {
    match(gitUiSource, /function stashCount\(view\)/);
    match(gitUiSource, /function canOpenStashView\(view\)/);
    match(gitUiSource, /No stashes stored\. Refresh to rescan\./);
    match(gitUiSource, /view\.tab === "stash" && !canOpenStashView\(view\)/);
    match(gitUiSource, /tab === "stash" && !canOpenStashView\(view\)/);
    match(gitActionsSource, />Tag<\/button>/);
    match(gitActionsSource, /openSelectedTagModal\(\)/);
    match(gitUiSource, /renderTagSelectedModal/);
    match(gitUiSource, /gitTagName/);
    match(gitUiSource, /\/api\/git-ui\/tag/);
  });

  it("keeps Git and file drawers on the newly selected workspace", () => {
    match(source, /gitWasVisible/);
    match(source, /fileWasVisible/);
    match(source, /openWorkspaceGitUi\(ws, \{ forceOpen: true \}\)/);
    match(source, /openWorkspaceFileBrowser\(ws, \{ forceOpen: true \}\)/);
    match(readFileSync(new URL("./desktop/app_js/render.js", import.meta.url), "utf8"), /HerdrGitUi\.open\(workspace, options \|\| \{\}\)/);
    match(readFileSync(new URL("./desktop/app_js/render.js", import.meta.url), "utf8"), /HerdrFileBrowser\.open\(workspace, options \|\| \{\}\)/);
    match(gitUiSource, /state\.visible && state\.activeKey === key && !openOptions\.forceOpen/);
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /state\.open && activeKey === key && !openOptions\.forceOpen/);
  });

  it("moves the diff layout toggle to the bottom of the Git side rail", () => {
    match(gitUiSource, /function renderDiffLayoutSideToggle/);
    match(gitUiSource, /git-ui-side-bottom/);
    ok(!gitUiSource.includes('<span class="git-ui-toolbar-title">${view.file ? "File view" : "Diff view"}</span>${changes}${history}${blame}${layoutToggle}'));
    const gitLayoutCss = readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8");
    match(gitLayoutCss, /\.git-ui-side-bottom \{[\s\S]*?margin-top: auto;/);
    match(gitLayoutCss, /\.git-ui-side-bottom \.git-ui-btn \{[\s\S]*?width: 100%;/);
  });


  it("documents and traps temporary terminal keyboard input", () => {
    const tempTerminalSource = readFileSync(new URL("./shared/temp_terminal.js", import.meta.url), "utf8");
    const terminalFitSource = readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8");
    const shortcutsSource = readFileSync(new URL("./desktop/app_js/shortcuts.js", import.meta.url), "utf8");
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
    const modalCss = readFileSync(new URL("./desktop/app_css/modals.css", import.meta.url), "utf8");

    match(tempTerminalSource, /document\.addEventListener\("keydown", tempTerminalKeydown, true\)/);
    match(tempTerminalSource, /if \(tempTerminalOwnsEventTarget\(event\.target\)\) \{/);
    match(tempTerminalSource, /terminalFocusRetainingInputForKey\(event\)/);
    match(tempTerminalSource, /shortcutLabelFn/);
    match(tempTerminalSource, /setShortcutTitle\(button, "Minimize temporary terminal"\)/);
    match(tempTerminalSource, /setShortcutTitle\(button, "Show temporary terminal"\)/);
    match(shortcutsSource, /tempTerminalToggle/);
    match(readFileSync(new URL("./desktop/app_js/bindings.js", import.meta.url), "utf8"), /shortcutLabelFn: \(\) => shortcutLabel\("webuiShortcuts", "tempTerminalToggle"\)/);
    match(tempTerminalSource, /if \(event\.key === "Backspace"\) return "\\x7f";/);
    match(tempTerminalSource, /if \(event\.key === "Tab"\) return event\.shiftKey \? "\\x1b\[Z" : "\\t";/);
    match(tempTerminalSource, /term\.element \|\| \(el\(containerId\) && el\(containerId\)\.querySelector/);
    match(tempTerminalSource, /case "Backspace": return "\\x7f";/);
    match(tempTerminalSource, /case "Tab": return event\.shiftKey \? "\\x1b\[Z" : "\\t";/);
    match(tempTerminalSource, /String\(event\.key \|\| ""\)\.toLowerCase\(\) === "g"/);
    match(shortcutsSource, /function tempTerminalModalOpen\(\)/);
    match(shortcutsSource, /if \(tempTerminalModalOpen\(\)\) return false;/);
    match(tempTerminalSource, /function terminalGridSize\(container\)/);
    match(tempTerminalSource, /function connectTerminalWsAfterLayout\(terminalId, attempt\)/);
    match(tempTerminalSource, /ensureTerminalSurface\(container\)/);
    match(tempTerminalSource, /function waitForTerminalFit\(container, attempt, callback\)/);
    match(tempTerminalSource, /HerdrTerminalFit\.gridSize\(container, term/);
    match(tempTerminalSource, /HerdrTerminalFit\.cellSize\(term, container/);
    match(tempTerminalSource, /HerdrTerminalFit\.fitXtermToContainer\(container\)/);
    match(terminalFitSource, /function cellSize\(term, container, fallback\)/);
    match(terminalFitSource, /function gridSize\(container, term, options\)/);
    match(terminalFitSource, /function fitXtermToContainer\(container, options\)/);
    match(terminalFitSource, /root\.HerdrTerminalFit/);
    match(tempTerminalSource, /resizeTerminalSurface\(container, cols, rows\)/);
    match(tempTerminalSource, /box\.width >= 320 && box\.height >= 120/);
    match(tempTerminalSource, /function afterBrowserLayout\(callback\)/);
    match(tempTerminalSource, /rowReserve: 1/);
    match(terminalFitSource, /rows: Math\.max\(opts\.minRows \|\| 8,/);
    ok(!tempTerminalSource.includes("setTimeout(handleResize, 0)"));
    match(modalCss, /height: min\(80vh, calc\(100dvh - 32px\)\)/);
    match(modalCss, /width: calc\(100vw - 32px\);\n\s+max-width: none;/);
    ok(!modalCss.includes("max-width: 1200px"));
    match(modalCss, /\.temp-terminal-body \{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
    match(modalCss, /\.temp-terminal-body \.xterm \{[\s\S]*?height: 100%;[\s\S]*?width: 100%;/);
    match(html, /Input captured · Ctrl\+G detaches/);
    match(html, /aria-label="Minimize temporary terminal"/);
    match(html, /aria-label="Detach temporary terminal"/);
    match(modalCss, /\.temp-terminal-hint/);
    match(modalCss, /\.temp-terminal-restore \{[\s\S]*?position: fixed;[\s\S]*?right: calc\(env\(safe-area-inset-right, 0px\) \+ 18px\);/);
    match(source, /Ctrl\+G<\/kbd><span>Detach temporary terminal/);
    match(source, /Temporary terminal captures Tab\/Backspace and normal input while open/);
  });

  it("defines file explorer and Git file filters", () => {
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /q=\$\{encodeURIComponent\(target\.filter\.trim\(\)\)\}/);
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /showSearch\(\)/);
    const sharedFileTreeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");
    const desktopFileBrowserSource = readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8");
    const mobileFileBrowserSource = readFileSync(new URL("./mobile/file_browser.js", import.meta.url), "utf8");
    const desktopWorktreesSource = readFileSync(new URL("./desktop/app_js/worktrees.js", import.meta.url), "utf8");
    const mobileWorktreesSource = readFileSync(new URL("./mobile/worktrees.js", import.meta.url), "utf8");
    const directoryPickerSource = readFileSync(new URL("./desktop/directory_picker.js", import.meta.url), "utf8");
    match(sharedFileTreeSource, /renderCurrentDirectoryRow/);
    match(sharedFileTreeSource, /herdr-tree-up-action/);
    match(sharedFileTreeSource, /value === "~"/);
    match(desktopFileBrowserSource, /Tree\.renderCurrentDirectoryRow/);
    match(mobileFileBrowserSource, /Tree\.renderCurrentDirectoryRow/);
    match(desktopFileBrowserSource, /permission_required/);
    match(desktopFileBrowserSource, /Grant folder access/);
    match(desktopFileBrowserSource, /\/api\/file-browser\/request-access/);
    match(desktopFileBrowserSource, /Herdr needs folder access to browse or search this folder\./);
    match(desktopFileBrowserSource, /setError\(target, error\);\n\s+target\.filterDone = true;/);
    match(desktopFileBrowserSource, /Folder access is required to search file contents\./);
    match(directoryPickerSource, /permission_required/);
    match(directoryPickerSource, /Grant folder access/);
    match(directoryPickerSource, /function configuredDefaultFolder\(\)/);
    match(directoryPickerSource, /typeof window\.defaultFolderPath === "function"/);
    match(directoryPickerSource, /function initialPickerPath\(input\)/);
    match(directoryPickerSource, /if \(!text \|\| text === "\/"\) return configuredDefaultFolder\(\);/);
    match(directoryPickerSource, /const parts = splitPath\(initialPickerPath\(input\)\);/);
    match(desktopWorktreesSource, /function usefulDirectoryDefault\(value\)/);
    match(desktopWorktreesSource, /return usefulDirectoryDefault\(defaultFolderPath\(\)\) \|\| usefulDirectoryDefault\(options\.explorationDefaultDirectory\) \|\| "~";/);
    match(mobileWorktreesSource, /defaultFolderFn/);
    match(mobileWorktreesSource, /if \(defaultFolder\) return defaultFolder;/);
    match(directoryPickerSource, /Tree\.renderCurrentDirectoryRow/);
    ok(!directoryPickerSource.includes("Tree.upEntry"));
    ok(!directoryPickerSource.includes(">Root</button>"));
    ok(!desktopFileBrowserSource.includes("entries.unshift(Tree.upEntry"));
    ok(!mobileFileBrowserSource.includes("entries.unshift(Tree.upEntry"));
    const fileTreeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");
    const fileIconSource = readFileSync(new URL("./shared/file_icons.js", import.meta.url), "utf8");
    const fileIconCss = readFileSync(new URL("./shared/file_icons.css", import.meta.url), "utf8");
    match(fileIconSource, /FILE_ICON_BY_EXT/);
    match(fileIconSource, /FILE_ICON_BY_NAME/);
    ok(!fileIconSource.includes("FOLDER_ICON_BY_NAME"));
    match(fileTreeSource, /HerdrFileIcons/);
    match(fileIconCss, /color: currentColor/);
    ok(!fileIconCss.includes("--file-icon-color"));
    match(appBootSource, /\/assets\/shared\/file-icons\.js/);
    match(appBootSource, /\/assets\/shared\/file-icons\.css/);
    match(appBootSource, /\/assets\/shared\/content-search\.css/);
    match(appBootSource, /\/assets\/shared\/colors\.css/);
    match(appBootSource, /\/assets\/shared\/line-context\.js/);
    match(appBootSource, /\/assets\/shared\/file-content-search\.js/);
    const fileContentSearchSource = readFileSync(new URL("./shared/file_content_search.js", import.meta.url), "utf8");
    const workspaceSearchSource = readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8");
    const searchSource = readFileSync(new URL("./desktop/search.js", import.meta.url), "utf8");
    const lineContextSource = readFileSync(new URL("./shared/line_context.js", import.meta.url), "utf8");
    const sharedColorsCss = readFileSync(new URL("./shared/colors.css", import.meta.url), "utf8");
    const sharedContentSearchCss = readFileSync(new URL("./shared/content_search.css", import.meta.url), "utf8");
    match(fileContentSearchSource, /HerdrContentSearch/);
    match(lineContextSource, /HerdrLineContext/);
    match(lineContextSource, /nextContextSize/);
    match(lineContextSource, /pushMergedChunk/);
    match(fileContentSearchSource, /lineChunks/);
    match(fileContentSearchSource, /mergeChunk/);
    ok(!fileContentSearchSource.includes("function renderMatch"));
    ok(!fileContentSearchSource.includes("<article class=\"herdr-content-search-match"));
    ok(!fileContentSearchSource.includes("expandAll"));
    ok(!fileContentSearchSource.includes("Collapse all"));
    match(fileContentSearchSource, /herdr-content-search-hit/);
    match(fileContentSearchSource, /herdr-content-search-context-cell/);
    match(fileContentSearchSource, /herdr-content-search-context-arrow/);
    match(fileContentSearchSource, /Show more above/);
    match(fileContentSearchSource, /Show more below/);
    ok(!fileContentSearchSource.includes("More above"));
    ok(!fileContentSearchSource.includes("More below"));
    match(fileContentSearchSource, /openMatch/);
    match(searchSource, /Alt\+↑|ArrowUp/);
    match(searchSource, /Digit1/);
    match(workspaceSearchSource, /fileContentSearchDefaultExpanded/);
    match(readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8"), /setFileContentSearchDefaultExpanded/);
    match(sharedColorsCss, /--herdr-search-hit-bg/);
    match(sharedColorsCss, /--herdr-search-hit-border/);
    match(sharedColorsCss, /--herdr-search-hit-shadow/);
    match(sharedColorsCss, /--herdr-search-match-border/);
    match(sharedColorsCss, /--herdr-content-panel-bg/);
    match(sharedContentSearchCss, /herdr-content-search-context-arrow/);
    match(sharedContentSearchCss, /herdr-content-search-hit/);
    match(sharedContentSearchCss, /font-weight: 700/);
    match(workspaceSearchSource, /preserveExpanded/);
    match(workspaceSearchSource, /pathSearchAvailable/);
    match(workspaceSearchSource, /normalizePathKind/);
    match(searchSource, /renderSearchPalettePreservingScroll/);
    const editorSource = readFileSync(new URL("./vendor/codemirror_entry.mjs", import.meta.url), "utf8");
    match(editorSource, /foldGutter/);
    match(editorSource, /foldKeymap/);
    match(editorSource, /readableHighlightStyle/);
    match(editorSource, /--editor-syntax-keyword/);
    match(editorSource, /languageNameForPath/);
    match(editorSource, /EditorView\.contentAttributes\.of\(\{ "data-language": languageNameForPath\(opts\.path\) \}\)/);
    match(editorSource, /searchHighlightExtensions/);
    match(editorSource, /scrollToSearchHighlight/);
    ok(!editorSource.includes("defaultHighlightStyle"));
    match(readFileSync(new URL("./desktop/app_css/base.css", import.meta.url), "utf8"), /--editor-syntax-string: #a6e3a1/);
    match(readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8"), /--editor-syntax-string: #a6e3a1/);
    match(source, /id="optFileBrowserLineNumbers"/);
    ok(!source.includes("optFileBrowserPathSearch"));
    match(source, /id="optFileBrowserSearchPageSize"/);
    match(source, /id="optFileContentSearchMinChars"/);
    match(source, /id="optFileContentSearchPageSize"/);
    match(source, /id="optFileContentSearchContextLines"/);
    match(source, /id="optFileContentSearchAutoCollapseFiles"/);
    match(source, /id="optFileContentSearchDefaultExpanded"/);
    match(source, /id="optFileContentSearchMatchesPerFile"/);
    match(source, /id="optFileContentSearchMatchCase"/);
    match(source, /id="optFileContentSearchRegex"/);
    match(source, /fileBrowserSearchPageSize: 100/);
    match(source, /fileContentSearchMinChars: 3/);
    match(source, /fileContentSearchPageSize: 50/);
    match(source, /fileContentSearchContextLines: 2/);
    match(source, /fileContentSearchDefaultExpanded: true/);
    match(source, /fileContentSearchMatchCase: false/);
    match(source, /fileContentSearchRegex: false/);
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /\/api\/file-browser\/content-search/);
    match(readFileSync(new URL("./mobile/file_browser.js", import.meta.url), "utf8"), /HerdrMobileFilesContent/);
    ok(!readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8").includes("setFileBrowserPathSearch"));
    match(readFileSync(new URL("./mobile/settings.js", import.meta.url), "utf8"), /setFileContentSearchContextLines/);
    match(gitUiSource, /placeholder="Filter files"/);
    match(gitUiSource, /filterFiles/);
  });

  it("uses shared file tree rows for Git files with Git metadata", () => {
    const fileTreeSource = readFileSync(new URL("./shared/file_tree.js", import.meta.url), "utf8");
    const gitLayoutCss = readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8");

    match(gitUiSource, /FileTree\.renderPathTree\(files, \{/);
    match(gitUiSource, /statusForPath: fileTreeStatus/);
    match(gitUiSource, /function fileSummaryEntries\(path, kind\)/);
    match(gitUiSource, /function normalizeFileTreeStatus\(status, kind\)/);
    match(fileTreeSource, /opts\.statusForPath\(dirPath, opts\.kind\)/);
    match(fileTreeSource, /opts\.metaForPath\(dirPath, opts\.kind\)/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.git-ui-file \{[\s\S]*?display: grid;/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.git-ui-file:is\(\.git-modified, \.git-added, \.git-untracked, \.git-deleted, \.git-changed, \.git-conflict\)/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.git-ui-file:is\(\.git-modified, \.git-added, \.git-untracked, \.git-deleted, \.git-changed, \.git-conflict\) \{\s*color: var\(--fg\);/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.git-ui-dir:is\(\.git-modified, \.git-added, \.git-untracked, \.git-deleted, \.git-changed, \.git-conflict\) \{\s*color: var\(--muted\);/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.file\.git-ui-file \.herdr-tree-icon:not\(\.herdr-tree-icon-filetype\) \{\s*background: var\(--muted\);/);
    match(gitLayoutCss, /\.git-ui-list \.herdr-tree-row\.dir\.git-ui-file \.herdr-tree-icon:not\(\.herdr-tree-icon-filetype\) \{\s*background: var\(--accent\);/);
    match(gitLayoutCss, /\.git-ui-file-icon\.conflict/);
  });

  it("supports Ctrl+F search across compared Git diff text", () => {
    const gitLogCss = readFileSync(new URL("./desktop/git_ui/log.css", import.meta.url), "utf8");
    const gitDiffCss = readFileSync(new URL("./desktop/git_ui/diff.css", import.meta.url), "utf8");

    match(gitUiSource, /function handleDiffSearchShortcut\(event, view\)/);
    match(gitUiSource, /editableTarget\(event\.target\)/);
    match(gitUiSource, /event\.ctrlKey && !event\.metaKey|!event\.ctrlKey && !event\.metaKey/);
    match(gitUiSource, /id="gitUiDiffSearch"/);
    match(gitUiSource, /state\.focusDiffSearch = true/);
    match(gitUiSource, /function highlightDiffText\(code, path\)/);
    match(gitUiSource, /const rows = unified \? unifiedRows\(chunk\) : sideBySideRows\(chunk\)/);
    match(gitUiSource, /<mark class="git-ui-search-match">/);
    match(gitUiSource, /renderDiffCode\(oldLine, newLine, path, "old"\)/);
    match(gitUiSource, /renderDiffCode\(oldLine, newLine, path, "new"\)/);
    match(gitUiSource, /highlightDiffText\(content\.slice\(changed\.start, changed\.end\), path\)/);
    match(gitLogCss, /\.git-ui-diff-search \{/);
    match(gitDiffCss, /\.git-ui-search-match \{/);
  });

  it("keeps content search file expansion when context is reloaded", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ fileContentSearchDefaultExpanded: false }));
    loadWorkspaceSearch(ctx);
    const helper = ctx.HerdrWorkspaceSearch;

    const state = helper.createContentState({ expanded: { "src/a.js": true, "src/b.js": false } });
    helper.applyContentResults(state, { files: [{ path: "src/a.js" }, { path: "src/b.js" }], total_matches: 2 }, false, { preserveExpanded: true });

    equal(state.expanded["src/a.js"], true);
    equal(state.expanded["src/b.js"], false);

    helper.applyContentResults(state, { files: [{ path: "src/a.js" }], total_matches: 1 }, false);
    equal(state.expanded["src/a.js"], false);
  });

  it("normalizes shared path search settings", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ searchFilesEnabled: false, searchFoldersEnabled: true }));
    loadWorkspaceSearch(ctx);
    const helper = ctx.HerdrWorkspaceSearch;

    equal(helper.pathSearchAvailable(helper.settings()), true);
    equal(helper.normalizePathKind("file", helper.settings()), "dir");

    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ searchFilesEnabled: false, searchFoldersEnabled: false }));
    const disabled = helper.settings();
    equal(helper.pathSearchAvailable(disabled), false);
    equal(helper.normalizePathKind("dir", disabled), "dir");
  });

  it("normalizes shared search settings order and bounds", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({
      searchSectionOrder: "content,files,content,unknown",
      fileBrowserSearchPageSize: 9999,
      fileContentSearchMinChars: 999,
      fileContentSearchPageSize: 1,
      fileContentSearchContextLines: -5,
      fileContentSearchAutoCollapseFiles: 999,
      fileContentSearchMatchesPerFile: 999,
      fileContentSearchDefaultExpanded: false,
      fileContentSearchMatchCase: true,
      fileContentSearchRegex: true,
    }));
    loadWorkspaceSearch(ctx);

    const opts = ctx.HerdrWorkspaceSearch.settings();
    equal(JSON.stringify(opts.searchSectionOrder), JSON.stringify(["content", "files", "workspaces"]));
    equal(opts.pathPageSize, 500);
    equal(opts.contentMinChars, 20);
    equal(opts.contentPageSize, 10);
    equal(opts.contextLines, 0);
    equal(opts.autoCollapseFiles, 200);
    equal(opts.matchesPerFile, 50);
    equal(opts.defaultExpanded, false);
    equal(opts.matchCase, true);
    equal(opts.regex, true);
  });

  it("uses shared search settings to skip disabled APIs and clamp query params", async () => {
    const ctx = context();
    const urls = [];
    ctx.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, statusText: "OK", json: async () => ({ entries: [], files: [], truncated: false }) };
    };
    loadWorkspaceSearch(ctx);
    const helper = ctx.HerdrWorkspaceSearch;

    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ searchFilesEnabled: false, searchFoldersEnabled: false, searchContentEnabled: false }));
    const disabledPath = await helper.searchPaths({ cwd: "/tmp/repo", query: "needle" });
    equal(disabledPath.disabled, true);
    equal(disabledPath.entries.length, 0);
    equal(disabledPath.git_status, null);
    equal(disabledPath.truncated, false);
    const disabledContent = await helper.searchContent({ cwd: "/tmp/repo", query: "needle" });
    equal(disabledContent.disabled, true);
    equal(disabledContent.files.length, 0);
    equal(disabledContent.total_files, 0);
    equal(disabledContent.total_matches, 0);
    equal(disabledContent.truncated, false);
    equal(urls.length, 0);

    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({
      fileBrowserGitStatus: false,
      fileBrowserSearchPageSize: 25,
      fileContentSearchPageSize: 15,
      fileContentSearchMatchCase: true,
      fileContentSearchRegex: true,
    }));
    await helper.searchPaths({ cwd: "/tmp/a b", query: "hello world", kind: "file", offset: 5 });
    match(urls[0], /^\/api\/file-browser\/tree\?/);
    match(urls[0], /cwd=%2Ftmp%2Fa%20b/);
    match(urls[0], /q=hello%20world/);
    match(urls[0], /search_kind=file/);
    match(urls[0], /offset=5/);
    match(urls[0], /limit=25/);
    ok(!urls[0].includes("include_git_status=true"));

    await helper.searchContent({ cwd: "/tmp/repo", query: "needle", contextLines: 99, matchesPerFile: 0 });
    match(urls[1], /^\/api\/file-browser\/content-search\?/);
    match(urls[1], /context_lines=20/);
    match(urls[1], /max_matches_per_file=1/);
    match(urls[1], /limit=15/);
    match(urls[1], /match_case=true/);
    match(urls[1], /regex=true/);
  });

  it("renders new workspace modal with manual folder field", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.workspaceCreateModalHtml();

    match(html, /id="workspaceCreatePath"/);
    ok(!html.includes("workspacePathOptions"));
    match(html, /id="workspaceCreateLabel"/);
    match(html, /id="workspaceCreateSubmit"/);
  });

  it("renders unified workspace and worktree opener", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.worktreeOpenModalHtml();

    match(html, /<h2>Open workspace or worktree<\/h2>/);
    match(html, /id="worktreeDiscoverPath"/);
    match(html, /id="worktreeWorkspaceLabel"/);
    match(html, /id="worktreeWorkspaceSubmit"/);
    match(html, /id="worktreeOpenList"/);
    match(html, /id="worktreeNewSection"/);
    ok(html.indexOf('id="worktreeNewSection"') < html.indexOf('id="worktreeWorkspaceSection"'));
    ok(html.indexOf('class="worktree-workspace-name"') < html.indexOf('id="worktreeWorkspaceLabel"'));
    match(html, /class="option worktree-pull-option"/);
    match(html, /Update base first/);
    match(html, /id="worktreeOpenRefresh"/);
    match(html, /class="app-refresh-icon"/);
    ok(!source.includes('id = "openWorktrees"'));
  });

  it("detects diverging fast-forward pull failures", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ok(ctx.pullFastForwardFailed("fatal: Not possible to fast-forward, aborting."));
    ok(ctx.pullFastForwardFailed("hint: Diverging branches can't be fast-forwarded"));
    ok(!ctx.pullFastForwardFailed("network failed while fetching origin"));
  });

  it("resolves workspace path from pane cwd when workspace metadata is missing", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext(`state.panes = [
      {
        workspace_id: "ws1",
        cwd: "/repo/from-pane",
        foreground_cwd: "/repo/from-foreground",
      },
    ];`, ctx);

    equal(ctx.workspacePath({ workspace_id: "ws1" }), "/repo/from-foreground");
    equal(
      ctx.workspacePath({ workspace_id: "ws1", cwd: "/repo/from-workspace" }),
      "/repo/from-workspace",
    );
  });

  it("renders server access settings fields", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.serverSettingsHtml();

    match(html, /id="optServerBind"/);
    match(html, /id="optServerUser"/);
    match(html, /id="optServerPassword"/);
    match(html, /id="optServerLocalBypass"/);
    match(html, /id="optBackendMode"/);
    match(html, /id="optBuiltinBackendEnabled"/);
    match(html, /id="optExternalHerdrBackendEnabled"/);
    match(html, /id="optBuiltinShell"/);
    match(html, /id="optDefaultFolder"/);
    match(html, /id="optNoSleepAutoCooldown"/);
    match(html, /id="serverSettingsApply"/);
    match(html, /<h3>Network access<\/h3>/);
    match(html, /<h3>Backend<\/h3>/);
    match(html, /<h3>Power behavior<\/h3>/);
    match(html, /\.config\/herdr-webui\/webui-settings\.json/);
    match(source, /el\("optBackendMode"\)\.value = settings\.backend_mode \|\| "builtin";/);
    match(source, /el\("optBuiltinBackendEnabled"\)\.checked = settings\.builtin_backend_enabled !== false;/);
    match(source, /el\("optExternalHerdrBackendEnabled"\)\.checked = settings\.external_herdr_backend_enabled !== false;/);
    match(source, /backend_mode: backendMode,/);
    match(source, /builtin_backend_enabled: builtinBackendEnabled,/);
    match(source, /external_herdr_backend_enabled: externalHerdrBackendEnabled,/);
    match(source, /builtin_shell: builtinShell \|\| null,/);
    match(source, /default_folder: defaultFolder \|\| null,/);
    match(source, /state\.defaultFolder = settings\.default_folder/);
    match(source, /selectedOrDefaultWorkspace/);
    match(source, /defaultFolderFn: defaultFolderPath/);
    ok(!source.includes('body: JSON.stringify({ label: "default", cwd: null })'));
  });

  it("labels the side footer backend as built-in for built-in backends", async () => {
    const ctx = context();
    ctx.fetch = async (url) => {
      equal(url, "/api/versions");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          webui: "1.2.3",
          backend: "builtin-0.1.0",
          backend_mode: "builtin",
          session: "default",
          compatibility: { status: "compatible" },
        }),
      };
    };
    vm.runInContext(source, ctx);

    await ctx.loadVersions();

    equal(
      ctx.document.getElementById("versions").textContent,
      "webui 1.2.3 · backend built-in",
    );
    equal(ctx.document.getElementById("footerSessionButton").textContent, "default · built-in");

    ctx.fetch = async (url) => {
      equal(url, "/api/versions");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          webui: "1.2.3",
          backend: "builtin-0.1.0",
          backend_mode: "auto",
          session: "default",
          compatibility: { status: "compatible" },
        }),
      };
    };

    await ctx.loadVersions();

    equal(
      ctx.document.getElementById("versions").textContent,
      "webui 1.2.3 · backend built-in",
    );

    ctx.fetch = async (url) => {
      equal(url, "/api/versions");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          webui: "1.2.3",
          backend: "0.7.3",
          backend_mode: "external",
          session: "default",
          compatibility: { status: "compatible" },
        }),
      };
    };

    await ctx.loadVersions();

    equal(
      ctx.document.getElementById("versions").textContent,
      "webui 1.2.3 · backend 0.7.3",
    );
  });

  it("filters OSC color query replies before terminal input reaches the backend", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(
      ctx.stripTerminalQueryReplies("\x1b]10;rgb:4c4c/4f4f/6969\x07hello\x1b]11;rgb:efef/f1f1/f5f5\x1b\\"),
      "hello",
    );
    equal(
      ctx.stripTerminalQueryReplies("\x1b]4;10;rgb:d7d7/ffff/d6d6\x1b\\prompt"),
      "prompt",
    );
    equal(ctx.stripTerminalQueryReplies("4;10;rgb:d7d7/ffff/d6d6\\prompt"), "prompt");
    equal(ctx.stripTerminalQueryReplies("\x1b]12;rgb:d7d7/ffff/d6d6\x07prompt"), "prompt");
    equal(ctx.stripTerminalQueryReplies("\x1b[1;1Rprompt"), "prompt");
    equal(ctx.stripTerminalQueryReplies("before\x1b[24;80Rafter"), "beforeafter");
    equal(ctx.stripTerminalQueryReplies("\x1b[?1;1Rprompt"), "prompt");
    equal(ctx.stripTerminalQueryReplies("normal input"), "normal input");
  });

  it("renders default shell panels as numeric panel labels", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext(`
      state.ws = "ws1";
      state.tab = "tab2";
      state.panelMenuOpen = true;
      state.tabs = [
        { workspace_id: "ws1", tab_id: "tab1", label: "shell", number: 1 },
        { workspace_id: "ws1", tab_id: "tab2", label: "shell", number: 2 },
        { workspace_id: "ws1", tab_id: "tab3", label: "custom", number: 3 },
      ];
    `, ctx);

    const html = ctx.renderPanelField();

    match(html, /<span>2<\/span>/);
    match(html, />1<\/button>/);
    match(html, />2<\/button>/);
    match(html, />custom<\/button>/);
    equal(html.includes(">shell</button>"), false);
    equal(ctx.panelRenameInitialLabel({ label: "shell", number: 1 }), "");

    vm.runInContext(`
      state.ws = "ws2";
      state.tab = "ws2-tab1";
      state.tabs = [
        { workspace_id: "ws2", tab_id: "ws2-tab1", label: "shell", number: 1 },
        { workspace_id: "ws2", tab_id: "ws2-tab2", label: "shell", number: 2 },
      ];
    `, ctx);
    match(ctx.renderPanelField(), /<span>1<\/span>/);
  });

  it("keeps session manager buttons on one rounded style", () => {
    match(source, /class="session-button primary" id="newBuiltinSessionTarget"/);
    match(source, /class="session-button" id="newHerdrSessionTarget"/);
    ok(!source.includes('class="tab add" id="newHerdrSessionTarget"'));
    ok(!source.includes('class="mini danger" onclick="event.stopPropagation\(\);closeCurrentSession'));
    match(desktopWorkspacesCss, /\.session-button \{/);
    match(desktopWorkspacesCss, /border-radius: 10px;/);
  });

  it("renders backend-aware session manager and sends backend target headers", async () => {
    const ctx = context();
    const calls = [];
    ctx.history = {
      pushState(_state, _title, path) {
        ctx.location.pathname = path;
      },
      replaceState(_state, _title, path) {
        ctx.location.pathname = path;
      },
    };
    ctx.fetch = async (url, opt = {}) => {
      calls.push({ url, opt });
      if (url === "/api/sessions") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            current_backend: "builtin",
            sessions: [
              { name: "default", backend: "builtin", backend_label: "built-in", running: true },
              { name: "work", backend: "external-herdr", backend_label: "Herdr", running: true },
            ],
          }),
        };
      }
      if (url === "/api/session/launch") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url === "/api/versions") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            backend_mode: "builtin",
            current_backend: opt.headers && opt.headers["x-herdr-backend"],
            session: "work",
            compatibility: { status: "compatible" },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    vm.runInContext(source, ctx);

    await ctx.showSessionManager();

    const html = ctx.document.getElementById("sessionList").innerHTML;
    match(html, /built-in/);
    match(html, /Herdr/);
    ctx.goSession("work", "external-herdr");
    await ctx.launchBackend("work", "external-herdr");

    equal(vm.runInContext("state.sessionBackend", ctx), "external-herdr");
    equal(ctx.apiOptions({}).headers["x-herdr-backend"], "external-herdr");
    equal(ctx.apiOptions({}).headers["x-herdr-session"], "work");
    const launchCall = calls.find((call) => call.url === "/api/session/launch");
    deepEqual(JSON.parse(launchCall.opt.body), {
      session: "work",
      backend: "external-herdr",
    });
  });

  it("defines grouped settings sections", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id=\"settingsSearch\"/);
    match(source, /function setupSettingsSearch\(\)/);
    match(source, /function filterSettings\(\)/);
    match(source, /settings-filter-hidden/);
    match(source, /title: "Appearance"/);
    match(source, /title: "Terminal input"/);
    match(source, /title: "Agents and alerts"/);
    match(source, /id="optBrowserNotifications"/);
    match(source, /title: "Worktrees"/);
    match(source, /title: "Server"/);
  });

  it("defines keyboard shortcuts and terminal font settings", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optGlobalShortcutsEnabled"/);
    match(source, /id="optGlobalShortcutPrefix"/);
    match(source, /id="optGlobalShortcutPrefixCapture"/);
    match(source, /DEFAULT_GLOBAL_SHORTCUT_PREFIX/);
    match(source, /id="optTerminalFontFamily"/);
    match(source, /id="optTerminalLinks"/);
    match(source, /JetBrainsMono Nerd Font/);
    match(source, /LEGACY_TERMINAL_FONT_FAMILY/);
    match(source, /HerdrAppHelpers\.resolveTerminalFontFamily\(""\)/);
    match(source, /handleGlobalShortcut/);
    match(source, /isShortcutPrefix/);
    match(source, /runPrefixedShortcut/);
    match(source, /selectRelativeAgent\(1\)/);
    match(source, /selectRelativeAgent\(-1\)/);
    match(source, /terminalFontFamily/);
    match(source, /applyTerminalLinks/);
    match(source, /registerLinkProvider/);
    match(source, /buffer\.viewportY/);
  });

  it("migrates the old desktop monospace terminal default to the bundled Nerd Font", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const normalized = vm.runInContext(
      `normalizeOptions({ terminalFontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" }).terminalFontFamily`,
      ctx,
    );

    match(normalized, /Herdr JetBrainsMono Nerd Font Mono/);
    match(normalized, /Symbols Nerd Font Mono/);
  });

  it("normalizes configurable shortcut prefixes", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.normalizeShortcutPrefix("control+b"), "Ctrl+B");
    equal(ctx.normalizeShortcutPrefix("Option+Shift+x"), "Alt+Shift+X");
    equal(ctx.normalizeShortcutPrefix("bad+b"), "Ctrl+B");
    equal(ctx.normalizeShortcutPrefix("b"), "Ctrl+B");
  });

  it("cycles agents by blocked done idle working priority", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const order = vm.runInContext(
      `state.agents = [
        { agent_status: "working", pane_id: "working" },
        { agent_status: "idle", pane_id: "idle" },
        { agent_status: "blocked", pane_id: "blocked" },
        { agent_status: "done", pane_id: "done" },
      ];
      agentCycleList().map((agent) => agent.pane_id).join(",");`,
      ctx,
    );

    equal(order, "blocked,done,idle,working");
  });

  it("shows linked worktree branch as title and custom label as label chip", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `const workspace = {
        workspace_id: "ws1",
        label: "friendly label",
        pane_count: 1,
        agent_status: "idle",
        worktree: {
          is_linked_worktree: true,
          checkout_path: "/tmp/repo/folder-name",
        },
      };
      state.worktrees = [{
        open_workspace_id: "ws1",
        path: "/tmp/repo/folder-name",
        branch: "feature/demo",
        label: "repo label",
      }];
      ({ title: workspaceDisplayTitle(workspace), meta: spaceMeta(workspace) });`,
      ctx,
    );

    equal(result.title, "feature/demo");
    match(result.meta, /chip label/);
    match(result.meta, /friendly label/);
    equal(result.meta.includes("chip branch"), false);
  });

  it("shows linked worktree custom label in agent list", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `const workspace = {
        workspace_id: "ws1",
        label: "friendly label",
        worktree: {
          is_linked_worktree: true,
          checkout_path: "/tmp/repo/folder-name",
          repo_key: "repo",
          repo_name: "repo",
        },
      };
      state.worktrees = [{
        open_workspace_id: "ws1",
        path: "/tmp/repo/folder-name",
        branch: "feature/demo",
        label: "repo label",
      }];
      renderAgentRow(
        { workspace_id: "ws1", tab_id: "tab1", pane_id: "pane1", agent_status: "idle", name: "agent" },
        { ws1: workspace },
        { tab1: { workspace_id: "ws1", tab_id: "tab1", label: "" } },
        new Map([["ws1", 1]]),
      );`,
      ctx,
    );

    match(html, /agent-worktree[^>]*>friendly label</);
    equal(html.includes("feature/demo"), false);
  });

  it("searches workspaces only after a query using repo tags branches and panel names", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const results = vm.runInContext(
      `state.workspaceBranches = { ws1: "fallback/branch" };
      state.workspaces = [{
        workspace_id: "ws1",
        label: "friendly label",
        tags: ["backend", "urgent"],
        worktree: {
          is_linked_worktree: true,
          repo_name: "repo-name",
          repo_key: "repo-key",
          repo_root: "/tmp/repo",
          checkout_path: "/tmp/worktrees/repo/feature",
        },
      }];
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "main panel" }];
      state.allTabs = state.tabs;
      state.panes = [{ tab_id: "tab1", pane_id: "pane1" }];
      state.worktrees = [{ open_workspace_id: "ws1", path: "/tmp/worktrees/repo/feature", branch: "feature/demo", label: "repo label" }];
      state.agents = [{ workspace_id: "ws1", tab_id: "tab1", pane_id: "pane1", agent_status: "blocked", name: "deploy agent" }];
      ({
        empty: searchCandidates("").length,
        label: searchCandidates("friendly")[0],
        agent: searchCandidates("deploy")[0],
        repo: searchCandidates("repo-name")[0],
        tag: searchCandidates("backend").find((item) => item.ws === "ws1"),
        branch: searchCandidates("feature/demo").find((item) => item.ws === "ws1"),
        panelWorkspace: searchCandidates("main panel").find((item) => item.kind === "worktree" || item.kind === "workspace"),
      });`,
      ctx,
    );

    equal(results.empty, 0);
    equal(results.label.ws, "ws1");
    equal(results.label.tab, "tab1");
    equal(results.label.pane, "pane1");
    equal(results.agent.kind, "agent");
    equal(results.repo.ws, "ws1");
    equal(results.tag.ws, "ws1");
    equal(results.branch.ws, "ws1");
    equal(results.panelWorkspace.ws, "ws1");
  });

  it("hides repo header actions when parent workspace card exists", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.worktrees = [{ is_linked_worktree: true, source_repo_key: "repo", open_workspace_id: null }];
      renderRepoHeader({ key: "repo", label: "repo", parent: { workspace_id: "ws1" } });`,
      ctx,
    );

    equal(html.includes("with-actions"), false);
    equal(html.includes("repo-actions"), false);
  });

  it("does not render repo header when parent workspace card exists", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.workspaces = [
        {
          workspace_id: "parent",
          label: "repo",
          pane_count: 1,
          agent_status: "idle",
          worktree: {
            is_linked_worktree: false,
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/tmp/repo",
            checkout_path: "/tmp/repo",
          },
        },
        {
          workspace_id: "child",
          label: "feature",
          pane_count: 1,
          agent_status: "idle",
          worktree: {
            is_linked_worktree: true,
            repo_key: "repo-key",
            repo_name: "repo",
            repo_root: "/tmp/repo",
            checkout_path: "/tmp/worktrees/repo/feature",
          },
        },
      ];
      state.worktrees = [
        { open_workspace_id: "parent", path: "/tmp/repo", branch: "main" },
        { open_workspace_id: "child", path: "/tmp/worktrees/repo/feature", branch: "feature" },
      ];
      renderSpaces();`,
      ctx,
    );

    equal(html.includes("repo-header workspace-orphan-header"), false);
    match(html, /workspace-group-main/);
  });

  it("closes the last panel by closing its workspace instead of tab.close", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const calls = await vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        return { result: {} };
      };
      refresh = () => {};
      state.ws = "ws1";
      state.tab = "tab1";
      state.pane = "pane1";
      state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "one" }];
      state.allTabs = state.tabs;
      state.panes = [{ tab_id: "tab1", pane_id: "pane1" }];
      closeTab("tab1").then(() => calls);`,
      ctx,
    );

    equal(calls.length, 1);
    equal(calls[0].url, "/api/workspaces/ws1/close");
  });

  it("closes workspace panels through workspace.close", async () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const calls = await vm.runInContext(
      `const calls = [];
      api = async (url, opt = {}) => {
        calls.push({ url, method: opt.method || "GET" });
        return { result: {} };
      };
      closeWorkspaceById("ws1").then(() => calls);`,
      ctx,
    );

    equal(calls.map((call) => call.url).join(","), "/api/workspaces/ws1/close");
  });

  it("defines stuck-working dismissal controls", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optWorkingDismissMinutes"/);
    match(source, /id="optStuckWorkingEnabled"/);
    match(source, /id="optAgentSortMode"/);
    match(source, /id="optParentCloseMode"/);
    match(source, /Dismiss/);
    match(source, /herdr-web-working-dismissals/);
    match(source, /displayStatus = dismissed \? "ignored"/);
  });

  it("defines sidebar collapse controls", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

    match(html, /id="sidebarToggle"/);
    match(source, /herdr-web-sidebar-collapsed/);
    match(source, /applySidebarCollapsed/);
    match(source, /sidebarAgentStatusCounts/);
    match(source, /sidebar-count/);
  });

  it("renders collapsed sidebar agent counters", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-sidebar-collapsed", "1");
    vm.runInContext(source, ctx);

    const html = vm.runInContext(
      `state.agents = [
        { agent_status: "blocked" },
        { agent_status: "working" },
        { agent_status: "idle" },
        { agent_status: "done" },
        { agent_status: "done" },
      ];
      sidebarToggleHtml();`,
      ctx,
    );

    match(html, /sidebar-count blocked[^>]*>1</);
    match(html, /sidebar-count working[^>]*>1</);
    match(html, /sidebar-count idle[^>]*>1</);
    match(html, /sidebar-count done[^>]*>2</);
  });

  it("fast-refreshes pane, tab, and worktree lifecycle events", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.eventNeedsFastRefresh("pane.closed"), true);
    equal(ctx.eventNeedsFastRefresh("pane.exited"), true);
    equal(ctx.eventNeedsFastRefresh("tab.closed"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.created"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.opened"), true);
    equal(ctx.eventNeedsFastRefresh("worktree.removed"), true);
    equal(ctx.eventNeedsFastRefresh("pane.focused"), false);
  });

  it("switches selected pane when Herdr reports current pane exited", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tab = "tab_1";
       state.panes = [
         { tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" },
         { tab_id: "tab_1", pane_id: "pane_2", terminal_id: "term_2" },
       ];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });
       ({ pane: state.pane, terminalId: state.terminalId });`,
      ctx,
    );

    equal(result.pane, "pane_2");
    equal(result.terminalId, "term_2");
  });

  it("replaces stale route after selected panel disappears", async () => {
    const ctx = context();
    const replaced = [];
    ctx.location.pathname = "/session/default/workspace/ws1/tab/old/pane/oldpane";
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    ctx.Terminal = class {
      open() {}
      onData() {}
      onScroll() {}
      loadAddon() {}
      clear() {}
      focus() {}
      resize() {}
      dispose() {}
    };
    ctx.fetch = async (url) => {
      const text = String(url);
      const result = text.includes("workspaces")
        ? { workspaces: [{ workspace_id: "ws1", label: "repo" }] }
        : text.includes("workspace-order")
          ? { order: [] }
          : text.includes("worktrees")
            ? { source: {}, worktrees: [] }
            : text.includes("tabs")
              ? { tabs: [{ workspace_id: "ws1", tab_id: "new", number: 1 }] }
              : text.includes("panes")
                ? { panes: [{ workspace_id: "ws1", tab_id: "new", pane_id: "newpane", terminal_id: "term2" }] }
                : text.includes("pane-layout")
                  ? { layout: { panes: [] } }
                  : { agents: [] };
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    vm.runInContext(source, ctx);

    const result = await vm.runInContext(
      "refreshSeq = 1; refreshOnline(1).then(() => ({ tab: state.tab, pane: state.pane }))",
      ctx,
    );

    equal(result.tab, "new");
    equal(result.pane, "newpane");
    ok(replaced.some((url) => String(url).includes("/tab/new/pane/newpane")));
  });

  it("switches away from selected tab when refresh shows it has no pane", async () => {
    const ctx = context();
    const replaced = [];
    ctx.location.pathname = "/session/default/workspace/ws1/tab/old/pane/oldpane";
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    ctx.Terminal = class {
      open() {}
      onData() {}
      onScroll() {}
      loadAddon() {}
      clear() {}
      focus() {}
      resize() {}
      dispose() {}
    };
    ctx.fetch = async (url) => {
      const text = String(url);
      const result = text.includes("workspaces")
        ? { workspaces: [{ workspace_id: "ws1", label: "repo" }] }
        : text.includes("workspace-order")
          ? { order: [] }
          : text.includes("worktrees")
            ? { source: {}, worktrees: [] }
            : text.includes("tabs")
              ? { tabs: [
                  { workspace_id: "ws1", tab_id: "old", number: 1 },
                  { workspace_id: "ws1", tab_id: "new", number: 2, focused: true },
                ] }
              : text.includes("panes")
                ? { panes: [{ workspace_id: "ws1", tab_id: "new", pane_id: "newpane", terminal_id: "term2", focused: true }] }
                : text.includes("pane-layout")
                  ? { layout: { panes: [] } }
                  : { agents: [] };
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    vm.runInContext(source, ctx);

    const result = await vm.runInContext(
      "refreshSeq = 1; refreshOnline(1).then(() => ({ tab: state.tab, pane: state.pane, terminalId: state.terminalId }))",
      ctx,
    );

    equal(result.tab, "new");
    equal(result.pane, "newpane");
    equal(result.terminalId, "term2");
    ok(replaced.some((url) => String(url).includes("/tab/new/pane/newpane")));
  });

  it("clears selected pane when no fallback pane remains", () => {
    const ctx = context();
    const replaced = [];
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tab = "tab_1";
       state.ws = "ws1";
       state.panes = [{ tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" }];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });
       ({ pane: state.pane, terminalId: state.terminalId });`,
      ctx,
    );

    equal(result.pane, null);
    equal(result.terminalId, null);
    equal(replaced.at(-1), "/session/default/workspace/ws1");
  });

  it("clears stale terminal DOM when selected pane exits even without xterm object", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const terminal = ctx.document.getElementById("terminal");
    terminal.innerHTML = "stale terminal";

    vm.runInContext(
      `term = null;
       state.ws = "ws1";
       state.tab = "tab_1";
       state.pane = "pane_1";
       state.terminalId = "term_1";
       state.panes = [{ tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" }];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });`,
      ctx,
    );

    equal(terminal.innerHTML, "");
  });

  it("switches selected panel immediately when current tab closes", () => {
    const ctx = context();
    const replaced = [];
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.ws = "ws1";
       state.tab = "tab_1";
       state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tabs = [
         { workspace_id: "ws1", tab_id: "tab_1" },
         { workspace_id: "ws1", tab_id: "tab_2", focused: true },
       ];
       state.allTabs = state.tabs.slice();
       state.panes = [
         { workspace_id: "ws1", tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" },
         { workspace_id: "ws1", tab_id: "tab_2", pane_id: "pane_2", terminal_id: "term_2", focused: true },
       ];
       forgetClosedSelection("tab.closed", { tab_id: "tab_1" });
       ({ tab: state.tab, pane: state.pane, terminalId: state.terminalId, tabs: state.tabs.map((tab) => tab.tab_id) });`,
      ctx,
    );

    equal(result.tab, "tab_2");
    equal(result.pane, "pane_2");
    equal(result.terminalId, "term_2");
    equal(JSON.stringify(result.tabs), JSON.stringify(["tab_2"]));
    equal(replaced.at(-1), "/session/default/workspace/ws1/tab/tab_2/pane/pane_2");
  });

  it("switches selected panel immediately when terminal exit closes last pane", () => {
    const ctx = context();
    const replaced = [];
    ctx.history.replaceState = (_state, _title, url) => replaced.push(url);
    vm.runInContext(source, ctx);

    const result = vm.runInContext(
      `state.ws = "ws1";
       state.tab = "tab_1";
       state.pane = "pane_1";
       state.terminalId = "term_1";
       state.tabs = [
         { workspace_id: "ws1", tab_id: "tab_1" },
         { workspace_id: "ws1", tab_id: "tab_2", focused: true },
       ];
       state.allTabs = state.tabs.slice();
       state.panes = [
         { workspace_id: "ws1", tab_id: "tab_1", pane_id: "pane_1", terminal_id: "term_1" },
         { workspace_id: "ws1", tab_id: "tab_2", pane_id: "pane_2", terminal_id: "term_2", focused: true },
       ];
       forgetClosedSelection("pane.exited", { pane_id: "pane_1" });
       ({ tab: state.tab, pane: state.pane, terminalId: state.terminalId, tabs: state.tabs.map((tab) => tab.tab_id), panes: state.panes.map((pane) => pane.pane_id) });`,
      ctx,
    );

    equal(result.tab, "tab_2");
    equal(result.pane, "pane_2");
    equal(result.terminalId, "term_2");
    equal(JSON.stringify(result.tabs), JSON.stringify(["tab_2"]));
    equal(JSON.stringify(result.panes), JSON.stringify(["pane_2"]));
    equal(replaced.at(-1), "/session/default/workspace/ws1/tab/tab_2/pane/pane_2");
  });

  it("auto-closes pane when Herdr reports it exited", async () => {
    const requests = [];
    const ctx = context();
    ctx.fetch = async (url, opt) => {
      requests.push({ url, method: (opt && opt.method) || "GET" });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    vm.runInContext(source, ctx);

    vm.runInContext(
      `forgetClosedSelection("pane.exited", { pane_id: "pane_1" });`,
      ctx,
    );
    await Promise.resolve();

    const closeRequest = requests.find((request) => request.url === "/api/panes/pane_1/close");
    ok(closeRequest);
    equal(closeRequest.method, "POST");
  });

  it("keeps blocked agents first when attention sorting is inverted", () => {
    const ctx = context();
    ctx.localStorage.setItem(
      "herdr-web-options",
      JSON.stringify({ agentSortMode: "attention_inverted" }),
    );
    vm.runInContext(source, ctx);

    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "blocked" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "working" },
          { agent_status: "blocked" },
        ),
      ),
      1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "working" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "unknown" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
  });

  it("keeps blocked agents first, then idle before done", () => {
    const ctx = context();
    ctx.localStorage.setItem(
      "herdr-web-options",
      JSON.stringify({ agentSortMode: "attention" }),
    );
    vm.runInContext(source, ctx);

    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "blocked" },
          { agent_status: "idle" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "idle" },
          { agent_status: "done" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "idle" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "done" },
          { agent_status: "working" },
        ),
      ),
      -1,
    );
  });

  it("preserves custom agent status order when saving settings", () => {
    const ctx = context();
    ctx.localStorage.setItem(
      "herdr-web-options",
      JSON.stringify({
        agentSortMode: "attention_inverted",
        agentStatusOrder: ["working", "blocked", "idle", "done", "other"],
      }),
    );
    vm.runInContext(source, ctx);

    equal(
      Math.sign(
        ctx.agentAttentionCompare(
          { agent_status: "working" },
          { agent_status: "blocked" },
        ),
      ),
      -1,
    );
    vm.runInContext("saveOptions()", ctx);
    const saved = JSON.parse(ctx.localStorage.getItem("herdr-web-options"));
    deepEqual(saved.agentStatusOrder, [
      "working",
      "blocked",
      "idle",
      "done",
      "other",
    ]);
  });

  it("normalizes sidebar split percent to whole bounded values", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.normalizeSidebarWorkspacePercent(33.6), 34);
    equal(ctx.normalizeSidebarWorkspacePercent(10), 20);
    equal(ctx.normalizeSidebarWorkspacePercent(90), 80);
  });

  it("defines tab activity setting and badge", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(source, /id="optShowTabActivity"/);
    match(source, /tab-activity/);
    match(source, /tabActivityLabel/);
  });

  it("renders current panel as label with add and close buttons", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    const html = vm.runInContext(
      `state.ws = "ws1";
       state.tab = "tab1";
       state.tabs = [{ workspace_id: "ws1", tab_id: "tab1", label: "main" }];
       renderPanelField();`,
      ctx,
    );

    match(html, /panel-label/);
    match(html, /panel-add/);
    match(html, /panel-close/);
    match(html, /Close current panel/);
    ok(!html.includes("panelSelector"));
  });

  it("resizes workspace pane for an open panel selector", () => {
    const renderSource = readFileSync(new URL("./desktop/app_js/render.js", import.meta.url), "utf8");
    const chromeCss = readFileSync(new URL("./desktop/app_css/chrome.css", import.meta.url), "utf8");

    match(renderSource, /function syncWorkspacePanelMenuSize\(\)/);
    match(renderSource, /querySelector\("\.panel-menu"\)/);
    match(renderSource, /--workspace-panel-menu-min-height/);
    match(chromeCss, /\.sidebar-pane\.workspaces-pane\.panel-menu-open \{[\s\S]*?min-height: max\(20%, var\(--workspace-panel-menu-min-height, 0px\)\);/);
    match(chromeCss, /\.sidebar-pane\.workspaces-pane\.panel-menu-open \.sidebar-scroll \{[\s\S]*?overflow: visible;/);
  });

  it("captures terminal paste before xterm native paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /sendPasteToTerminal\(text\)/);
    match(source, /schedulePasteChunkFlush\(0\)/);
    match(source, /function flushPasteChunks\(\)/);
    match(source, /PASTE_TEXT_CHUNK_SIZE = 4096/);
    match(source, /termWs\.bufferedAmount < PASTE_BUFFER_LIMIT/);
    match(source, /normalizeTerminalPasteChunk\(pasteJob, rawChunk/);
    match(source, /showTerminalPasteProgress\(pasteJob\.total\)/);
    ok(!source.includes('JSON.stringify({ type: "paste"'));
    ok(!source.includes('.paste(text)'));
  });

  it("renders terminal paste progress UI", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
    const terminalCss = readFileSync(new URL("./desktop/app_css/terminal.css", import.meta.url), "utf8");
    match(html, /id="terminalPasteProgress"/);
    match(html, /id="terminalPasteProgressLabel"/);
    match(html, /id="terminalPasteProgressBar"/);
    match(terminalCss, /\.terminal-paste-progress \{/);
    match(terminalCss, /\.terminal-paste-progress-track i \{[\s\S]*?transition: width 80ms linear;/);
    match(source, /function updateTerminalPasteProgress\(done, total\)/);
    match(source, /label\.textContent = pct >= 100 \? "Paste sent" : "Pasting… " \+ pct \+ "%"/);
  });

  it("renders no-sleep control options", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    const html = ctx.noSleepControlHtml("noSleepTest");

    match(html, /id="noSleepTest"/);
    match(html, /value="off"/);
    match(html, /shell-icon-button/);
    match(html, /coffee-outline/);
  });

  it("does not duplicate no-sleep control in static header", () => {
    const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");

    equal(html.includes("noSleepSelect"), false);
  });

  it("handles rejected audio unlock attempts", () => {
    const ctx = context();
    ctx.AudioContext = class {
      resume() {
        return Promise.reject(new Error("blocked"));
      }
    };
    vm.runInContext(source, ctx);

    doesNotThrow(() => ctx.unlockAudio());
  });

  it("requests browser notification permission before enabling notifications", async () => {
    const ctx = context();
    let requested = false;
    ctx.Notification = {
      permission: "default",
      async requestPermission() {
        requested = true;
        this.permission = "granted";
        return "granted";
      },
    };
    vm.runInContext(source, ctx);

    await ctx.setBrowserNotifications(true);

    equal(requested, true);
    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).browserNotifications,
      true,
    );
  });

  it("uses louder attention sound gain", () => {
    match(source, /notificationVolume: 0\.24/);
    match(source, /function attentionSoundVolume\(\)/);
  });

  it("stores desktop notification volume from Settings", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.document.getElementById("optNotificationVolume").value = "65";
    ctx.document.getElementById("optNotificationVolume").oninput();

    equal(
      JSON.parse(ctx.localStorage.getItem("herdr-web-options")).notificationVolume,
      0.65,
    );
    equal(ctx.document.getElementById("notificationVolumeValue").textContent, "65");
  });

  it("requires credentials for non-local server bind", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(
      ctx.serverSettingsValidationError("0.0.0.0:8787", "", "", false),
      "Username and password are required before binding to 0.0.0.0 or any non-local address.",
    );
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "pass", false), "");
    equal(ctx.serverSettingsValidationError("0.0.0.0:8787", "user", "", true), "");
    equal(ctx.serverSettingsValidationError("127.0.0.1:8787", "", "", false), "");
  });

  it("renders extracted worktree and shortcut modals", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateForm"/);
    match(ctx.worktreeCreateModalHtml(), /id="worktreeCreateSubmit"/);
    match(ctx.worktreeOpenModalHtml(), /id="worktreeDiscoverPath"/);
    ok(!ctx.worktreeOpenModalHtml().includes("worktreePathOptions"));
    match(ctx.worktreeOpenModalHtml(), /id="worktreeBranchOptions"/);
    match(ctx.shortcutsModalHtml(), /id="shortcutsModal"/);
    match(ctx.shortcutsModalHtml(), /id="closeShortcutCurrent"/);
  });

  it("prefills workspace label from final folder segment", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value =
      "/Users/me/projects/herdr-webui/";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "herdr-webui");
  });

  it("keeps manually edited workspace label while folder changes", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/first";
    ctx.syncWorkspaceCreateLabel();
    ctx.document.getElementById("workspaceCreateLabel").value = "custom";
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/second";

    ctx.syncWorkspaceCreateLabel();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "custom");
  });

  it("focuses and selects suggested workspace label", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/project";

    ctx.focusWorkspaceCreateLabel();

    const label = ctx.document.getElementById("workspaceCreateLabel");
    equal(label.value, "project");
    equal(label.focused, true);
    equal(label.selected, true);
  });

  it("uses workspace fallback label for empty folder", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.suggestedWorkspaceLabel(""), "workspace");
  });

  it("does not expose old path suggestion helper", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    equal(ctx.loadDirectoryPathSuggestions, undefined);
    equal(ctx.schedulePathSuggestions, undefined);
  });

  it("workspace path changes only update generated label", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    ctx.document.getElementById("workspaceCreatePath").value = "/tmp/project";

    ctx.workspaceCreatePathChanged();

    equal(ctx.document.getElementById("workspaceCreateLabel").value, "project");
  });

  it("uses settings default folder for workspace and worktree open defaults", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext('state.defaultFolder = "/tmp/default"', ctx);

    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "/tmp/default");

    ctx.document.getElementById("optWorktreeDefaultDirectory").value = "/tmp/worktrees";
    ctx.document.getElementById("optWorktreeDefaultDirectory").oninput();
    ctx.document.getElementById("optExplorationDefaultDirectory").value = "/tmp/code";
    ctx.document.getElementById("optExplorationDefaultDirectory").oninput();
    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "/tmp/default");

    ctx.openWorktreeOpenModal();

    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "/tmp/default");
    ctx.openWorktreeOpenModal("/");
    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "/tmp/default");

    vm.runInContext('state.openWorktreeSource = { repo_name: "repo", repo_root: "/src/repo" }', ctx);
    ctx.document.getElementById("worktreeNewBranch").value = "feature/x";
    ctx.syncWorktreeCheckoutPath();
    equal(ctx.document.getElementById("worktreeNewPath").value, "/tmp/worktrees/repo/feature-x");
  });

  it("does not use legacy root as worktree discover default", () => {
    const ctx = context();
    vm.runInContext(source, ctx);
    vm.runInContext('state.defaultFolder = ""; options.explorationDefaultDirectory = "/";', ctx);

    ctx.openWorktreeOpenModal("/");

    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "~");
  });

  it("defines side-by-side and unified Git diff layouts", () => {
    match(gitSettingsSource, /id="optGitUiDiffLayout"/);
    match(gitSettingsSource, /id="optGitUiDefaultBranch"/);
    match(gitSettingsSource, /gitUiDefaultBranch: "master"/);
    match(gitUiSource, /function gitLogDefaultBranch\(\)/);
    match(gitUiSource, /base=\$\{encodeURIComponent\(baseBranch\)\}/);
    match(gitLogSource, /Toggle history scope: All/);
    match(gitSettingsSource, /Unified \(GitHub-style\)/);
    match(gitSettingsSource, /gitUiDiffLayout: "side-by-side"/);
    match(gitUiSource, /function diffLayoutMode\(\)/);
    match(gitUiSource, /function renderDiffLayoutSideToggle\(view\)/);
    match(gitUiSource, /git-ui-diff-layout-toggle/);
    match(gitUiSource, /HerdrGitUi\.setDiffLayout\('side-by-side'\)/);
    match(gitUiSource, /HerdrGitUi\.setDiffLayout\('unified'\)/);
    match(gitUiSource, /setDiffLayout\(layout\)/);
    match(gitUiSource, /function renderUnifiedLine\(/);
    match(gitUiSource, /git-ui-unified-row/);
    match(gitUiSource, /sideBySideRows\(chunk\)/);
    match(gitUiSource, /renderUnifiedLine\(row, path, index, rows, rowIndex, contextArrows\)/);
    match(gitUiSource, /restoreHunk\('\$\{arg\(path\)\}',\$\{hunkIndex\}\)/);
    match(gitUiSource, /function contextArrowsForChunk\(chunks, index\)/);
    match(gitUiSource, /const after = next \? hiddenGap\(chunk, next\) : false;/);
  });

  it("loads shared terminal fit helper before terminal clients", () => {
    const terminalFitSource = readFileSync(new URL("./shared/terminal_fit.js", import.meta.url), "utf8");
    const desktopTerminalSource = readFileSync(new URL("./desktop/app_js/terminal.js", import.meta.url), "utf8");
    const mobileTerminalSource = readFileSync(new URL("./mobile/terminal.js", import.meta.url), "utf8");

    match(appBootSource, /\/assets\/shared\/terminal-fit\.js/);
    match(terminalFitSource, /visibleBox/);
    match(desktopTerminalSource, /HerdrTerminalFit\.cellSize\(term, terminal/);
    match(desktopTerminalSource, /HerdrTerminalFit\.gridSize\(shell, term/);
    match(mobileTerminalSource, /HerdrTerminalFit\.gridSize\(shell, term/);
    match(mobileTerminalSource, /HerdrTerminalFit\.fitXtermToContainer\(terminal\)/);
    ok(!mobileTerminalSource.includes("Math.floor(shell.clientWidth / 9)"));
  });



  it("stops terminal loading when no workspace exists", () => {
    ok(source.includes("if (!state.ws) {"));
    ok(source.includes("state.allTabs = [];"));
    ok(source.includes("state.tabs = [];"));
    ok(source.includes("state.panes = [];"));
    ok(source.includes("state.agents = [];"));
    ok(source.includes("state.terminalId = null;"));
    ok(source.includes("setTerminalLoading(false);"));
  });

  it("uses one Git folder selection flow and offers return to workspace", () => {
    const directoryPickerSource = readFileSync(new URL("./desktop/directory_picker.js", import.meta.url), "utf8");
    const gitLayoutCss = readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8");
    const featuresDoc = readFileSync(new URL("../../docs/features.md", import.meta.url), "utf8");
    const technicalDoc = readFileSync(new URL("../../docs/technical-details.md", import.meta.url), "utf8");
    const releaseNotes = readFileSync(new URL("../../docs/release-notes.md", import.meta.url), "utf8");

    match(directoryPickerSource, /function afterSelectCallback\(input\)/);
    match(directoryPickerSource, /input\.dataset\.directoryPickerAfterSelect/);
    match(gitUiSource, /id="gitUiBranchCwd"[^`]*data-directory-picker-after-select="HerdrGitUi\.applyBranchModalCwd"/);
    ok(!gitUiSource.includes("Load typed path"));
    ok(!gitUiSource.includes(">Use directory</button>"));
    ok(!gitUiSource.includes(">Switch to</button>"));
    match(gitUiSource, /Choosing a folder moves the Git panel to that directory immediately/);
    match(gitUiSource, /workspaceCwd: nextWorkspaceCwd/);
    match(gitUiSource, /function gitCwdMatchesWorkspace\(view\)/);
    match(gitUiSource, /HerdrGitUi\.returnToWorkspaceCwd\(\)/);
    match(gitUiSource, /returnToWorkspaceCwd\(\) \{/);
    match(gitUiSource, /git-ui-current-changes-icon/);
    match(gitUiSource, /title="Return to current changes"/);
    match(gitUiSource, /returnToCurrentChanges\}\$\{returnToWorkspace\}/);
    ok(!gitUiSource.includes('${compareButton}<button'));
    match(gitLayoutCss, /\.git-ui-return-cwd-icon span/);
    match(gitLayoutCss, /folder-up\.svg/);
    match(gitLayoutCss, /\.git-ui-current-changes-icon span \{[\s\S]*?git\.svg/);
    match(gitUiSource, /Folder picker: selected folder becomes the Git panel directory immediately/);
    match(gitUiSource, /Load more changes fetches older commits/);
    match(source, /Choosing a folder in the Git directory picker immediately moves the Git panel/);
    match(source, /WebUI no longer opens a workspace automatically on startup/);
    match(source, /In Git UI, open Git directory\/branch dialog/);
    match(featuresDoc, /The Git directory picker has a single meaning/);
    match(featuresDoc, /The built-in backend starts with zero workspaces/);
    match(technicalDoc, /Built-in sessions do not seed a default workspace/);
    match(technicalDoc, /Git cwd is independent from workspace selection/);
    match(releaseNotes, /0\.2\.50 Release Notes/);
    match(readmeDoc, /herdr-webui-tui --api-socket \/path\/to\/herdr\.sock --terminal-socket \/path\/to\/herdr-client\.sock/);
    match(readmeDoc, /The TUI is a client; it does not start the backend by itself/);
    match(installationDoc, /This is the recommended quick-start path/);
    match(installationDoc, /For an external Herdr-compatible backend, point TUI at the socket pair explicitly/);
    match(releaseNotes, /Updates the global `\?` Help & Shortcuts modal/);
    match(releaseNotes, /`Worktree…` creates a linked worktree/);
    match(releaseNotes, /table header, and filter row sticky/);
    match(releaseNotes, /File browser `Show history` opens the Git log scoped to the file/);
    match(releaseNotes, /Committed files` side preview/);
    match(featuresDoc, /normal worktree creation modal prefilled/);
    match(featuresDoc, /scope row, table header, and filter row are sticky/);
    match(featuresDoc, /File browser `Show history` opens this log scoped to the selected file/);
    match(featuresDoc, /Selecting one commit loads a `Committed files` side preview/);
    match(technicalDoc, /src\/assets\/desktop\/git_ui\/actions\.js/);
    match(technicalDoc, /selected-commit action strip/);
    match(technicalDoc, /optional `file` path/);
    match(technicalDoc, /commit\^` versus `commit`/);
    match(gitUiSource, /function gitBranchModalDefaultCwd\(cwd\)/);
    match(gitUiSource, /if \(path && path !== "\/"\) return path;/);
    match(gitUiSource, /typeof window\.defaultFolderPath === "function"/);
    match(gitUiSource, /id="gitUiCleanupRoot"[^`]*data-directory-picker-after-select="HerdrGitUi\.scanCleanup"/);
    match(gitUiSource, /class="mini directory-picker-trigger" onclick="HerdrDirectoryPicker\.openInput\('gitUiBranchCwd'\)"/);
  });

  it("renders Git log like a four-column graph table with ref chips", () => {
    const gitLogCss = readFileSync(new URL("./desktop/git_ui/log.css", import.meta.url), "utf8");
    const assetsSource = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");

    match(assetsSource, /include_str!\("assets\/desktop\/git_ui\/log\.js"\)/);
    match(gitUiSource, /logAll: true,/);
    match(gitUiSource, /logScope: "all",/);
    match(gitUiSource, /logLimit: GIT_LOG_PAGE_SIZE,/);
    match(gitUiSource, /const GIT_LOG_PAGE_SIZE = 80;/);
    match(gitUiSource, /const GIT_LOG_MAX_LIMIT = 2000;/);
    match(fileBrowserSource, /HerdrFileBrowser.showHistory/);
    match(fileBrowserSource, />Show history<\/button>/);
    match(fileBrowserSource, /menu\.kind === "file" \? `<button onclick="HerdrFileBrowser\.menuAction\('history'\)">Show history<\/button>` : ""/);
    match(fileBrowserSource, /if \(action === "history"\) \{ this\.showHistory\(encodeURIComponent\(menu\.path\)\); return; \}/);
    match(fileBrowserSource, /showHistory\(encodedPath\)/);
    match(fileBrowserSource, /hide\(\);\n\s+window\.HerdrGitUi\.openFileHistory/);
    match(fileBrowserSource, /openFileHistory\(encodeURIComponent\(state\.cwd\), encodeURIComponent\(path\)\)/);
    match(gitUiSource, /\/api\/git-ui\/path-info\?cwd=\$\{encodeURIComponent\(cwd\)\}&path=\$\{encodeURIComponent\(path\)\}/);
    match(gitUiSource, /cwd = info\.repo_root \|\| cwd;/);
    match(gitUiSource, /path = info\.file \|\| path;/);
    match(gitUiSource, /window\.HerdrGitLog\.render/);
    match(gitLogSource, /onclick="HerdrGitUi\.cycleLogScope\(\)"/);
    match(gitLogSource, /Toggle history scope: All/);
    match(gitLogSource, /function logScopeLabel/);
    ok(!gitLogSource.includes("HerdrGitUi.setLogAll(false)"));
    ok(!gitLogSource.includes("All branches</button>"));
    ok(!gitUiSource.includes("function renderLogLine(line)"));
    match(gitLogSource, /window\.HerdrGitLog = \{ render, scrollToCommit, rowsFromData, laneColor, applyFilters, logCommitCount, selectedBranchForHash \};/);
    match(gitLogSource, /git-ui-log-table-head/);
    match(gitLogSource, /<span>Graph<\/span><span>Description<\/span><span>Date<\/span><span>Author<\/span>/);
    match(gitLogSource, /class="git-ui-log-ref \$\{kind\}"/);
    match(gitLogSource, /current: detail\.labels\.some/);
    match(gitLogSource, /const LANE_COLORS = \[/);
    match(gitLogSource, /exact_date/);
    match(gitLogSource, /function renderLoadMore/);
    ok(!gitLogSource.includes("const footer = renderLoadMore(data,"));
    match(gitLogSource, /renderLoadMore\(options\.data \|\| \{\}, rows, options, esc\)/);
    match(gitLogSource, /Load more changes/);
    match(gitLogSource, /git-ui-log-file-scope/);
    match(gitLogSource, /clearLogFileHistory\(\)/);
    match(gitLogSource, /HerdrGitUi.loadMoreLog\(\)/);
    match(gitLogSource, /data\.has_more/);
    match(gitLogSource, /function renderFilterRow/);
    match(gitLogSource, /oninput="HerdrGitUi.setLogFilter/);
    match(gitLogSource, /aria-label="Filter \$\{label\}"/);
    match(gitLogSource, /input\("description", "Description"\)/);
    match(gitLogSource, /name="git-log-filter-\$\{field\}"/);
    match(gitUiSource, /id="gitUiFileFilter"/);
    match(gitUiSource, /name="git-ui-file-filter"/);
    match(source, /Show history opens Git log scoped to the selected file/);
    match(source, /Committed files side preview/);
    ok(!gitLogSource.includes("Filter description"));
    match(gitLogSource, /git-ui-log-filter-spacer/);
    ok(!gitLogSource.includes('setLogFilter(' + "\'graph"));
    match(gitLogSource, /function applyFilters/);
    match(gitLogSource, /git-ui-log-hover-card/);
    match(gitLogSource, /if \(label === "HEAD" \|\| label.startsWith\("HEAD -> "\)\) return "current";/);
    match(gitLogSource, /return "main";/);
    match(gitUiSource, /logFilters: \{ description: "", date: "", author: "" \}/);
    match(gitUiSource, /max=\$\{logLimit\}/);
    match(gitUiSource, /scope=\$\{encodeURIComponent\(view\.logScope\)\}/);
    match(gitUiSource, /cycleLogScope\(\) \{/);
    match(gitUiSource, /const order = \["all", "base-current", "base"\]/);
    match(gitUiSource, /async loadMoreLog\(\)/);
    match(gitUiSource, /view\.logLimit = Math\.min\(GIT_LOG_MAX_LIMIT/);
    match(gitUiSource, /setLogFilter\(field, value\)/);
    ok(!gitUiSource.includes('"graph", "description"'));
    match(gitUiSource, /HerdrGitLog\.applyFilters\(view\.logFilters\)/);
    match(gitLogCss, /grid-template-columns: minmax\(96px, max-content\) minmax\(240px, 1fr\) minmax\(90px, 120px\) minmax\(120px, 180px\);/);
    match(gitLogCss, /\.git-ui-log-ref\.current[\s\S]*?#ef4444/);
    match(gitLogCss, /\.git-ui-log-ref\.main[\s\S]*?#3b82f6/);
    match(gitLogCss, /\.git-ui-log-filter-row/);
    match(gitLogCss, /\.git-ui-log-file-scope/);
    match(gitLogCss, /\.git-ui-log-filter \.sr-only/);
    match(gitLogCss, /\.git-ui-log-load-more/);
    match(gitLogCss, /\.git-ui-log-hover-card/);
    match(gitLogSource, /function selectedBranchForHash/);
    match(gitActionsSource, />Worktree…<\/button>/);
    match(gitActionsSource, /Selected commit has no branch label/);
    match(gitActionsSource, /title="Create a worktree from \$\{esc\(options\.selectedBranch\)\}"/);
    match(gitUiSource, /createWorktreeFromSelectedBranch\(\)/);
    match(source, /function openWorktreeCreateFromGitBranch\(cwd, branch\)/);
    match(source, /id="worktreeFetchRemotes"/);
    match(source, /Fetch remote branches…/);
    match(source, /remote=true/);
    match(source, /fetch=true/);
    match(source, /function localWorktreeBranchName\(branch\)/);
    match(gitUiSource, /function preserveContentScroll\(tab\)/);
    match(gitUiSource, /return tab === "cleanup" \|\| tab === "log";/);
    match(gitUiSource, /const scrollTop = preserveContentScroll\(view\.tab\)/);
    match(gitUiSource, /content\.scrollTop = scrollTop;/);
    match(gitLogCss, /\.git-ui-log-scope-head \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/);
    match(gitLogCss, /\.git-ui-log-table-head \{[\s\S]*?position: sticky;[\s\S]*?top: var\(--git-log-scope-sticky-height, 58px\);/);
    match(gitLogCss, /\.git-ui-log-filter-row \{[\s\S]*?position: sticky;[\s\S]*?--git-log-table-head-sticky-height/);
    match(gitUiSource, /function updateGitLogStickyOffsets\(\)/);
    match(gitUiSource, /--git-log-scope-sticky-height/);
    match(gitLogCss, /border-style: dashed;/);
  });

  it("derives the selected Git log branch for worktree creation", () => {
    const ctx = context();
    vm.runInContext(gitLogSource, ctx);

    const branch = ctx.HerdrGitLog.selectedBranchForHash(
      {
        rows: [
          { hash: "aaa111", labels: ["HEAD -> feature/current", "origin/feature/current"] },
          { hash: "bbb222", labels: ["origin/feature/remote"] },
          { hash: "ccc333", labels: ["tag: v1"] },
        ],
      },
      "aaa111",
      "master",
    );

    equal(branch, "feature/current");
    equal(
      ctx.HerdrGitLog.selectedBranchForHash(
        { rows: [{ hash: "bbb222", labels: ["origin/feature/remote"] }] },
        "bbb222",
        "master",
      ),
      "origin/feature/remote",
    );
    equal(
      ctx.HerdrGitLog.selectedBranchForHash(
        { rows: [{ hash: "ccc333", labels: ["tag: v1"] }] },
        "ccc333",
        "master",
      ),
      "",
    );
  });

  it("opens the worktree modal prefilled from a selected Git log branch", async () => {
    const ctx = context();
    const urls = [];
    ctx.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).startsWith("/api/worktrees")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: {
              source: {
                source_checkout_path: "/repo",
                repo_name: "repo",
                repo_root: "/repo",
                default_worktree_directory: "/worktrees",
              },
              worktrees: [],
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ branches: ["main", "feature/local", "origin/feature/remote"] }),
      };
    };
    vm.runInContext(source, ctx);

    match(source, /id="worktreeNewTitle">Create worktree/);
    match(source, /Review branch name, base branch, and checkout path, then create and open/);
    match(source, /id="worktreeNewSubmit">Create and open/);
    equal(ctx.localWorktreeBranchName("feature/local"), "feature/local");
    equal(ctx.localWorktreeBranchName("origin/feature/remote"), "feature/remote");
    equal(ctx.localWorktreeBranchName("upstream/release/candidate"), "release/candidate");

    await ctx.openWorktreeCreateFromGitBranch("/repo", "origin/feature/remote");

    equal(ctx.document.getElementById("worktreeOpenModal").style.display, "grid");
    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "/repo");
    equal(ctx.document.getElementById("worktreeNewBase").value, "origin/feature/remote");
    equal(ctx.document.getElementById("worktreeNewBranch").value, "feature/remote");
    match(ctx.document.getElementById("worktreeNewPath").value, /\/worktrees\/repo\/feature-remote$/);

    await ctx.fetchWorktreeRemoteBranches();
    ok(urls.some((url) => url.includes("/api/git-branches?") && url.includes("remote=true") && url.includes("fetch=true")));
  });

  it("uses the same editor mount tooling for previous and current hunk text", () => {
    const gitDiffCss = readFileSync(new URL("./desktop/git_ui/diff.css", import.meta.url), "utf8");

    match(gitUiSource, /git-ui-hunk-old-mount" data-hunk-index="\$\{hunk\.index\}" data-editor-side="old" data-readonly="true"/);
    match(gitUiSource, /git-ui-hunk-current-mount" data-hunk-index="\$\{hunk\.index\}" data-editor-side="current" data-readonly="\$\{hunk\.newStart \? "false" : "true"\}"/);
    match(gitUiSource, /const sourceClass = side === "old" \? "git-ui-hunk-old-hidden" : "git-ui-hunk-current-hidden";/);
    ok(!gitUiSource.includes("<pre class=\"git-ui-editor-preview del\""));
    match(gitDiffCss, /\.git-ui-hunk-old-mount \.cm-content/);
    match(gitDiffCss, /\.git-ui-hunk-old-mount \.cm-scroller \{\n\s+flex-direction: row-reverse;/);
    match(gitDiffCss, /\.git-ui-hunk-old-mount \.cm-gutters \{\n\s+border-left: 1px solid var\(--border\);\n\s+border-right: 0;/);
    match(gitDiffCss, /\.git-ui-hunk-current-mount \.cm-content/);
    match(gitDiffCss, /\.git-ui-hunk-edit \{[\s\S]*?display: block;[\s\S]*?\.git-ui-hunk-editor textarea\.git-ui-hunk-edit-hidden \{\n\s+display: none;/);
  });
});
