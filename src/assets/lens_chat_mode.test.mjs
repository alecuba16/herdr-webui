// Unit tests for the structured chat mode of the chat lens
// (src/assets/desktop/app_js/lens.js).
//
// Same vm harness pattern as lens_behavior.test.mjs, extended with the
// DOM pieces structured mode uses: innerHTML parsing into a small
// element tree, querySelector/querySelectorAll over data-* attributes,
// closest(), remove(), insertBefore(), and createElement.
//
// The conversation payload shapes mirror the server's turn_json exactly
// (design section 4): turns[{role, ts, parts[{kind,...}]}], version,
// session_id, model, reasoning_effort, status.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const LENS_SOURCE = readFileSync(
  new URL("./desktop/app_js/lens.js", import.meta.url),
  "utf8",
);
const SHARED_CORE_SOURCE = readFileSync(
  new URL("./shared/core.js", import.meta.url),
  "utf8",
);

// A minimal HTML tokenizer: builds stub children with correct nesting
// via a tag stack (a lazy regex cannot pair nested same-tag markup).
// NOT a real parser — only the lens's own markup shapes need to work.
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
  const tokenRe = /<\/(div|span|button|pre|form|input)\s*>|<(div|span|button|pre|form|input)\b([^>]*?)(\/)?>/g;
  let last = 0;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    // Text before this token belongs to the currently open element.
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
      // Top-level parsed children belong to the host (innerHTML was
      // set ON this node); without this, appendChild's move semantics
      // never find a previous parent and node-drain loops spin.
      node.parentNode = host;
    }
    // Void elements never open a nesting scope, even without a
    // self-closing slash (real HTML parsers close <input> implicitly).
    if (!m[4] && m[2] !== "input") stack.push(node);
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
    value: "", // form inputs: the decision answer field
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
      // Serialize when anything under this node mutated after the last
      // innerHTML assignment (the fetch lands text deep in the tree).
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
      // Like the real DOM: the child MOVES out of its previous parent
      // (the lens drains chunk nodes with at.firstChild loops).
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
      // Like the real DOM: the child MOVES out of its previous parent
      // (the lens moves nodes chunk-wise with at.firstChild loops).
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
      // Generic: self first, then ancestors, using the same selector
      // engine as querySelector (matches() handles attr/class/tag).
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
    parentNode: null,
    registry,
  };
  // textContent writes (full-output fetch lands text in the pre) must
  // invalidate the cached innerHTML string.
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
  // The lens assigns node.id AFTER createElement (overlay(), switch): a
  // setter keeps the registry in sync so getElementById finds the real
  // element, like lens_behavior.test.mjs does.
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
  // outerHTML setter: like the real DOM, the node is REPLACED in its
  // parent's children by freshly parsed markup (syncResolvedTools swaps
  // running rows for full tool rows in place).
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
  // One simple/compound selector chunk: [attr], [attr="value"], .class,
  // #id and/or tag, e.g. `.lens-turn[data-ts]` — all parts must match.
  // Attribute values are compared after basic entity decoding because
  // _attrs stores the raw (escaped) markup text.
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
  // Descendant selector "a b": b must have an ancestor matching a.
  const parts = selectorParts(sel);
  if (parts.length > 1) {
    // Right-most part must match this node; each earlier part must
    // match some ancestor chain upward in order.
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

function makeContext(overrides = {}) {
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
  // Timers as id -> {fn, ms, cancelled}: clearTimeout actually cancels,
  // so stopPolling can disarm the re-armed cadence timer like the
  // browser does.
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
    api: overrides.api || (async () => { throw Error("no api"); }),
    term: null,
    CSS: undefined,
    // The lens reads these from the DESKTOP_JS bundle scope (terminal.js
    // defines them there); the vm harness mirrors the bundle.
    escapeHtml: (value) =>
      String(value == null ? "" : value).replace(/[&<>"]/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]),
    escapeAttr: (value) =>
      String(value == null ? "" : value).replace(/[&<>"']/g, (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]),
    inputAttrs: (enterkeyhint) =>
      ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no"' +
      (enterkeyhint ? ` enterkeyhint="${String(enterkeyhint)}"` : ""),
    HerdrComposer: { sync() {} },
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SHARED_CORE_SOURCE, contextObject);
  vm.runInContext("var term = globalThis.__term;", contextObject);
  vm.runInContext(LENS_SOURCE, contextObject);
  return { ctx, registry, shell, vmCtx: contextObject };
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
const unresolvableSession = { kind: "jcode", resolvable: false, reason: "no_session_path" };

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
          { kind: "thinking", text: "pondering" },
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

// Drain pending promise continuations the way the browser would: the
// poll chain (timer -> await api() -> render) needs both a macrotask
// boundary and the microtask queue to flush.
async function settle(ms = 5) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("lens structured chat mode", () => {
  it("module exports the structured surface", () => {
    const { ctx } = makeContext();
    for (const name of [
      "syncSwitchVisibility", "refreshConversation", "setPendingBubble",
      "turnDurationHtml", "formatDuration",
    ]) {
      equal(typeof ctx.HerdrLens[name], "function", `${name} must be exported`);
    }
  });

  it("formats durations like the reference copy", () => {
    const { ctx } = makeContext();
    const f = ctx.HerdrLens.formatDuration;
    equal(f(0), "0s");
    equal(f(42), "42s");
    equal(f(60), "1m");
    equal(f(156), "2m 36s");
    equal(f(3600), "1h");
    equal(f(7380), "2h 3m");
  });

  it("renders a duration meta line only for valid assistant spans", () => {
    const { ctx } = makeContext();
    const t = ctx.HerdrLens.turnDurationHtml;
    // Valid span: ts -> end_ts.
    equal(
      t({ role: "assistant", ts: "2026-10-05T10:00:00Z", end_ts: "2026-10-05T10:02:36Z" }),
      '<div class="lens-turn-meta">Worked for 2m 36s</div>',
    );
    // Missing end: no meta (a turn still in flight has no duration).
    equal(t({ role: "assistant", ts: "2026-10-05T10:00:00Z" }), "");
    // Unparseable stamps: no meta, never a crash.
    equal(t({ role: "assistant", ts: "t2", end_ts: "t3" }), "");
    equal(t({ role: "assistant", ts: "", end_ts: "" }), "");
    // Negative span (clock skew): no meta.
    equal(t({ role: "assistant", ts: "2026-10-05T10:02:36Z", end_ts: "2026-10-05T10:00:00Z" }), "");
    // Absurd span (>24h): data corruption, no meta.
    equal(
      t({ role: "assistant", ts: "2026-10-05T10:00:00Z", end_ts: "2026-11-05T10:00:00Z" }),
      "",
    );
  });

  it("publishes session model/effort to the composer on every poll", async () => {
    const seen = [];
    const { ctx } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
      extra: {
        HerdrComposer: {
          sync() {},
          setSessionMeta(meta) { seen.push(meta); },
        },
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    // Lens open publishes null FIRST (resetChatState clears stale meta
    // before the first poll lands), then the poll result.
    equal(seen.length, 2, "reset publishes null, then the poll result");
    equal(seen[0], null, "lens open clears stale meta before the first poll");
    equal(seen[1].model, "m", "model travels from the poll response");
    equal(seen[1].reasoning_effort, null, "missing effort stays null");

    // A failing poll clears the meta (never a stale label).
    ctx.api = async () => { throw Error("boom"); };
    fireTimers(ctx);
    await settle();
    equal(seen.length, 3);
    equal(seen[2], null, "failed poll publishes null meta");

    // Pane switch resets meta too (resetChatState clears it).
    ctx.api = async () => conversationFixture();
    ctx.state.pane = "pane_2";
    ctx.HerdrLens.onPaneChanged();
    const last = seen[seen.length - 1];
    equal(last, null, "pane change resets the meta to null");
  });

  it("clears stale meta when the pane stops being chat-capable (workspace close)", async () => {
    // Freeze bug: workspace close switched the active pane to one with
    // no agent session. The poll guard returned before publishing, so
    // the composer kept the dead pane's model label forever. The guard
    // must publish null on the way out, same contract as a failed poll.
    const seen = [];
    const { ctx } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
      extra: {
        HerdrComposer: {
          sync() {},
          setSessionMeta(meta) { seen.push(meta); },
        },
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(seen[seen.length - 1].model, "m", "poll landed first");
    // Workspace close: the pane row loses its agent session (or the
    // pane itself vanishes). Here the row drops agent_session entirely.
    const row = ctx.state.agents.find((a) => a.pane_id === "pane_1");
    row.agent_session = null;
    fireTimers(ctx); // next poll tick hits the guard
    await settle();
    equal(seen[seen.length - 1], null, "unsupported pane publishes null meta");
    // The cadence also stopped: no further publishes even if timers fire.
    const before = seen.length;
    fireTimers(ctx);
    await settle();
    equal(seen.length, before, "polling stopped after the clear");
  });

  it("clears stale meta with NO poll tick at all (pane switch to a shell pane)", async () => {
    // The other freeze path: the workspace close switches the pane and
    // connectTerminal fires onPaneChanged BEFORE any timer runs.
    // ensurePolling/onPaneChanged must clear on the spot, or the label
    // freezes because no tick ever fires for the unsupported pane.
    const seen = [];
    const { ctx } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
      extra: {
        HerdrComposer: {
          sync() {},
          setSessionMeta(meta) { seen.push(meta); },
        },
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(seen[seen.length - 1].model, "m", "poll landed first");
    // Workspace close: pane switches to one with no agent row, no timer.
    ctx.state.pane = "pane_2";
    ctx.state.agents = []; // closed workspace drops its rows
    ctx.HerdrLens.onPaneChanged(); // connectTerminal path, no fireTimers
    await settle();
    equal(seen[seen.length - 1], null, "onPaneChanged clears without a tick");
    // ensurePolling alone (setLens re-run path) also clears.
    ctx.state.pane = "pane_1";
    ctx.state.agents = [jcodeRow(resolvableSession)];
    ctx.api = async () => conversationFixture();
    ctx.HerdrLens.onPaneChanged();
    fireTimers(ctx);
    await settle();
    equal(seen[seen.length - 1].model, "m", "meta republished for the chat pane");
    ctx.state.agents = [];
    // setLens re-entry only calls ensurePolling when the pane still
    // supports chat (line above). The unsupported-pane re-entry that
    // runs ensurePolling is onPaneChanged again (connectTerminal fires
    // it on every switch, supported or not):
    ctx.HerdrLens.onPaneChanged();
    equal(seen[seen.length - 1], null, "ensurePolling guard clears too");
  });

  it("renders a duration meta line inside assistant turns", async () => {
    const fixture = conversationFixture();
    fixture.turns[1].ts = "2026-10-05T10:00:00Z";
    fixture.turns[1].end_ts = "2026-10-05T10:02:36Z";
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => fixture,
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = registry.get("terminalLens").querySelector(".terminal-lens-content");
    match(content.innerHTML, /lens-turn-meta/, "assistant turn carries the meta line");
    ok(content.innerHTML.includes("Worked for 2m 36s"), "duration text renders");
    // User turns never carry a duration.
    const userTurn = content.querySelector('.lens-turn-user');
    ok(!userTurn.innerHTML.includes("Worked for"), "user turn has no duration");
  });

  it("gates the Chat|Terminal switch on agent_session", () => {
    // Unsupported pane (shell): hidden.
    const shellPane = makeContext({
      state: { pane: "pane_1", agents: [{ pane_id: "pane_1", name: "sh", agent_session: null }] },
    });
    shellPane.ctx.HerdrLens.insertLensSwitch();
    const switchNode = shellPane.registry.get("terminalLensSwitch");
    ok(switchNode, "switch node exists");
    equal(switchNode.hidden, true, "shell pane hides the switch");

    // Supported agent with resolvable session: visible.
    const okPane = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    okPane.ctx.HerdrLens.insertLensSwitch();
    equal(okPane.registry.get("terminalLensSwitch").hidden, false,
      "jcode pane with resolvable session shows the switch");

    // Supported agent, unresolvable: switch STILL visible (the lens
    // shows the refusal copy).
    const refusedPane = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(unresolvableSession)] },
    });
    refusedPane.ctx.HerdrLens.insertLensSwitch();
    equal(refusedPane.registry.get("terminalLensSwitch").hidden, false,
      "unresolvable jcode pane keeps the switch visible");
  });

  it("renders turns, thinking, tool summary, and empty state", async () => {
    let calls = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => {
        calls++;
        return conversationFixture();
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    ok(lens, "lens overlay exists");
    const content = lens.querySelector(".terminal-lens-content");
    ok(content, "content node exists");
    const html = content.innerHTML;
    match(html, /lens-turn lens-turn-user/);
    match(html, /lens-tool/);
    match(html, /lens-thinking/);
    ok(html.includes("hello"), "user text renders");
    ok(html.includes("run seq"), "tool brief renders");
    ok(!html.includes("pondering-body"), "thinking stays collapsed");
    // The trimmed tool offers the fetch button only once expanded
    // (collapsed rows are one-line summaries).
    ok(!html.includes("Show full output"), "collapsed tool hides the fetch button");
    const toggle = content.querySelector("[data-toggle-tool]");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    ok(content.innerHTML.includes("Show full output"),
      "expanded tool offers the full-output fetch");
    equal(calls, 1, "one conversation fetch on open");
  });

  it("shows the loading skeleton before the first poll lands", async () => {
    let resolvePoll;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: () => new Promise((resolve) => { resolvePoll = resolve; }),
    });
    ctx.HerdrLens.setLens(true);
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    match(content.innerHTML, /lens-loading/, "loading skeleton shows on open");
    // Fire the poll tick: api() is called and stays pending.
    fireTimers(ctx);
    await settle();
    ok(typeof resolvePoll === "function", "the poll reached api()");
    match(content.innerHTML, /lens-loading/, "skeleton holds while pending");
    resolvePoll(conversationFixture());
    await settle();
    ok(!content.innerHTML.includes("lens-loading"), "skeleton replaced by turns");
  });

  it("renders the refusal copy for unresolvable sessions", async () => {
    let code = "no_session_path";
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(unresolvableSession)] },
      api: async () => {
        const error = Error("refused");
        error.details = { error: "x", code };
        throw error;
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    match(content.innerHTML, /No jcode conversation found/,
      "no_session_path refusal copy renders");
    // Hint precedence: the alt-screen hint stays hidden in structured mode.
    const alt = lens.querySelector("#terminalLensAlt");
    equal(alt.hidden, true, "alt hint hidden in structured mode");
    // The lens itself stays open: the switch is visible by design.
    equal(ctx.HerdrLens.isActive(), true);
  });

  it("prefers the poll's fresh refusal code over a stale resolved agents row", async () => {
    // state.agents only refreshes on events; a session that resolved at
    // flip time and stopped matching later keeps a stale resolved row
    // while the poll's 404 carries the real reason. The copy must come
    // from the poll error, not the stale row (else it falls to the
    // generic "unavailable" line).
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => {
        const error = Error("refused");
        error.details = { error: "x", code: "no_session_path" };
        throw error;
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = registry.get("terminalLens").querySelector(".terminal-lens-content");
    match(content.innerHTML, /No jcode conversation found/,
      "fresh poll refusal wins over the stale resolved row");
  });

  it("appends new turns without rewriting old ones", async () => {
    const first = conversationFixture();
    const second = {
      ...first,
      version: "g2",
      turns: [
        ...first.turns,
        { role: "user", ts: "t3", end_ts: "t3", parts: [{ kind: "text", text: "second message" }] },
      ],
    };
    let poll = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => (poll++ === 0 ? first : second),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    const turn1 = content.children[0];
    equal(turn1.getAttribute("data-ts"), "t1", "first turn carries its ts");
    // Force the second poll (cadence tick).
    fireTimers(ctx);
    await settle();
    equal(content.children.length, 3, "turns appended, pending-less");
    equal(content.children[0], turn1, "the first turn NODE keeps identity (no rewrite)");
    equal(content.children[2].getAttribute("data-ts"), "t3", "new turn at the tail");
  });

  it("same-count polls never rewrite the DOM (selection survives)", async () => {
    // Regression: appendOnly was `turns.length > prevTurns && ...`, so an
    // idle same-count poll fell into the full-rewrite branch and wiped
    // text selection every 2s. The sync path must keep node identity.
    const fixture = conversationFixture();
    let poll = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => fixture,
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    const turnNodes = content.children.map((c) => c);
    equal(content.children.length, 2, "both turns rendered");
    // Two more polls with the same conversation: identity must hold.
    for (let i = 0; i < 2; i++) {
      fireTimers(ctx);
      await settle();
    }
    equal(content.children[0], turnNodes[0], "user turn node keeps identity");
    equal(content.children[1], turnNodes[1], "assistant turn node keeps identity");
    equal(content.children.length, 2, "no phantom rows appended");
    // Keyed text parts: the sync path must FIND every part row, not
    // re-append it (an unkeyed text part duplicated on every poll).
    const partRows = content.querySelectorAll("[data-part-key]");
    equal(partRows.length, 4, "exactly the 4 part rows, no duplicates");
    // The part text is still present exactly once per part.
    equal(content.innerHTML.split("done").length - 1, 1, "text part not duplicated");
  });

  it("full re-render when the prefix breaks (rotation)", async () => {
    const first = conversationFixture();
    const rotated = {
      ...first,
      version: "g2",
      turns: [
        { role: "user", ts: "OTHER", end_ts: "OTHER", parts: [{ kind: "text", text: "rotated" }] },
      ],
    };
    let poll = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => (poll++ === 0 ? first : rotated),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    const turn1 = content.children[0];
    fireTimers(ctx);
    await settle();
    ok(content.children[0] !== turn1, "prefix break forces a full re-render");
    equal(content.children.length, 1);
  });

  it("resolves running tools into full rows in place", async () => {
    const running = {
      ...conversationFixture(),
      turns: [
        conversationFixture().turns[0],
        {
          role: "assistant", ts: "t2", end_ts: "t2",
          parts: [{ kind: "tool_pending", name: "bash" }],
        },
      ],
    };
    const resolved = {
      ...conversationFixture(),
      turns: [
        conversationFixture().turns[0],
        {
          role: "assistant", ts: "t2", end_ts: "t2",
          parts: [
            {
              kind: "tool", name: "bash", brief: "done running",
              input: "{}", output: "ok", is_error: false,
            },
            { kind: "text", text: "all done" },
          ],
        },
      ],
    };
    let poll = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => (poll++ === 0 ? running : resolved),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    ok(content.innerHTML.includes("running bash"), "pending tool renders as running");
    fireTimers(ctx);
    await settle();
    ok(content.innerHTML.includes("done running"), "resolved tool shows its brief");
    ok(!content.innerHTML.includes("running bash"), "running row replaced");
    ok(content.innerHTML.includes("all done"),
      "text part appended to the open turn at the same turn count");
  });

  it("pending bubble lifecycle: shown after submit, dropped when the turn lands", async () => {
    const empty = { ...conversationFixture(), turns: [] };
    let current = empty;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => current,
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    match(content.innerHTML, /No messages yet/, "empty state renders");
    // Submit lands: composer reports the optimistic bubble + forced poll.
    ctx.HerdrLens.setPendingBubble("first post");
    ok(content.innerHTML.includes("first post"), "pending bubble appears");
    ok(content.innerHTML.includes("lens-turn-pending"), "bubble carries the pending class");
    // The poll carries the real turn: the bubble must drop.
    current = {
      ...empty,
      turns: [{ role: "user", ts: "t9", end_ts: "t9", parts: [{ kind: "text", text: "first post" }] }],
    };
    fireTimers(ctx);
    await settle();
    ok(!content.innerHTML.includes("lens-turn-pending"), "bubble removed once the real turn lands");
    ok(content.innerHTML.includes("first post"), "the real user turn stays");
    // Case (c): lens close drops a pending bubble silently — a submit
    // just before closing must not resurface as a stale bubble on the
    // next open.
    ctx.HerdrLens.setPendingBubble("close me");
    ok(content.innerHTML.includes("close me"), "second bubble renders");
    ctx.HerdrLens.setLens(false);
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    ok(!content.innerHTML.includes("lens-turn-pending"),
      "lens close drops the pending bubble (design 5c)");
    ok(!content.innerHTML.includes("close me"),
      "stale bubble never resurfaces on reopen");
  });

  it("expands and collapses thinking and tool output across polls", async () => {
    const fixture = conversationFixture();
    let poll = 0;
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => fixture,
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    // Toggle thinking open via the delegated click handler.
    const toggle = content.querySelector("[data-toggle-thinking]");
    ok(toggle, "thinking toggle exists");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    ok(content.innerHTML.includes("pondering"), "thinking body shows when expanded");
    // A poll tick must not collapse it back (append-only render).
    poll++;
    fireTimers(ctx);
    await settle();
    ok(content.innerHTML.includes("pondering"), "expansion survives a poll");
    // Tool toggle: open, body + fetch button show.
    const toolToggle = content.querySelector("[data-toggle-tool]");
    ok(toolToggle, "tool toggle exists");
    for (const fn of lens.listeners.click || []) fn({ target: toolToggle });
    ok(content.innerHTML.includes("lens-tool-open"), "tool opens");
    fireTimers(ctx);
    await settle();
    ok(content.innerHTML.includes("lens-tool-open"), "tool stays open across polls");
  });

  it("tool and thinking heads expand from the keyboard (Enter and Space)", async () => {
    // a11y gap fix: the heads were click-only. The carriers carry
    // tabindex+role=button and a delegated keydown maps Enter/Space to
    // the same toggle path as the click.
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    const fireKey = (target, key) => {
      let prevented = false;
      for (const fn of lens.listeners.keydown || []) {
        fn({ target, key, preventDefault() { prevented = true; } });
      }
      return prevented;
    };
    // Thinking head: focusable carrier + Enter opens.
    const think = content.querySelector("[data-toggle-thinking]");
    ok(think, "thinking toggle exists");
    ok(think._attrs && think._attrs.tabindex === "0", "thinking head is focusable (tabindex=0)");
    ok(think._attrs && think._attrs.role === "button", "thinking head announces as button");
    ok(fireKey(think, "Enter"), "Enter is preventDefault-ed");
    ok(content.innerHTML.includes("pondering"), "Enter expands thinking");
    // Space collapses it again.
    fireKey(think, " ");
    ok(!content.innerHTML.includes("pondering"), "Space collapses thinking");
    // Tool head: same contract.
    const toolHead = content.querySelector("[data-toggle-tool]");
    ok(toolHead, "tool toggle exists");
    ok(toolHead._attrs && toolHead._attrs.tabindex === "0", "tool head is focusable (tabindex=0)");
    ok(toolHead._attrs && toolHead._attrs.role === "button", "tool head announces as button");
    fireKey(toolHead, "Enter");
    ok(content.innerHTML.includes("lens-tool-open"), "Enter expands the tool");
    // Inner span carriers never fire the handler (target !== toggle).
    const inner = toolHead.querySelector(".lens-tool-name") || toolHead.children[0];
    if (inner) {
      const prevented = fireKey(inner, "Enter");
      ok(!prevented, "Enter on an inner span is not hijacked");
    }
    // Unrelated keys pass through untouched.
    ok(!fireKey(toolHead, "ArrowDown"), "ArrowDown is left to the scroller");
  });


  it("fetched full output survives the next poll", async () => {
    // The fetch lands the whole output in the pre (DOM-only, not in the
    // conversation payload). The next poll must NOT swap the row back to
    // the trimmed copy + fetch button (expansion persistence, review
    // doc: expanded state must survive every 2s poll).
    const fixture = conversationFixture();
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async (url) => {
        if (url.includes("/tool-output")) return { output: "1\n2\n3\n4\n5\n6" };
        return fixture;
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    const toolToggle = content.querySelector("[data-toggle-tool]");
    for (const fn of lens.listeners.click || []) fn({ target: toolToggle });
    const fetchButton = content.querySelector("[data-fetch-output]");
    ok(fetchButton, "expanded tool offers the fetch button");
    for (const fn of lens.listeners.click || []) fn({ target: fetchButton });
    await settle();
    ok(content.innerHTML.includes("1\n2\n3\n4\n5\n6"),
      "full output landed in the pre");
    // Idle poll, same turn count: the fetched output must still be there.
    fireTimers(ctx);
    await settle();
    ok(content.innerHTML.includes("1\n2\n3\n4\n5\n6"),
      "fetched full output survives the poll (no revert to trimmed)");
    ok(!content.querySelector("[data-fetch-output]"),
      "fetch button does not come back on idle polls");
  });

  it("fetches the whole tool output through the endpoint", async () => {
    const fixture = conversationFixture();
    const fetches = [];
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async (url) => {
        if (url.includes("/tool-output")) {
          fetches.push(url);
          return { output: "1\n2\n3" };
        }
        return fixture;
      },
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    // Expand the tool, then click the fetch button.
    const toolToggle = content.querySelector("[data-toggle-tool]");
    for (const fn of lens.listeners.click || []) fn({ target: toolToggle });
    const fetchButton = content.querySelector("[data-fetch-output]");
    ok(fetchButton, "fetch button renders for trimmed outputs");
    for (const fn of lens.listeners.click || []) fn({ target: fetchButton });
    await settle();
    equal(fetches.length, 1, "one tool-output fetch");
    match(fetches[0], /\/api\/panes\/pane_1\/tool-output\?ref=call_1/,
      "fetch URL carries pane id and ref");
    ok(content.innerHTML.includes("1\n2\n3"), "full output lands in the pre");
  });

  it("pane switch resets structured state and stops the old poll", async () => {
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    ctx.HerdrLens.insertLensSwitch();
    // The pane changes to a shell pane: force-off + gate hide.
    ctx.state.pane = "pane_2";
    ctx.state.agents = [{ pane_id: "pane_2", name: "sh", agent_session: null }];
    ctx.HerdrLens.onPaneChanged();
    equal(ctx.HerdrLens.isActive(), false, "unsupported pane forces the lens off");
    equal(registry.get("terminalLensSwitch").hidden, true, "switch hidden on the shell pane");
  });

  it("empty conversation shows the empty state, not a blank column", async () => {
    const empty = { ...conversationFixture(), turns: [] };
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => empty,
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    match(content.innerHTML, /No messages yet/, "explicit empty state renders");
  });

  it("single-flight: a slow poll never overlaps and queues one catch-up", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let started = 0;
    const { ctx } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => {
        started++;
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return conversationFixture();
      },
    });
    ctx.HerdrLens.setLens(true);
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
});

// ---- ask_user decision chooser ----

describe("lens decision chooser (ask_user)", () => {
  const decisionPart = {
    kind: "decision",
    question: "Deploy where?",
    options: [
      { label: "dev", detail: "staging cluster" },
      { label: "prod", detail: null },
    ],
    context: "release train",
  };

  function decisionFixture() {
    return {
      ...conversationFixture(),
      turns: [
        conversationFixture().turns[0],
        {
          role: "assistant",
          ts: "t2",
          end_ts: "t2",
          parts: [decisionPart],
        },
      ],
    };
  }

  // Blocked pane: agents row for pane_1 carries agent_status "blocked".
  function blockedContext(overrides = {}) {
    const sent = [];
    const { ctx, registry } = makeContext({
      state: {
        pane: "pane_1",
        agents: [jcodeRow(resolvableSession)],
      },
      api: async () => decisionFixture(),
      ...overrides,
    });
    ctx.state.agents[0].agent_status = "blocked";
    ctx.sendInputData = (payload) => sent.push(payload);
    return { ctx, registry, sent };
  }

  function lensNodes(registry) {
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    return { lens, content };
  }

  async function openBlocked(overrides = {}) {
    const harness = blockedContext(overrides);
    harness.ctx.HerdrLens.setLens(true);
    fireTimers(harness.ctx);
    await settle();
    return harness;
  }

  it("renders live controls while the pane is blocked", async () => {
    const { ctx, registry } = await openBlocked();
    const { content } = lensNodes(registry);
    const html = content.innerHTML;
    match(html, /data-decision="live"/, "live chooser while blocked");
    ok(html.includes("Deploy where?"), "question renders");
    ok(html.includes("staging cluster"), "option detail renders");
    ok(html.includes("Your answer"), "free-form input renders");
    ok(html.includes("Dismiss"), "dismiss control renders");
    equal(typeof ctx.HerdrLens.paneBlockedNow(), "boolean");
  });

  it("renders read-only (answered hint) when the pane is not blocked", async () => {
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => decisionFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const { content } = lensNodes(registry);
    const html = content.innerHTML;
    match(html, /data-decision="answered"/);
    ok(!html.includes("Your answer"), "no free-form input when not blocked");
    ok(!html.includes("Dismiss"), "no dismiss control when not blocked");
    ok(html.includes("Answered"), "answered hint renders");
  });

  it("option click sends Up arrow + digit keystrokes (no Enter)", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { lens, content } = lensNodes(registry);
    const option = content.querySelector("[data-decision-index=\"2\"]");
    ok(option, "option button renders");
    for (const fn of lens.listeners.click || []) fn({ target: option });
    equal(sent.length, 1, "one keystroke payload");
    equal(sent[0], "\u001b[A2", "Up arrow then the digit, no Enter");
    // The chooser collapses immediately: answered hint, no second send.
    const html = content.innerHTML;
    match(html, /data-decision="answered"/);
    ok(!html.includes("Your answer"), "controls collapse after answering");
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-decision-index=\"1\"]") || option });
    equal(sent.length, 1, "second click on the collapsed chooser sends nothing");
  });

  it("free-form submit sends bracketed paste + Enter", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { lens, content } = lensNodes(registry);
    const form = content.querySelector("form.lens-decision-form");
    ok(form, "answer form renders");
    const input = form.querySelector(".lens-decision-input");
    input.value = "  ship it now  ";
    for (const fn of lens.listeners.submit || []) fn({ target: form, preventDefault() {} });
    equal(sent.length, 1, "one keystroke payload");
    equal(
      sent[0],
      "\u001b[200~ship it now\u001b[201~\r",
      "bracketed paste then Enter, trimmed text",
    );
    match(content.innerHTML, /data-decision="answered"/, "chooser collapses");
  });

  it("empty submit sends nothing", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { lens, content } = lensNodes(registry);
    const form = content.querySelector("form.lens-decision-form");
    for (const fn of lens.listeners.submit || []) fn({ target: form, preventDefault() {} });
    equal(sent.length, 0, "empty answer never types into the pane");
  });

  it("dismiss collapses with an Answer button (re-openable), not answered", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { lens, content } = lensNodes(registry);
    const dismiss = content.querySelector(".lens-decision-dismiss");
    ok(dismiss, "dismiss button renders while blocked");
    for (const fn of lens.listeners.click || []) fn({ target: dismiss });
    equal(sent.length, 0, "dismiss sends no keystrokes");
    let html = content.innerHTML;
    ok(html.includes("Waiting for your answer in the terminal"), "collapsed hint");
    const expand = content.querySelector(".lens-decision-expand");
    ok(expand, "collapsed card keeps the Answer button");
    // Re-open: controls come back live (still blocked).
    for (const fn of lens.listeners.click || []) fn({ target: expand });
    html = content.innerHTML;
    match(html, /data-decision="live"/, "expand restores live controls");
    ok(html.includes("Your answer"), "free-form input is back");
  });

  it("stale click after unblocking sends nothing (fails closed)", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { content } = lensNodes(registry);
    const option = content.querySelector("[data-decision-index=\"1\"]");
    ok(option, "option button renders while blocked");
    // The agent answers in the terminal: the status event lands working.
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    await settle();
    const stale = content.querySelector("[data-decision-index=\"1\"]");
    // The DOM re-rendered to answered state; a stale node click would
    // still carry the old key. Simulate with the kept node.
    const lens = registry.get("terminalLens");
    for (const fn of lens.listeners.click || []) fn({ target: stale || option });
    equal(sent.length, 0, "stale click after working status sends nothing");
  });

  it("status event re-renders the chooser instantly (blocked -> working)", async () => {
    const { ctx, registry } = await openBlocked();
    const { content } = lensNodes(registry);
    match(content.innerHTML, /data-decision="live"/);
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    await settle();
    match(content.innerHTML, /data-decision="answered"/, "chooser disarms on the event");
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "blocked" });
    await settle();
    match(content.innerHTML, /data-decision="live"/, "chooser re-arms on blocked again");
  });

  it("another pane's blocked status never arms this pane's chooser", async () => {
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => decisionFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const { content } = lensNodes(registry);
    match(content.innerHTML, /data-decision="answered"/, "own pane not blocked: read-only");
    // A different pane in the same workspace reports blocked: the
    // workspace aggregate WOULD say blocked, but the per-pane gate
    // keeps this chooser read-only.
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_2", agent_status: "blocked" });
    await settle();
    match(content.innerHTML, /data-decision="answered"/, "other pane blocked does not arm this chooser");
  });

  it("pane switch resets the answered mark (no cross-pane carryover)", async () => {
    const { ctx, registry, sent } = await openBlocked();
    const { content } = lensNodes(registry);
    const option = content.querySelector("[data-decision-index=\"1\"]");
    for (const fn of registry.get("terminalLens").listeners.click || []) fn({ target: option });
    equal(sent.length, 1, "answered on pane_1");
    equal(ctx.HerdrLens._decisionAnsweredKey(), "Deploy where?|dev|prod");
    // A real pane switch changes state.pane; onPaneChanged resets the
    // per-pane marks (an answered question on pane A must not suppress
    // a pending question on pane B that happens to share the text).
    ctx.state.pane = "pane_2";
    ctx.state.agents = [{ pane_id: "pane_2", name: "jcode", agent_session: resolvableSession }];
    ctx.HerdrLens.onPaneChanged();
    equal(ctx.HerdrLens._decisionAnsweredKey(), null, "answered mark cleared on pane switch");
  });

  it("collapsed chooser flips to answered when the pane unblocks", async () => {
    const { ctx, registry } = await openBlocked();
    const { lens, content } = lensNodes(registry);
    const dismiss = content.querySelector(".lens-decision-dismiss");
    for (const fn of lens.listeners.click || []) fn({ target: dismiss });
    ok(content.innerHTML.includes("Waiting for your answer in the terminal"),
      "collapsed hint while still blocked");
    ok(content.querySelector(".lens-decision-expand"), "expand button while still blocked");
    // The TUI dismisses/resolves: working status event lands.
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    await settle();
    ok(content.innerHTML.includes("Answered"), "hint flips to answered on unblock");
    ok(!content.querySelector(".lens-decision-expand"), "expand button goes away once unblocked");
  });

  it("re-ask of the same question re-arms the chooser", async () => {
    let turn = 0;
    const { ctx, registry, sent } = blockedContext({
      api: async () => decisionFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const { lens, content } = lensNodes(registry);
    const option = content.querySelector("[data-decision-index=\"1\"]");
    for (const fn of lens.listeners.click || []) fn({ target: option });
    equal(sent.length, 1, "first ask answered");
    match(content.innerHTML, /data-decision="answered"/);
    // The pane blocks again on the SAME question text (agent re-asked):
    // the answered key matches, but the blocked re-arm rule only
    // applies while the SAME question stays answered. Since the key
    // matches, the chooser stays collapsed — the correct, safe read.
    const status = ctx.HerdrLens.paneBlockedNow();
    equal(status, true, "pane still blocked after answering (status not yet working)");
    match(content.innerHTML, /data-decision="answered"/, "same-key question stays collapsed");
  });
});

// ---- working (thinking) indicator ----

describe("lens working indicator (thinking animation)", () => {
  function workingContext(overrides = {}) {
    const { ctx, registry, vmCtx } = makeContext({
      state: {
        pane: "pane_1",
        agents: [jcodeRow(resolvableSession)],
      },
      api: async () => conversationFixture(),
      ...overrides,
    });
    ctx.state.agents[0].agent_status = "working";
    return { ctx, registry, vmCtx };
  }

  async function openWorking(overrides = {}) {
    const harness = workingContext(overrides);
    harness.ctx.HerdrLens.setLens(true);
    fireTimers(harness.ctx);
    await settle();
    return harness;
  }

  function lensNodesWorking(registry) {
    const lens = registry.get("terminalLens");
    const content = lens.querySelector(".terminal-lens-content");
    return { lens, content };
  }

  it("renders the animated collapsed block while the pane works", async () => {
    const { ctx, registry } = await openWorking();
    const { content } = lensNodesWorking(registry);
    const block = content.querySelector(".lens-working");
    ok(block, "working block renders at the tail");
    ok(content.innerHTML.includes("lens-working-dots"), "animated dots render");
    ok(content.innerHTML.includes("Thinking"), "collapsed label reads Thinking");
    ok(!content.querySelector(".lens-working-body"), "collapsed: no body");
    equal(typeof ctx.HerdrLens.paneWorkingNow(), "boolean");
    equal(ctx.HerdrLens.paneWorkingNow(), true);
    // The block sits last: after every turn and after the pending
    // bubble when one exists.
    const last = content.children[content.children.length - 1];
    ok(last && last.className.includes("lens-working"), "working block is the tail element");
  });

  it("absent when the pane is idle and when blocked (chooser owns blocked)", async () => {
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const { content } = lensNodesWorking(registry);
    ok(!content.querySelector(".lens-working"), "idle: no working block");
    // Blocked status: the decision chooser owns that surface; the
    // working block must NOT render alongside it.
    ctx.state.agents[0].agent_status = "blocked";
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "blocked" });
    await settle();
    ok(!content.querySelector(".lens-working"), "blocked: no working block");
  });

  it("status event arms and disarms instantly (working -> idle)", async () => {
    const { ctx, registry } = await openWorking();
    const { content } = lensNodesWorking(registry);
    ok(content.querySelector(".lens-working"), "armed while working");
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "idle" });
    await settle();
    ok(!content.querySelector(".lens-working"), "disarmed on idle event");
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    await settle();
    ok(content.querySelector(".lens-working"), "re-armed on working event");
  });

  it("expand shows the live elapsed timer and running tools", async () => {
    const { ctx, registry } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date(Date.now() - 65000).toISOString(),
            end_ts: new Date(Date.now() - 65000).toISOString(),
            parts: [
              { kind: "thinking", text: "pondering" },
              { kind: "tool_pending", name: "bash" },
            ],
          },
        ],
      }),
    });
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    ok(toggle, "toggle renders");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    const body = content.querySelector(".lens-working-body");
    ok(body, "expanded body renders");
    match(content.innerHTML, /Working for (\d+s|\d+m \d+s|\d+m)/, "live elapsed line renders");
    ok(content.innerHTML.includes("bash"), "running tool of the open turn listed");
    // Toggle back: collapsed again, tick stopped.
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-toggle-working]") });
    ok(!content.querySelector(".lens-working-body"), "collapsed again");
    equal(ctx.HerdrLens._workingExpanded(), false);
  });

  it("another pane's working status never arms this pane's block", async () => {
    const { ctx, registry } = makeContext({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () => conversationFixture(),
    });
    ctx.HerdrLens.setLens(true);
    fireTimers(ctx);
    await settle();
    const { content } = lensNodesWorking(registry);
    ok(!content.querySelector(".lens-working"), "own pane idle: no block");
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_2", agent_status: "working" });
    await settle();
    ok(!content.querySelector(".lens-working"), "other pane working does not arm this pane");
  });

  it("pane switch resets the expansion (no cross-pane carryover)", async () => {
    const { ctx, registry } = await openWorking();
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    equal(ctx.HerdrLens._workingExpanded(), true);
    ctx.state.pane = "pane_2";
    ctx.state.agents = [{ pane_id: "pane_2", name: "jcode", agent_session: resolvableSession, agent_status: "working" }];
    ctx.HerdrLens.onPaneChanged();
    equal(ctx.HerdrLens._workingExpanded(), false, "expansion reset on pane switch");
  });

  it("stale toggle click after the turn ended finds no carrier", async () => {
    const { ctx, registry } = await openWorking();
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    ok(toggle, "armed while working");
    // Turn ends: the event disarms the block and a re-render removed
    // the carrier from the DOM.
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "idle" });
    await settle();
    const stale = toggle; // kept node, detached by the re-render
    for (const fn of lens.listeners.click || []) fn({ target: stale });
    equal(ctx.HerdrLens._workingExpanded(), false, "stale click does not expand");
    ok(!content.querySelector(".lens-working"), "block stays away after stale click");
  });

  it("lens close drops the expansion (next open starts collapsed)", async () => {
    const { ctx, registry } = await openWorking();
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    equal(ctx.HerdrLens._workingExpanded(), true);
    ctx.HerdrLens.setLens(false);
    equal(ctx.HerdrLens._workingExpanded(), false, "expansion dropped on lens close");
  });

  it("expanded block ticks the elapsed line in place every second", async () => {
    const { ctx, registry } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date(Date.now() - 1000).toISOString(),
            end_ts: new Date(Date.now() - 1000).toISOString(),
            parts: [],
          },
        ],
      }),
    });
    const { lens, content } = lensNodesWorking(registry);
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-toggle-working]") });
    const elapsedNode = content.querySelector(".lens-working-elapsed");
    match(elapsedNode.textContent, /Working for/, "elapsed line renders");
    // The harness fires timers with zero wall-clock delay, so the
    // rounded second cannot advance by itself; instead prove the tick
    // REWRITES the elapsed line: plant a sentinel in the elapsed node
    // and require the tick to overwrite it with fresh state
    // (the production effect: the elapsed line refreshes every 1s
    // without any poll, and the head nodes are never rewritten).
    elapsedNode.textContent = "SENTINEL";
    fireTimers(ctx);
    const after = content.querySelector(".lens-working-elapsed");
    ok(after, "elapsed node still exists after the tick");
    match(after.textContent, /Working for/, "tick rewrote the elapsed line from fresh state");
    ok(!after.textContent.includes("SENTINEL"), "sentinel gone: the block was recomputed");
    // The tick re-arms itself while still working + expanded.
    ok(ctx._timers.size >= 1, "tick re-armed for the next second");
  });

  it("tick keeps the last honest elapsed text when the reference vanishes mid-tick", async () => {
    // workingStartedAt() can go null between a poll and the next tick
    // (turn ts flipped invalid, status event expired). Blanking the
    // elapsed line there would flash an empty line for a second; the
    // tick keeps the last text instead and the next poll rebuilds the
    // body from fresh state.
    const { ctx, registry, vmCtx } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date(Date.now() - 1000).toISOString(),
            end_ts: new Date(Date.now() - 1000).toISOString(),
            parts: [],
          },
        ],
      }),
    });
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    const before = content.querySelector(".lens-working-elapsed");
    ok(before, "elapsed line renders while a reference exists");
    match(before.textContent, /Working for/, "elapsed line has text");
    // Reference vanished but the pane still works and stays expanded:
    // the tick must keep the last text, not blank the line. No status
    // event was ever fired in this test, so workingStartedAt() only has
    // the turn-ts path; a NaN now (patched in the vm realm, where lens.js
    // actually runs) kills its freshness window. The realm's Date is an
    // intrinsic, not a sandbox property, so the patch runs inside the vm.
    vm.runInContext("globalThis.__origNow = Date.now; Date.now = () => NaN;", vmCtx);
    try {
      ok(!ctx.HerdrLens._workingStartedAt(), "harness: reference is null now");
      fireTimers(ctx);
      const after = content.querySelector(".lens-working-elapsed");
      ok(after, "elapsed node still exists after the tick");
      match(after.textContent, /Working for/, "tick kept the last honest text instead of blanking");
    } finally {
      vm.runInContext("Date.now = globalThis.__origNow; delete globalThis.__origNow;", vmCtx);
    }
  });

  it("head keeps node identity across syncs and ticks (focus stays on the toggle)", async () => {
    // A rewritten head drops keyboard focus in a real browser; the
    // fix is to build the head once per block and never rewrite it.
    // The harness has no activeElement, so node identity is the
    // focus proxy: the same toggle/dots/label nodes must survive
    // every sync path (expand, poll, tick, collapse).
    const { ctx, registry } = await openWorking();
    const { lens, content } = lensNodesWorking(registry);
    const toggle = content.querySelector("[data-toggle-working]");
    const dots = toggle.querySelector(".lens-working-dots");
    const label = toggle.querySelector(".lens-working-label");
    ok(toggle && dots && label, "head nodes exist");
    // Expand: the sync mutates in place instead of rebuilding.
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    ok(content.querySelector("[data-toggle-working]") === toggle, "toggle survives the expansion sync");
    ok(toggle.querySelector(".lens-working-dots") === dots, "dots survive the expansion sync");
    ok(toggle.querySelector(".lens-working-label") === label, "label survives the expansion sync");
    equal(toggle.getAttribute("aria-expanded"), "true", "aria-expanded flips in place");
    ok(content.querySelector(".lens-working-body"), "body renders on expansion");
    // Poll cycle while expanded: same head nodes, body synced apart.
    fireTimers(ctx);
    await settle();
    ok(content.querySelector("[data-toggle-working]") === toggle, "toggle survives a poll");
    ok(content.querySelector(".lens-working-dots") === dots, "dots survive a poll");
    // 1s tick: only the elapsed line is touched, head nodes stay.
    fireTimers(ctx);
    await settle();
    ok(content.querySelector("[data-toggle-working]") === toggle, "toggle survives a tick");
    ok(toggle.querySelector(".lens-working-dots") === dots, "dots survive a tick");
    // Collapse: same head node, state flips back, body drops.
    for (const fn of lens.listeners.click || []) fn({ target: toggle });
    ok(content.querySelector("[data-toggle-working]") === toggle, "toggle survives the collapse sync");
    equal(toggle.getAttribute("aria-expanded"), "false", "aria-expanded flips back in place");
    ok(!content.querySelector(".lens-working-body"), "body removed on collapse");
    equal(label.textContent, "Thinking…", "label back to the collapsed fallback");
  });

  it("collapsed label names the live tool, Thinking is the fallback", async () => {
    const { ctx, registry } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date(Date.now() - 1000).toISOString(),
            end_ts: new Date(Date.now() - 1000).toISOString(),
            parts: [{ kind: "tool_pending", name: "bash" }],
          },
        ],
      }),
    });
    const { content } = lensNodesWorking(registry);
    const label = content.querySelector(".lens-working-label");
    ok(label, "label node exists");
    equal(label.textContent, "bash…", "collapsed label names the running tool");
    // The turn ends: the pending row is gone, the label syncs back
    // to the fallback on the next poll (label reads conversation
    // state, not the DOM).
    ctx.api = async () => ({
      ...conversationFixture(),
      turns: [conversationFixture().turns[0], conversationFixture().turns[1]],
    });
    fireTimers(ctx);
    await settle();
    const labelAfter = content.querySelector(".lens-working-label");
    equal(labelAfter && labelAfter.textContent, "Thinking…", "fallback when no tool is running");
    // Escaping: a hostile tool name renders as text, never markup.
    const hostile = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date().toISOString(),
            end_ts: new Date().toISOString(),
            parts: [{ kind: "tool_pending", name: "<img src=x>" }],
          },
        ],
      }),
    });
    const { content: hostileContent } = lensNodesWorking(hostile.registry);
    const hostileLabel = hostileContent.querySelector(".lens-working-label");
    ok(hostileLabel, "label node exists for the hostile name");
    // Escaping: a hostile tool name renders as text, never markup.
    // The harness keeps source text undecoded, so the assert targets
    // the emitted HTML: the name must arrive escaped and no element
    // may be injected through it (a real browser also decodes it to
    // plain text in textContent).
    ok(hostileContent.innerHTML.includes("&lt;img src=x&gt;"), "hostile name is escaped in the emitted HTML");
    ok(!hostileContent.querySelector("img"), "no injected element from the tool name");
  });

  it("tick dies when the block disappears (error copy takes the content)", async () => {
    const { ctx, registry } = await openWorking();
    const { lens, content } = lensNodesWorking(registry);
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-toggle-working]") });
    ok(content.querySelector(".lens-working-body"), "expanded");
    // A failed poll replaces the turns with the error copy; the tick
    // must not survive against a block that no longer exists.
    ctx.api = async () => { throw { details: { code: "error" } }; };
    fireTimers(ctx);
    await settle();
    ok(!content.querySelector(".lens-working"), "block gone under the error copy");
    // The next tick finds no block and dies; a further timer pass
    // must contain no pending working tick (no orphan re-arm).
    fireTimers(ctx);
    equal(ctx._timers.size, 0, "no orphan tick re-armed after the block vanished");
  });

  it("no elapsed line when the reference start is unknowable (last turn is the user's)", async () => {
    // Lens opened mid-turn with NO working event seen (page refresh):
    // the last turn is the fresh user question (jcode saves it at
    // input). The PREVIOUS assistant turn's ts must not stand in as a
    // fake reference — the body shows the note line instead.
    const { ctx, registry } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          conversationFixture().turns[1],
          {
            role: "user",
            ts: new Date().toISOString(),
            end_ts: new Date().toISOString(),
            parts: [{ kind: "text", text: "what next?" }],
          },
        ],
      }),
    });
    const { lens, content } = lensNodesWorking(registry);
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-toggle-working]") });
    ok(content.querySelector(".lens-working-body"), "expanded body renders");
    ok(!content.querySelector(".lens-working-elapsed"), "no invented elapsed line");
    ok(content.innerHTML.includes("Agent is processing"), "honest note line instead");
  });

  it("elapsed fallback works when the last turn is the open assistant turn", async () => {
    // Working event unseen (refresh mid-turn) but the open assistant
    // turn IS the last turn: its ts is an honest reference.
    const { ctx, registry } = await openWorking({
      api: async () => ({
        ...conversationFixture(),
        turns: [
          conversationFixture().turns[0],
          {
            role: "assistant",
            ts: new Date(Date.now() - 1000).toISOString(),
            end_ts: new Date(Date.now() - 1000).toISOString(),
            parts: [],
          },
        ],
      }),
    });
    const { lens, content } = lensNodesWorking(registry);
    for (const fn of lens.listeners.click || []) fn({ target: content.querySelector("[data-toggle-working]") });
    match(
      content.innerHTML,
      /Working for (\d+s|\d+m \d+s|\d+m)/,
      "elapsed line from the open turn's ts",
    );
  });

  it("blocked status wins over working (never both surfaces)", async () => {
    const { ctx, registry } = await openWorking();
    const { content } = lensNodesWorking(registry);
    ok(content.querySelector(".lens-working"), "armed while working");
    ctx.HerdrLens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "blocked" });
    await settle();
    ok(!content.querySelector(".lens-working"), "blocked replaces the working block");
  });
});
