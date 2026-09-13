(function (root) {
  // Shared HTTP client for every browser bundle (desktop core, desktop lazy
  // feature modules, mobile). One place owns session/backend request headers,
  // 401 handling, and error normalization so all surfaces target the same
  // Herdr session and cannot drift again (see INVENTORY-TEMP.md §5: desktop
  // lazy modules previously shipped private api() copies without headers).
  //
  // Layout bundles register a context provider at boot:
  //   HerdrHttp.configure(() => ({
  //     session: state.session,             // "" or "default" means no header
  //     backend: currentSessionBackend(),   // "" means no header
  //   }));
  // Then call:
  //   await HerdrHttp.request(url, opt)     // opt: fetch options; JSON errors
  //                                         // throw Error with .status/.details
  //   HerdrHttp.options(opt)                // opt + credentials + headers
  // The provider is read on every request, so pin changes apply immediately.

  function errorMessage(body, statusText) {
    const err = body && body.error;
    if (!err) return statusText;
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    if (err.code) return String(err.code);
    try {
      return JSON.stringify(err);
    } catch (_) {
      return statusText;
    }
  }

  let contextProvider = null;

  function configure(provider) {
    if (typeof provider !== "function") return;
    contextProvider = provider;
  }

  function context() {
    try {
      return contextProvider ? contextProvider() || {} : {};
    } catch (_) {
      return {};
    }
  }

  function options(opt) {
    const next = Object.assign({}, opt || {});
    const ctx = context();
    const headers = Object.assign({}, next.headers || {});
    if (ctx.session && ctx.session !== "default")
      headers["x-herdr-session"] = String(ctx.session);
    if (ctx.backend) headers["x-herdr-backend"] = String(ctx.backend);
    next.headers = headers;
    next.credentials = next.credentials || "same-origin";
    return next;
  }

  async function request(url, opt) {
    const res = await fetch(url, options(opt));
    if (res.status === 401) {
      // Mirror desktop core behavior: expired auth reloads into the login
      // flow instead of surfacing a raw error in feature panels.
      root.location.href = "/";
      throw Error("unauthorized");
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok || (body && body.error)) {
      const error = Error(errorMessage(body, res.statusText));
      error.status = res.status;
      error.details = body || {};
      throw error;
    }
    return body || {};
  }

  const HerdrHttp = { configure, options, request, errorMessage };
  if (root && typeof root === "object") root.HerdrHttp = HerdrHttp;
  if (typeof module !== "undefined" && module.exports) module.exports = HerdrHttp;
})(globalThis);