import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const {
  ok,
  equal,
} = assert;

function relativeLuminance(hex) {
  const value = String(hex || "").replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseThemeVars(css) {
  const vars = {};
  const block = /body\.light \{([\s\S]*?)\n\}/.exec(css);
  const source = block ? block[1] : css;
  for (const match of source.matchAll(/--([a-z0-9-]+): (#[0-9a-fA-F]{6});/g)) {
    vars[match[1]] = match[2].toLowerCase();
  }
  return vars;
}

function parseBodyVars(css) {
  const vars = {};
  const block = /^body \{([\s\S]*?)\n\}/m.exec(css);
  const source = block ? block[1] : css;
  for (const match of source.matchAll(/--([a-z0-9-]+): (#[0-9a-fA-F]{6});/g)) {
    vars[match[1]] = match[2].toLowerCase();
  }
  return vars;
}

const desktopCss = readFileSync(new URL("./desktop/app_css/base.css", import.meta.url), "utf8");
const mobileCss = readFileSync(new URL("./mobile/app.css", import.meta.url), "utf8");

// Worst-case surfaces per theme: text may sit on bg, panel, or panel2/editor.
const syntaxKeys = [
  "editor-syntax-keyword",
  "editor-syntax-constant",
  "editor-syntax-number",
  "editor-syntax-string",
  "editor-syntax-regexp",
  "editor-syntax-comment",
  "editor-syntax-variable",
  "editor-syntax-function",
  "editor-syntax-type",
  "editor-syntax-property",
  "editor-syntax-tag",
  "editor-syntax-operator",
  "editor-syntax-meta",
  "editor-syntax-invalid",
];

const gitKeys = [
  "git-modified-color",
  "git-added-color",
  "git-deleted-color",
  "git-changed-color",
  "git-conflict-color",
];

function surfaceContrast(vars, keys, surfaces, label, min) {
  for (const key of keys) {
    const color = vars[key];
    ok(color, `${label}: missing ${key}`);
    for (const surface of surfaces) {
      const bg = vars[surface];
      ok(bg, `${label}: missing surface ${surface}`);
      const ratio = contrastRatio(color, bg);
      ok(
        ratio >= min,
        `${label}: ${key} ${color} on ${surface} ${bg} has contrast ${ratio.toFixed(2)} < ${min}`,
      );
    }
  }
}

function context() {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, textContent: "", value: "", innerHTML: "" });
    return elements.get(id);
  };
  const storage = new Map();
  const ctx = {
    console,
    TextEncoder,
    document: {
      body: getElement("body"),
      documentElement: getElement("html"),
      title: "",
      createElement: () => getElement(""),
      execCommand: () => true,
      querySelector: () => getElement(""),
      querySelectorAll: () => [],
      getElementById: getElement,
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    history: { pushState() {}, replaceState() {} },
    location: { pathname: "/", href: "" },
    navigator: { clipboard: {} },
    WebSocket: class {},
    fetch: async () => ({ status: 200, json: async () => ({}) }),
    addEventListener() {},
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => (typeof fn === "function" ? (fn(), 1) : 1),
    cancelAnimationFrame() {},
    prompt: () => null,
    confirm: () => true,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

function loadProfiles() {
  const source = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
  const start = source.indexOf("const themeColorDefaults = {");
  const end = source.indexOf("const settingsModules", start);
  const snippet = source.slice(start, end);
  const ctx = context();
  vm.runInContext(
    "var window = this; var localStorage = this.localStorage; " +
      snippet +
      "; this.__profiles = themeColorProfiles;",
    ctx,
  );
  return ctx.__profiles;
}

describe("theme contrast", () => {
  it("keeps light syntax colors at WCAG AA (4.5:1) on the editor background", () => {
    const light = parseThemeVars(desktopCss);
    surfaceContrast(light, syntaxKeys, ["editor-bg"], "light", 4.5);
  });

  it("keeps light git status colors at WCAG AA (4.5:1) on panel2 and bg", () => {
    const light = parseThemeVars(desktopCss);
    surfaceContrast(light, gitKeys, ["panel2", "bg"], "light", 4.5);
  });

  it("keeps dark syntax and git colors at WCAG AA (4.5:1)", () => {
    const dark = parseBodyVars(desktopCss);
    surfaceContrast(dark, syntaxKeys, ["editor-bg"], "dark", 4.5);
    surfaceContrast(dark, gitKeys, ["panel2", "bg"], "dark", 4.5);
  });

  it("keeps body text, muted text, and accents at WCAG AA in both themes", () => {
    for (const [label, vars] of [["dark", parseBodyVars(desktopCss)], ["light", parseThemeVars(desktopCss)]]) {
      for (const surface of ["bg", "panel", "panel2"]) {
        const fgRatio = contrastRatio(vars.fg, vars[surface]);
        ok(fgRatio >= 4.5, `${label}: fg on ${surface} is ${fgRatio.toFixed(2)} < 4.5`);
        const mutedRatio = contrastRatio(vars.muted, vars[surface]);
        ok(mutedRatio >= 4.5, `${label}: muted on ${surface} is ${mutedRatio.toFixed(2)} < 4.5`);
      }
      const accentRatio = contrastRatio(vars.accent, vars.bg);
      ok(accentRatio >= 4.5, `${label}: accent on bg is ${accentRatio.toFixed(2)} < 4.5`);
      // Text on accent fills (active tabs, primary buttons) uses accent-fg.
      const accentFg = vars["accent-fg"] || null;
      if (accentFg) {
        const onAccent = contrastRatio(accentFg, vars.accent);
        ok(onAccent >= 4.5, `${label}: accent-fg on accent is ${onAccent.toFixed(2)} < 4.5`);
      }
    }
  });

  it("keeps light editor carets visible (3:1 non-text) focused and dim", () => {
    const light = parseThemeVars(desktopCss);
    const focused = contrastRatio(light["editor-caret"], light["editor-bg"]);
    const dim = contrastRatio(light["editor-caret-dim"], light["editor-bg"]);
    ok(focused >= 3, `light focused caret contrast ${focused.toFixed(2)} < 3`);
    ok(dim >= 3, `light dim caret contrast ${dim.toFixed(2)} < 3`);
    const dark = parseBodyVars(desktopCss);
    const darkFocused = contrastRatio(dark["editor-caret"], dark["editor-bg"]);
    const darkDim = contrastRatio(dark["editor-caret-dim"], dark["editor-bg"]);
    ok(darkFocused >= 3, `dark focused caret contrast ${darkFocused.toFixed(2)} < 3`);
    ok(darkDim >= 3, `dark dim caret contrast ${darkDim.toFixed(2)} < 3`);
  });

  it("keeps desktop and mobile light palettes in parity", () => {
    const desktop = parseThemeVars(desktopCss);
    const mobile = parseThemeVars(mobileCss);
    const keys = [...syntaxKeys, ...gitKeys, "fg", "bg", "panel", "panel2", "editor-bg", "muted", "border", "border2", "accent", "editor-caret", "editor-caret-dim"];
    for (const key of keys) {
      equal(mobile[key], desktop[key], `light --${key} differs between desktop and mobile`);
    }
  });

  it("keeps the light agent status colors readable on panel and panel2", () => {
    const light = parseThemeVars(desktopCss);
    const statusColors = {
      idle: /body\.light \.agent-status\.idle \{\s*color: (#[0-9a-fA-F]{6});/.exec(desktopCss),
      working: /body\.light \.agent-status\.working \{\s*color: (#[0-9a-fA-F]{6});/.exec(desktopCss),
      blocked: /body\.light \.agent-status\.blocked \{\s*color: (#[0-9a-fA-F]{6});/.exec(desktopCss),
      done: /body\.light \.agent-status\.done \{\s*color: (#[0-9a-fA-F]{6});/.exec(desktopCss),
    };
    for (const [status, match] of Object.entries(statusColors)) {
      ok(match, `missing body.light .agent-status.${status} rule`);
      for (const surface of ["panel", "panel2"]) {
        const ratio = contrastRatio(match[1], light[surface]);
        ok(ratio >= 4.5, `light agent ${status} on ${surface} is ${ratio.toFixed(2)} < 4.5`);
      }
    }
    // Mobile nav chips share the same light hues.
    const mobileIdle = /body\.light \.mobile-nav-status\.idle \{\s*color: (#[0-9a-fA-F]{6});/.exec(mobileCss);
    ok(mobileIdle, "missing body.light .mobile-nav-status.idle rule");
    const ratio = contrastRatio(mobileIdle[1], light.bg);
    ok(ratio >= 4.5, `light mobile idle chip on bg is ${ratio.toFixed(2)} < 4.5`);
  });

  it("ships accessible dracula, monokai, and apple profiles", () => {
    const profiles = loadProfiles();
    for (const name of ["dracula", "monokai", "apple"]) {
      ok(profiles[name], `missing ${name} profile`);
      for (const mode of ["dark", "light"]) {
        const colors = profiles[name][mode];
        ok(colors && colors.background, `${name}.${mode} missing colors`);
        const fgRatio = contrastRatio(colors.foreground, colors.background);
        ok(fgRatio >= 4.5, `${name}.${mode} fg ${fgRatio.toFixed(2)} < 4.5`);
        const mutedRatio = contrastRatio(colors.muted, colors.background);
        ok(mutedRatio >= 4.5, `${name}.${mode} muted ${mutedRatio.toFixed(2)} < 4.5`);
        const accentRatio = contrastRatio(colors.accent, colors.background);
        ok(accentRatio >= 4.5, `${name}.${mode} accent ${accentRatio.toFixed(2)} < 4.5`);
        const accentFgRatio = contrastRatio(colors.background, colors.accent);
        ok(accentFgRatio >= 4.5, `${name}.${mode} accent-fg ${accentFgRatio.toFixed(2)} < 4.5`);
        const border2Ratio = contrastRatio(colors.border2, colors.background);
        ok(border2Ratio >= 3, `${name}.${mode} border2 ${border2Ratio.toFixed(2)} < 3`);
      }
    }
  });

  it("exposes the new profiles in the theme customizer dropdown", () => {
    const source = readFileSync(new URL("./desktop/app_js/core.js", import.meta.url), "utf8");
    for (const profile of ["dracula", "monokai", "apple"]) {
      match(source, new RegExp(`option value="${profile}"`));
    }
  });
});

function match(source, regex) {
  ok(regex.test(source), `expected ${regex} to match`);
}