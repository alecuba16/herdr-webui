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
    assert.equal(typeof module.submit, "function");
    assert.equal(typeof module.setDraft, "function");
    assert.equal(typeof module.parsePrompt, "function");
    assert.equal(typeof module.renderComposerBar, "function");
    assert.equal(typeof module.renderPromptCard, "function");
  });

  it("composer bar renders only on the terminal screen with a pane", () => {
    const { module, state } = composerContext();
    assert.match(module.renderComposerBar(), /id="mobileComposerInput"/);
    state.screen = "home";
    assert.equal(module.renderComposerBar(), "");
    state.screen = "terminal";
    state.pane = null;
    assert.equal(module.renderComposerBar(), "");
  });

  it("composer input carries the full mobile keyboard guard attribute set", () => {
    const { module } = composerContext();
    const html = module.renderComposerBar();
    assert.match(html, /autocomplete="off"/);
    assert.match(html, /autocorrect="off"/);
    assert.match(html, /autocapitalize="none"/);
    assert.match(html, /spellcheck="false"/);
    assert.match(html, /writingsuggestions="false"/);
    assert.match(html, /enterkeyhint="send"/);
  });

  it("drafts are per-pane and survive renders", () => {
    const { module, state } = composerContext();
    module.setDraft("hello one");
    state.pane = "pane-2";
    module.setDraft("hello two");
    assert.equal(module.draftFor("pane-1"), "hello one");
    assert.equal(module.draftFor("pane-2"), "hello two");
    assert.equal(module.draftValue(), "hello two");
  });

  it("submit posts to /api/panes/{id}/submit and clears the draft", async () => {
    const { module, calls } = composerContext();
    module.setDraft("do the thing\n");
    await module.submit();
    assert.equal(calls.api.length, 1);
    assert.equal(calls.api[0].url, "/api/panes/pane-1/submit");
    assert.equal(calls.api[0].opts.method, "POST");
    assert.deepEqual(JSON.parse(calls.api[0].opts.body), { text: "do the thing" });
    assert.equal(module.draftFor("pane-1"), "");
  });

  it("submit is a no-op for empty/whitespace drafts", async () => {
    const { module, calls } = composerContext();
    module.setDraft("   \n  ");
    await module.submit();
    assert.equal(calls.api.length, 0);
  });

  it("oversized drafts are refused locally with a note", async () => {
    const { module, state, calls } = composerContext();
    module.setDraft("x".repeat(20001));
    await module.submit();
    assert.equal(calls.api.length, 0, "must not call the API");
    assert.match(state.composerNote, /20000/);
  });

  it("api failures surface as composer notes", async () => {
    const { module, state } = composerContext({ status: "working" });
    // Re-create with a failing api.
    const failing = composerContext({ status: "working" });
    failing.module.setDraft("boom");
    failing.state.__failApi = true;
    // Patch by making a new module with failing api
    const sandbox = {
      console, setTimeout, clearTimeout, Date, JSON, Object, Array, Math,
      Number, String, Error, Set, Map, Promise, RegExp, encodeURIComponent,
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(composerSource, ctx);
    const mod = ctx.HerdrMobileComposerModule.create({
      state: failing.state,
      api: async () => {
        throw Object.assign(new Error("panel has no agent"), { details: { note: "No agent attached to this panel." } });
      },
      render: () => {},
      escapeHtml: (s) => String(s),
      inputAttrs: () => "",
      statusClassFn: () => "working",
      getTerminal: () => null,
    });
    mod.setDraft("hello");
    await mod.submit();
    assert.equal(failing.state.composerNote, "No agent attached to this panel.");
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
    assert.match(card, /id="mobilePromptCard"/);
    assert.match(card, /Allow network access/);

    const working = composerContext({ status: "working", term });
    assert.equal(working.module.renderPromptCard(), "", "no card when not blocked");

    const noTerm = composerContext({ status: "blocked", term: null });
    assert.equal(noTerm.module.renderPromptCard(), "", "no card without a terminal");
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