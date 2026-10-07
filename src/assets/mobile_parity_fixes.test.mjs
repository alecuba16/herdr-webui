// Behavior tests for the mobile parity fixes: composer + prompt cards
// module (vm-loaded with stubs), styled confirm sheet, workspace row
// actions, layout settings module, and version footer wiring.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const composerSource = read("./mobile/composer.js");
const appSource = read("./mobile/app.js");
const bootSource = read("./app_boot.js");
const screensSource = read("./mobile/screens.js");
const settingsSource = read("./mobile/settings.js");
const backendSource = read("./mobile/backend.js");
const layoutSettingsSource = read("./desktop/layout_settings.js");
const assetsRsSource = read("../assets.rs");

function composerContext({ status = "blocked", term = null } = {}) {
  const calls = { api: [], paste: [], renders: 0 };
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
    Map,
    Promise,
    RegExp,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(composerSource, ctx);
  const state = {
    screen: "terminal",
    pane: "pane-1",
    ws: "w1",
    tab: "t1",
    agents: [{ pane_id: "pane-1", workspace_id: "w1", tab_id: "t1", agent_status: "blocked" }],
    composerNote: "",
  };
  const module = ctx.HerdrMobileComposerModule.create({
    state,
    api: async (url, opts) => {
      calls.api.push({ url, opts });
      return {};
    },
    render: () => {
      calls.renders++;
    },
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, "c"),
    inputAttrs: (hint) => ` autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no"${hint ? ` enterkeyhint="${hint}"` : ""}`,
    statusClassFn: () => status,
    getTerminal: () => term,
  });
  return { module, state, calls };
}

describe("mobile composer + prompt cards module", () => {
  it("loads and exposes its API", () => {
    const { module } = composerContext();
    assert.equal(typeof module.renderComposerBar, "function");
    assert.equal(typeof module.parsePrompt, "function");
    assert.equal(typeof module.renderPromptCard, "function");
    assert.equal(typeof module.promptAnswer, "function");
    assert.equal(typeof module.promptDismiss, "function");
  });

  it("composer bar is removed: typing goes straight into the terminal", () => {
    const { module, state, calls } = composerContext();
    // The bar stub must stay empty everywhere so panels.js never mounts a
    // second input fighting the terminal for focus.
    assert.equal(module.renderComposerBar(), "");
    assert.equal(module.renderComposerNote(), "");
    state.screen = "home";
    assert.equal(module.renderComposerBar(), "");
    assert.equal(calls.api.length, 0, "no pane submit calls without the bar");
  });

  it("wterm bundle ships the keyboard guard set for direct terminal typing", () => {
    const bundle = read("./vendor/wterm.bundle.js");
    for (const attr of ['"autocapitalize","none"', '"writingsuggestions","false"', '"autocomplete","off"', '"autocorrect","off"', '"spellcheck","false"']) {
      assert.ok(bundle.includes(`this.textarea.setAttribute(${attr})`), `wterm missing textarea guard ${attr}`);
    }
  });

  it("parsePrompt detects option dialogs", () => {
    const { module } = composerContext();
    const prompt = module.parsePrompt([
      "Agent asks:",
      "Allow network access to example.com?",
      "1. Allow once",
      "2. Allow always",
      "3. Deny",
    ]);
    assert.ok(prompt, "options prompt must parse");
    assert.equal(prompt.kind, "options");
    assert.ok(prompt.title.length > 0);
    assert.deepEqual([...prompt.options].map((o) => String(o.key)), ["1", "2", "3"]);
  });

  it("parsePrompt detects free-text questions", () => {
    const { module } = composerContext();
    const prompt = module.parsePrompt([
      "What port should the server listen on?",
      "enter your response (enter send)",
    ]);
    assert.ok(prompt, "text prompt must parse");
    assert.equal(prompt.kind, "text");
    assert.match(prompt.title, /port/);
  });

  it("parsePrompt returns null for plain output", () => {
    const { module } = composerContext();
    const prompt = module.parsePrompt([
      "cargo build finished",
      "warning: unused variable",
      "done in 3.2s",
    ]);
    assert.equal(prompt, null);
  });

  it("prompt card only renders when blocked and a prompt parses", () => {
    const term = {
      wterm: {
        bridge: {
          usingAltScreen: () => false,
          getCols: () => 40,
          getRows: () => 6,
          getCell: (r, c) => {
            const rows = [
              "Allow network access to example.com? ",
              "",
              "1. Allow once",
              "2. Allow always",
              "3. Deny",
              "",
            ];
            const line = rows[r] || "";
            const ch = line[c] || " ";
            return { width: 1, chars: ch };
          },
        },
      },
      sendPasteToTerminal: (text) => {},
    };
    const blocked = composerContext({ status: "blocked", term });
    const card = blocked.module.renderPromptCard();
    assert.match(card, /mobile-prompt-card/);
    // panels.js syncComposer tracks the card by id (el("mobilePromptCard"))
    // to replace/remove it across renders; a missing id would stack duplicates.
    assert.match(card, /id="mobilePromptCard"/, "prompt card keeps the tracked id");
    assert.match(card, /Allow network access/);

    const working = composerContext({ status: "working", term });
    assert.equal(working.module.renderPromptCard(), "", "no card when not blocked");

    const noTerm = composerContext({ status: "blocked", term: null });
    assert.equal(noTerm.module.renderPromptCard(), "", "no card without a terminal");

    // Free-text prompt branch: the answer input must carry the full guard
    // set so Android autocorrect/grammar never mangles a typed answer.
    const textTerm = {
      wterm: {
        bridge: {
          usingAltScreen: () => false,
          getCols: () => 40,
          getRows: () => 6,
          getCell: (r, c) => {
            const rows = ["What is the API token?", "", "Enter your response:"];
            const line = rows[r] || "";
            const ch = line[c] || " ";
            return { width: 1, chars: ch };
          },
        },
      },
      sendPasteToTerminal: () => {},
    };
    const textCard = composerContext({ status: "blocked", term: textTerm }).module.renderPromptCard();
    assert.match(textCard, /id="mobilePromptInput"/, "free-text prompt renders the answer input");
    assert.match(textCard, /autocomplete="off"/);
    assert.match(textCard, /autocorrect="off"/);
    assert.match(textCard, /autocapitalize="none"/);
    assert.match(textCard, /spellcheck="false"/);
    assert.match(textCard, /writingsuggestions="false"/);
    assert.match(textCard, /enterkeyhint="send"/);
  });

  it("prompt card renders as a bottom sheet with backdrop and Cancel", () => {
    const term = {
      wterm: {
        bridge: {
          usingAltScreen: () => false,
          getCols: () => 40,
          getRows: () => 6,
          getCell: (r, c) => {
            const rows = [
              "Allow network access to example.com? ",
              "",
              "1. Allow once",
              "2. Allow always",
              "3. Deny",
              "",
            ];
            const line = rows[r] || "";
            const ch = line[c] || " ";
            return { width: 1, chars: ch };
          },
        },
      },
      sendPasteToTerminal: () => {},
    };
    const card = composerContext({ status: "blocked", term }).module.renderPromptCard();
    // Sheet chrome: backdrop + sheet + handle, so it reads like the other
    // mobile sheets instead of a floating card glued to the old composer bar.
    assert.match(card, /mobile-sheet-backdrop mobile-prompt-backdrop/);
    assert.match(card, /mobile-sheet mobile-prompt-card/);
    assert.match(card, /mobile-sheet-handle/);
    // Cancel button replaces the old bare ✕ glyph.
    assert.match(card, /aria-label="Cancel and close question"/);
    assert.ok(!/>✕<\/button>/.test(card), "no bare ✕ close button");
    // Backdrop click also dismisses.
    assert.match(card, /mobile-prompt-backdrop" onclick="HerdrMobile\.promptDismiss/);
  });

  it("document Escape handler closes prompt card between confirm and tabs sheet", () => {
    // The document-level Escape chain must cover the composer prompt card:
    // after the confirm sheet, before the tabs sheet, the handler clicks
    // the card's Cancel button so the composer cleanup path runs
    // (promptDismiss) instead of just hiding the node. Static shape check on
    // the real app.js source: the prompt-card branch must exist, must call
    // preventDefault, must click .mobile-prompt-head button, and must sit
    // between the confirm branch and the tabs-sheet branch.
    const confirmIdx = appSource.indexOf('const confirmSheet = el("mobileConfirmSheet")');
    const promptIdx = appSource.indexOf('const promptCard = el("mobilePromptCard")');
    const tabsIdx = appSource.indexOf("if (state.tabsSheetOpen) {");
    assert.ok(confirmIdx > 0, "confirm branch present");
    assert.ok(promptIdx > confirmIdx, "prompt-card branch after confirm branch");
    assert.ok(tabsIdx > promptIdx, "prompt-card branch before tabs-sheet branch");
    const branch = appSource.slice(promptIdx - 20, promptIdx + 260);
    assert.match(branch, /event\.preventDefault\(\)/);
    assert.match(branch, /\.mobile-prompt-head button"\)\?\.click\(\)/);
  });

  it("answering an option sends the key through the terminal paste path", async () => {
    const pasted = [];
    const term = {
      wterm: {
        bridge: {
          usingAltScreen: () => false,
          getCols: () => 40,
          getRows: () => 6,
          getCell: (r, c) => {
            const rows = [
              "Allow network access to example.com? ",
              "",
              "1. Allow once",
              "2. Allow always",
              "3. Deny",
              "",
            ];
            const line = rows[r] || "";
            return { width: 1, chars: line[c] || " " };
          },
        },
      },
      sendPasteToTerminal: (text) => pasted.push(text),
    };
    const { module } = composerContext({ status: "blocked", term });
    module.promptAnswer("Allow network access to example.com", "2");
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0], "2\r");
    // After answering, the dismiss key prevents re-showing the same prompt.
    assert.equal(module.renderPromptCard(), "");
  });

  it("dismiss hides the card until a different prompt appears", () => {
    const term = {
      wterm: {
        bridge: {
          usingAltScreen: () => false,
          getCols: () => 40,
          getRows: () => 6,
          getCell: (r, c) => {
            const rows = [
              "Allow network access to example.com? ",
              "",
              "1. Allow once",
              "2. Allow always",
              "3. Deny",
              "",
            ];
            const line = rows[r] || "";
            return { width: 1, chars: line[c] || " " };
          },
        },
      },
    };
    const { module } = composerContext({ status: "blocked", term });
    assert.match(module.renderPromptCard(), /mobile-prompt-card/);
    module.promptDismiss("Allow network access to example.com");
    assert.equal(module.renderPromptCard(), "");
  });

  it("alt-screen terminals produce no card", () => {
    const term = {
      wterm: {
        bridge: {
          usingAltScreen: () => true,
          getCols: () => 40,
          getRows: () => 6,
          getCell: () => ({ width: 1, chars: "x" }),
        },
      },
    };
    const { module } = composerContext({ status: "blocked", term });
    assert.equal(module.renderPromptCard(), "");
  });
});

describe("styled confirm sheet wiring", () => {
  it("app.js defines a promise-based mobileConfirm with a FIFO queue", () => {
    assert.match(appSource, /function mobileConfirm\(message\)/);
    assert.match(appSource, /const confirmQueue = \[\]/);
    assert.match(appSource, /function showNextConfirm\(\)/);
    assert.match(appSource, /function resolveConfirm\(value\)/);
    assert.match(appSource, /mobileConfirmSheet/);
    assert.match(appSource, /resolveConfirm,/);
  });

  it("no raw window.confirm remains in the wiring paths", () => {
    assert.ok(!/=> confirm\(\.\.\.args\)/.test(appSource), "wirings must use mobileConfirm");
  });

  it("all confirm call sites await the promise", () => {
    const files = [
      ["./mobile/actions.js", /await confirmFn\(`Close panel/],
      ["./mobile/git.js", /await confirmFn\(`Discard all uncommitted changes/],
      ["./mobile/git.js", /await confirmFn\(`Switch to branch/],
      ["./mobile/screens.js", /await confirmFn\(`Close workspace/],
      ["./mobile/sessions.js", /await confirmFn\("Remove stale closed/],
      ["./mobile/sessions.js", /await confirmFn\(`Close current/],
      ["./mobile/sessions.js", /await confirmFn\(`Close \$\{sessionBackendLabel\(rowBackend\)\}/],
      ["./mobile/backend.js", /\(await confirmFn\(/],
      ["./mobile/file_browser.js", /await deps\.confirm\(`Delete/],
      ["./mobile/file_browser.js", /await deps\.confirm\(`Discard unsaved/],
    ];
    for (const [path, pattern] of files) {
      const source = read(path);
      assert.ok(pattern.test(source), `${path} must await confirm (${pattern})`);
    }
    // And no sync `if (!confirmFn(` remains anywhere.
    for (const path of ["./mobile/actions.js", "./mobile/git.js", "./mobile/screens.js", "./mobile/sessions.js", "./mobile/backend.js", "./mobile/file_browser.js"]) {
      const source = read(path);
      assert.ok(!/if \(!confirmFn\(/.test(source), `${path} must not call confirmFn sync`);
      assert.ok(!/if \(!deps\.confirm\(/.test(source), `${path} must not call confirm sync`);
    }
  });

  it("confirm sheet is mounted in the shell outside the screen container", () => {
    const shellIdx = appSource.indexOf("function renderShell()");
    const sheetIdx = appSource.indexOf('id="mobileConfirmSheet"');
    const screenIdx = appSource.indexOf('id="mobileScreen"');
    assert.ok(shellIdx > -1 && sheetIdx > shellIdx, "sheet markup must be inside renderShell");
    // The sheet appears after the drawer markup, i.e. outside <main>.
    assert.ok(sheetIdx > screenIdx, "sheet must not be inside the screen element");
  });
});

describe("workspace row actions wiring", () => {
  it("screens.js renders rename/close buttons per workspace row", () => {
    assert.match(screensSource, /HerdrMobile\.renameWorkspace\(/);
    assert.match(screensSource, /HerdrMobile\.closeWorkspace\(/);
    assert.match(screensSource, /\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/rename/);
    assert.match(screensSource, /\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/close/);
    assert.match(screensSource, /renderRenameSheet\(\)/);
  });

  it("rename sheet reuses the shared sheet classes", () => {
    assert.match(screensSource, /mobile-sheet-backdrop/);
    assert.match(screensSource, /mobile-sheet-handle/);
    assert.match(screensSource, /mobile-sheet-title/);
    assert.match(screensSource, /mobile-sheet-actions/);
  });

  it("app.js registers the rename/close actions on HerdrMobile", () => {
    assert.match(appSource, /renameWorkspace: \(\.\.\.args\) => mobileScreens\.startRenameWorkspace/);
    assert.match(appSource, /closeWorkspace: \(\.\.\.args\) => mobileScreens\.closeWorkspaceById/);
  });

  it("composer.js loads before app.js and is registered in boot", () => {
    const composerIdx = bootSource.indexOf("/assets/mobile/composer.js");
    const appIdx = bootSource.indexOf("/assets/mobile/app.js");
    assert.ok(composerIdx > -1 && composerIdx < appIdx, "composer.js loads before app.js");
    assert.match(assetsRsSource, /mobile\/composer\.js/);
  });

  it("unknown nav statuses render no pill", () => {
    const screens = read("./mobile/screens.js");
    assert.match(screens, /\["blocked",\s*"done",\s*"idle",\s*"working"\]/);
  });
});

describe("desktop layout settings module", () => {
  it("registers a layout section on the desktop settings surface", () => {
    const sandbox = {
      window: {},
      document: {
        getElementById: () => null,
      },
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(layoutSettingsSource, ctx);
    const modules = ctx.window.HerdrSettingsModules;
    assert.ok(Array.isArray(modules) && modules.length === 1);
    const module = modules[0];
    assert.equal(module.id, "layout");
    assert.match(module.html, /id="optLayoutMode"/);
    assert.match(module.html, /herdr-web-layout|viewport width/);
  });

  it("the module is concatenated into the desktop bundle", () => {
    assert.match(assetsRsSource, /include_str!\("assets\/desktop\/layout_settings\.js"\)/);
  });
});

describe("mobile version footer", () => {
  it("backend.js loads /api/versions into state.versionsText", () => {
    assert.match(backendSource, /api\("\/api\/versions"\)/);
    assert.match(backendSource, /versionsText/);
  });

  it("settings.js renders the version footer in the Data section", () => {
    assert.match(settingsSource, /mobileVersionFooter/);
    assert.match(settingsSource, /versionsText \|\| "webui - · backend -"/);
  });
});