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
  const tokenRe = /<\/(div|span|button|pre)\s*>|<(div|span|button|pre)\b([^>]*?)(\/)?>/g;
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
    if (!m[4]) stack.push(node);
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
    HerdrComposer: { sync() {} },
    ...overrides.extra,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  const contextObject = vm.createContext(ctx);
  vm.runInContext(SHARED_CORE_SOURCE, contextObject);
  vm.runInContext("var term = globalThis.__term;", contextObject);
  vm.runInContext(LENS_SOURCE, contextObject);
  return { ctx, registry, shell };
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
    ]) {
      equal(typeof ctx.HerdrLens[name], "function", `${name} must be exported`);
    }
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
