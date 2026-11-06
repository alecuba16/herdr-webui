import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Coverage batch for the five small settings modules split off from the
// bindings work: desktop/lsp_settings.js, desktop/layout_settings.js,
// desktop/window_layout_settings.js, desktop/git_ui/settings.js, and
// desktop/git_ui/diff_search.js. Each module boots in its own vm context
// with the product script compiled under its real path so c8 attributes
// lines to the source file. Known dead code left uncovered on purpose:
// lsp_settings.js api()/post() bodies (no callers; the toggle path goes
// through window.HerdrLsp.updateConfig).

function productScript(relPath) {
  productScript.cache = productScript.cache || new Map();
  if (!productScript.cache.has(relPath)) {
    const realPath = fileURLToPath(new URL(relPath, import.meta.url));
    productScript.cache.set(relPath, new vm.Script(readFileSync(realPath, "utf8"), { filename: realPath }));
  }
  return productScript.cache.get(relPath);
}

function element(id = "") {
  return {
    id,
    dataset: {},
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    title: "",
    children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    remove() {},
    insertBefore() {},
    replaceWith() {},
    closest() { return null; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    click() { if (typeof this.onclick === "function") this.onclick(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };
}

// Registry-backed getElementById: unknown ids materialize on demand, and a
// test can pin an id to null by storing null in the map (the `if (node)`
// guards in the product code).
function idRegistry() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  return { elements, get };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("lsp_settings.js", () => {
  function boot({ lsp, feedback, fileBrowser, http } = {}) {
    const { elements, get } = idRegistry();
    const storage = new Map();
    const timers = [];
    const window = {};
    if (lsp !== undefined) window.HerdrLsp = lsp;
    if (feedback !== undefined) window.HerdrSettingsFeedback = feedback;
    if (fileBrowser !== undefined) window.HerdrFileBrowser = fileBrowser;
    const sandboxObject = {
      window,
      document: { getElementById: get },
      localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
      },
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout() {},
      fetch: async () => { throw Error("fetch must not be reached"); },
    };
    if (http !== undefined) sandboxObject.HerdrHttp = http;
    sandboxObject.globalThis = sandboxObject;
    const ctx = vm.createContext(sandboxObject);
    productScript("./desktop/lsp_settings.js").runInContext(ctx);
    return { ctx, window, get, elements, modules: window.HerdrSettingsModules, timers };
  }

  it("registers the module, forces the boolean, and applies it to the checkbox", () => {
    const { modules, get } = boot({});
    assert.equal(modules.length, 1);
    assert.equal(modules[0].id, "lsp");
    assert.equal(typeof modules[0].desc, "string");
    assert.deepEqual([...modules[0].ids], ["optLspEnabled"]);
    assert.deepEqual({ ...modules[0].defaults }, { lspEnabled: false });
    const options = { lspEnabled: "yes" };
    modules[0].normalize(options);
    assert.equal(options.lspEnabled, false, "non-boolean coerces to false");
    options.lspEnabled = true;
    modules[0].normalize(options);
    assert.equal(options.lspEnabled, true);
    modules[0].apply(options);
    assert.equal(get("optLspEnabled").checked, true);
    modules[0].apply({ lspEnabled: false });
    assert.equal(get("optLspEnabled").checked, false);
    // missing element: apply survives a null checkbox
    const { modules: m2, elements } = boot({});
    elements.set("optLspEnabled", null);
    m2[0].apply({ lspEnabled: true });
    assert.ok(true, "no throw with a null checkbox");
  });

  it("bind wires the enable checkbox and the scan button exactly once", () => {
    const calls = [];
    const { modules, get, window } = boot({
      fileBrowser: { refreshLsp() { calls.push(["refreshLsp"]); } },
    });
    const bindCtx = {
      setOption(key, value) { calls.push(["set", key, value]); },
      saveOptions() { calls.push(["save"]); },
    };
    modules[0].bind(bindCtx);
    const enabled = get("optLspEnabled");
    const scan = get("lspSettingsScan");
    assert.equal(enabled.dataset.bound, "1");
    assert.equal(scan.dataset.bound, "1");
    // bind also fired the initial scan; no HerdrLsp means the unavailable note
    assert.match(get("lspSettingsServers").innerHTML, /LSP client unavailable/);
    enabled.checked = true;
    enabled.onchange();
    assert.deepEqual(calls, [["set", "lspEnabled", true], ["save"], ["refreshLsp"]]);
    // refreshLsp is optional
    const bare = boot({});
    const bareCalls = [];
    bare.modules[0].bind({ setOption() {}, saveOptions() { bareCalls.push(1); } });
    bare.get("optLspEnabled").checked = false;
    bare.get("optLspEnabled").onchange();
    assert.deepEqual(bareCalls, [1], "save still runs without HerdrFileBrowser");
    // second bind never rewires
    const before = enabled.onchange;
    modules[0].bind(bindCtx);
    assert.equal(enabled.onchange, before);
  });

  it("reload without a container or without HerdrLsp is a safe no-op", async () => {
    const { window, elements } = boot({});
    elements.set("lspSettingsServers", null);
    await window.HerdrLspSettings.reload();
    assert.ok(true, "null container returns early");
    const noLsp = boot({});
    await noLsp.window.HerdrLspSettings.reload();
    assert.match(noLsp.get("lspSettingsServers").innerHTML, /LSP client unavailable/);
  });

  it("the scan renders server rows from config plus detection", async () => {
    const config = {
      languages: ["python", "go", "ghost"],
      settings: {
        enabled: true,
        servers: {
          go: { enabled: true, command: "gopls", args: ["-h"] },
          ghost: { enabled: false, command: "ghost-lang" },
        },
      },
    };
    const detected = [
      { language: "go", name: "gopls", found: "/usr/bin/gopls", hint: "" },
      { language: "python", name: "pylsp", found: false, hint: "pip install python-lsp-server" },
    ];
    const { window, get } = boot({
      lsp: { getConfig: async () => config, detect: async () => detected },
    });
    const container = get("lspSettingsServers");
    const promise = window.HerdrLspSettings.reload();
    assert.match(container.innerHTML, /Scanning…/);
    await promise;
    const html = container.innerHTML;
    assert.match(html, /Installed/);
    assert.match(html, /Not found/);
    assert.match(html, /pip install python-lsp-server/, "install hint on the missing row");
    assert.match(html, /data-lsp-language-enable="go" checked/, "configured go row checked");
    assert.match(html, /ghost-lang/, "undetected language falls back to the configured command");
    assert.match(html, /title="\/usr\/bin\/gopls"/, "found path rides the status title");
    // config.languages empty: the detected languages drive the rows
    const detectedOnly = boot({
      lsp: {
        getConfig: async () => ({ languages: [], settings: { enabled: false, servers: {} } }),
        detect: async () => detected,
      },
    });
    await detectedOnly.window.HerdrLspSettings.reload();
    assert.match(detectedOnly.get("lspSettingsServers").innerHTML, /data-language="go"/);
    // nothing known at all: the empty note
    const empty = boot({
      lsp: { getConfig: async () => ({ languages: [], settings: {} }), detect: async () => [] },
    });
    await empty.window.HerdrLspSettings.reload();
    assert.match(empty.get("lspSettingsServers").innerHTML, /No known languages/);
  });

  it("a failed scan writes the error and clears the container", async () => {
    const { window, get, elements } = boot({
      lsp: { getConfig: async () => { throw Error("scan failed"); }, detect: async () => [] },
    });
    await window.HerdrLspSettings.reload();
    assert.equal(get("lspSettingsError").textContent, "scan failed");
    assert.equal(get("lspSettingsServers").innerHTML, "");
    // error element missing: the catch survives a null
    const { window: w2, elements: e2, get: g2 } = boot({
      lsp: { getConfig: async () => { throw Error("boom"); }, detect: async () => [] },
    });
    e2.set("lspSettingsError", null);
    await w2.HerdrLspSettings.reload();
    assert.equal(g2("lspSettingsServers").innerHTML, "");
  });

  it("toggling a language posts the merged settings and updates the live config", async () => {
    const config = {
      languages: ["go"],
      settings: { enabled: true, servers: { go: { enabled: true, command: "gopls", args: ["-h"] } } },
    };
    const detected = [{ language: "go", name: "gopls", found: "/bin/gopls", hint: "" }];
    const posted = [];
    let nextBody = { settings: { enabled: true, servers: {} } };
    let failNext = false;
    const { window, get } = boot({
      lsp: {
        getConfig: async () => config,
        detect: async () => detected,
        updateConfig: async (settings) => {
          if (failNext) throw Error("boom");
          posted.push(settings);
          return nextBody;
        },
      },
    });
    // renderServers attaches onchange to whatever querySelectorAll
    // returns; seed the fake input BEFORE the reload that renders rows.
    const input = {
      checked: false,
      getAttribute: () => "go",
      closest: () => element("row"),
    };
    get("lspSettingsServers").querySelectorAll = () => [input];
    await window.HerdrLspSettings.reload();
    input.onchange();
    await flush();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].servers.go.enabled, false, "toggle writes enabled false");
    assert.equal(posted[0].servers.go.command, "gopls", "existing command preserved");
    assert.deepEqual([...posted[0].servers.go.args], ["-h"], "existing args preserved");
    assert.equal(config.settings, nextBody.settings, "config adopts the server response");
    assert.equal(get("lspSettingsError").textContent, "");
    // failure path: checkbox reverts, error surfaces
    failNext = true;
    input.checked = true;
    input.onchange();
    await flush();
    assert.equal(input.checked, false, "failed toggle reverts");
    assert.equal(get("lspSettingsError").textContent, "boom");
  });

  it("the settings feedback badge rides the toggle when present", async () => {
    const flashes = [];
    const feedback = {
      create() {
        return {
          flashSavingRow(row) {
            flashes.push(["saving", row]);
            return {
              done(label) { flashes.push(["done", label]); },
              fail(message) { flashes.push(["fail", message]); },
            };
          },
        };
      },
    };
    const config = { languages: ["go"], settings: { enabled: true, servers: { go: { enabled: true } } } };
    const detected = [{ language: "go", name: "gopls", found: "/bin/gopls", hint: "" }];
    const { window, get } = boot({
      lsp: {
        getConfig: async () => config,
        detect: async () => detected,
        updateConfig: async (settings) => ({ settings }),
      },
      feedback,
    });
    const input = { checked: false, getAttribute: () => "go", closest: () => element("row") };
    get("lspSettingsServers").querySelectorAll = () => [input];
    await window.HerdrLspSettings.reload();
    input.onchange();
    await flush();
    assert.deepEqual(flashes.slice(-1), [["done", "Saved"]]);
    // feedback present but the row lookup fails: no badge, toggle still saves
    const noRow = { checked: true, getAttribute: () => "go", closest: () => null };
    get("lspSettingsServers").querySelectorAll = () => [noRow];
    await window.HerdrLspSettings.reload();
    noRow.onchange();
    await flush();
    assert.equal(flashes.length, 2, "no badge without a row");
  });
});

describe("layout_settings.js", () => {
  function boot({ stored, throwingGet, throwingSet } = {}) {
    const { elements, get } = idRegistry();
    const window = {};
    const saved = [];
    window.location = { reload() { saved.push(["reload"]); } };
    window.setTimeout = (fn, ms) => { saved.push(["timer", ms]); window.__timer = fn; return 1; };
    const storage = new Map();
    if (stored !== undefined) storage.set("herdr-web-layout", stored);
    const sandboxObject = {
      window,
      document: { getElementById: get },
      localStorage: {
        getItem: throwingGet ? () => { throw Error("denied"); } : (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: throwingSet ? () => { throw Error("read only"); } : (key, value) => storage.set(key, String(value)),
      },
    };
    sandboxObject.globalThis = sandboxObject;
    const ctx = vm.createContext(sandboxObject);
    productScript("./desktop/layout_settings.js").runInContext(ctx);
    return { ctx, window, get, elements, modules: window.HerdrSettingsModules, saved, storage };
  }

  it("registers the layout module and reads every stored preference shape", () => {
    const { modules, get } = boot({ stored: "mobile" });
    assert.equal(modules.length, 1);
    assert.equal(modules[0].id, "layout");
    assert.deepEqual([...modules[0].ids], ["optLayoutMode"]);
    modules[0].normalize({});
    modules[0].apply({});
    assert.equal(get("optLayoutMode").value, "mobile", "stored mobile applies");
    const desk = boot({ stored: "desktop" });
    desk.modules[0].apply({});
    assert.equal(desk.get("optLayoutMode").value, "desktop", "stored desktop applies");
    const garbage = boot({ stored: "bogus" });
    garbage.modules[0].apply({});
    assert.equal(garbage.get("optLayoutMode").value, "auto", "garbage falls back to auto");
    const empty = boot({ stored: null });
    empty.modules[0].apply({});
    assert.equal(empty.get("optLayoutMode").value, "auto", "empty falls back to auto");
    const denied = boot({ throwingGet: true });
    denied.modules[0].apply({});
    assert.equal(denied.get("optLayoutMode").value, "auto", "a throwing getItem falls back to auto");
  });

  it("bind persists the choice, notes the reload, and reloads through the timer", () => {
    const s = boot({});
    s.modules[0].bind({});
    const select = s.get("optLayoutMode");
    assert.equal(select.dataset.bound, "1");
    assert.equal(select.value, "auto", "bind seeds the current preference");
    select.value = "desktop";
    select.onchange();
    assert.equal(s.storage.get("herdr-web-layout"), "desktop");
    const note = s.get("layoutSettingsNote");
    assert.equal(note.textContent, "Layout preference saved. Reloading…");
    assert.equal(note.hidden, false);
    s.window.__timer();
    assert.deepEqual(s.saved, [["timer", 150], ["reload"]]);
    // invalid select value persists as auto
    const s2 = boot({});
    s2.modules[0].bind({});
    const select2 = s2.get("optLayoutMode");
    select2.value = "bogus";
    select2.onchange();
    assert.equal(s2.storage.get("herdr-web-layout"), "auto");
    // a throwing setItem still notes and reloads
    const s3 = boot({ throwingSet: true });
    s3.modules[0].bind({});
    s3.get("optLayoutMode").value = "mobile";
    s3.get("optLayoutMode").onchange();
    assert.equal(s3.get("layoutSettingsNote").textContent, "Layout preference saved. Reloading…");
    // missing note element: no crash
    const s4 = boot({});
    s4.elements.set("layoutSettingsNote", null);
    s4.modules[0].bind({});
    s4.get("optLayoutMode").value = "mobile";
    s4.get("optLayoutMode").onchange();
    assert.ok(true, "null note tolerated");
    // double bind is idempotent
    const before = select.onchange;
    s.modules[0].bind({});
    assert.equal(select.onchange, before);
  });
});

describe("window_layout_settings.js", () => {
  function boot({ resetImpl } = {}) {
    const { elements, get } = idRegistry();
    const window = {};
    if (resetImpl !== undefined) window.resetWindowLayout = resetImpl;
    const sandboxObject = {
      window,
      document: { getElementById: get },
    };
    sandboxObject.globalThis = sandboxObject;
    const ctx = vm.createContext(sandboxObject);
    productScript("./desktop/window_layout_settings.js").runInContext(ctx);
    return { ctx, window, get, elements, modules: window.HerdrSettingsModules };
  }

  it("registers the windowLayout module with no-op normalize and apply", () => {
    const { modules } = boot({});
    assert.equal(modules.length, 1);
    assert.equal(modules[0].id, "windowLayout");
    assert.match(modules[0].html, /windowLayoutReset/);
    assert.deepEqual([...modules[0].ids], ["windowLayoutReset"]);
    modules[0].normalize({});
    modules[0].apply({});
    assert.ok(true);
  });

  it("bind attaches the reset handler once and reset covers every promise shape", async () => {
    const s = boot({ resetImpl: async () => true });
    s.modules[0].bind();
    const button = s.get("windowLayoutReset");
    assert.equal(button.dataset.bound, "1");
    button.onclick();
    await flush();
    const note = s.get("windowLayoutResetNote");
    assert.equal(note.textContent, "Layout reset. Panes rebuilt as single panes.");
    assert.equal(note.hidden, false);
    // done false: no note
    const s2 = boot({ resetImpl: async () => false });
    s2.modules[0].bind();
    s2.get("windowLayoutReset").onclick();
    await flush();
    assert.equal(s2.get("windowLayoutResetNote").textContent, "");
    // rejection: caught, note untouched
    const s3 = boot({ resetImpl: async () => { throw Error("boom"); } });
    s3.modules[0].bind();
    s3.get("windowLayoutReset").onclick();
    await flush();
    assert.equal(s3.get("windowLayoutResetNote").textContent, "");
    // resetWindowLayout absent: onclick is a no-op
    const s4 = boot({});
    s4.modules[0].bind();
    s4.get("windowLayoutReset").onclick();
    await flush();
    assert.equal(s4.get("windowLayoutResetNote").textContent, "");
    // resetWindowLayout present but not a function: still a no-op
    const s5 = boot({});
    s5.window.resetWindowLayout = "not callable";
    s5.modules[0].bind();
    s5.get("windowLayoutReset").onclick();
    await flush();
    assert.equal(s5.get("windowLayoutResetNote").textContent, "");
    // note element missing on the success path: no crash
    const s6 = boot({ resetImpl: async () => true });
    s6.elements.set("windowLayoutResetNote", null);
    s6.modules[0].bind();
    s6.get("windowLayoutReset").onclick();
    await flush();
    assert.ok(true, "null note tolerated");
    // double bind keeps the first handler
    const before = button.onclick;
    s.modules[0].bind();
    assert.equal(button.onclick, before);
  });
});

describe("git_ui/settings.js", () => {
  function boot() {
    const { elements, get } = idRegistry();
    const window = {};
    const sandboxObject = {
      window,
      document: { getElementById: get },
      inputAttrs: (hint) => ` attrs="${hint}"`,
    };
    sandboxObject.globalThis = sandboxObject;
    const ctx = vm.createContext(sandboxObject);
    productScript("./desktop/git_ui/settings.js").runInContext(ctx);
    return { ctx, window, get, elements, modules: window.HerdrSettingsModules };
  }

  it("normalize clamps and defaults every git ui option", () => {
    const { modules } = boot();
    const module = modules[0];
    assert.equal(module.id, "gitUi");
    const options = {};
    module.normalize(options);
    assert.equal(options.gitUiEnabled, true);
    assert.equal(options.gitUiFileListMode, "tree");
    assert.equal(options.gitUiDiffLayout, "side-by-side");
    assert.equal(options.gitUiDefaultBranch, "master");
    assert.equal(options.gitUiLargeDiffLineLimit, 2000);
    assert.equal(options.gitUiRemoteBranchPreload, 10);
    const garbage = {
      gitUiEnabled: false,
      gitUiFileListMode: "flat",
      gitUiDiffLayout: "unified",
      gitUiDefaultBranch: "   ",
      gitUiLargeDiffLineLimit: 999999,
      gitUiRemoteBranchPreload: 0,
    };
    module.normalize(garbage);
    assert.equal(garbage.gitUiEnabled, false);
    assert.equal(garbage.gitUiFileListMode, "flat");
    assert.equal(garbage.gitUiDiffLayout, "unified");
    assert.equal(garbage.gitUiDefaultBranch, "master", "blank trims back to master");
    assert.equal(garbage.gitUiLargeDiffLineLimit, 200000, "limit clamps high");
    assert.equal(garbage.gitUiRemoteBranchPreload, 1, "preload clamps low");
    const negative = { gitUiLargeDiffLineLimit: -5, gitUiRemoteBranchPreload: 150 };
    module.normalize(negative);
    assert.equal(negative.gitUiLargeDiffLineLimit, 0, "negative limit clamps to zero");
    assert.equal(negative.gitUiRemoteBranchPreload, 100, "preload clamps high");
    const strings = {
      gitUiFileListMode: "bogus",
      gitUiDiffLayout: "bogus",
      gitUiDefaultBranch: "  trunk  ",
      gitUiLargeDiffLineLimit: "NaN",
      gitUiRemoteBranchPreload: "NaN",
    };
    module.normalize(strings);
    assert.equal(strings.gitUiFileListMode, "tree");
    assert.equal(strings.gitUiDiffLayout, "side-by-side");
    assert.equal(strings.gitUiDefaultBranch, "trunk", "branch trims");
    assert.equal(strings.gitUiLargeDiffLineLimit, 2000, "NaN limit falls back");
    assert.equal(strings.gitUiRemoteBranchPreload, 10, "NaN preload falls back");
  });

  it("apply writes every control and keeps the stock defaults for nullish", () => {
    const { modules, get } = boot();
    modules[0].apply({
      gitUiEnabled: false,
      gitUiFileListMode: "flat",
      gitUiDiffLayout: "unified",
      gitUiDefaultBranch: "trunk",
      gitUiLargeDiffLineLimit: 500,
      gitUiRemoteBranchPreload: 42,
    });
    assert.equal(get("optGitUiEnabled").checked, false);
    assert.equal(get("optGitUiFileListMode").value, "flat");
    assert.equal(get("optGitUiDiffLayout").value, "unified");
    assert.equal(get("optGitUiDefaultBranch").value, "trunk");
    assert.equal(get("optGitUiLargeDiffLineLimit").value, "500");
    assert.equal(get("optGitUiRemoteBranchPreload").value, "42");
    modules[0].apply({});
    assert.equal(get("optGitUiEnabled").checked, true, "undefined enabled reads as not-false");
    assert.equal(get("optGitUiFileListMode").value, "tree");
    assert.equal(get("optGitUiDiffLayout").value, "side-by-side");
    assert.equal(get("optGitUiDefaultBranch").value, "master");
    assert.equal(get("optGitUiLargeDiffLineLimit").value, "2000", "nullish limit keeps 2000");
    assert.equal(get("optGitUiRemoteBranchPreload").value, "10", "nullish preload keeps 10");
    modules[0].apply({ gitUiLargeDiffLineLimit: 0, gitUiRemoteBranchPreload: 0 });
    assert.equal(get("optGitUiLargeDiffLineLimit").value, "0", "zero limit stays zero");
    assert.equal(get("optGitUiRemoteBranchPreload").value, "0", "zero preload stays zero through apply");
    // missing elements: apply survives nulls everywhere
    const { modules: m2, elements } = boot();
    for (const id of m2[0].ids) elements.set(id, null);
    m2[0].apply({ gitUiEnabled: true });
    assert.ok(true, "null controls tolerated");
  });

  it("bind commits every control through setOption/save/apply and refreshes the ui", () => {
    const { modules, get, window } = boot();
    const calls = [];
    const bindCtx = {
      opts: {},
      setOption(key, value) { calls.push(["set", key, value]); this.opts[key] = value; },
      saveOptions() { calls.push(["save"]); },
      applyOptions() { calls.push(["apply"]); },
    };
    window.HerdrGitUi = { refreshVisible() { calls.push(["refresh"]); } };
    modules[0].bind(bindCtx);
    const enabled = get("optGitUiEnabled");
    enabled.checked = true;
    enabled.onchange();
    assert.deepEqual(
      calls.slice(0, 4),
      [["set", "gitUiEnabled", true], ["save"], ["apply"], ["refresh"]],
    );
    const fileList = get("optGitUiFileListMode");
    fileList.value = "bogus";
    fileList.onchange();
    assert.equal(bindCtx.opts.gitUiFileListMode, "tree", "bogus list mode maps to tree");
    fileList.value = "flat";
    fileList.onchange();
    assert.equal(bindCtx.opts.gitUiFileListMode, "flat");
    const diffLayout = get("optGitUiDiffLayout");
    diffLayout.value = "unified";
    diffLayout.onchange();
    assert.equal(bindCtx.opts.gitUiDiffLayout, "unified");
    diffLayout.value = "bogus";
    diffLayout.onchange();
    assert.equal(bindCtx.opts.gitUiDiffLayout, "side-by-side", "bogus layout maps to side-by-side");
    const branch = get("optGitUiDefaultBranch");
    branch.value = "  trunk  ";
    branch.onchange();
    assert.equal(bindCtx.opts.gitUiDefaultBranch, "trunk", "branch trims");
    branch.value = "   ";
    branch.onchange();
    assert.equal(bindCtx.opts.gitUiDefaultBranch, "master", "blank branch maps to master");
    const limit = get("optGitUiLargeDiffLineLimit");
    limit.value = "";
    limit.onchange();
    assert.equal(bindCtx.opts.gitUiLargeDiffLineLimit, 0, "blank limit maps to zero");
    limit.value = "500";
    limit.onchange();
    assert.equal(bindCtx.opts.gitUiLargeDiffLineLimit, 500);
    const preload = get("optGitUiRemoteBranchPreload");
    preload.value = "";
    preload.onchange();
    assert.equal(bindCtx.opts.gitUiRemoteBranchPreload, 10, "blank preload maps to 10");
    preload.value = "42";
    preload.onchange();
    assert.equal(bindCtx.opts.gitUiRemoteBranchPreload, 42);
    // HerdrGitUi absent: the commit chain still runs without refresh
    const bare = boot();
    const bareCalls = [];
    bare.modules[0].bind({
      setOption(key) { bareCalls.push(key); },
      saveOptions() { bareCalls.push("save"); },
      applyOptions() { bareCalls.push("apply"); },
    });
    bare.get("optGitUiEnabled").checked = false;
    bare.get("optGitUiEnabled").onchange();
    assert.deepEqual(bareCalls, ["gitUiEnabled", "save", "apply"]);
    // double bind never rewires
    window.HerdrGitUi = null;
    modules[0].bind(bindCtx);
    assert.ok(enabled.onchange, "handler survives the second bind");
  });
});

describe("git_ui/diff_search.js", () => {
  function createModule({ activeView, layoutMode = "unified", rowsFromChunk } = {}) {
    const sandboxObject = { window: {}, console, Math, JSON };
    sandboxObject.globalThis = sandboxObject;
    const ctx = vm.createContext(sandboxObject);
    productScript("./desktop/git_ui/diff_search.js").runInContext(ctx);
    let view = activeView;
    const fakeSyntax = { highlight: (code) => `[${code}]` };
    const mod = ctx.HerdrGitUiDiffSearchModule.create({
      active: () => view,
      Syntax: () => fakeSyntax,
      diffLayoutMode: () => layoutMode,
      rowsFromChunk:
        rowsFromChunk || ((chunk) => chunk.rows || (chunk.lines || []).map((line) => ({ line }))),
    });
    return { mod, setView: (next) => { view = next; } };
  }

  it("highlightDiffText wraps every hit and passes through without a query", () => {
    const { mod, setView } = createModule({ activeView: { diffSearchQuery: "todo" } });
    assert.equal(mod.diffSearchQuery(), "todo");
    assert.equal(
      mod.highlightDiffText("a todo b", "src/x.js"),
      "[a ]<mark class=\"git-ui-search-match\">[todo]</mark>[ b]",
    );
    // multiple hits wrap each occurrence; the gap between hits and the
    // tail after the last hit still pass through the highlighter
    assert.equal(
      mod.highlightDiffText("todo todo", "src/x.js"),
      "<mark class=\"git-ui-search-match\">[todo]</mark>[ ]<mark class=\"git-ui-search-match\">[todo]</mark>[]",
    );
    assert.equal(
      mod.highlightDiffText("nothing here", "src/x.js"),
      "[nothing here]",
      "no hit highlights the whole text once",
    );
    assert.equal(
      mod.highlightDiffText("TODO upper", "src/x.js"),
      "<mark class=\"git-ui-search-match\">[TODO]</mark>[ upper]",
      "matching is case-insensitive",
    );
    assert.equal(mod.highlightDiffText(null, "p"), "[]", "null code never throws");
    setView({ diffSearchQuery: "   " });
    assert.equal(mod.diffSearchQuery(), "", "whitespace-only query trims to empty");
    assert.equal(mod.highlightDiffText("plain", "p"), "[plain]");
    setView(null);
    assert.equal(mod.diffSearchQuery(), "");
    assert.equal(mod.highlightDiffText("plain", "p"), "[plain]", "null view highlights directly");
  });

  it("canSearchDiff gates on tab type, side editor, and file presence", () => {
    const { mod } = createModule({ activeView: { diffSearchQuery: "x" } });
    assert.equal(mod.canSearchDiff(null), false);
    assert.equal(mod.canSearchDiff({ sideEditor: true }), false);
    for (const tab of ["history", "log", "stash", "cleanup", "conflicts"]) {
      assert.equal(mod.canSearchDiff({ tab }), false, `${tab} blocks search`);
    }
    assert.equal(mod.canSearchDiff({ tab: "changes", diff: { files: [{ path: "a" }] } }), true);
    assert.equal(mod.canSearchDiff({ tab: "changes", file: "a.js", diff: { files: [] } }), true);
    assert.equal(mod.canSearchDiff({ tab: "changes", diff: { files: [] } }), false);
  });

  it("countTextMatches counts case-insensitively without overlaps", () => {
    const { mod } = createModule({ activeView: { diffSearchQuery: "x" } });
    assert.equal(mod.countTextMatches("todo TODO todo", "todo"), 3);
    assert.equal(mod.countTextMatches("anything", ""), 0, "empty needle counts zero");
    assert.equal(mod.countTextMatches("anything", "   "), 0, "whitespace needle counts zero");
    assert.equal(mod.countTextMatches(null, "x"), 0, "null value counts zero");
    assert.equal(mod.countTextMatches("aaa", "aa"), 1, "matches do not overlap");
  });

  it("diffSearchMatchCount uses server counts then falls back to local rows", () => {
    const { mod } = createModule({ activeView: { diffSearchQuery: "todo" }, layoutMode: "unified" });
    assert.equal(mod.diffSearchMatchCount({ diff: { files: [] } }, ""), 0, "empty needle is zero");
    assert.equal(mod.diffSearchMatchCount(null, "todo"), 0, "null view is zero");
    const serverCounted = {
      diff: {
        files: [
          { match_count: 2, chunks: [{ lines: [{ content: "todo fix" }] }] },
          { match_count: 0, chunks: [] },
        ],
      },
    };
    assert.equal(mod.diffSearchMatchCount(serverCounted, "todo"), 2, "server counts win");
    // one file without match_count: the whole view falls back to local rows
    const mixed = {
      diff: {
        files: [
          { match_count: 2, chunks: [] },
          { chunks: [{ lines: [{ content: "todo and todo" }, { content: "clean" }] }] },
        ],
      },
    };
    assert.equal(mod.diffSearchMatchCount(mixed, "todo"), 2, "mixed payload counts locally");
    const unifiedView = {
      diff: { files: [{ chunks: [{ lines: [{ content: "todo and todo" }, { content: "clean" }, { content: null }] }] }] },
    };
    assert.equal(mod.diffSearchMatchCount(unifiedView, "todo"), 2, "unified rows count per line");
    const side = createModule({ activeView: { diffSearchQuery: "todo" }, layoutMode: "side-by-side" });
    const sideView = {
      diff: {
        files: [
          { chunks: [{ rows: [{ old_line: { content: "todo" }, new_line: { content: "todo todo" } }, { old_line: null, new_line: { content: "clean" } }] }] },
        ],
      },
    };
    assert.equal(
      side.mod.diffSearchMatchCount(sideView, "todo"),
      3,
      "side-by-side counts old and new halves",
    );
    const custom = createModule({
      activeView: { diffSearchQuery: "todo" },
      layoutMode: "unified",
      rowsFromChunk: () => [{ line: { content: "todo" } }, { line: { content: "no" } }],
    });
    assert.equal(
      custom.mod.diffSearchMatchCount({ diff: { files: [{ chunks: [{}] }] } }, "todo"),
      1,
      "explicit rowsFromChunk overrides the chunk shape",
    );
  });
});