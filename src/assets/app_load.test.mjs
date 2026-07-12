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

describe("app bundle load", () => {
  let source;
  let gitUiSource;
  let gitSettingsSource;
  let desktopWorkspacesCss;
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
      readFileSync(new URL("./shared/terminal_scroll.js", import.meta.url), "utf8") +
      "\n" +
      readFileSync(new URL("./desktop/search.js", import.meta.url), "utf8") +
      "\n" +
      desktopAppSource;
    gitUiSource = readFileSync(new URL("./desktop/git_ui.js", import.meta.url), "utf8");
    gitSettingsSource = readFileSync(new URL("./desktop/git_ui/settings.js", import.meta.url), "utf8");
    desktopWorkspacesCss = readFileSync(new URL("./desktop/app_css/workspaces.css", import.meta.url), "utf8");
  });

  it("loads without initialization-order ReferenceError", () => {
    doesNotThrow(() => vm.runInContext(source, context()));
  });

  it("keeps file history header scoped to selected files", () => {
    match(gitUiSource, /function renderFileToolbar\(activeTab\) \{\n\s+const view = active\(\) \|\| \{\};/);
    match(gitUiSource, /const history = view\.file \? `<button class="git-ui-btn \$\{activeTab === "history" \? "active" : ""\}" onclick="HerdrGitUi\.tab\('history'\)">History<\/button>` : "";/);
    equal([...gitUiSource.matchAll(/git-ui-log-head/g)].length, 1);
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
    match(gitUiSource, /Leave commit editor and return to changes\? Draft is saved locally\./);
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
    ok(!desktopTerminalSource.includes("term.onScroll"));
    ok(!desktopTerminalSource.includes("term.scrollToLine"));
    ok(!desktopTerminalSource.includes("const shouldPreserve"));
    match(desktopTerminalSource, /shell\.scrollTop = 0;\n\s+shell\.scrollLeft = 0;/);
    match(desktopTerminalSource, /function sendBackendTail\(\) \{[\s\S]*?for \(let i = 0; i < 120; i \+= 1\)[\s\S]*?sendBackendScroll\(200\)/);
    match(desktopTerminalSource, /function scrollTerminalToBottom\(focus = true\) \{[\s\S]*?sendBackendTail\(\);[\s\S]*?setTerminalFollowPaused\(false\);[\s\S]*?term\.scrollToBottom\(\);/);
    match(desktopTerminalSource, /ws\.onopen = \(\) => \{[\s\S]*?scrollTerminalToBottom\(false\);/);
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
    match(html, /Git selector opens repo tools for diff, stage\/unstage, discard, commit, commit & push, pull, push\/force-push, rebase, conflicts, stash, branches, cleanup, and worktree prune/);
    match(html, /Changes, log, stash, and cleanup use one exclusive segmented toggle/);
    match(html, /file filter sits below the action toolbar/);
    match(html, /cleanup uses the shared broom icon/);
    match(html, /Prefix then \/ or the header magnifier opens one palette for workspaces, repos, worktrees, labels, agents, panels, file\/folder results, and file-content matches/);
    match(html, /Alt\+F selects files, Alt\+D selects folders, Alt\+1\/2\/3 toggles sections, and Alt\+↑\/↓ expands content context/);
    match(html, /Alt\+F\/Alt\+D inside the palette to switch file or folder search, Alt\+1\/2\/3 to collapse or expand search sections, and Alt\+↑\/↓ to expand selected content-match context/);
    match(source, /DEFAULT_WEBUI_SHORTCUTS/);
    match(source, /removeWorktreeAlt: "Backspace"/);
    match(source, /removeWorktreeAlt: \(\) =>/);
    match(source, /DEFAULT_GIT_SHORTCUTS/);
    match(source, /function shortcutCollisionFor\(scope, action, key\)/);
    match(source, /data-shortcut-record/);
    match(source, /Shortcut conflict with:/);
    match(source, /optFileContentSearchDefaultExpanded/);
  });

  it("keeps Git prefix shortcuts collision-free with WebUI prefix keys", () => {
    const webuiKeys = new Set([...source.matchAll(/case "([^"]+)":/g)].map((match) => match[1]));
    const gitKeys = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyC", "KeyL", "KeyR", "KeyG", "KeyY", "KeyU", "KeyD", "KeyZ", "KeyH", "KeyM", "KeyE", "KeyO", "KeyV", "KeyI", "Digit0"];
    equal(gitKeys.filter((key) => webuiKeys.has(key)).join(","), "");
  });

  it("defines Git cleanup tab and maintenance endpoints", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    match(gitUiSource, /git-ui-cleanup-tab-icon/);
    match(gitUiSource, /renderGitViewTabs/);
    match(gitUiSource, /git-ui-view-toggle/);
    ok(gitUiSource.indexOf("Worktree actions") < gitUiSource.indexOf("git-ui-file-filter"));
    match(readFileSync(new URL("./desktop/git_ui/layout.css", import.meta.url), "utf8"), /git-ui-view-toggle-group/);
    match(readFileSync(new URL("./icons/broom.svg", import.meta.url), "utf8"), /Broom sweeping dust icon/);
    match(gitUiSource, /scanCleanup/);
    match(gitUiSource, /selectAllCleanup/);
    match(gitUiSource, /Delete selected/);
    match(gitUiSource, /\/api\/git-ui\/cleanup-scan/);
    match(gitUiSource, /\/api\/git-ui\/branch-delete/);
    match(gitUiSource, /\/api\/git-ui\/worktree-remove/);
    match(gitUiSource, /HerdrDirectoryPicker\.openInput\('gitUiCleanupRoot'\)/);
  });

  it("defines file explorer and Git file filters", () => {
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /q=\$\{encodeURIComponent\(target\.filter\.trim\(\)\)\}/);
    match(readFileSync(new URL("./desktop/file_browser.js", import.meta.url), "utf8"), /showSearch\(\)/);
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

  it("keeps content search file expansion when context is reloaded", () => {
    const ctx = context();
    ctx.localStorage.setItem("herdr-web-options", JSON.stringify({ fileContentSearchDefaultExpanded: false }));
    vm.runInContext(readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8"), ctx);
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
    vm.runInContext(readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8"), ctx);
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
    vm.runInContext(readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8"), ctx);

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
    vm.runInContext(readFileSync(new URL("./shared/workspace_search.js", import.meta.url), "utf8"), ctx);
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
    match(html, /id="optBuiltinShell"/);
    match(html, /id="optNoSleepAutoCooldown"/);
    match(html, /id="serverSettingsApply"/);
    match(html, /<h3>Network access<\/h3>/);
    match(html, /<h3>Backend<\/h3>/);
    match(html, /<h3>Power behavior<\/h3>/);
    match(html, /\.config\/herdr-webui\/webui-settings\.json/);
    match(source, /el\("optBackendMode"\)\.value = settings\.backend_mode \|\| "builtin";/);
    match(source, /backend_mode: backendMode,/);
    match(source, /builtin_shell: builtinShell \|\| null,/);
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

  it("captures terminal paste before xterm native paste", () => {
    match(source, /addEventListener\(\s*"paste"/);
    match(source, /stopImmediatePropagation\(\)/);
    match(source, /sendPasteToTerminal\(text\)/);
    match(source, /sendInputData\(terminalPasteInput\(text, false\)/);
    ok(!source.includes('JSON.stringify({ type: "paste"'));
    ok(!source.includes('.paste(text)'));
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

  it("keeps exploration and worktree default directories separate", () => {
    const ctx = context();
    vm.runInContext(source, ctx);

    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "");

    ctx.document.getElementById("optWorktreeDefaultDirectory").value = "/tmp/worktrees";
    ctx.document.getElementById("optWorktreeDefaultDirectory").oninput();
    ctx.document.getElementById("optExplorationDefaultDirectory").value = "/tmp/code";
    ctx.document.getElementById("optExplorationDefaultDirectory").oninput();
    ctx.openWorkspaceCreateModal();
    equal(ctx.document.getElementById("workspaceCreatePath").value, "/tmp/code");

    ctx.openWorktreeOpenModal();

    equal(ctx.document.getElementById("worktreeDiscoverPath").value, "/tmp/code");

    vm.runInContext('state.openWorktreeSource = { repo_name: "repo", repo_root: "/src/repo" }', ctx);
    ctx.document.getElementById("worktreeNewBranch").value = "feature/x";
    ctx.syncWorktreeCheckoutPath();
    equal(ctx.document.getElementById("worktreeNewPath").value, "/tmp/worktrees/repo/feature-x");
  });

  it("defines side-by-side and unified Git diff layouts", () => {
    match(gitSettingsSource, /id="optGitUiDiffLayout"/);
    match(gitSettingsSource, /Unified \(GitHub-style\)/);
    match(gitSettingsSource, /gitUiDiffLayout: "side-by-side"/);
    match(gitUiSource, /function diffLayoutMode\(\)/);
    match(gitUiSource, /function renderUnifiedLine\(/);
    match(gitUiSource, /git-ui-unified-row/);
    match(gitUiSource, /sideBySideRows\(chunk\)/);
    match(gitUiSource, /renderUnifiedLine\(row, path, index, rows, rowIndex, contextArrows\)/);
    match(gitUiSource, /restoreHunk\('\$\{arg\(path\)\}',\$\{hunkIndex\}\)/);
    match(gitUiSource, /function contextArrowsForChunk\(chunks, index\)/);
    match(gitUiSource, /const after = next \? hiddenGap\(chunk, next\) : false;/);
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
