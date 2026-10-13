// Settings modal sections: merges the old shortcuts modal into Settings
// and adds the section rail.
//
// Before this module the footer had two buttons (Settings and Shortcuts)
// opening two modals with overlapping chrome. The feature merges them:
// one footer button opens one modal, Help & Shortcuts rides as the first
// peer section, and a left rail lists every section with the accent
// color marking the section currently in view (horizontal chips under
// 640px). Mobile ships its own settings stack, so this installs on
// desktop only.
//
// Install/uninstall is the toggle: install() is idempotent and rebuilds
// the modal chrome, uninstall() removes the rail and the help section so
// the modal falls back to the plain single-column layout (the footer
// button then opens the un-railed modal; callers check `installed()` to
// decide which chrome to build). Everything lives behind
// window.HerdrSettingsSections so core.js stays free of this feature.
(function (root) {
  let installed = false;
  let scrollSyncTarget = null;
  const scrollSync = () => updateSettingsNavCurrent();

  // Smooth-scroll respects the OS reduced-motion setting; matches the
  // base.css prefers-reduced-motion rule for CSS-driven animation.
  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function modal() {
    return document.getElementById("settingsModal");
  }

  function body() {
    const m = modal();
    return m && m.querySelector(".settings-body");
  }

  // The shell owns the scroll (overflow:auto under the modal's max-height
  // clip); the .modal card itself never scrolls, so anything reading or
  // writing scroll on it silently does nothing.
  function scrollContainer() {
    const m = modal();
    return (m && m.querySelector(".settings-shell")) || body();
  }

  function navSections() {
    const b = body();
    return b
      ? Array.from(b.querySelectorAll(":scope > .settings-section"))
      : [];
  }

  function sectionTitle(section, index) {
    const head = section.querySelector(":scope > .settings-section-head h3");
    return head ? head.textContent : `Section ${index + 1}`;
  }

  function updateSettingsNavCurrent() {
    const m = modal();
    const nav = document.getElementById("settingsNav");
    if (!nav) return;
    // Layout in a hidden modal reads as zeros: every section rect sits at
    // the scroller top and the loop crowns the last one. Skip when the
    // modal is not actually on screen; openSettingsModalAt recomputes
    // right after display flips to grid.
    if (m && typeof m.getClientRects === "function" &&
        m.getClientRects().length === 0) return;
    const sections = navSections();
    const scroller = scrollContainer();
    if (!scroller) return;
    // The current section is the last one whose top edge crossed the
    // scroller top; the first section wins while it is still in view.
    // Rects are used instead of offsetTop because offsetTop is relative
    // to the nearest positioned ancestor, not to this scroller.
    const scrollerTop = scroller.getBoundingClientRect().top;
    const scrollTop = scroller.scrollTop;
    const scrollMax = Math.max(
      0,
      (scroller.scrollHeight || 0) - (scroller.clientHeight || 0),
    );
    const atBottom = scrollMax - scrollTop <= 8;
    let currentIdx = 0;
    for (let i = 0; i < sections.length; i++) {
      const top = sections[i].getBoundingClientRect().top;
      if (top - scrollerTop + scrollTop <= 8) currentIdx = i;
    }
    // A short last section can never cross the top edge (the scroll
    // clamps before it gets there), so bottom-of-scroll pins it. The 8px
    // tolerance absorbs subpixel smooth-scroll stops and dpi rounding.
    if (atBottom && sections.length) currentIdx = sections.length - 1;
    Array.from(nav.children).forEach((btn, i) => {
      const active = i === currentIdx;
      btn.classList.toggle("settings-nav-current", active);
      btn.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function syncSettingsNav() {
    const m = modal();
    const nav = document.getElementById("settingsNav");
    if (!nav) return;
    const sections = navSections();
    const makeButton = (section, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-nav-item";
      btn.dataset.settingsNavIndex = String(index);
      btn.textContent = sectionTitle(section, index);
      btn.addEventListener("click", () => focusSettingsSection(section));
      return btn;
    };
    const current = Array.from(nav.children);
    const labels = sections.map((s, i) => sectionTitle(s, i));
    const changed =
      current.length !== sections.length ||
      current.some((btn, i) => btn.textContent !== labels[i]);
    if (changed) {
      nav.innerHTML = "";
      sections.forEach((section, index) =>
        nav.appendChild(makeButton(section, index)),
      );
    }
    updateSettingsNavCurrent();
  }

  function focusSettingsSection(section) {
    if (!section) return;
    const scroller = scrollContainer();
    if (!scroller) return;
    // Rect math lands the section flush with the scroller top no matter
    // which ancestor is positioned (offsetTop would not).
    let target =
      section.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const scrollMax = Math.max(
      0,
      (scroller.scrollHeight || 0) - (scroller.clientHeight || 0),
    );
    // A target beyond the scroll max would clamp mid-animation; jump to
    // the max directly so the last section lands fully in view.
    if (target >= scrollMax - 8) target = scrollMax;
    scroller.scrollTo({
      top: Math.max(0, target),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    updateSettingsNavCurrent();
    const head = section.querySelector(":scope > .settings-section-head");
    if (head) {
      head.setAttribute("tabindex", "-1");
      head.focus({ preventScroll: true });
    }
  }

  function helpAndShortcutsSectionHtml() {
    return (
      '<div class="settings-section-head"><h3>Help &amp; Shortcuts</h3>' +
      "<p>Functionality map, keyboard shortcuts, and the shortcut editor. " +
      "Terminal apps may handle their own keybindings inside the pane.</p></div>" +
      '<div class="help-shortcut-mount" aria-live="polite"></div>'
    );
  }

  function renderHelpAndShortcutsSection() {
    // The help section hosts the old shortcuts-modal body: functionality
    // map, keyboard shortcuts reference, and the shortcut editor.
    // Rendered once at startup so applyOptions() finds
    // closeShortcutCurrent and the editor target on its first pass.
    // helpAndShortcutsBodyHtml/renderShortcutEditor live in the shared
    // desktop bundle scope (core.js/shortcuts.js); they may be absent in
    // isolated harnesses, so guard both.
    const b = body();
    const section = b && b.querySelector(":scope > .settings-help-section");
    if (!section) return false;
    const mount = section.querySelector(".help-shortcut-mount");
    if (!mount || mount.dataset.rendered === "1") return true;
    mount.dataset.rendered = "1";
    mount.innerHTML =
      typeof helpAndShortcutsBodyHtml === "function"
        ? helpAndShortcutsBodyHtml()
        : "";
    if (typeof renderShortcutEditor === "function")
      renderShortcutEditor();
    return true;
  }

  function openSettingsModalAt(sectionSelector) {
    const m = modal();
    if (!m) return;
    m.style.display = "grid";
    // prepareSettingsModalOpen (core.js) runs the open chores: apply
    // options, server settings, confirm-row watchers, search reset.
    if (typeof prepareSettingsModalOpen === "function")
      prepareSettingsModalOpen();
    if (!installed) return;
    renderHelpAndShortcutsSection();
    syncSettingsNav();
    const b = body();
    const section =
      sectionSelector && b ? b.querySelector(sectionSelector) : null;
    if (section) {
      requestAnimationFrame(() => {
        focusSettingsSection(section);
        // focusSettingsSection smooth-scrolls; the nav accent catches up
        // after that scroll settles, but an immediate pass covers the
        // no-scroll case (target already in view) where no scroll event
        // fires.
        updateSettingsNavCurrent();
        setTimeout(updateSettingsNavCurrent, 450);
      });
    } else {
      requestAnimationFrame(updateSettingsNavCurrent);
    }
  }

  function buildShell(modalCard) {
    // The old body must be re-inserted into the modal before it can host
    // the shell's children: insertBefore on a detached reference node
    // throws, and a throw here would kill the whole core.js run (footer
    // build included) with the modal half-built.
    const b = body();
    const helpSection = document.createElement("section");
    helpSection.className = "settings-section settings-help-section";
    helpSection.dataset.settingsSection = "help";
    helpSection.innerHTML = helpAndShortcutsSectionHtml();
    b.insertBefore(helpSection, b.firstChild);
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    nav.id = "settingsNav";
    nav.setAttribute("aria-label", "Settings sections");
    const shell = document.createElement("div");
    shell.className = "settings-shell";
    // :scope matters: serverSettingsHtml() embeds its own .modal-actions
    // deep inside a settings section, and querySelector returns the first
    // match in document order; inserting before a non-child throws.
    const actions = modalCard.querySelector(":scope > .modal-actions");
    if (actions) modalCard.insertBefore(shell, actions);
    else modalCard.appendChild(shell);
    shell.appendChild(nav);
    shell.appendChild(b);
    return shell;
  }

  function attachScrollSync() {
    detachScrollSync();
    const scroller = scrollContainer();
    if (!scroller) return;
    scrollSyncTarget = scroller;
    scroller.addEventListener("scroll", scrollSync, { passive: true });
  }

  function detachScrollSync() {
    if (scrollSyncTarget) {
      scrollSyncTarget.removeEventListener("scroll", scrollSync);
      scrollSyncTarget = null;
    }
  }

  function install() {
    const m = modal();
    const modalCard = m && m.querySelector(".modal");
    if (!m || !modalCard) return false;
    if (installed || m.dataset.settingsSections === "1") {
      installed = true;
      return true;
    }
    buildShell(modalCard);
    attachScrollSync();
    syncSettingsNav();
    m.dataset.settingsSections = "1";
    installed = true;
    return true;
  }

  function uninstall() {
    const m = modal();
    if (!m) return false;
    detachScrollSync();
    const shell = m.querySelector(".settings-shell");
    const nav = document.getElementById("settingsNav");
    const b = body();
    if (shell && b) {
      // Fold the body back as a plain modal column, drop rail and help.
      const modalCard = m.querySelector(".modal");
      const actions = modalCard && modalCard.querySelector(":scope > .modal-actions");
      const help = b.querySelector(":scope > .settings-help-section");
      if (help) help.remove();
      if (actions) modalCard.insertBefore(b, actions);
      else modalCard.appendChild(b);
      shell.remove();
    }
    if (nav) nav.remove();
    delete m.dataset.settingsSections;
    installed = false;
    return true;
  }

  const api = {
    install,
    uninstall,
    installed() {
      return installed;
    },
    syncSettingsNav,
    updateSettingsNavCurrent,
    focusSettingsSection,
    openSettingsModalAt,
    renderHelpAndShortcutsSection,
    helpAndShortcutsSectionHtml,
    HELP_SECTION_SELECTOR: ":scope > .settings-help-section, .settings-help-section",
  };
  root.HerdrSettingsSections = api;
  if (typeof module !== "undefined" && module.exports)
    module.exports = api;

  // Desktop boot: install as soon as the modal chrome exists (core.js
  // builds it before this file loads). The eager help render covers the
  // first applyOptions() pass; if the chrome is missing (isolated test
  // harness without the full DOM), install() simply returns false.
  if (install()) renderHelpAndShortcutsSection();
})(typeof globalThis !== "undefined" ? globalThis : window);