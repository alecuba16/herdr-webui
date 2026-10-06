import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Host behavior tests for the mobile temporary Files/Git overlays
 * (`mobile/temp_overlays.js`). The module runs in a vm context with stub
 * drawer factories (HerdrMobileFileBrowser/HerdrMobileGitModule), then the
 * public surface (HerdrMobileTempOverlays) is driven: fresh instance per
 * open, `currentWorkspaceCwd` pinned to the overlay folder, callback
 * namespace rewriting (HerdrMobileTempFiles/HerdrMobileTempFilesTree/
 * HerdrMobileTempGit), picker flow, and no /api/workspaces calls.
 */

function makeElement(id = "") {
  const el = {
    id,
    children: [],
    _innerHTML: "",
    onclick: null,
    style: {},
    attributes: {},
    className: "",
    title: "",
    textContent: "",
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      if (child) {
        child.parentNode = this;
        if (child.id && this._register) this._register(child.id, child);
      }
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      if (child) child.parentNode = null;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) {
      this._innerHTML = value;
      if (typeof value !== "string") return;
      const stub = (prop, marker) => {
        if (value.includes(marker) && !this[prop]) this[prop] = makeElement(prop);
      };
      stub("titleEl", "temp-overlay-title");
      stub("folderEl", 'temp-overlay-folder"');
      stub("hintEl", "temp-overlay-hint");
      stub("folderBtn", "temp-overlay-folder-btn");
      stub("minimizeBtn", "temp-overlay-minimize");
      stub("closeBtn", "temp-overlay-close");
      stub("bodyEl", "temp-overlay-body");
      stub("restoreButton", 'temp-overlay-restore"');
    },
    querySelector(selector) {
      const map = {
        ".temp-overlay-title": "titleEl",
        ".temp-overlay-folder": "folderEl",
        ".temp-overlay-hint": "hintEl",
        ".temp-overlay-folder-btn": "folderBtn",
        ".temp-overlay-minimize": "minimizeBtn",
        ".temp-overlay-close": "closeBtn",
        ".temp-overlay-body": "bodyEl",
        ".temp-overlay-restore": "restoreButton",
      };
      return this[map[selector]] || null;
    },
    get parentNode() { return this._parentNode || null; },
    set parentNode(v) { this._parentNode = v; },
  };
  return el;
}

function context({ treeError = null } = {}) {
  const elements = new Map();
  const body = makeElement("body");
  const created = [];
  const apiCalls = [];
  const treeCalls = [];

  const getElement = (id) => elements.get(id) || null;
  const register = (id, el) => {
    if (id && !elements.has(id)) elements.set(id, el);
  };

  // Stub file-browser factory: record deps, expose a few methods the host
  // binds (filesBackToTree etc.) and markup carrying the original
  // namespaces so the rewrite is observable.
  const filesInstances = [];
  const makeFilesFactory = () => ({
    create(deps) {
      filesInstances.push(deps);
      return {
        currentWorkspaceCwd: deps.currentWorkspaceCwd,
        renderScreen() {
          return '<button onclick="HerdrMobile.filesRefresh()">r</button>' +
            '<button onclick="HerdrMobileFiles.select(&#39;x&#39;)">t</button>';
        },
        refresh: () => {},
        select: () => {},
        toggle: () => {},
        up: () => {},
        backToTree: () => {},
        filter: () => {},
      };
    },
  });

  const gitInstances = [];
  const makeGitFactory = () => ({
    create(deps) {
      gitInstances.push(deps);
      return {
        renderGitScreen(target) {
          target.innerHTML = '<button onclick="HerdrMobile.loadGitStatus()">s</button>';
          return undefined;
        },
        loadGitStatus: () => {},
        selectGitFile: () => {},
      };
    },
  });

  const ctx = {
    document: {
      body,
      activeElement: null,
      createElement(tag) {
        const el = makeElement(tag);
        el._register = register;
        created.push(el);
        return el;
      },
      getElementById: getElement,
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    },
    requestAnimationFrame(fn) {
      fn();
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    Event: function Event(type) { this.type = type; },
    HerdrMobileAppDeps: { state: { defaultFolder: "/settings/default" } },
    HerdrMobileApi(url) {
      apiCalls.push(String(url));
      if (String(url).startsWith("/api/file-browser/tree")) {
        treeCalls.push(String(url));
        if (treeError) return Promise.reject(new Error(treeError));
        // Production semantics: entry paths are relative to the tree cwd.
        return Promise.resolve({
          entries: [{ name: "docs", path: "docs" }],
        });
      }
      return Promise.resolve({ result: {} });
    },
    // The picker prefers HerdrHttp when present.
    HerdrHttp: {
      request(url) {
        apiCalls.push(String(url));
        if (String(url).startsWith("/api/file-browser/tree")) {
          treeCalls.push(String(url));
          if (treeError) return Promise.reject(new Error(treeError));
          return Promise.resolve({ entries: [{ name: "docs", path: "docs" }] });
        }
        return Promise.resolve({ result: {} });
      },
    },
    HerdrMobileConfirm: () => Promise.resolve(true),
    HerdrMobileJsArg: (value) => value,
    HerdrMobilePathBasename: (path) => String(path).split("/").pop(),
    HerdrMobileFileBrowser: makeFilesFactory(),
    HerdrMobileGitModule: makeGitFactory(),
    apiCalls,
    treeCalls,
    filesInstances,
    gitInstances,
    created,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  body._register = register;
  return vm.createContext(ctx);
}

function loadHost(ctx) {
  // Real load order: shared controller first, then the mobile host.
  vm.runInContext(
    readFileSync(new URL("./shared/temp_overlay.js", import.meta.url), "utf8"),
    ctx,
  );
  vm.runInContext(
    readFileSync(new URL("./mobile/temp_overlays.js", import.meta.url), "utf8"),
    ctx,
  );
  return ctx.HerdrMobileTempOverlays;
}

async function flush(n = 10) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe("mobile temporary overlay host", () => {
  it("exposes the full public surface", () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    for (const name of [
      "create", "files", "git", "openFiles", "openGit", "toggleFiles", "toggleGit",
      "bindAppHelpers", "pickerClose", "pickerEnter", "pickerUp", "pickerSelect", "pickerFilter",
    ]) {
      equal(typeof overlays[name], "function", `${name} is a function`);
    }
  });

  it("openFiles builds a fresh file-browser instance pinned to the overlay folder", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    const files = overlays.files();
    ok(files && files.isOpen(), "files manager open");
    equal(files.currentFolder(), "/repo/project");
    equal(ctx.filesInstances.length, 1, "one fresh instance");
    const deps = ctx.filesInstances[0];
    equal(typeof deps.currentWorkspaceCwd, "function");
    equal(deps.currentWorkspaceCwd(), "/repo/project", "cwd pinned to the overlay folder");
    ok(deps.state && typeof deps.state === "object", "fresh state slice");
    // The core contract: no workspace or session API was ever touched.
    equal(ctx.apiCalls.filter((u) => u.includes("/api/workspaces")).length, 0, "no workspace api calls");
  });

  it("openGit builds a fresh git instance pinned to the overlay folder", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openGit("/repo/site");
    const git = overlays.git();
    ok(git && git.isOpen(), "git manager open");
    equal(git.currentFolder(), "/repo/site");
    equal(ctx.gitInstances.length, 1, "one fresh git instance");
    equal(ctx.gitInstances[0].currentWorkspaceCwd(), "/repo/site", "cwd pinned");
  });

  it("the rendered markup rewrites the callback namespaces to the temp ones", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    const modal = ctx.document.getElementById("tempFilesOverlayModal");
    ok(modal, "tempFilesOverlayModal registered");
    const surface = modal.bodyEl && modal.bodyEl.children[0];
    ok(surface, "body present");
    const html = String(surface._innerHTML || surface.innerHTML || "");
    ok(html.includes("HerdrMobileTempFiles.filesRefresh"), "screen namespace rewritten");
    ok(html.includes("HerdrMobileTempFilesTree.select"), "tree namespace rewritten");
    ok(!html.includes("HerdrMobile.filesRefresh"), "original screen namespace gone");
    ok(!html.includes("HerdrMobileFiles.select"), "original tree namespace gone");
    ok(ctx.HerdrMobileTempFiles && typeof ctx.HerdrMobileTempFiles.filesRefresh === "function",
      "temp files namespace bound");
    ok(ctx.HerdrMobileTempFilesTree && typeof ctx.HerdrMobileTempFilesTree.select === "function",
      "temp tree namespace bound");
  });

  it("git markup is rewritten to the temp git namespace and bound", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openGit("/repo/site");
    const modal = ctx.document.getElementById("tempGitOverlayModal");
    ok(modal, "tempGitOverlayModal registered");
    const surface = modal.bodyEl && modal.bodyEl.children[0];
    const html = String(surface && (surface._innerHTML || surface.innerHTML) || "");
    ok(html.includes("HerdrMobileTempGit.loadGitStatus"), "git namespace rewritten");
    ok(!html.includes("HerdrMobile.loadGitStatus"), "original git namespace gone");
    ok(ctx.HerdrMobileTempGit && typeof ctx.HerdrMobileTempGit.loadGitStatus === "function",
      "temp git namespace bound");
  });

  it("closing the overlay drops the instance and unbinds the namespaces", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    ok(ctx.HerdrMobileTempFiles, "namespace bound while open");
    overlays.files().close();
    equal(ctx.filesInstances.length, 1, "no extra instance created on close");
    ok(!ctx.HerdrMobileTempFiles, "files namespace unbound after close");
    ok(!ctx.HerdrMobileTempFilesTree, "tree namespace unbound after close");
    ok(!overlays.files().isOpen(), "manager closed");
  });

  it("reopen swaps the folder and creates a second fresh instance", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    await overlays.openFiles("/repo/other");
    equal(overlays.files().currentFolder(), "/repo/other");
    equal(ctx.filesInstances.length, 2, "second fresh instance");
    equal(ctx.filesInstances[1].currentWorkspaceCwd(), "/repo/other", "second instance pinned to the new folder");
    equal(ctx.filesInstances[0].currentWorkspaceCwd(), "/repo/project", "first instance keeps its own folder");
  });

  it("toggle minimizes and restores without a second instance", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    overlays.toggleFiles();
    ok(overlays.files().isMinimized(), "minimized after toggle");
    overlays.toggleFiles();
    ok(!overlays.files().isMinimized(), "restored");
    equal(ctx.filesInstances.length, 1, "same instance reused");
  });

  it("openFiles with no folder falls back to the app default folder", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles();
    equal(overlays.files().currentFolder(), "/settings/default");
    equal(ctx.filesInstances[0].currentWorkspaceCwd(), "/settings/default");
  });

  it("the folder picker loads dirs-only entries and can select one", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    // chooseFolder resolves when the picker selection lands; drive the flow
    // via the public picker hooks.
    overlays.files().chooseFolder();
    await flush(20);
    const pickerModal = ctx.document.getElementById("tempOverlayPickerModal");
    ok(pickerModal, "picker modal registered");
    ok(ctx.treeCalls.some((u) => u.includes("dirs_only=true")), "tree call filtered to directories");
    // Enter the docs subfolder (rows carry paths relative to the picker cwd)
    // and select; the pick promise retargets the overlay.
    overlays.pickerEnter(encodeURIComponent("docs"));
    await flush(20);
    overlays.pickerSelect();
    await flush(20);
    equal(overlays.files().currentFolder(), "/repo/project/docs", "picker selection retargets the overlay");
    equal(ctx.filesInstances.length, 2, "retarget built a fresh instance");
  });

  it("picker errors surface in the picker and the overlay stays usable", async () => {
    const ctx = context({ treeError: "tree boom" });
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    overlays.files().chooseFolder();
    await flush(20);
    const pickerModal = ctx.document.getElementById("tempOverlayPickerModal");
    ok(pickerModal, "picker still opens on error");
    ok(String(pickerModal._innerHTML).includes("tree boom"), "error rendered in picker");
    overlays.pickerClose();
    await flush();
    equal(overlays.files().currentFolder(), "/repo/project", "overlay folder untouched after failed pick");
  });
});

describe("mobile temporary overlay host: shared controller integration", () => {
  it("minimized overlays get a restore pill and restore on click", async () => {
    const ctx = context();
    const overlays = loadHost(ctx);
    await overlays.openFiles("/repo/project");
    overlays.files().minimize();
    // The restore pill is a separate body-level bar element.
    const restoreBar = ctx.created.find((el) => String(el.className).includes("temp-overlay-restore-bar"));
    ok(restoreBar, "restore bar materialized");
    ok(restoreBar.restoreButton, "restore pill stubbed");
    ok(restoreBar.restoreButton.onclick, "restore pill wired");
    restoreBar.restoreButton.onclick();
    ok(!overlays.files().isMinimized(), "restored via the pill");
  });
});
