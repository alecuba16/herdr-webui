(function () {
  const LAYOUT_KEY = "herdr-web-layout";
  const MOBILE_QUERY = "(max-width: 760px)";

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
    const script = document.createElement("script");
    script.async = false;
    script.src = src;
    document.body.appendChild(script);
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
      loadCss("/assets/desktop/shortcuts.css");
      loadCss("/assets/desktop/search.css");
    }
    loadScript("/assets/shared/core.js");
    if (mobile) {
      loadScript("/assets/mobile/core.js");
      loadScript("/assets/mobile/attention.js");
      loadScript("/assets/mobile/terminal.js");
      loadScript("/assets/mobile/worktrees.js");
      loadScript("/assets/mobile/git.js");
      loadScript("/assets/mobile/settings.js");
    } else {
      loadScript("/assets/desktop/search.js");
      loadScript("/assets/desktop/git-ui.js");
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

  loadLayout();
})();
