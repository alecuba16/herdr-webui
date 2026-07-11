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
    if (readLayoutPreference() === "mobile") return true;
    if (readLayoutPreference() === "desktop") return false;
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
    document.body.appendChild(script);
    scriptLoads[src] = new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(Error("Failed to load " + src));
    });
    return scriptLoads[src];
  }

  function loadLayout() {
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
    loadCss("/assets/shared/file-icons.css");
    loadCss("/assets/shared/content-search.css");
    loadScript("/assets/shared/core.js");
    loadScript("/assets/shared/file-icons.js");
    loadScript("/assets/shared/file-tree.js");
    loadScript("/assets/shared/file-content-search.js");
    loadScript("/assets/shared/workspace-search.js");
    loadScript("/assets/vendor/codemirror.js");
    loadScript("/assets/shared/editor.js");
    loadScript("/assets/shared/terminal-scroll.js");
    loadScript("/assets/shared/temp-terminal.js");
    if (mobile) {
      loadScript("/assets/mobile/core.js");
      loadScript("/assets/mobile/attention.js");
      loadScript("/assets/mobile/terminal.js");
      loadScript("/assets/mobile/worktrees.js");
      loadScript("/assets/mobile/file-browser.js");
      loadScript("/assets/mobile/settings.js");
    } else {
      loadScript("/assets/desktop/search.js");
      loadScript("/assets/desktop/directory-picker.js");
    }
    loadScript(mobile ? "/assets/mobile/app.js" : "/assets/desktop/app.js");
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
