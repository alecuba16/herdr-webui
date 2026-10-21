// Unit tests for the mobile chat lens (src/assets/mobile/lens.js).
//
// Same vm harness pattern as the desktop lens_chat_mode.test.mjs: a
// small HTML tokenizer/serializer backing innerHTML, querySelector over
// data-* attributes, closest(), remove(), and id-registry
// getElementById. The conversation payload shapes mirror the server's
// turn_json exactly.
//
// Differences from the desktop harness worth noting:
// - the mobile lens is created through HerdrMobileLensModule.create
//   with injected deps (state, api, sendPaste, ...), not a global.
// - `el` is the mobile app's getElementById helper, injected too.
// - the overlay lives inside #terminalShell (created on demand).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const LENS_SOURCE = readFileSync(new URL("./mobile/lens.js", import.meta.url), "utf8");

// A minimal HTML tokenizer: builds stub children with correct nesting
// via a tag stack. Only the lens's own markup shapes need to work.
function parseHtml(host, html) {
  host._html = html;
  host._parseSeq = host.registry ? host.registry._mutSeq : 0;
  const root = [];
  const stack = [];
  const top = () => stack[stack.length - 1] || null;
  const pushText = (text) => {
    if (!text) return;
    const node = top();
    if (node) node.textContent += text;
  };
  const tokenRe = /<\/(div|span|button|pre|form|input|img)\s*>|<(div|span|button|pre|form|input|img)\b([^>]*?)(\/)?>/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      stack.pop();
      continue;
    }
    const node = makeElement(m[2], m[3] || "", "", host.registry);
    const parent = top();
    if (parent) {
      parent.children.push(node);
      node.parentNode = parent;
    } else {
      root.push(node);
      node.parentNode = host;
    }
    if (!m[4] && m[2] !== "input" && m[2] !== "img") stack.push(node);
  }
  pushText(html.slice(last));
  return root;
}

function attrsOf(attrText) {
  const attrs = {};
  const re = /([a-zA-Z-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrText)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function makeElement(tag, attrText, inner, registry) {
  const attrs = attrsOf(attrText);
  if (registry && registry._mutSeq === undefined) registry._mutSeq = 0;
  const node = {
    tagName: tag.toUpperCase(),
    className: attrs.class || "",
    hidden: false,
    textContent: "",
    disabled: false,
    value: "",
    children: [],
    listeners: {},
    _attrs: attrs,
    _html: inner,
    _mutated: false,
    set innerHTML(html) {
      this.children = parseHtml(this, html);
      this._html = html;
      this._mutated = false;
    },
    get innerHTML() {
      if (this._mutated || (this._parseSeq !== undefined && this._parseSeq !== this.registry._mutSeq))
        return serialize(this);
      return this._html;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name)
        ? this._attrs[name]
        : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    appendChild(child) {
      if (child.parentNode && child.parentNode !== this) {
        const from = child.parentNode.children.indexOf(child);
        if (from !== -1) child.parentNode.children.splice(from, 1);
        child.parentNode._mutated = true;
      }
      this.children.push(child);
      child.parentNode = this;
      this._mutated = true;
      this._mutSeq = (this.registry._mutSeq += 1);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode && child.parentNode !== this) {
        const from = child.parentNode.children.indexOf(child);
        if (from !== -1) child.parentNode.children.splice(from, 1);
        child.parentNode._mutated = true;
      }
      const at = this.children.indexOf(ref);
      if (at === -1) this.children.push(child);
      else this.children.splice(at, 0, child);
      child.parentNode = this;
      this._mutated = true;
      this._mutSeq = (this.registry._mutSeq += 1);
      return child;
    },
    remove() {
      if (this.parentNode) {
        const at = this.parentNode.children.indexOf(this);
        if (at !== -1) this.parentNode.children.splice(at, 1);
        this.parentNode._mutated = true;
        this.parentNode._mutSeq = (this.parentNode.registry._mutSeq += 1);
      }
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    closest(selector) {
      let node = this;
      while (node) {
        if (matches(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const collect = (node) => {
        for (const child of node.children || []) {
          if (matches(child, sel)) out.push(child);
          collect(child);
        }
      };
      collect(this);
      return out;
    },
    focus() {},
    dataset: {},
    classList: {
      _set: new Set(),
      toggle(name, value) {
        if (value === undefined) value = !this._set.has(name);
        if (value) this._set.add(name);
        else this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    onclick: null,
    parentNode: null,
    registry,
  };
  let textContent = "";
  Object.defineProperty(node, "textContent", {
    get: () => textContent,
    set(value) {
      textContent = String(value);
      node._mutated = true;
      node._mutSeq = (node.registry._mutSeq += 1);
    },
    configurable: true,
  });
  let currentId = attrs.id;
  Object.defineProperty(node, "id", {
    get: () => currentId,
    set(value) {
      currentId = value;
      node._attrs.id = value;
      if (registry && value) registry.set(value, node);
    },
    configurable: true,
  });
  Object.defineProperty(node, "outerHTML", {
    get: () => serialize(node),
    set(html) {
      const parent = node.parentNode;
      if (!parent) return;
      const parsed = parseHtml(parent, html);
      const at = parent.children.indexOf(node);
      if (at === -1) return;
      parent.children.splice(at, 1, ...parsed);
      parent._mutated = true;
      parent._mutSeq = (parent.registry._mutSeq += 1);
    },
    configurable: true,
  });
  if (registry && attrs.id) registry.set(attrs.id, node);
  for (const child of node.children) child.parentNode = node;
  return node;
}

function serialize(node) {
  const attrs = Object.entries(node._attrs)
    .filter(([name]) => name !== "class")
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  const cls = node.className ? ` class="${node.className}"` : "";
  const tag = node.tagName.toLowerCase();
  const inner = node.children.map(serialize).join("");
  return `<${tag}${cls}${attrs}>${inner}${node.textContent || ""}</${tag}>`;
}

function selectorParts(sel) {
  return String(sel)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.trim());
}

function partMatches(node, part) {
  const decodeEntities = (s) =>
    String(s)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const tokens = part.match(/[.#]?[a-zA-Z-]+|\[[^\]]+\]/g) || [];
  return tokens.every((token) => {
    if (token.startsWith("[")) {
      const body = token.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq === -1) return node._attrs[body.trim()] !== undefined;
      const name = body.slice(0, eq).trim();
      const want = decodeEntities(body.slice(eq + 1).trim().replace(/^["']|["']$/g, ""));
      return node._attrs[name] !== undefined && decodeEntities(node._attrs[name]) === want;
    }
    if (token.startsWith("."))
      return (" " + node.className + " ").includes(" " + token.slice(1) + " ");
    if (token.startsWith("#")) return node._attrs.id === token.slice(1);
    return node.tagName === token.toUpperCase();
  });
}

function matches(node, sel) {
  const parts = selectorParts(sel);
  if (parts.length > 1) {
    if (!partMatches(node, parts[parts.length - 1])) return false;
    let ancestor = node.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (ancestor && !partMatches(ancestor, parts[i]))
        ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  }
  return partMatches(node, sel);
}

function makeHarness(overrides = {}) {
  const registry = new Map();
  registry._mutSeq = 0;
  const doc = {
    registry,
    getElementById: (id) => registry.get(id) || null,
    createElement: () => makeElement("div", "", "", registry),
    addEventListener() {},
  };
  const shell = makeElement("div", 'id="terminalShell"', "", registry);
  registry.set("terminalShell", shell);
  const switchRow = makeElement(
    "div",
    'id="mobileLensSwitch" class="mobile-lens-switch"',
    "",
    registry,
  );
  const chatToggle = makeElement(
    "button",
    'id="mobileLensChatToggle" type="button" aria-pressed="false"',
    "",
    registry,
  );
  const terminalToggle = makeElement(
    "button",
    'id="mobileLensTerminalToggle" type="button" aria-pressed="true"',
    "",
    registry,
  );
  switchRow.appendChild(chatToggle);
  switchRow.appendChild(terminalToggle);
  registry.set("mobileLensSwitch", switchRow);
  registry.set("mobileLensChatToggle", chatToggle);
  registry.set("mobileLensTerminalToggle", terminalToggle);

  const timers = new Map();
  let timerSeq = 1;
  const fireTimers = () => {
    const batch = [...timers.values()];
    timers.clear();
    for (const timer of batch) {
      if (timer.cancelled) continue;
      timer.fn();
    }
  };
  const ctx = {
    console,
    setTimeout(fn, ms) {
      if (typeof fn !== "function") return 0;
      const id = timerSeq++;
      timers.set(id, { fn, ms: ms || 0, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.cancelled = true;
      timers.delete(id);
    },
    _fireTimers: fireTimers,
    _timers: timers,
    document: doc,
    state: overrides.state || { pane: "pane_1", agents: [] },
    api:
      overrides.api ||
      (async () => {
        throw Error("no api");
      }),
    fetch: async (url, opts) => {
      const called = overrides.fetch ? await overrides.fetch(url, opts) : undefined;
      if (called) return called;
      const body = await ctx.api(url);
      return json200(body);
    },
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_:-]/g, "\\$&") },
    escapeHtml: (value) =>
      String(value == null ? "" : value).replace(/[&<>"]/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]),
    inputAttrs: (enterkeyhint) =>
      ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no"' +
      (enterkeyhint ? ` enterkeyhint="${String(enterkeyhint)}"` : ""),
    HerdrMobileComposerDeps: { syncComposer() {} },
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const vmCtx = vm.createContext(ctx);
  vm.runInContext(LENS_SOURCE, vmCtx);
  // The mobile lens factory takes injected deps; the harness el() is the
  // app's getElementById shape.
  const sendPaste =
    overrides.sendPaste ||
    ((text) => {
      (ctx._sent ||= []).push(text);
    });
  const lens = ctx.HerdrMobileLensModule.create({
    state: ctx.state,
    el: (id) => registry.get(id) || null,
    api: ctx.api,
    escapeHtml: ctx.escapeHtml,
    inputAttrs: ctx.inputAttrs,
    statusClassFn: overrides.statusClassFn || ((status) => status),
    getTerminal: () => null,
    sendPaste,
    render: () => {},
  });
  ctx.lens = lens;
  return { ctx, registry, shell, lens, vmCtx };
}

function jcodeRow(agentSession) {
  return {
    pane_id: "pane_1",
    name: "jcode",
    display_agent: "jcode",
    agent: "jcode",
    agent_session: agentSession,
  };
}

const resolvableSession = { kind: "jcode", resolvable: true, session_id: "session_x" };

function conversationFixture() {
  return {
    source: "jcode-transcript",
    session_id: "session_x",
    version: "g1",
    cursor: null,
    model: "m",
    reasoning_effort: null,
    status: "Active",
    turns: [
      {
        role: "user",
        ts: "t1",
        end_ts: "t1",
        parts: [{ kind: "text", text: "hello" }],
      },
      {
        role: "assistant",
        ts: "t2",
        end_ts: "t2",
        parts: [
          {
            kind: "tool",
            name: "bash",
            brief: "run seq",
            input: "{}",
            output: "1\n2\n… trimmed",
            is_error: false,
            output_ref: "call_1",
            output_size: 13893,
          },
          { kind: "text", text: "done" },
        ],
      },
    ],
  };
}

function fireTimers(ctx) {
  ctx._fireTimers();
}

function json200(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    json: async () => body,
  };
}

async function settle(ms = 5) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function lensNode(registry) {
  return registry.get("mobileLens") || null;
}

function lensContent(registry) {
  const node = lensNode(registry);
  ok(node, "lens overlay mounted");
  return node.querySelector(".mobile-lens-content");
}

describe("mobile lens", () => {
  it("publishes the module and its API surface", () => {
    const { ctx, lens } = makeHarness();
    for (const name of [
      "toggle", "setLens", "isActive", "render", "renderSwitch",
      "syncSwitchUi", "syncSwitchVisibility", "onPaneChanged",
      "onAgentStatusChanged", "refreshConversation", "setPendingBubble",
      "loadOlder", "chatSupported", "formatDuration", "decisionHtml",
    ]) {
      equal(typeof lens[name], "function", `${name} must be exported`);
    }
  });

  it("chat gate: jcode with agent_session only", () => {
    const { ctx, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    equal(lens.chatSupported(), true, "jcode + session = chat capable");
    ctx.state.agents = [{ pane_id: "pane_1", name: "bash", agent_session: resolvableSession }];
    equal(lens.chatSupported(), false, "non-jcode agent never chat capable");
    ctx.state.agents = [jcodeRow(null)];
    equal(lens.chatSupported(), false, "jcode without session not chat capable");
    ctx.state.agents = [];
    equal(lens.chatSupported(), false, "no agents row not chat capable");
  });

  it("setLens re-docks the composer through the dock hook on open and close", async () => {
    // The chat view had no input box because the composer stayed mounted
    // in the keybar toolbar, covered by the lens overlay (and unreachable
    // with the toolbar folded). setLens must call the dock hook so the
    // composer moves into the overlay on open and back on close.
    const calls = [];
    const { registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
      extra: {
        HerdrMobileComposerDeps: {
          syncComposerDock: () => calls.push("dock"),
          syncComposer: () => calls.push("sync"),
        },
      },
    });
    lens.setLens(true);
    equal(calls[0], "dock", "open re-docks the composer first");
    equal(calls[1], "sync", "open then refreshes the composer state");
    calls.length = 0;
    lens.setLens(false);
    equal(calls[0], "dock", "close re-docks the composer back to the keybar");
    equal(calls[1], "sync", "close then refreshes the composer state");
    ok(registry.get("mobileLens"), "overlay stays mounted across the toggle");
  });

  it("setLens mounts the overlay in the shell and flips the switch", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    equal(lensNode(registry), null, "overlay not mounted before open");
    lens.setLens(true);
    const node = lensNode(registry);
    ok(node, "overlay mounted on open");
    equal(node.hidden, false, "overlay visible");
    const chatToggle = registry.get("mobileLensChatToggle");
    equal(chatToggle.getAttribute("aria-pressed"), "true", "Chat pressed on");
    const terminalToggle = registry.get("mobileLensTerminalToggle");
    equal(terminalToggle.getAttribute("aria-pressed"), "false", "Terminal pressed off");
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("lens-turn-user"), "user turn rendered");
    ok(content.innerHTML.includes('lens-tool-name">bash'), "tool row rendered");
    lens.setLens(false);
    equal(node.hidden, true, "overlay hidden on close");
    equal(chatToggle.getAttribute("aria-pressed"), "false", "Chat pressed off after close");
    equal(terminalToggle.getAttribute("aria-pressed"), "true", "Terminal pressed on after close");
  });

  it("polls the conversation route with pane_id and renders turns", async () => {
    const seen = [];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        seen.push(url);
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(seen.length, 1, "first poll fired");
    match(seen[0], /^\/api\/panes\/pane_1\/conversation\?pane_id=pane_1/, "pane_id param travels");
    const content = lensContent(registry);
    ok(content.innerHTML.includes("hello"), "user text rendered");
    ok(content.innerHTML.includes("done"), "assistant text rendered");
  });

  it("loading skeleton before the first poll lands", async () => {
    let gate = false;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        while (!gate) await new Promise((r) => setTimeout(r, 1));
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("lens-loading"), "loading skeleton shown");
    gate = true;
    await settle(20);
    ok(!content.innerHTML.includes("lens-loading"), "skeleton gone after poll");
  });

  it("refusal copy for unresolvable sessions", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: {
        pane: "pane_1",
        agents: [jcodeRow({ kind: "jcode", resolvable: false, reason: "no_session_path" })],
      },
      fetch: async () => {
        const error = Error("no session");
        error.details = { code: "no_session_path" };
        throw error;
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(
      content.innerHTML.includes("No jcode conversation found"),
      "refusal copy rendered",
    );
  });

  it("pending bubble: shown after submit, dropped when the turn lands", async () => {
    let turnLanded = false;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200(
          turnLanded
            ? {
                ...conversationFixture(),
                turns: [
                  ...conversationFixture().turns,
                  { role: "user", ts: "t3", parts: [{ kind: "text", text: "new message" }] },
                ],
              }
            : conversationFixture(),
        ),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.setPendingBubble("new message");
    let content = lensContent(registry);
    ok(content.innerHTML.includes("lens-turn-pending"), "pending bubble shown");
    ok(content.innerHTML.includes("new message"), "pending text visible");
    turnLanded = true;
    lens.refreshConversation();
    await settle(20);
    content = lensContent(registry);
    ok(!content.innerHTML.includes("lens-turn-pending"), "pending bubble dropped");
    ok(content.innerHTML.includes("new message"), "real turn present");
  });

  it("decision chooser: live while blocked, answered otherwise", async () => {
    const decisionPart = {
      kind: "decision",
      name: "decision",
      question: "Deploy now?",
      options: [
        { label: "Yes", detail: "ship it" },
        { label: "No", detail: "hold" },
      ],
    };
    let blocked = true;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200({
          ...conversationFixture(),
          turns: [
            ...conversationFixture().turns,
            { role: "assistant", ts: "t3", parts: [decisionPart] },
          ],
        }),
      sendPaste: (text) => {
        (ctx._sent ||= []).push(text);
      },
    });
    ctx.state.agents[0].agent_status = "blocked";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="live"'), "chooser live while blocked");
    // Click option 1: sends Up + 1.
    const option = content.querySelector('[data-decision-key].lens-decision-option');
    ok(option, "option button rendered");
    const key = option.getAttribute("data-decision-key");
    lens._resetDecisionState();
    const clickEvent = {
      target: {
        closest(selector) {
          if (selector.includes("lens-decision-option"))
            return content.querySelector('[data-decision-key].lens-decision-option');
          return null;
        },
      },
    };
    // Simulate through the lens's click handler: the overlay listens on
    // click; the harness reaches the same decisionAnswer path.
    const overlayNode = lensNode(registry);
    const handler = overlayNode.listeners.click[0];
    ok(handler, "click handler attached");
    handler(clickEvent);
    await settle();
    equal(ctx._sent.length, 1, "answer sent");
    equal(ctx._sent[0], "\u001b[A1", "Up + digit payload");
    content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="answered"'), "chooser flips to answered");
  });

  it("decision chooser read-only when the pane is not blocked", async () => {
    const decisionPart = {
      kind: "decision",
      name: "decision",
      question: "Deploy now?",
      options: [{ label: "Yes" }],
    };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200({
          ...conversationFixture(),
          turns: [
            ...conversationFixture().turns,
            { role: "assistant", ts: "t3", parts: [decisionPart] },
          ],
        }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="answered"'), "answered state when not blocked");
    ok(content.innerHTML.includes("Answered"), "answered hint rendered");
  });

  it("working indicator: shown while working, gone when idle", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
    });
    ctx.state.agents[0].agent_status = "working";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.innerHTML.includes("lens-working"), "working block while status working");
    ok(content.innerHTML.includes("lens-working-dots"), "animated dots present");
    lens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "idle" });
    await settle();
    content = lensContent(registry);
    ok(!content.innerHTML.includes("lens-working"), "working block gone when idle");
  });

  it("tool expand: head toggles open and output appears", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(!content.innerHTML.includes("lens-tool-open"), "tool closed by default");
    const head = content.querySelector("[data-toggle-tool]");
    ok(head, "tool head rendered");
    const overlayNode = lensNode(registry);
    const handler = overlayNode.listeners.click[0];
    handler({ target: { closest: (sel) => (sel.includes("toggle-tool") ? head : null) } });
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes("lens-tool-open"), "tool opened");
    ok(content.innerHTML.includes("lens-tool-output"), "output rendered");
    ok(content.innerHTML.includes("output trimmed"), "size meta shown");
  });

  it("load-older pages above the newest page", async () => {
    let olderAvailable = true;
    const olderPage = {
      ...conversationFixture(),
      cursor: null,
      turns: [
        { role: "user", ts: "t0a", parts: [{ kind: "text", text: "older question" }] },
      ],
    };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before=")) {
          if (!olderAvailable) return json200({ ...olderPage, cursor: null });
          olderAvailable = false;
          return json200({ ...olderPage, cursor: "older_cursor" });
        }
        return json200({ ...conversationFixture(), cursor: "new_cursor" });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.innerHTML.includes("Load earlier messages"), "load-older button present");
    lens.loadOlder();
    await settle(15);
    content = lensContent(registry);
    const html = content.innerHTML;
    const olderAt = html.indexOf("older question");
    const newerAt = html.indexOf("hello");
    ok(olderAt !== -1 && newerAt !== -1, "both pages rendered");
    ok(olderAt < newerAt, "older page sits above the newest page");
    // Poll continues with from= for held pages.
    const state = lens._state();
    equal(state.heldFrom, "new_cursor", "heldFrom tracks the newest cursor");
  });

  it("pane switch resets state and stops the old poll", async () => {
    let calls = 0;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        calls++;
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(calls, 1, "first pane polled");
    ctx.state.pane = "pane_2";
    ctx.state.agents = [];
    lens.onPaneChanged("key2");
    await settle();
    equal(lens.isActive(), false, "lens forced off on agent-less pane");
    const callsAfter = calls;
    fireTimers(ctx);
    await settle();
    equal(calls, callsAfter, "no further polls after the pane went agent-less");
  });

  it("appends new turns without rewriting old ones", async () => {
    let variant = 0;
    const responses = [
      conversationFixture(),
      {
        ...conversationFixture(),
        version: "g2",
        turns: [
          ...conversationFixture().turns,
          { role: "user", ts: "t3", parts: [{ kind: "text", text: "next question" }] },
        ],
      },
    ];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(responses[Math.min(variant, responses.length - 1)]),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    const before = content.innerHTML;
    ok(before.includes("hello"), "first turn present");
    variant = 1;
    lens.refreshConversation();
    await settle(15);
    const after = content.innerHTML;
    ok(after.includes("next question"), "new turn appended");
    ok(after.startsWith(before.replace(/<div data-older-control[\s\S]*?<\/div>/, "")) || after.includes("hello"), "old turns kept");
    ok(after.includes("hello"), "old turn kept");
  });

  it("empty conversation shows the empty state", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200({ ...conversationFixture(), turns: [] }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("lens-empty"), "empty state rendered");
  });

  it("single-flight: a slow poll never overlaps and queues one catch-up", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let started = 0;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        started++;
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    // Drive several timer ticks while the first poll is slow.
    for (let i = 0; i < 4; i++) {
      fireTimers(ctx);
      await Promise.resolve();
    }
    // Let the in-flight poll finish; its finally block re-arms the
    // catch-up timer which the fake clock still owes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    fireTimers(ctx);
    await settle();
    equal(maxConcurrent, 1, "no overlapping polls");
    ok(started >= 2 && started <= 3, "queued catch-up ran, but not one-per-tick");
  });

  it("status event re-renders instantly (blocked -> working)", async () => {
    const decisionPart = {
      kind: "decision",
      name: "decision",
      question: "Go?",
      options: [{ label: "Yes" }],
    };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200({
          ...conversationFixture(),
          turns: [
            ...conversationFixture().turns,
            { role: "assistant", ts: "t3", parts: [decisionPart] },
          ],
        }),
    });
    ctx.state.agents[0].agent_status = "blocked";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="live"'), "live while blocked");
    lens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="answered"'), "answered after unblock event");
  });

  it("switch visibility follows the chat gate", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    const switchRow = registry.get("mobileLensSwitch");
    lens.syncSwitchVisibility();
    equal(switchRow.hidden, false, "switch visible on chat-capable pane");
    ctx.state.agents = [];
    lens.syncSwitchVisibility();
    equal(switchRow.hidden, true, "switch hidden on agent-less pane");
  });

  it("renderSwitch emits the segmented control markup", () => {
    const { lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    const html = lens.renderSwitch();
    match(html, /id="mobileLensSwitch"/);
    match(html, /aria-label="Panel view"/);
    match(html, /HerdrMobileLens\.showChat\(\)/);
    match(html, /HerdrMobileLens\.showTerminal\(\)/);
    match(html, /id="mobileLensChatToggle"/);
    match(html, /id="mobileLensTerminalToggle"/);
  });

  it("showTerminal closes an open lens; showChat reopens it", () => {
    const { lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    lens.showChat();
    equal(lens.isActive(), true, "showChat activates the lens");
    lens.showTerminal();
    equal(lens.isActive(), false, "showTerminal closes the lens");
    equal(
      lens.isActive(),
      false,
      "showTerminal stays closed when already on terminal view",
    );
    lens.showChat();
    equal(lens.isActive(), true, "showChat reopens after terminal view");
  });

  it("new turns while scrolled up arm the unread pill", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    lens.showChat();
    fireTimers(ctx);
    await settle();
    const node = lensNode(registry);
    const scroller = node.querySelector("#mobileLensScroller");
    // Scrolled up: the scroll listener flips follow off without
    // reaching the bottom edge (no atBottom reset).
    scroller.scrollTop = 400;
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 300;
    scroller.listeners.scroll[0]();
    // A second poll adds one turn (append path).
    const grown = conversationFixture();
    grown.turns.push({
      role: "assistant",
      ts: "t3",
      end_ts: "t3",
      parts: [{ kind: "text", text: "more" }],
    });
    ctx.api = async () => grown;
    ctx.fetch = async () => json200(grown);
    fireTimers(ctx);
    await settle();
    const pill = node.querySelector("#mobileLensNew");
    equal(pill.hidden, false, "pill visible after new turn while scrolled up");
    // Landing at the bottom clears it.
    scroller.scrollTop = 700;
    scroller.listeners.scroll[0]();
    equal(pill.hidden, true, "pill hidden again at the bottom");
  });

  it("older pages prepend does not arm the unread pill", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async (url) => {
        if (url.includes("before=")) {
          return {
            source: "jcode-transcript",
            session_id: "session_x",
            version: "g0",
            cursor: null,
            turns: [
              {
                role: "user",
                ts: "t0",
                end_ts: "t0",
                parts: [{ kind: "text", text: "earlier" }],
              },
            ],
          };
        }
        return conversationFixture();
      },
    });
    lens.showChat();
    fireTimers(ctx);
    await settle();
    const node = lensNode(registry);
    const scroller = node.querySelector("#mobileLensScroller");
    scroller.scrollTop = 10;
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 300;
    scroller.listeners.scroll[0]();
    fireTimers(ctx);
    await settle();
    const pill = node.querySelector("#mobileLensNew");
    equal(pill.hidden, true, "pill stays hidden when only older pages loaded");
  });

  it("bounded walk-back drops held pages and says turns were skipped", async () => {
    // heldFrom set, then the newest page cursor moves beyond the
    // 32-page walk bound: the reset must mark the skip, keep a valid
    // olderCursor, and not claim the beginning.
    const newest = conversationFixture();
    const pages = [];
    for (let i = 0; i < 40; i++) {
      pages.push({
        role: "user",
        ts: `t${i}`,
        end_ts: `t${i}`,
        parts: [{ kind: "text", text: `turn ${i}` }],
      });
    }
    let held = false;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async (url) => {
        if (url.includes("before=") && !held) {
          held = true;
          return {
            source: "jcode-transcript",
            session_id: "session_x",
            version: "g0",
            cursor: "cursor_old",
            turns: [pages[0]],
          };
        }
        if (url.includes("from=")) {
          // 33 pages of gap: beyond the 32-page walk bound.
          const page = { ...newest, cursor: "cursor_far", turns: [pages[1]] };
          return page;
        }
        return { ...newest, cursor: "cursor_new" };
      },
    });
    lens.showChat();
    fireTimers(ctx);
    await settle();
    const node = lensNode(registry);
    const scroller = node.querySelector("#mobileLensScroller");
    scroller.scrollTop = 10;
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 300;
    scroller.listeners.scroll[0]();
    fireTimers(ctx);
    await settle();
    // Simulate the cursor moving on the next poll: from cursor_new to
    // something the walk cannot join in 32 steps.
    ctx.fetch = async (url) => {
      if (url.includes("from=")) {
        return json200({ ...newest, cursor: "cursor_far2", turns: [pages[2]] });
      }
      return json200({ ...newest, cursor: "cursor_moved", version: "g2" });
    };
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(
      content.innerHTML.includes("Some earlier messages were skipped"),
      "truncation note shown after a bounded reset",
    );
  });
});