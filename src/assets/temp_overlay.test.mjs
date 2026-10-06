import { describe, it } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
    type: "",
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
      // Real DOM move semantics: appending an already-attached node
      // re-raises it (controller raiseModal relies on this).
      const existing = this.children.indexOf(child);
      if (existing >= 0) this.children.splice(existing, 1);
      this.children.push(child);
      if (child) {
        child.parentNode = this;
        if (child.id && this._register) this._register(child.id, child);
      }
    },
    remove() {
      if (this.parentNode) this.parentNode.children = (this.parentNode.children || []).filter((c) => c !== this);
      this.parentNode = null;
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
      if (typeof value === "string") {
        if (value.includes("temp-overlay-restore\"") && !this.restoreButton)
          this.restoreButton = makeElement("restore");
      }
    },
    querySelector(selector) {
      if (selector === ".temp-overlay-title") return this.titleEl || (this.titleEl = makeElement("title"));
      if (selector === ".temp-overlay-folder") return this.folderEl || (this.folderEl = makeElement("folder"));
      if (selector === ".temp-overlay-hint") return this.hintEl || (this.hintEl = makeElement("hint"));
      if (selector === ".temp-overlay-folder-btn") return this.folderBtn || (this.folderBtn = makeElement("folder-btn"));
      if (selector === ".temp-overlay-minimize") return this.minimizeBtn || (this.minimizeBtn = makeElement("minimize"));
      if (selector === ".temp-overlay-close") return this.closeBtn || (this.closeBtn = makeElement("close"));
      if (selector === ".temp-overlay-body") return this.bodyEl || (this.bodyEl = makeElement("body"));
      if (selector === ".temp-overlay-restore") return this.restoreButton || null;
      return null;
    },
    get parentNode() { return this._parentNode || null; },
    set parentNode(v) { this._parentNode = v; },
  };
  return el;
}

function context() {
  const elements = new Map();
  const created = [];
  const body = makeElement("body");
  body.className = "body";
  // appendChild registers children by id so getElementById can find the
  // controller-created modal (a real DOM does this implicitly).
  body._register = (id, el) => {
    if (id && !elements.has(id)) elements.set(id, el);
  };
  const getElement = (id) => elements.get(id) || null;
  const docListeners = {};
  const ctx = {
    document: {
      body,
      activeElement: null,
      createElement(tag) {
        const el = makeElement(tag);
        el._register = body._register;
        created.push(el);
        return el;
      },
      getElementById: getElement,
      querySelectorAll() { return []; },
      addEventListener(type, fn) {
        (docListeners[type] = docListeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        if (!docListeners[type]) return;
        docListeners[type] = docListeners[type].filter((f) => f !== fn);
      },
      dispatchEvent(ev) {
        const list = (docListeners[ev && ev.type] || []).slice();
        for (const fn of list) fn(ev);
        return true;
      },
      docListeners,
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
    created,
    elements,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  return vm.createContext(ctx);
}

function loadController(ctx) {
  vm.runInContext(readFileSync(new URL("./shared/temp_overlay.js", import.meta.url), "utf8"), ctx);
  return ctx.HerdrTempOverlay;
}

function makeHost(overrides = {}) {
  const ctx = context();
  const calls = { opened: [], closed: [], folders: [] };
  const prefix = overrides.modalIdPrefix || (overrides.tool === "git" ? "tempGitOverlay" : "tempFilesOverlay");
  const manager = loadController(ctx).create({
    tool: "files",
    modalIdPrefix: "tempFilesOverlay",
    defaultFolderFn: () => "/default/folder",
    openSurface(folder, surfaceEl, session) {
      calls.opened.push({ folder, session });
      surfaceEl.innerHTML = "<div>surface</div>";
      return { marker: "handle-" + session };
    },
    closeSurface(session, handle) {
      calls.closed.push({ session, handle });
    },
    pickFolder() {
      calls.folders.push("picked");
      return Promise.resolve("/picked/folder");
    },
    ...overrides,
  });
  return {
    ctx,
    manager,
    calls,
    modal: () => ctx.document.getElementById(prefix + "Modal"),
    bar: () => ctx.created.find((el) => String(el.className).includes("temp-overlay-restore-bar")),
  };
}

describe("temporary overlay controller (shared)", () => {
  it("normalizes folder paths", () => {
    const ctx = context();
    const H = loadController(ctx);
    equal(H.normalizeFolder("/some/path/"), "/some/path");
    equal(H.normalizeFolder("/some/path///"), "/some/path");
    equal(H.normalizeFolder(""), "/");
    equal(H.normalizeFolder(null), "/");
    equal(H.normalizeFolder("/"), "/");
    equal(H.normalizeFolder("  /trimmed/  "), "/trimmed");
  });

  it("lastPathLevel returns the final path segment", () => {
    const ctx = context();
    const H = loadController(ctx);
    equal(H.lastPathLevel("/home/user/project"), "project");
    equal(H.lastPathLevel("/home/user/project/"), "project");
    equal(H.lastPathLevel("/"), "");
    equal(H.lastPathLevel(""), "");
    equal(H.lastPathLevel(null), "");
  });

  it("exposes tool labels and hints", () => {
    const ctx = context();
    const H = loadController(ctx);
    equal(H.toolLabel("files"), "Files");
    equal(H.toolLabel("git"), "Git");
    equal(H.toolLabel("unknown"), "Files");
    ok(H.toolHint("files").includes("Temporary Files"));
    ok(H.toolHint("git").includes("Temporary Git"));
  });

  it("open renders the surface on the default folder without arguments", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    equal(manager.isOpen(), false);
    const active = manager.open();
    equal(manager.isOpen(), true);
    equal(active.folder, "/default/folder");
    equal(calls.opened.length, 1);
    equal(calls.opened[0].folder, "/default/folder");
  });

  it("open with a folder normalizes trailing slashes", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/repo/my-folder///");
    equal(calls.opened[0].folder, "/repo/my-folder");
    equal(manager.currentFolder(), "/repo/my-folder");
  });

  it("open again restores a minimized surface and swaps folders", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/first");
    manager.minimize();
    equal(manager.isMinimized(), true);
    manager.open("/second");
    equal(manager.isMinimized(), false, "open restores the minimized surface");
    equal(calls.opened.length, 2, "folder change re-renders the surface");
    equal(calls.opened[1].folder, "/second");
    equal(manager.currentFolder(), "/second");
  });

  it("toggle minimizes when visible and restores when minimized", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open();
    equal(manager.isOpen(), true);
    equal(manager.toggle(), null, "toggle on a visible surface minimizes");
    equal(manager.isMinimized(), true);
    const active = manager.toggle();
    ok(active, "toggle on a minimized surface restores");
    equal(manager.isMinimized(), false);
  });

  it("close tears down the surface and clears the body", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/close-me");
    const session = calls.opened[0].session;
    manager.close();
    equal(manager.isOpen(), false);
    equal(calls.closed.length, 1);
    equal(calls.closed[0].session, session);
    equal(calls.closed[0].handle.marker, "handle-" + session);
    equal(manager.currentFolder(), "");
  });

  it("close passes the resolved handle from a promise-returning openSurface", async () => {
    const ctx = context();
    const calls = { opened: [], closed: [] };
    const manager = loadController(ctx).create({
      tool: "git",
      modalIdPrefix: "tempGitOverlay",
      defaultFolderFn: () => "/repo",
      async openSurface(folder, surfaceEl, session) {
        calls.opened.push({ folder, session });
        return { marker: "async-" + session };
      },
      closeSurface(session, handle) {
        calls.closed.push({ session, handle });
      },
    });
    manager.open();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    manager.close();
    equal(calls.closed.length, 1);
    equal(calls.closed[0].handle.marker, "async-" + calls.opened[0].session);
  });

  it("a throwing openSurface surfaces the error in the hint and clears the body", () => {
    const ctx = context();
    const manager = loadController(ctx).create({
      tool: "git",
      modalIdPrefix: "tempGitOverlay",
      defaultFolderFn: () => "/repo",
      openSurface() {
        throw new Error("Git UI is disabled in settings");
      },
    });
    manager.open("/repo");
    const modal = ctx.document.getElementById("tempGitOverlayModal");
    ok(modal, "modal created");
    const hint = modal.hintEl;
    ok(hint, "hint element exists");
    ok(hint.textContent.includes("Cannot open this folder: Git UI is disabled"), "error shown in the hint");
    equal(modal.bodyEl.innerHTML, "", "body cleared after the failure");
  });

  it("a rejecting openSurface promise surfaces the error too", async () => {
    const ctx = context();
    const manager = loadController(ctx).create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/repo",
      openSurface() {
        return Promise.reject(new Error("load failed"));
      },
    });
    manager.open();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    const modal = ctx.document.getElementById("tempFilesOverlayModal");
    ok(modal.hintEl.textContent.includes("Cannot open this folder: load failed"));
  });

  it("a stale async surface result never lands on a newer session", async () => {
    const ctx = context();
    let resolveFirst;
    const manager = loadController(ctx).create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/repo",
      openSurface(folder, surfaceEl, session) {
        if (session === 1) {
          return new Promise((resolve) => { resolveFirst = () => resolve({ marker: "stale" }); });
        }
        return { marker: "fresh" };
      },
      closeSurface(session, handle) {
        if (session === 1) ok(!handle || handle.marker !== "stale", "stale handle must not be delivered");
      },
    });
    manager.open("/repo"); // session 1, pending promise
    manager.open("/other"); // session 2 replaces the surface synchronously
    resolveFirst();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    manager.close();
  });

  it("chooseFolder swaps the folder with the picked path", async () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/before");
    manager.chooseFolder();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    equal(manager.currentFolder(), "/picked/folder");
    equal(calls.opened.length, 2, "surface re-rendered for the new folder");
    equal(calls.opened[1].folder, "/picked/folder");
  });

  it("chooseFolder treats an empty pick as keep-current", async () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost({
      pickFolder() {
        return Promise.resolve("");
      },
    });
    manager.open("/keep-me");
    manager.chooseFolder();
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    equal(manager.currentFolder(), "/keep-me");
    equal(calls.opened.length, 1, "no re-render for an empty pick");
  });

  it("chooseFolder without a picker is a no-op", () => {
    const { manager } = makeHost({ pickFolder: null });
    manager.open("/keep-me");
    manager.chooseFolder();
    equal(manager.currentFolder(), "/keep-me");
  });

  it("minimize hides the modal and restore brings it back", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/repo");
    const modal = ctxModal(manager);
    manager.minimize();
    equal(modal.style.display, "none");
    equal(modal.attributes["aria-hidden"], "true");
    manager.restore();
    equal(modal.style.display, "grid");
    equal(modal.attributes["aria-hidden"], undefined);
  });

  it("the restore bar appears only while minimized and restores on click", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/repo/project");
    manager.minimize();
    const bar = findBar(manager);
    ok(bar, "restore bar exists");
    equal(bar.style.display, "flex");
    ok(bar.innerHTML.includes("temp-overlay-restore"), "restore pill rendered");
    ok(bar.innerHTML.includes("Temporary Files"), "pill label carries the title");
    ok(bar.restoreButton, "restore button stubbed");
    bar.restoreButton.onclick();
    equal(manager.isMinimized(), false, "pill click restores");
    equal(bar.style.display, "none", "bar hidden after restore");
  });

  it("minimize while nothing is open is a no-op", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.minimize();
    manager.restore();
    equal(manager.isOpen(), false);
  });

  it("syncHead updates title, folder and hint text", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/home/user/repo-x");
    const modal = ctxModal(manager);
    equal(modal.titleEl.textContent, "Temporary Files · repo-x");
    equal(modal.folderEl.textContent, "/home/user/repo-x");
    equal(modal.folderEl.title, "/home/user/repo-x");
    ok(modal.hintEl.textContent.includes("Temporary Files"), "default hint names the tool");
  });

  it("head buttons wire to chooseFolder, minimize, and close", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/repo");
    const modal = ctxModal(manager);
    ok(modal.folderBtn.onclick, "folder button wired");
    ok(modal.minimizeBtn.onclick, "minimize button wired");
    ok(modal.closeBtn.onclick, "close button wired");
    modal.closeBtn.onclick();
    equal(manager.isOpen(), false, "close button closes");
    ok(calls.closed.length === 1, "close hook fired");
  });

  it("the git tool renders the git icon and label in the restore pill", () => {
    const { manager, bar: findBar } = makeHost({ tool: "git" });
    manager.open("/repo/git-x");
    manager.minimize();
    const bar = findBar(manager);
    ok(bar.innerHTML.includes("⑂"), "git icon");
    ok(bar.innerHTML.includes("Temporary Git"), "git title");
  });

  it("the modal is created once and reused across opens", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/first");
    const modal = ctxModal(manager);
    manager.close();
    manager.open("/second");
    equal(ctxModal(manager), modal, "same modal node reused");
  });

  it("shortcut label is appended to minimize and restore titles when provided", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost({ shortcutLabelFn: () => "Ctrl+B Shift+F" });
    manager.open("/repo");
    const modal = ctxModal(manager);
    ok(String(modal.minimizeBtn.title).includes("Ctrl+B Shift+F"), "minimize title carries the shortcut");
    manager.minimize();
    const bar = findBar(manager);
    ok(bar.innerHTML.includes("Ctrl+B Shift+F"), "restore pill title carries the shortcut");
  });

  it("folders with special characters are escaped in the restore pill", () => {
    const { manager, modal: ctxModal, bar: findBar } = makeHost();
    manager.open('/repo/<script>&"quotes"');
    manager.minimize();
    const bar = findBar(manager);
    ok(!bar.innerHTML.includes("<script>"), "raw script tag must not appear");
    ok(bar.innerHTML.includes("&lt;script&gt;"), "escaped label rendered");
  });

  it("swapFolder teardown calls closeSurface for the old session", () => {
    const { manager, calls, modal: ctxModal, bar: findBar } = makeHost();
    manager.open("/one");
    equal(calls.opened[0].session, 1);
    manager.open("/two");
    equal(calls.closed.length, 1, "old session torn down on folder swap");
    equal(calls.closed[0].session, 1);
    equal(calls.opened.length, 2);
    equal(calls.opened[1].folder, "/two");
  });

  // ---- Document-level Escape capture (terminal parity) ----

  function escEvent(overrides = {}) {
    return Object.assign(
      {
        type: "keydown",
        key: "Escape",
        target: null,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; this._prevented = true; },
        stopPropagation() { this._stopped = true; },
      },
      overrides,
    );
  }

  it("Escape closes an open overlay through the document trap", () => {
    const { ctx, manager, calls } = makeHost();
    manager.open("/repo");
    equal(manager.isOpen(), true);
    const event = escEvent();
    ctx.document.dispatchEvent(event);
    equal(calls.closed.length, 1, "closeSurface ran on Escape");
    equal(manager.isOpen(), false, "overlay closed");
    ok(event._prevented, "Escape consumed");
    ok(event._stopped, "propagation stopped");
  });

  it("Escape does nothing when no overlay is open", () => {
    const { ctx, manager, calls } = makeHost();
    const event = escEvent();
    ctx.document.dispatchEvent(event);
    equal(calls.closed.length, 0);
    equal(event._prevented, undefined, "key untouched");
  });

  it("Escape is ignored when the key was already consumed (drawer paths win)", () => {
    const { ctx, manager, calls } = makeHost();
    manager.open("/repo");
    const event = escEvent({ defaultPrevented: true });
    ctx.document.dispatchEvent(event);
    equal(manager.isOpen(), true, "overlay stays open when a drawer consumed Esc");
    equal(calls.closed.length, 0);
  });

  it("Escape is ignored while the overlay is minimized", () => {
    const { ctx, manager, calls } = makeHost();
    manager.open("/repo");
    manager.minimize();
    ctx.document.dispatchEvent(escEvent());
    equal(manager.isOpen(), true, "minimized overlay stays");
    equal(manager.isMinimized(), true);
    equal(calls.closed.length, 0);
  });

  it("Escape is ignored while an editable field has focus", () => {
    const { ctx, manager } = makeHost();
    manager.open("/repo");
    const event = escEvent({ target: { tagName: "INPUT" } });
    ctx.document.dispatchEvent(event);
    equal(manager.isOpen(), true, "input keeps its own Esc behavior");
  });

  it("Escape yields to a foreign modal stacked above the overlay", () => {
    const { ctx, manager } = makeHost();
    manager.open("/repo");
    // Desktop picker: modal node exists while open (created/removed per
    // session, no inline display style).
    ctx.document.getElementById("directoryPickerModal");
    const picker = ctx.document.createElement("div");
    picker.id = "directoryPickerModal";
    ctx.elements.set("directoryPickerModal", picker);
    ctx.document.dispatchEvent(escEvent());
    equal(manager.isOpen(), true, "picker owns Esc, overlay stays");
  });

  it("Escape closes the DOM-topmost overlay when both are open", () => {
    const ctxA = context();
    const H = loadController(ctxA);
    const files = H.create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/a",
      openSurface() { return null; },
    });
    const git = H.create({
      tool: "git",
      modalIdPrefix: "tempGitOverlay",
      defaultFolderFn: () => "/b",
      openSurface() { return null; },
    });
    files.open("/a");
    git.open("/b");
    // Both modals live in the same body; git was opened last so its modal
    // node was re-raised: DOM order decides stacking.
    const filesModal = ctxA.document.getElementById("tempFilesOverlayModal");
    const gitModal = ctxA.document.getElementById("tempGitOverlayModal");
    ok(ctxA.document.body.children.indexOf(gitModal) > ctxA.document.body.children.indexOf(filesModal), "git modal raised above files");
    ctxA.document.dispatchEvent(escEvent());
    equal(git.isOpen(), false, "DOM-topmost (git) closed");
    equal(files.isOpen(), true, "files overlay stays");
  });

  it("restore re-raises the modal above the other overlay and Esc closes it", () => {
    const ctxA = context();
    const H = loadController(ctxA);
    const files = H.create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/a",
      openSurface() { return null; },
    });
    const git = H.create({
      tool: "git",
      modalIdPrefix: "tempGitOverlay",
      defaultFolderFn: () => "/b",
      openSurface() { return null; },
    });
    files.open("/a");
    git.open("/b");
    files.minimize();
    files.restore();
    const filesModal = ctxA.document.getElementById("tempFilesOverlayModal");
    const gitModal = ctxA.document.getElementById("tempGitOverlayModal");
    ok(ctxA.document.body.children.indexOf(filesModal) > ctxA.document.body.children.indexOf(gitModal), "restored files modal raised above git");
    ctxA.document.dispatchEvent(escEvent());
    equal(files.isOpen(), false, "restored overlay owns Esc");
    equal(git.isOpen(), true, "lower overlay stays");
  });

  it("closeTopmost closes the visible overlay and reports false with none", () => {
    const ctxA = context();
    const H = loadController(ctxA);
    equal(H.closeTopmost(), false, "no overlay open");
    const manager = H.create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/a",
      openSurface() { return null; },
    });
    manager.open("/a");
    equal(H.closeTopmost(), true);
    equal(manager.isOpen(), false);
  });

  it("isForeignModalVisible reports picker modals and ignores overlay/terminal modals", () => {
    const ctxA = context();
    const H = loadController(ctxA);
    const manager = H.create({
      tool: "files",
      modalIdPrefix: "tempFilesOverlay",
      defaultFolderFn: () => "/a",
      openSurface() { return null; },
    });
    equal(H.isForeignModalVisible(), false, "nothing open");
    manager.open("/a");
    equal(H.isForeignModalVisible(), false, "own overlay modal is not foreign");
  });

});
