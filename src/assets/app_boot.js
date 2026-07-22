(function () {
  const LAYOUT_KEY = "herdr-web-layout";
  const MOBILE_QUERY = "(max-width: 760px)";
  const scriptLoads = {};

  function readLayoutPreference() {
    try {
      const value = localStorage.getItem(LAYOUT_KEY);
      if (value === "desktop" || value === "mobile") return value;
    } catch (_) {}
    return "auto";
  }

  function prefersMobile() {
    const preference = readLayoutPreference();
    if (preference === "mobile") return true;
    if (preference === "desktop") return false;
    return !!(window.matchMedia && window.matchMedia(MOBILE_QUERY).matches);
  }

  function resolvedLayout() {
    return prefersMobile() ? "mobile" : "desktop";
  }

  function loadCss(href) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  function loadScript(src) {
    if (scriptLoads[src]) return scriptLoads[src];
    const script = document.createElement("script");
    script.async = false;
    script.src = src;
    scriptLoads[src] = new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(Error("Failed to load " + src));
    });
    document.body.appendChild(script);
    return scriptLoads[src];
  }

  async function loadScriptsSequentially(sources) {
    for (const src of sources) await loadScript(src);
  }

  async function loadLayout() {
    const layout = resolvedLayout();
    const mobile = layout === "mobile";
    document.documentElement.dataset.herdrLayout = layout;
    if (mobile) {
      loadCss("/assets/mobile/app.css");
    } else {
      loadCss("/assets/desktop/app.css");
      loadCss("/assets/desktop/git-ui.css");
      loadCss("/assets/desktop/file-browser.css");
      loadCss("/assets/desktop/shortcuts.css");
      loadCss("/assets/desktop/search.css");
    }
    loadCss("/assets/shared/colors.css");
    loadCss("/assets/vendor/wterm.css");
    loadCss("/assets/shared/file-icons.css");
    loadCss("/assets/shared/content-search.css");
    await loadScriptsSequentially([
      "/assets/shared/core.js",
      "/assets/shared/actions.js",
      "/assets/shared/file-icons.js",
      "/assets/shared/file-tree.js",
      "/assets/shared/line-context.js",
      "/assets/shared/file-content-search.js",
      "/assets/shared/workspace-search.js",
      "/assets/vendor/codemirror.js",
      "/assets/vendor/wterm.js",
      "/assets/shared/editor.js",
      "/assets/shared/terminal-fit.js",
      "/assets/shared/terminal-adapter.js",
      "/assets/shared/temp-terminal.js",
      ...(mobile ? [
        "/assets/mobile/core.js",
        "/assets/mobile/attention.js",
        "/assets/mobile/terminal.js",
        "/assets/mobile/worktrees.js",
        "/assets/mobile/file-browser.js",
        "/assets/mobile/settings.js",
        "/assets/mobile/app.js",
      ] : [
        "/assets/desktop/search.js",
        "/assets/desktop/directory-picker.js",
        "/assets/desktop/app.js",
      ]),
    ]);
    watchAutoLayout(layout);
  }

  function watchAutoLayout(currentLayout) {
    if (readLayoutPreference() !== "auto" || !window.matchMedia) return;
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      if (readLayoutPreference() !== "auto") return;
      const nextLayout = resolvedLayout();
      if (nextLayout === currentLayout) return;
      window.location.reload();
    };
    if (media.addEventListener) media.addEventListener("change", onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  window.HerdrLoadScript = loadScript;
  loadLayout();
})();
