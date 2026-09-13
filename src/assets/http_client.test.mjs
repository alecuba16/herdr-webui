import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { doesNotThrow, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// HerdrHttp is the single shared browser HTTP client. It exists so every
// surface (desktop core, desktop lazy Git/Files/picker/LSP modules, mobile)
// sends the same x-herdr-session/x-herdr-backend headers and handles 401 the
// same way. Regression background: desktop lazy modules shipped private
// api() copies without those headers and the Git drawer read worktrees from
// the wrong session/backend (INVENTORY-TEMP.md §5).

function createContext({ fetchImpl } = {}) {
  const context = {
    console,
    globalThis: null,
    location: { href: "http://localhost/" },
    fetch: fetchImpl || (async () => { throw Error("fetch not stubbed"); }),
  };
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function loadHttp(context) {
  vm.runInContext(
    readFileSync(new URL("./shared/http.js", import.meta.url), "utf8"),
    context,
  );
  return context.HerdrHttp;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

describe("HerdrHttp shared client", () => {
  let requests;
  let context;
  let HerdrHttp;

  beforeEach(() => {
    requests = [];
    context = createContext({
      fetchImpl: async (url, opt) => {
        requests.push({ url, opt });
        return jsonResponse({ ok: true, value: 1 });
      },
    });
    HerdrHttp = loadHttp(context);
    ok(HerdrHttp, "HerdrHttp must register on globalThis");
  });

  it("sends session and backend headers when configured", async () => {
    HerdrHttp.configure(() => ({ session: "work", backend: "builtin" }));
    await HerdrHttp.request("/api/workspaces");
    equal(requests.length, 1);
    const headers = requests[0].opt.headers;
    equal(headers["x-herdr-session"], "work");
    equal(headers["x-herdr-backend"], "builtin");
  });

  it("omits headers for default session and empty backend", async () => {
    HerdrHttp.configure(() => ({ session: "default", backend: "" }));
    await HerdrHttp.request("/api/workspaces");
    const headers = requests[0].opt.headers;
    equal(headers["x-herdr-session"], undefined);
    equal(headers["x-herdr-backend"], undefined);
  });

  it("reads the provider per request so pin changes apply immediately", async () => {
    let session = "work";
    HerdrHttp.configure(() => ({ session, backend: "builtin" }));
    await HerdrHttp.request("/api/workspaces");
    session = "other";
    await HerdrHttp.request("/api/workspaces");
    equal(requests[0].opt.headers["x-herdr-session"], "work");
    equal(requests[1].opt.headers["x-herdr-session"], "other");
  });

  it("always sends same-origin credentials", async () => {
    await HerdrHttp.request("/api/versions");
    equal(requests[0].opt.credentials, "same-origin");
  });

  it("merges caller headers without losing them", async () => {
    HerdrHttp.configure(() => ({ session: "work", backend: "builtin" }));
    await HerdrHttp.request("/api/git-ui/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const headers = requests[0].opt.headers;
    equal(headers["Content-Type"], "application/json");
    equal(headers["x-herdr-session"], "work");
    equal(headers["x-herdr-backend"], "builtin");
  });

  it("keeps working without a configured provider", async () => {
    await HerdrHttp.request("/api/versions");
    ok(!requests[0].opt.headers["x-herdr-session"]);
  });

  it("normalizes error payloads into Error with status and details", async () => {
    context.fetch = async () => jsonResponse({ error: { message: "boom" } }, 409);
    await assert.rejects(
      HerdrHttp.request("/api/git-ui/commit", { method: "POST" }),
      (error) => {
        equal(error.message, "boom");
        equal(error.status, 409);
        equal(error.details.error.message, "boom");
        return true;
      },
    );
  });

  it("redirects to login flow on 401 and throws unauthorized", async () => {
    context.location.href = "http://localhost/";
    context.fetch = async () => jsonResponse({ error: "unauthorized" }, 401);
    await assert.rejects(
      HerdrHttp.request("/api/workspaces"),
      (error) => {
        equal(error.message, "unauthorized");
        return true;
      },
    );
    equal(context.location.href, "/");
  });

  it("treats a non-JSON body as an empty result object", async () => {
    context.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => { throw Error("not json"); },
    });
    const body = await HerdrHttp.request("/api/versions");
    equal(typeof body, "object");
  });
});

describe("bundle api() client guard", () => {
  // Bundles must delegate to HerdrHttp instead of redefining private fetch
  // wrappers. A private wrapper that forgets the session/backend headers
  // silently misroutes requests to the default session.
  const bundles = [
    "./desktop/app_js/core.js",
    "./desktop/git_ui.js",
    "./desktop/file_browser.js",
    "./desktop/directory_picker.js",
    "./desktop/lsp_settings.js",
    "./mobile/app.js",
    "./shared/lsp.js",
  ];

  it("every bundle api() delegates to the shared HerdrHttp client", () => {
    for (const path of bundles) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      match(
        source,
        /function api\(.*\)\s*\{[\s\S]*?globalThis\.HerdrHttp\s*\.\s*request/,
        `${path} must route api() through globalThis.HerdrHttp.request`,
      );
    }
  });

  it("app boot loads the shared client before all consumers", () => {
    const boot = readFileSync(new URL("./app_boot.js", import.meta.url), "utf8");
    const httpIndex = boot.indexOf("/assets/shared/http.js");
    ok(httpIndex >= 0, "app_boot must load shared/http.js");
    for (const consumer of [
      "/assets/shared/options.js",
      "/assets/shared/workspace-search.js",
      "/assets/desktop/app.js",
      "/assets/mobile/app.js",
    ]) {
      const consumerIndex = boot.indexOf(consumer);
      ok(consumerIndex > httpIndex, `${consumer} must load after shared/http.js`);
    }
  });

  it("server serves the shared client at the documented route", () => {
    const assets = readFileSync(new URL("../assets.rs", import.meta.url), "utf8");
    match(assets, /SHARED_HTTP_JS:\s*&str\s*=\s*include_str!\("assets\/shared\/http\.js"\)/);
    const main = readFileSync(new URL("../main.rs", import.meta.url), "utf8");
    match(main, /"\/assets\/shared\/http\.js",\s*get\(shared_http_js\)/);
  });

  it("layouts configure HerdrHttp with session and backend context", () => {
    const desktop = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
    match(desktop, /HerdrHttp\.configure/);
    const mobile = readFileSync(new URL("./mobile/app.js", import.meta.url), "utf8");
    match(mobile, /HerdrHttp\.configure/);
    doesNotThrow(() => {
      equal(typeof desktop, "string");
    });
  });
});