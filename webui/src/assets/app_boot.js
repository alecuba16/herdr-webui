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
    const mobile = prefersMobile();
    document.documentElement.dataset.herdrLayout = mobile
      ? "mobile"
      : "desktop";
    loadCss(mobile ? "/assets/mobile.css" : "/assets/app.css");
    if (mobile) {
      loadScript("/assets/mobile-core.js");
      loadScript("/assets/mobile-terminal.js");
      loadScript("/assets/mobile-worktrees.js");
      loadScript("/assets/mobile-settings.js");
    }
    loadScript(mobile ? "/assets/mobile.js" : "/assets/app.js");
  }

  loadLayout();
})();
