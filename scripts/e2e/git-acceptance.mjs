// Full-stack acceptance checks for the Git explorer rework.
//
// Behavioral `node --test` suites cover the git_ui module against stubbed
// fetches, but they cannot catch wiring bugs between the served bundle, the
// embedded assets, and the real git backend. This script boots the JS bundles
// the real server actually serves, proxies every vm fetch to the real backend,
// and drives the same call chain a browser click uses.
//
// Driven by scripts/e2e/run-git-e2e.sh (see that file for the environment
// overrides).
import vm from "node:vm";
import { request as httpsRequest } from "node:https";

const ORIGIN = process.env.E2E_ORIGIN;
const REPO = process.env.E2E_REPO;
const CLEAN = process.env.E2E_CLEAN_REPO;

if (!ORIGIN || !REPO) {
  console.error("E2E_ORIGIN and E2E_REPO must be set (use scripts/e2e/run-git-e2e.sh)");
  process.exit(2);
}

function httpsJson(url, init) {
  return new Promise((resolve, reject) => {
    const options = { rejectUnauthorized: false };
    if (init && init.method) options.method = init.method;
    if (init && init.headers) options.headers = init.headers;
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
    const req = httpsRequest(`${ORIGIN}${path}`, { rejectUnauthorized: false }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.end();
  });
}

function element() {
  return {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    value: "",
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild() {},
    removeChild() {},
    remove() {},
    replaceWith() {},
    insertBefore() {},
    after() {},
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    insertAdjacentHTML() {},
    focus() {},
    blur() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    offsetHeight: 0,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

const calls = [];
const fetchImpl = async (url, init) => {
  const raw = String(url);
  const full = raw.startsWith("http") ? raw : `${ORIGIN}${raw}`;
  const path = new URL(full).pathname;
  calls.push({ path, init });
  const res = await httpsJson(full, init);
  const body = await res.json();
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => body };
};

function context() {
  const localStorage = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, Map, Set, RegExp, Error,
    TextEncoder, TextDecoder,
    encodeURIComponent, decodeURIComponent,
    fetch: fetchImpl,
    alert() {},
    prompt: () => null,
    confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      title: "",
      body: element(),
      documentElement: element(),
      hidden: false,
      visibilityState: "visible",
      __panelHtml: "",
      createElement: () => element(),
      execCommand: () => true,
      querySelector: () => element(),
      querySelectorAll: () => [],
      getElementById(id) {
        const el = element();
        if (id === "gitUiPanel") {
          Object.defineProperty(el, "innerHTML", {
            get() { return ctx.document.__panelHtml; },
            set(value) { ctx.document.__panelHtml = String(value); },
          });
        }
        return el;
      },
      addEventListener() {},
    },
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
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

// Boot exactly the bundle set the server serves for the desktop git-ui feature.
const SHARED_BUNDLES = [
  "/assets/shared/core.js",
  "/assets/shared/options.js",
  "/assets/shared/actions.js",
  "/assets/shared/file-icons.js",
  "/assets/shared/file-tree.js",
  "/assets/shared/line-context.js",
  "/assets/shared/file-content-search.js",
  "/assets/shared/workspace-search.js",
];
const sources = [];
for (const path of SHARED_BUNDLES) sources.push(await loadText(path));
// appRefreshIconButton comes from the desktop app bundle (app_js/core.js).
sources.push('\nfunction appRefreshIconButton(){ return ""; }\n');
sources.push(await loadText("/assets/desktop/git-ui.js"));
const ctx = context();
vm.runInContext(sources.join("\n;\n"), ctx);

const ui = ctx.window.HerdrGitUi;
if (!ui) throw new Error("HerdrGitUi failed to boot from served bundles");

const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

// 1. Open the Git panel for the real repo (what a browser click does).
await ui.open({ cwd: REPO, title: "accept-repo" }, { forceOpen: true });
await new Promise((resolve) => setTimeout(resolve, 300));
assert(calls.some((c) => c.path === "/api/git-ui/status"), "git panel fetched status from the real backend");

// 2. The real status must report the untracked dir with a trailing slash.
const statusRes = await httpsJson(`${ORIGIN}/api/git-ui/status?cwd=${encodeURIComponent(REPO)}`);
const status = await statusRes.json();
assert(status.untracked.includes("scratchdir/"), "backend reports scratchdir/ as an untracked dir");

// 3. Render the changes tree and confirm the dir row (no phantom file row).
const treeFiles = status.untracked.concat(status.unstaged, status.staged);
const html = ctx.window.HerdrFileTree.renderPathTree(treeFiles, {
  callback: "HerdrGitUi",
  toggleMethod: "toggleDir",
  selectMethod: "selectFile",
  activateMethod: "activateTreeItem",
  contextMethod: "fileMenu",
  dirContextKind: "dir",
  dataPrefix: "git",
  rowClass: "git-ui-file",
  kind: "?",
});
assert(/herdr-tree-row dir/.test(html), "changes tree renders a dir row for scratchdir/");
assert(!/title="scratchdir\/"/.test(html), "no phantom file row for scratchdir/");
assert(/fileMenu\(event,'scratchdir'[^)]*,'dir'\)/.test(html), "dir row wires the dir context menu kind");

// 6. Header rework: the branch chip renders left-justified with the current
// branch, and the right side carries the status split button (Fetch, or
// Pull ↓N / Push ↑N when diverged).
const chipRes = await httpsJson(`${ORIGIN}/api/git-ui/status?cwd=${encodeURIComponent(REPO)}`);
const chipStatus = await chipRes.json();
const panelHtml = () => ctx.document.__panelHtml || "";
let headerHtml = panelHtml();
assert(/git-ui-branch-chip/.test(headerHtml), "branch chip rendered in header");
assert(new RegExp(`git-ui-branch-chip-name">${chipStatus.branch}</span>`).test(headerHtml), `chip shows the real branch name (${chipStatus.branch})`);
assert(new RegExp(`git-ui-branch-chip-name">${chipStatus.branch}</span><b class="git-ui-chip-caret">`).test(headerHtml), "chip label sits left of the caret with no sync badges");
assert(/git-ui-status-label/.test(headerHtml), "status split button rendered on the right");
assert(/git-ui-status-caret/.test(headerHtml), "status dropdown caret rendered");

// 7. The dropdown menu exposes exactly the seven git-flow actions.
ui.toggleHeaderMenu({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 12, bottom: 40 }) }, clientX: 12, clientY: 40 });
headerHtml = panelHtml();
const menuChunk = (headerHtml.match(/git-ui-header-menu" style[^>]*>[\s\S]*?<\/div>/) || [""])[0];
const menuLabels = (menuChunk.match(/<button onclick="[^"]*">[^<]+/g) || []).map((chunk) => chunk.replace(/^<button onclick="[^"]*">/, ""));
assert.deepEqual(menuLabels, ["Fetch", "Fetch From", "Pull", "Pull (rebase)", "Push", "Push to", "Force push"], "menu offers exactly the seven Zed actions");
for (const method of ["fetchOrigin", "openFetchFromModal", "openPullModal", "pullWithRebase", "openPushModal", "openPushToModal", "openForcePushModal"]) {
  assert(new RegExp(`HerdrGitUi\\.${method}\\(\\)`).test(menuChunk), `header menu wires ${method}`);
}
ui.toggleHeaderMenu({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 12, bottom: 40 }) }, clientX: 12, clientY: 40 });

// 8. Fetch from the menu reaches the real backend (fetch origin).
await ui.fetchOrigin();
await new Promise((resolve) => setTimeout(resolve, 400));
const fetchCall = calls.filter((c) => c.path === "/api/git-ui/fetch").pop();
assert(fetchCall, "fetch POST reached the real backend");
assert(JSON.parse(fetchCall.init.body).cwd === REPO, "fetch posted the repo cwd");

// 9. The branches endpoint returns author/date/subject for each branch.
const branchesRes = await httpsJson(`${ORIGIN}/api/git-ui/branches?cwd=${encodeURIComponent(REPO)}`);
const branches = await branchesRes.json();
assert(branches.local.length >= 1, "branches endpoint lists local branches");
const main = branches.local.find((b) => b.name === "main");
assert(main && main.author === "e2e" && main.subject === "init", "branch payload carries author/subject from real git");
assert(main && /\d{4}-\d{2}-\d{2}T/.test(String(main.date)), "branch payload carries an ISO date");

// 10. The branch list popover renders local and remote sections from the
// real payload, with author · relative time and hover details.
await ui.openBranchList({ stopPropagation() {}, currentTarget: null, clientX: 0, clientY: 0 });
await new Promise((resolve) => setTimeout(resolve, 400));
const listHtml = panelHtml();
assert(/git-ui-branch-list/.test(listHtml), "branch list popover opened");
assert(/Local branches/.test(listHtml), "branch list shows the local section");
assert(/e2e · /.test(listHtml), "branch rows show author · relative time");
assert(/title="[^"]*init[^"]*"/.test(listHtml), "branch row hover title carries the commit subject");
const switchCall = calls.filter((c) => c.path === "/api/git-ui/switch").pop();
assert(!switchCall, "no switch fired yet");

// 11. Filtering narrows rows. Switching runs on the clean clone (git refuses
// checkout over the dirty fixture tree).
ui.branchListFilter("no-such-branch");
const filteredHtml = panelHtml();
assert(!/git-ui-branch-row"/.test(filteredHtml), "filter hides all rows on no match");
ui.branchListFilter("ma");
ui.closeBranchList();
await ui.open({ cwd: CLEAN, title: "clean-repo" }, { forceOpen: true });
await new Promise((resolve) => setTimeout(resolve, 300));
await ui.openBranchList({ stopPropagation() {}, currentTarget: null, clientX: 0, clientY: 0 });
await new Promise((resolve) => setTimeout(resolve, 400));
const cleanListHtml = panelHtml();

assert(/feature-lane/.test(cleanListHtml), "clean repo branch list shows feature-lane");
assert(/Remote branches/.test(cleanListHtml), "clone lists feature-lane under remote branches");
// feature-lane exists only on the remote in the clone: switch from the
// remote row; the UI strips origin/ and asks git to create the local branch.
await ui.switchFromBranchList(encodeURIComponent("origin/feature-lane"), true);
await new Promise((resolve) => setTimeout(resolve, 400));
const switchPost = calls.filter((c) => c.path === "/api/git-ui/switch").pop();
assert(switchPost, "switch POST reached the real backend after branch-list click");
assert(JSON.parse(switchPost.init.body).branch === "feature-lane", "switch posted the bare branch name feature-lane");
const laneStatusRes = await httpsJson(`${ORIGIN}/api/git-ui/status?cwd=${encodeURIComponent(CLEAN)}`);
const laneStatus = await laneStatusRes.json();
assert(laneStatus.branch === "feature-lane", "clean repo now sits on feature-lane after the switch");
// And back to main: proves the list can switch both ways on a clean tree.
await ui.switchFromBranchList(encodeURIComponent("main"), false);
await new Promise((resolve) => setTimeout(resolve, 400));
const backStatusRes = await httpsJson(`${ORIGIN}/api/git-ui/status?cwd=${encodeURIComponent(CLEAN)}`);
const backStatus = await backStatusRes.json();
assert(backStatus.branch === "main", "clean repo switched back to main via the branch list");

// 4. Context-menu discard must reach the real backend and mutate real git.
// The active view is still the clean clone from the switch checks: reopen
// the dirty fixture repo first.
await ui.open({ cwd: REPO, title: "accept-repo" }, { forceOpen: true });
await new Promise((resolve) => setTimeout(resolve, 300));
ui.fileMenu({ preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5 }, "scratchdir/", "?", "dir");
await ui.menuAction("discard");
await new Promise((resolve) => setTimeout(resolve, 400));
const discard = calls.filter((c) => c.path === "/api/git-ui/discard").pop();
assert(discard, "discard POST reached the real backend");
const body = JSON.parse(discard.init.body);
assert(body.paths[0] === "scratchdir" && body.confirmed === true, "discard posted the folder with confirmed=true");

// 5. The real repo must now be clean of the untracked dir.
const afterRes = await httpsJson(`${ORIGIN}/api/git-ui/status?cwd=${encodeURIComponent(REPO)}`);
const after = await afterRes.json();
assert(!after.untracked.some((p) => p.startsWith("scratchdir")), "scratchdir is gone from real repo status");


console.log("GIT E2E ACCEPTANCE PASSED");