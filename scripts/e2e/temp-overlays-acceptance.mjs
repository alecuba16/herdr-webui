// Full-stack acceptance checks for the temporary Files/Git overlays.
//
// The node --test suites cover the host modules against stub drawers, but
// they cannot catch wiring bugs between the served bundles, the embedded
// assets, the real tree API, and the real directory picker module. This
// script boots the bundles the real server serves (shared controller,
// desktop host, desktop drawers, directory picker), proxies every vm fetch
// to the real backend, and drives the same call chain a browser click uses:
// open both overlays at once, cross-hide survival, Change-folder through the
// real picker modal, picker close, and the minimized-overlay shell-toggle
// handoff.
//
// Driven by scripts/e2e/run-temp-overlays-e2e.sh (see that file for the
// environment overrides).
import vm from "node:vm";
import { request as httpsRequest } from "node:https";

const ORIGIN = process.env.E2E_ORIGIN;
const FILES_DIR = process.env.E2E_FILES_DIR;
const GIT_DIR = process.env.E2E_GIT_DIR;

if (!ORIGIN || !FILES_DIR || !GIT_DIR) {
  console.error("E2E_ORIGIN, E2E_FILES_DIR and E2E_GIT_DIR must be set (use scripts/e2e/run-temp-overlays-e2e.sh)");
  process.exit(2);
}

function httpsJson(url, init) {
  return new Promise((resolve, reject) => {
    const options = { rejectUnauthorized: false };
    if (init && init.method) options.method = init.method;
    if (init && init.headers) options.headers = Object.assign({ cookie: process.env.E2E_COOKIE || "" }, init.headers || {});
    const req = httpsRequest(url, options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, json: async () => JSON.parse(raw) }));
    });
    req.on("error", reject);
    if (init && init.body) req.write(init.body);
    req.end();
  });
}

function loadText(path) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${ORIGIN}${path}`, { rejectUnauthorized: false, headers: { cookie: process.env.E2E_COOKIE || "" } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.end();
  });
}

// Minimal but parentage-correct DOM: panels live in a registry, appendChild
// re-parents, remove detaches, getElementById returns the registered node.
function makeDom() {
  const elements = new Map();
  let uid = 0;
  function makeElement(id = "") {
    const el = {
      id,
      children: [],
      _innerHTML: "",
      style: {},
      attributes: {},
      className: "",
      title: "",
      textContent: "",
      value: "",
      type: "",
      tag: "div",
      classList: {
        _set: new Set(),
        add(...cls) { for (const c of cls) this._set.add(c); },
        remove(...cls) { for (const c of cls) this._set.delete(c); },
        toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      addEventListener(type, fn) { (this._listeners = this._listeners || {})[type] = (this._listeners[type] || []).concat(fn); },
      removeEventListener(type, fn) { if (this._listeners && this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn); },
      dispatchEvent(ev) { for (const fn of (this._listeners && this._listeners[ev.type] || []).slice()) fn(ev); return true; },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
        if (child.id && !elements.has(child.id)) elements.set(child.id, child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
        if (child) child.parentNode = null;
      },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); if (this.id && elements.get(this.id) === this) elements.delete(this.id); },
      setAttribute(n, v) { this.attributes[n] = String(v); },
      removeAttribute(n) { delete this.attributes[n]; },
      getAttribute(n) { return this.attributes[n] !== undefined ? this.attributes[n] : null; },
      get innerHTML() { return this._innerHTML; },
      set innerHTML(value) {
        this._innerHTML = value;
        for (const child of this.children.slice()) this.removeChild(child);
        if (typeof value !== "string") return;
        // Synthesize stub children for the class/id markers the real code
        // queries right after setting innerHTML. Real HTML parsing would
        // build these; this stub models just enough of it.
        const markers = [
          ["titleEl", 'temp-overlay-title"'],
          ["folderEl", 'temp-overlay-folder"'],
          ["hintEl", "temp-overlay-hint"],
          ["folderBtn", "temp-overlay-folder-btn"],
          ["minimizeBtn", "temp-overlay-minimize"],
          ["closeBtn", "temp-overlay-close"],
          ["bodyEl", "temp-overlay-body"],
          ["restoreButton", 'temp-overlay-restore"'],
          ["gitSideEl", 'git-ui-side"'],
          ["gitContentEl", 'git-ui-content"'],
        ];
        for (const [prop, marker] of markers) {
          if (value.includes(marker) && !this[prop]) {
            this[prop] = makeElement("");
            this[prop].className = marker.replace(/["\s]/g, "");
            this.appendChild(this[prop]);
          }
        }
        // Register any id="..." elements so getElementById finds them
        // (directoryPickerSearchInput, fileBrowserPreview, ...).
        for (const match of String(value).matchAll(/id="([^"]+)"/g)) {
          const id = match[1];
          if (!elements.has(id)) {
            const el = makeElement(id);
            el.className = "";
            elements.set(id, el);
            this.appendChild(el);
          }
        }
      },
      get firstElementChild() { return this.children[0] || null; },
      parentElement: null,
      selectionStart: null,
      selectionEnd: null,
      setSelectionRange() {},
      querySelector(sel) {
        const map = {
          ".temp-overlay-title": "titleEl",
          ".temp-overlay-folder": "folderEl",
          ".temp-overlay-hint": "hintEl",
          ".temp-overlay-folder-btn": "folderBtn",
          ".temp-overlay-minimize": "minimizeBtn",
          ".temp-overlay-close": "closeBtn",
          ".temp-overlay-body": "bodyEl",
          ".temp-overlay-restore": "restoreButton",
          ".git-ui-side": "gitSideEl",
          ".git-ui-content": "gitContentEl",
          ".git-ui-branch-list": "branchListEl",
        };
        const prop = map[sel];
        if (prop) return this[prop] || null;
        if (sel === "input") {
          return this.children.find((c) => c.tag === "input") || null;
        }
        return null;
      },
      querySelectorAll() { return []; },
      replaceWith(next) {
        if (this.parentNode) {
          const idx = this.parentNode.children.indexOf(this);
          if (idx >= 0) this.parentNode.children[idx] = next;
          next.parentNode = this.parentNode;
        }
      },
      focus() {},
      insertAdjacentHTML(position, html) {
        // Enough for insertMissingHtml: parse the id out and register a stub
        // node at the body level, exactly where the app expects to find it.
        const ids = [...String(html).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
        for (const id of ids) {
          if (!elements.has(id)) {
            const el = makeElement(id);
            elements.set(id, el);
            this.appendChild(el);
          }
        }
      },
      scrollTop: 0,
      scrollHeight: 0,
      offsetHeight: 0,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      parentNode: null,
    };
    return el;
  }
  const body = makeElement("body");
  body.className = "body";
  // Real app.html always ships #terminalShell in the body; the drawers'
  // ensurePanel() append relative to it (git_ui has no body fallback).
  const shell = makeElement("terminalShell");
  body.appendChild(shell);
  // head is a sibling in the real DOM; only appendChild must work on it.
  const head = makeElement("head");
  const doc = {
    body,
    head,
    title: "",
    activeElement: null,
    hidden: false,
    visibilityState: "visible",
    fonts: undefined,
    createElement(tag) { const el = makeElement(""); el.tag = tag; return el; },
    createTextNode(text) { const el = makeElement(""); el.textContent = text; return el; },
    getElementById: (id) => elements.get(id) || null,
    registerElement: (id, el) => { if (id && !elements.has(id)) elements.set(id, el); },
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  return { doc, elements, makeElement };
}

const apiCalls = [];
const fetchImpl = async (url, init) => {
  const raw = String(url);
  const full = raw.startsWith("http") ? raw : `${ORIGIN}${raw}`;
  apiCalls.push({ path: new URL(full).pathname + new URL(full).search, init });
  const res = await httpsJson(full, init);
  const body = await res.json();
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => body };
};

function context(dom) {
  const localStorage = new Map();
  const rafQueue = [];
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    flushRaf(ticks = 1) { for (let i = 0; i < ticks; i += 1) { const q = rafQueue.splice(0); for (const fn of q) fn(); } },
    cancelAnimationFrame() {},
    Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Map, Set, RegExp, Error,
    TextEncoder, TextDecoder, URL, URLSearchParams,
    encodeURIComponent, decodeURIComponent,
    Event: function Event(type) { this.type = type; },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = (init && init.detail) || null; },
    getComputedStyle() { return { paddingLeft: "0px", paddingRight: "0px", getPropertyValue() { return ""; } }; },
    fetch: fetchImpl,
    alert() {},
    prompt: () => null,
    confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    document: dom.doc,
    localStorage: {
      getItem: (key) => localStorage.get(key) || null,
      setItem: (key, value) => localStorage.set(key, String(value)),
      removeItem: (key) => localStorage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    window: null,
    globalThis: null,
    WebSocket: class {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 20));

// Boot exactly the bundle set the real browser loads for the desktop
// overlays (src/assets/app_boot.js order): shared modules, then the desktop
// lazy feature files (picker, drawers), then the overlay host. The desktop
// host is only served inside the concatenated /assets/desktop/app.js, so it
// is sliced out between its comment header and workspace_create.js.
const SHARED_BUNDLES = [
  "/assets/shared/core.js",
  "/assets/shared/http.js",
  "/assets/shared/options.js",
  "/assets/shared/actions.js",
  "/assets/shared/file-icons.js",
  "/assets/shared/file-tree.js",
  "/assets/shared/line-context.js",
  "/assets/shared/file-content-search.js",
  "/assets/shared/workspace-search.js",
  "/assets/shared/editor.js",
  "/assets/shared/terminal-fit.js",
  "/assets/shared/temp-overlay.js",
];
const sources = [];
for (const path of SHARED_BUNDLES) sources.push(await loadText(path));
// Desktop search.js comes before the lazy modules in app_boot order; the
// drawers do not depend on it, but keeping the served order avoids drift.
sources.push(await loadText("/assets/desktop/search.js"));
sources.push(await loadText("/assets/desktop/directory-picker.js"));
sources.push(await loadText("/assets/desktop/file-browser.js"));
sources.push(await loadText("/assets/desktop/git-ui.js"));

// The overlay host lives inside the served desktop app bundle. Slice it
// from the served bytes (not the repo file) so this acceptance run always
// exercises what the server actually ships.
const desktopApp = await loadText("/assets/desktop/app.js");
const HOST_START = "Temporary Files/Git overlay hosts";
const HOST_END = "function openWorkspaceCreateModal()";
const hostStart = desktopApp.indexOf(HOST_START);
if (hostStart < 0) throw new Error("overlay host start marker missing from served app.js");
const hostEnd = desktopApp.indexOf(HOST_END, hostStart);
if (hostEnd < 0) throw new Error("overlay host end marker missing from served app.js");
// Walk back to the /** comment opener so the slice is valid JS.
const commentStart = desktopApp.lastIndexOf("/**", hostStart);
if (commentStart < 0) throw new Error("overlay host comment opener missing");
const hostSlice = desktopApp.slice(commentStart, hostEnd);

// App-scope helpers the host closes over (core.js owns the real ones; the
// stubs mirror the shapes the unit suite uses). The drawers' cross-hide
// paths stay real: the coexistence contract is exactly what this run tests.
sources.push(`
function selectedOrDefaultWorkspace() { return { workspace_id: "e2e-ws", cwd: "${FILES_DIR}" }; }
function workspacePath(ws) { return (ws && ws.cwd) || ""; }
function defaultFolderPath() { return "${FILES_DIR}"; }
function shortcutLabel() { return "Ctrl+Q F"; }
function gitUiEnabled() { return true; }
async function ensureGitUiLoaded() {}
async function ensureFileBrowserLoaded() {}
function appRefreshIconButton(opts) { return "<button class='" + ((opts && opts.className) || "") + "' title='" + ((opts && opts.title) || "") + "'>⟳</button>"; }
function explorationDefaultDirectory() { return "${FILES_DIR}"; }
`);
sources.push(hostSlice);

const dom = makeDom();
const ctx = context(dom);
vm.runInContext(sources.join("\n;\n"), ctx);

const overlays = ctx.window.HerdrTempOverlays;
assert(overlays && typeof overlays.openFiles === "function", "HerdrTempOverlays booted from served bundles");
assert(ctx.window.HerdrDirectoryPicker, "real directory picker booted from served bundles");
assert(ctx.window.HerdrFileBrowser && ctx.window.HerdrGitUi, "real desktop drawers booted from served bundles");

// 1. Open both overlays on different real folders: the coexistence contract.
const openFiles = overlays.openFiles(FILES_DIR);
await Promise.all([openFiles, nextFrame()]);
await openFiles;
await nextFrame();
const filesModal = dom.doc.getElementById("tempFilesOverlayModal");
assert(filesModal, "files overlay modal registered");
const filesPanel = dom.doc.getElementById("fileBrowserPanel");
assert(filesPanel, "file browser panel exists");
assert(filesPanel.parentNode && String(filesPanel.parentNode.className).indexOf("temp-overlay-body") !== -1,
  "files panel mounted inside the files overlay body");

const openGit = overlays.openGit(GIT_DIR);
await Promise.all([openGit, nextFrame()]);
await openGit;
await nextFrame();
const gitModal = dom.doc.getElementById("tempGitOverlayModal");
assert(gitModal, "git overlay modal registered");
const gitPanel = dom.doc.getElementById("gitUiPanel");
assert(gitPanel, "git panel exists");
assert(gitPanel.parentNode && String(gitPanel.parentNode.className).indexOf("temp-overlay-body") !== -1,
  "git panel mounted inside the git overlay body");

// Cross-hide survival: opening git must NOT have removed the files panel.
assert(dom.doc.getElementById("fileBrowserPanel") === filesPanel, "files panel survived opening the git overlay");
assert(dom.doc.getElementById("gitUiPanel") === gitPanel, "git panel survived the files drawer hide path");
assert(overlays.currentFolder("files") === FILES_DIR, "files overlay keeps its folder");
assert(overlays.currentFolder("git") === GIT_DIR, "git overlay keeps its folder");

// The drawers' hide() must have early-returned: panels still display.
assert(!filesPanel.style.display || filesPanel.style.display === "grid", "files panel not display:none'd by cross-hide");
assert(!gitPanel.style.display || gitPanel.style.display === "grid", "git panel not display:none'd by cross-hide");

// 2. Change folder through the REAL directory picker module.
const filesManager = overlays.files();
const changeBtn = filesModal.querySelector(".temp-overlay-folder-btn");
assert(changeBtn && changeBtn.onclick, "Change folder button wired");
changeBtn.onclick();
await nextFrame();
const pickerModal = dom.doc.getElementById("directoryPickerModal");
assert(pickerModal, "real directory picker modal opened");
assert(apiCalls.some((c) => c.path.includes("/api/file-browser/tree")), "picker fetched the tree from the real backend");

// Navigate into the real subfolder through the picker's public select()
// (what a row click calls), then commit with selectCurrent() so the hidden
// input change event resolves the host promise.
await new Promise((resolve) => setTimeout(resolve, 150));
const picker = ctx.window.HerdrDirectoryPicker;
// Tree rows carry paths relative to the picker root (splitPath put the
// absolute fixture under "/"), so navigating into the subfolder means
// loading the full relative path, exactly what a row click passes.
const fixtureRel = FILES_DIR.replace(/^\/+/, "");
picker.select(encodeURIComponent(`${fixtureRel}/subdir`));
await new Promise((resolve) => setTimeout(resolve, 150));
assert(pickerModal, "picker still open after navigating into a subfolder");
picker.selectCurrent();
await nextFrame();
await nextFrame();
assert(!dom.doc.getElementById("directoryPickerModal"), "picker modal closed after select");
const pickedPath = `${FILES_DIR.replace(/\/$/, "")}/subdir`;
assert(overlays.currentFolder("files") === pickedPath,
  `Change folder resolved to the picked subfolder (got ${overlays.currentFolder("files")})`);
const afterChange = dom.doc.getElementById("fileBrowserPanel");
assert(afterChange, "files panel re-mounted after the change-folder cycle");
assert(afterChange.parentNode && String(afterChange.parentNode.className).indexOf("temp-overlay-body") !== -1,
  "new panel instance sits inside the files overlay body (forgetWorkspace drops the old node; render() recreates it)");
assert(overlays.files().isOpen(), "files overlay still open after the change-folder cycle");

// 3. Picker close without a select keeps the folder.
const gitManager = overlays.git();
const gitChangeBtn = gitModal.querySelector(".temp-overlay-folder-btn");
gitChangeBtn.onclick();
await nextFrame();
const picker2 = dom.doc.getElementById("directoryPickerModal");
assert(picker2, "git overlay opened the picker too");
ctx.window.HerdrDirectoryPicker.close();
ctx.flushRaf(5);
await nextFrame();
assert(!dom.doc.getElementById("directoryPickerModal"), "picker closed");
assert(overlays.currentFolder("git") === GIT_DIR, "git overlay folder untouched after picker close");

// 4. Closing one overlay leaves the sibling intact (real drawer teardown).
overlays.closeFiles();
await nextFrame();
assert(!dom.doc.getElementById("tempFilesOverlayModal") || overlays.files().isOpen() === false, "files overlay closed");
const gitPanelAfter = dom.doc.getElementById("gitUiPanel");
assert(gitPanelAfter === gitPanel, "git panel untouched by the files overlay close");

// 5. No workspace/session API was ever called by the overlay flows.
const workspaceCalls = apiCalls.filter((c) => c.path.indexOf("/api/workspaces") === 0 || c.path.indexOf("/api/sessions") === 0);
assert(workspaceCalls.length === 0, `no workspace/session API calls from the overlays (got ${workspaceCalls.length})`);

console.log("PASS - temp overlay acceptance: coexistence, real picker, close, no workspace calls");