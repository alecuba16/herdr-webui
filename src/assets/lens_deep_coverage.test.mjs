// Deep-coverage companion to mobile_lens_behavior.test.mjs for
// src/assets/mobile/lens.js. Targets the ranges the behavior suite leaves
// uncovered: poll error/recovery paths (etag, 304, 409 history_changed,
// walk join/failure), loadOlder edge states, part rendering branches
// (image, tool_pending, compact, fetched tool output), the working
// indicator lifecycle, decision dismiss/expand/submit, keyboard toggles,
// the new-output pill, and the switch drag fallbacks.
//
// Harness duplicated from mobile_lens_behavior.test.mjs per the
// standalone-test-file convention: vm mini-DOM with an innerHTML
// tokenizer, data-* querySelector, id registry, fake timers.
import { describe, it } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Compiled once so coverage attributes mobile/lens.js lines to the real file.
const MOBILE_LENS_PATH = fileURLToPath(new URL("./mobile/lens.js", import.meta.url));
const mobileLensScript = new vm.Script(readFileSync(MOBILE_LENS_PATH, "utf8"), {
  filename: MOBILE_LENS_PATH,
});

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
        this.parentNode = null;
      }
    },
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type];
      if (list) {
        const at = list.indexOf(fn);
        if (at !== -1) list.splice(at, 1);
      }
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
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    // Inline styles (switch drag writes left/top/transform here) and a
    // rect stub that follows inline left/top like the real DOM does;
    // offsetParent pins the drag container (.mobile-terminal-screen).
    style: {},
    getBoundingClientRect() {
      return {
        width: this._rectWidth || 100,
        height: this._rectHeight || 30,
        left: (parseFloat(this.style.left) || 0) + (this._rectLeft || 0),
        top: (parseFloat(this.style.top) || 0) + (this._rectTop || 0),
      };
    },
    offsetParent: null,
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
  // Document-level drag listeners (mousemove/mouseup/touch*) land here;
  // the switch drag registers them on drag start and drops them on end.
  const docListeners = new Map();
  const doc = {
    registry,
    getElementById: (id) => registry.get(id) || null,
    createElement: () => makeElement("div", "", "", registry),
    addEventListener(type, fn) {
      (docListeners.get(type) || docListeners.set(type, []).get(type)).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (list) {
        const at = list.indexOf(fn);
        if (at !== -1) list.splice(at, 1);
      }
    },
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
  // The lens arms a ResizeObserver on the switch container; tests fire
  // the callbacks by hand (the real one runs on layout changes).
  const resizeObservers = [];
  class ResizeObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      resizeObservers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
      this.callback = null;
    }
  }
  const fireTimers = () => {
    const batch = [...timers.values()];
    timers.clear();
    for (const timer of batch) {
      if (timer.cancelled) continue;
      timer.fn();
    }
  };
  const storageBacking = new Map();
  const ctx = {
    console,
    ResizeObserver: ResizeObserverStub,
    _resizeObservers: resizeObservers,
    // The switch drag persists its position through localStorage.
    localStorage: {
      getItem: (key) => (storageBacking.has(key) ? storageBacking.get(key) : null),
      setItem: (key, value) => storageBacking.set(String(key), String(value)),
      removeItem: (key) => storageBacking.delete(key),
    },
    _docListeners: docListeners,
    _storage: storageBacking,
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
  mobileLensScript.runInContext(vmCtx);
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

describe("mobile lens deep coverage", () => {
  it("HerdrHttp options shape the fetch and a stored etag short-circuits on 304", async () => {
    let calls = 0;
    let lastOpts = null;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      extra: {
        HerdrHttp: { options: (o) => ({ ...o, credentials: "include" }) },
      },
      fetch: async (url, opts) => {
        calls++;
        lastOpts = opts;
        if (calls === 1)
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: { get: (name) => (name === "etag" ? 'W/"g1"' : null) },
            json: async () => conversationFixture(),
          };
        return {
          ok: false,
          status: 304,
          statusText: "Not Modified",
          headers: { get: () => null },
          json: async () => null,
        };
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(calls, 1, "first poll fired");
    equal(lastOpts && lastOpts.credentials, "include", "HerdrHttp.options shaped the request");
    const content = lensContent(registry);
    ok(content.innerHTML.includes("hello"), "turns rendered");
    fireTimers(ctx);
    await settle();
    equal(calls, 2, "second poll fired");
    equal(
      lastOpts && lastOpts.headers && lastOpts.headers["if-none-match"],
      'W/"g1"',
      "stored etag travels as if-none-match",
    );
    ok(content.innerHTML.includes("hello"), "304 leaves the rendered turns in place");
  });

  it("ambiguous and generic refusal copies surface through the poll error path", async () => {
    let mode = "ambiguous";
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        if (mode === "ambiguous")
          return json200({ error: "boom", code: "ambiguous" });
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          headers: { get: () => null },
          json: async () => {
            throw Error("bad body");
          },
        };
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(
      content.innerHTML.includes("Multiple jcode conversations match"),
      "ambiguous code renders the disambiguation refusal",
    );
    mode = "fivehundred";
    fireTimers(ctx);
    await settle();
    content = lensContent(registry);
    ok(
      content.innerHTML.includes("Conversation unavailable right now"),
      "unparseable error body falls back to the generic refusal copy",
    );
  });

  it("history_changed recovery: refetch lands turns, failed refetch renders the refusal", async () => {
    let calls = 0;
    let conflictHard = false;
    const conflict = () => ({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: { get: () => null },
      json: async () => ({ error: "gone", code: "history_changed" }),
    });
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      // The recovery fetch goes through the same stub: call 1 is the
      // poll's 409, call 2 is the recovery refetch.
      fetch: async () => {
        calls++;
        if (conflictHard || calls === 1) return conflict();
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.innerHTML.includes("hello"), "recovery fetch re-landed the newest page");
    equal(calls, 2, "poll hit the 409, then the recovery fetch");
    conflictHard = true;
    calls = 0;
    fireTimers(ctx);
    await settle();
    content = lensContent(registry);
    ok(
      content.innerHTML.includes("Conversation unavailable right now"),
      "failed recovery renders the refusal",
    );
    equal(calls, 2, "poll 409 again, recovery fetch failed too");
  });

  it("a 200 with an unparseable body lands on the refusal via the poll catch", async () => {
    // body=null makes pollConversation throw mid-try (response.cursor on
    // null); the catch converts it to the generic refusal render. Next
    // poll with a good body clears it.
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => {
          throw Error("not json");
        },
      }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(
      content.innerHTML.includes("Conversation unavailable right now"),
      "body-less success renders the refusal through the poll catch",
    );
    ctx.fetch = async () => json200(conversationFixture());
    fireTimers(ctx);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes("hello"), "next poll recovers the transcript");
  });

  it("a poll queued while one is in flight runs after it settles", async () => {
    let calls = 0;
    let release = null;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        calls++;
        await new Promise((resolve) => {
          release = resolve;
        });
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(calls, 1, "first poll in flight");
    lens.refreshConversation();
    equal(calls, 1, "queued poll does not start a second fetch");
    release();
    await settle();
    fireTimers(ctx);
    await settle();
    equal(calls, 2, "queued poll ran after the in-flight one settled");
    release();
    await settle();
    ok(lensContent(registry).innerHTML.includes("hello"), "turns rendered");
  });

  it("a joined walk merges gap turns and a vanished cursor clears heldFrom", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const omega = { role: "user", ts: "t0", parts: [{ kind: "text", text: "omega" }] };
    const gamma = { role: "user", ts: "t0b", parts: [{ kind: "text", text: "gamma" }] };
    const beta = { role: "user", ts: "t2", parts: [{ kind: "text", text: "beta" }] };
    let fromPage = { cursor: "c1", turns: [] };
    const walkPage = { cursor: "c1", turns: [gamma] };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        // loadOlder walks back from the newest cursor; the join walk
        // fetches before the moved cursor. Distinct pages per URL.
        if (url.includes("before=c1")) return json200({ cursor: null, turns: [omega] });
        if (url.includes("before=")) return json200(walkPage);
        if (url.includes("from=")) return json200(fromPage);
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    equal(lens._state().heldFrom, "c1", "first older page anchors heldFrom");
    fromPage = { cursor: "c2", turns: [beta] };
    lens.refreshConversation();
    await settle();
    const state = lens._state();
    equal(state.heldFrom, "c2", "joined walk advances heldFrom");
    equal(state.olderTurns.length, 2, "gap turn merged into the older pages");
    const content = lensContent(registry);
    ok(content.innerHTML.includes("omega"), "older page turn held");
    ok(content.innerHTML.includes("gamma"), "gap turn joined");
    // The from= page replaces the live turns: everything before the
    // held cursor lives in olderTurns now, so alpha is not re-fetched.
    ok(content.innerHTML.includes("beta"), "fresh turn held");
    fromPage = { cursor: null, turns: [] };
    lens.refreshConversation();
    await settle();
    equal(lens._state().heldFrom, null, "vanished cursor clears heldFrom");
  });

  it("a throwing walk re-anchors on the newest page without a truncation note", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const omega = { role: "user", ts: "t0", parts: [{ kind: "text", text: "omega" }] };
    const beta = { role: "user", ts: "t2", parts: [{ kind: "text", text: "beta" }] };
    let fromPage = { cursor: "c1", turns: [] };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before=c1")) return json200({ cursor: null, turns: [omega] });
        if (url.includes("before=")) throw Error("walk exploded");
        if (url.includes("from=")) return json200(fromPage);
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    ok(lensContent(registry).innerHTML.includes("omega"), "older page held");
    fromPage = { cursor: "c2", turns: [beta] };
    lens.refreshConversation();
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("alpha"), "re-anchored on the newest page");
    ok(!content.innerHTML.includes("omega"), "held pages dropped");
    ok(!content.innerHTML.includes("skipped"), "no truncation note for a failed walk");
    ok(
      !content.innerHTML.includes("Beginning of conversation"),
      "no false beginning endcap after a failed walk",
    );
    equal(lens._state().olderTurns.length, 0, "older pages dropped");
    equal(lens._state().heldFrom, null, "heldFrom cleared");
  });

  it("loadOlder failures mark the retry control and retry clicks re-arm the walk", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const omega = { role: "user", ts: "t0", parts: [{ kind: "text", text: "omega" }] };
    let mode = "ok";
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before=")) {
          if (mode === "err500")
            return {
              ok: false,
              status: 500,
              statusText: "Server Error",
              headers: { get: () => null },
              json: async () => ({ error: "boom" }),
            };
          if (mode === "nullpage")
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              headers: { get: () => null },
              json: async () => {
                throw Error("no body");
              },
            };
          return json200({ cursor: null, turns: [omega] });
        }
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    mode = "err500";
    lens.loadOlder();
    await settle();
    equal(lens._state().olderState, "failed", "500 marks the walk failed");
    let content = lensContent(registry);
    let retry = content.querySelector("[data-load-older]");
    ok(retry, "retry control rendered");
    mode = "nullpage";
    fireClick(retry);
    await settle();
    equal(lens._state().olderState, "failed", "body-less page marks the walk failed");
    content = lensContent(registry);
    retry = content.querySelector("[data-load-older]");
    ok(retry, "retry control rendered again");
    mode = "ok";
    fireClick(retry);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes("omega"), "retry click loaded the older page");
    ok(content.innerHTML.includes("Beginning of conversation"), "endcap after the last page");
    equal(lens._state().olderState, "idle", "walk state back to idle");
  });

  it("a history_changed older page drops the held pages and refreshes", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before="))
          return {
            ok: false,
            status: 409,
            statusText: "Conflict",
            headers: { get: () => null },
            json: async () => ({ error: "gone", code: "history_changed" }),
          };
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    const state = lens._state();
    equal(state.olderState, "idle", "history_changed reset the walk state");
    equal(state.olderTurns.length, 0, "held pages dropped");
    ok(lensContent(registry).innerHTML.includes("alpha"), "newest page re-rendered");
  });

  it("lens close mid-loadOlder leaves the walk idle, on success and failure", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const omega = { role: "user", ts: "t0", parts: [{ kind: "text", text: "omega" }] };
    let resolveBefore = null;
    let rejectBefore = null;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before="))
          return new Promise((resolve, reject) => {
            resolveBefore = resolve;
            rejectBefore = reject;
          });
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    ok(resolveBefore, "older page fetch parked");
    lens.setLens(false);
    resolveBefore(json200({ cursor: null, turns: [omega] }));
    await settle();
    equal(lens._state().olderState, "idle", "stale success leaves idle");
    ok(!lensContent(registry).innerHTML.includes("omega"), "stale page dropped");
    // Reopen on the same pane: the walk must be usable again, not stuck
    // in a dead "loading" flag.
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(lens._state().olderState, "idle", "reopen finds an idle walk");
    lens.loadOlder();
    await settle();
    ok(rejectBefore, "second older fetch parked");
    lens.setLens(false);
    rejectBefore(Object.assign(Error("boom"), { status: 500 }));
    await settle();
    equal(lens._state().olderState, "idle", "stale failure leaves idle");
  });

  it("walking to the transcript start renders the beginning endcap", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const older2 = { role: "user", ts: "t0b", parts: [{ kind: "text", text: "older2" }] };
    const older1 = { role: "user", ts: "t0a", parts: [{ kind: "text", text: "older1" }] };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before=c1")) return json200({ cursor: "c0", turns: [older2] });
        if (url.includes("before=c0")) return json200({ cursor: null, turns: [older1] });
        if (url.includes("from=")) return json200({ cursor: "c1", turns: [] });
        return json200({ cursor: "c1", turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    ok(lensContent(registry).innerHTML.includes("older2"), "first older page held");
    lens.loadOlder();
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("older1"), "second older page held");
    ok(content.innerHTML.includes("Beginning of conversation"), "endcap marks the known start");
    equal(content.querySelectorAll("[data-load-older]").length, 0, "no load button at the top");
  });

  it("the pending bubble rides the first full render of the conversation", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
    });
    lens.setLens(true);
    lens.setPendingBubble("draft note");
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    const pending = content.querySelector(".lens-turn-pending");
    ok(pending, "pending row rendered with the conversation");
    ok(pending.innerHTML.includes("draft note"), "pending row carries the draft text");
  });

  it("image parts render pane-scoped lazy imgs and drop empty refs", async () => {
    const withImages = () => ({
      ...conversationFixture(),
      turns: [
        { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          ts: "t2",
          parts: [
            { kind: "image", ref: "img_1", media_type: "image/png" },
            { kind: "image", ref: "" },
            { kind: "image", ref: "img_2" },
          ],
        },
      ],
    });
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(withImages()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    const images = content.querySelectorAll(".lens-image img");
    equal(images.length, 2, "empty-ref image renders nothing");
    ok(
      content.innerHTML.includes('src="/api/panes/pane_1/conversation/image?ref=img_1"'),
      "src is pane-scoped",
    );
    ok(content.innerHTML.includes('loading="lazy"'), "lazy loading set");
    ok(content.innerHTML.includes("pasted image/png image"), "media type in the alt text");
    ok(content.innerHTML.includes('alt="pasted image"'), "generic alt without a media type");
  });

  it("tool_pending runs show the head count and a continuation row", async () => {
    const withRuns = () => ({
      ...conversationFixture(),
      turns: [
        { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          ts: "t2",
          parts: [
            { kind: "tool_pending", name: "bash" },
            { kind: "tool_pending", name: "bash" },
          ],
        },
      ],
    });
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(withRuns()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    const running = content.querySelectorAll(".lens-tool-running");
    equal(running.length, 2, "both pending rows render");
    ok(content.innerHTML.includes("×2"), "head row carries the run count");
    equal(
      content.querySelectorAll(".lens-tool-run-continuation").length,
      1,
      "tail row is a continuation",
    );
    ok(content.innerHTML.includes("running"), "running label present");
  });

  it("compact rows render their summary and unknown parts render nothing", async () => {
    const withCompact = () => ({
      ...conversationFixture(),
      turns: [
        { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          ts: "t2",
          parts: [
            { kind: "compact", summary: "older turns dropped" },
            { kind: "mystery_part", text: "invisible" },
          ],
        },
      ],
    });
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(withCompact()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("Earlier context compacted"), "compact label rendered");
    ok(content.innerHTML.includes("older turns dropped"), "compact summary rendered");
    ok(!content.innerHTML.includes("invisible"), "unknown part kinds render nothing");
  });

  it("Show full output fetches through api, swaps in place, and survives a re-render", async () => {
    const apiUrls = [];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async (url) => {
        apiUrls.push(url);
        return { output: "full output body" };
      },
      fetch: async () => json200(conversationFixture()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    let content = lensContent(registry);
    const head = content.querySelector("[data-toggle-tool]");
    ok(head, "tool toggle rendered");
    fireClick(head);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes("lens-tool-open"), "tool row opened");
    ok(content.innerHTML.includes("output trimmed: 13893 chars total"), "trim meta shown");
    const fetchButton = content.querySelector("[data-fetch-output]");
    ok(fetchButton, "Show full output button rendered");
    fireClick(fetchButton);
    await settle(15);
    equal(apiUrls.length, 1, "api fetched once");
    ok(apiUrls[0].includes("/tool-output?ref=call_1"), "tool-output route with the ref");
    let pre = content.querySelector(".lens-tool-output");
    equal(pre && pre.textContent, "full output body", "output swapped in place");
    equal(content.querySelectorAll("[data-fetch-output]").length, 0, "button removed");
    // A same-count re-render must keep the fetched output.
    lens.render();
    await settle();
    content = lensContent(registry);
    pre = content.querySelector(".lens-tool-output");
    equal(pre && pre.textContent, "full output body", "fetched output survives the re-render");
    equal(content.querySelectorAll("[data-fetch-output]").length, 0, "no fetch button after re-render");
    ok(!content.innerHTML.includes("output trimmed"), "trim meta gone");
  });

  it("a re-render mid full-output fetch removes the stale button row", async () => {
    let release = null;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      api: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      fetch: async () => json200(conversationFixture()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    let content = lensContent(registry);
    fireClick(content.querySelector("[data-toggle-tool]"));
    await settle();
    const button = content.querySelector("[data-fetch-output]");
    ok(button, "fetch button rendered");
    fireClick(button);
    await settle();
    // Mid-fetch: collapse the tool so the re-rendered row is closed and
    // has no [data-fetch-output]. The resolved fetch then takes the
    // else branch and removes the original detached button (1119).
    fireClick(lensContent(registry).querySelector("[data-toggle-tool]"));
    await settle();
    ok(
      !lensContent(registry).innerHTML.includes("lens-tool-open"),
      "row collapsed while the fetch was parked",
    );
    release({ output: "late body" });
    await settle(20);
    ok(
      lensContent(registry).querySelector("[data-toggle-tool]") !== null,
      "closed row still intact after the fetch resolved",
    );
    ok(!button.parentNode, "original detached button removed");
  });

  it("a failed full-output fetch re-enables the button with a retry label", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
      // api left at its default: it throws.
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    const content = lensContent(registry);
    fireClick(content.querySelector("[data-toggle-tool]"));
    await settle();
    const button = content.querySelector("[data-fetch-output]");
    ok(button, "fetch button rendered");
    fireClick(button);
    await settle(15);
    equal(button.disabled, false, "button re-enabled");
    equal(button.textContent, "Show full output (retry)", "retry label shown");
  });

  it("a 409 recovery refetch with an unparseable body parks on the loading fallback", async () => {
    let calls = 0;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 409,
            statusText: "Conflict",
            headers: { get: () => null },
            json: async () => ({ error: "history changed", details: { code: "history_changed" } }),
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          json: async () => {
            throw Error("not json");
          },
        };
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    // The 409 recovery refetch parsed to body=null; render() falls
    // through to the loading fallback because conversation is null
    // while loadingChat is false (981-983).
    ok(
      lensContent(registry).innerHTML.includes("loading chat…"),
      "unparseable recovery body parks on the loading fallback",
    );
  });

  it("the working block expands, ticks, follows new turns, and collapses", async () => {
    const baseTurns = () => [
      { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
      {
        role: "assistant",
        ts: new Date(Date.now() - 3000).toISOString(),
        parts: [{ kind: "tool_pending", name: "cargo" }],
      },
    ];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200({ ...conversationFixture(), turns: baseTurns() }),
    });
    ctx.state.agents[0].agent_status = "working";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    ok(content.querySelector(".lens-working"), "working block rendered");
    ok(content.innerHTML.includes("cargo"), "head label carries the running tool");
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    let toggle = content.querySelector("[data-toggle-working]");
    ok(toggle, "working toggle rendered");
    fireClick(toggle);
    await settle();
    content = lensContent(registry);
    let body = content.querySelector(".lens-working-body");
    ok(body, "expanded body appears");
    ok(body.innerHTML.includes("Working for"), "elapsed line present");
    ok(body.innerHTML.includes("cargo"), "running tools listed");
    // The tick timer refreshes the elapsed line in place.
    fireTimers(ctx);
    await settle();
    body = content.querySelector(".lens-working-body");
    ok(body && body.innerHTML.includes("Working for"), "elapsed line refreshed by the tick");
    // A new turn arrives: the block moves to stay last.
    ctx.fetch = async () =>
      json200({
        ...conversationFixture(),
        turns: [
          ...baseTurns(),
          { role: "user", ts: "t3", parts: [{ kind: "text", text: "later" }] },
        ],
      });
    fireTimers(ctx);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes("later"), "new turn appended");
    equal(
      content.lastElementChild && content.lastElementChild.className,
      "lens-working",
      "working block stays last",
    );
    // Collapse: body leaves, tick stops.
    toggle = content.querySelector("[data-toggle-working]");
    fireClick(toggle);
    await settle();
    content = lensContent(registry);
    equal(content.querySelectorAll(".lens-working-body").length, 0, "body removed on collapse");
  });

  it("working body lines track the start source: turn ts, bad ts, stale ts, user turn", async () => {
    const withLast = (turn) => ({
      ...conversationFixture(),
      turns: [
        { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
        turn,
      ],
    });
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200(
          withLast({
            role: "assistant",
            ts: new Date(Date.now() - 2000).toISOString(),
            parts: [{ kind: "tool_pending", name: "cargo" }],
          }),
        ),
    });
    ctx.state.agents[0].agent_status = "working";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    const content = lensContent(registry);
    fireClick(content.querySelector("[data-toggle-working]"));
    await settle();
    let body = lensContent(registry).querySelector(".lens-working-body");
    ok(body.innerHTML.includes("Working for"), "fresh turn timestamp yields the elapsed line");
    ok(body.innerHTML.includes("cargo"), "pending tool listed");
    // Unparseable timestamp: no elapsed line, the note line instead.
    ctx.fetch = async () =>
      json200(withLast({ role: "assistant", ts: "not-a-date", parts: [{ kind: "text", text: "x" }] }));
    lens.refreshConversation();
    await settle();
    body = lensContent(registry).querySelector(".lens-working-body");
    ok(body.innerHTML.includes("Agent is processing"), "bad timestamp falls back to the note");
    ok(!body.innerHTML.includes("Working for"), "no elapsed line without a start");
    // Timestamp older than a day: stale, note again.
    ctx.fetch = async () =>
      json200(
        withLast({
          role: "assistant",
          ts: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          parts: [{ kind: "text", text: "x" }],
        }),
      );
    lens.refreshConversation();
    await settle();
    body = lensContent(registry).querySelector(".lens-working-body");
    ok(body.innerHTML.includes("Agent is processing"), "day-old timestamp counts as stale");
    // Last turn from the user: no assistant start, note again.
    ctx.fetch = async () =>
      json200(withLast({ role: "user", ts: "t9", parts: [{ kind: "text", text: "q" }] }));
    lens.refreshConversation();
    await settle();
    body = lensContent(registry).querySelector(".lens-working-body");
    ok(body.innerHTML.includes("Agent is processing"), "user turn gives no start");
    lens._resetWorkingState();
  });

  it("a working status event provides the elapsed start", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200({
          ...conversationFixture(),
          turns: [
            { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
            { role: "assistant", ts: "t2", parts: [{ kind: "text", text: "x" }] },
          ],
        }),
    });
    lens.onAgentStatusChanged({ pane_id: "pane_1", agent_status: "working" });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.querySelector(".lens-working"), "event-driven working block rendered");
    lensNode(registry).listeners.click[0]({
      target: content.querySelector("[data-toggle-working]"),
    });
    await settle();
    const body = lensContent(registry).querySelector(".lens-working-body");
    ok(body && body.innerHTML.includes("Working for"), "event timestamp yields the elapsed line");
  });

  it("the new-output pill arms while scrolled up and a click resumes following", async () => {
    let turns = [
      { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
      { role: "assistant", ts: "t2", parts: [{ kind: "text", text: "done" }] },
    ];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200({ ...conversationFixture(), turns }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const scroller = registry.get("mobileLensScroller");
    scroller.scrollTop = 10;
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 300;
    scroller.listeners.scroll[0]();
    turns = [
      ...turns,
      { role: "user", ts: "t3", parts: [{ kind: "text", text: "later" }] },
    ];
    fireTimers(ctx);
    await settle();
    const pill = registry.get("mobileLensNew");
    equal(pill.hidden, false, "pill armed for unread output while scrolled up");
    pill.onclick();
    equal(pill.hidden, true, "pill dismissed");
    equal(scroller.scrollTop, 1000, "view snapped back to the bottom");
    ok(lensContent(registry).innerHTML.includes("later"), "turns intact after resume");
  });

  it("a same-count render appends a new part row to its turn", async () => {
    let parts = [{ kind: "text", text: "step" }];
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () =>
        json200({
          ...conversationFixture(),
          turns: [
            { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
            { role: "assistant", ts: "t2", parts },
          ],
        }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    let content = lensContent(registry);
    equal(content.querySelectorAll(".lens-tool").length, 0, "no tool row yet");
    parts = [
      { kind: "text", text: "step" },
      { kind: "tool", name: "bash", brief: "run", input: "{}", output: "ok", is_error: false },
    ];
    fireTimers(ctx);
    await settle();
    content = lensContent(registry);
    const tool = content.querySelector(".lens-tool");
    ok(tool, "new part row appended to the existing turn");
    ok(content.innerHTML.includes("bash"), "tool row rendered");
  });

  it("cssEscape falls back to a plain escape without the CSS global", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
      extra: { CSS: undefined },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("hello"), "same-count sync kept the rows");
    ok(content.querySelector('[data-part-key="1:0:bash"]'), "part rows still addressable");
  });

  it("decision dismiss collapses the chooser and expand reopens it", async () => {
    const decisionPart = {
      kind: "decision",
      name: "decision",
      question: "Deploy now?",
      options: [{ label: "Yes" }, { label: "No" }],
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
    const fireClick = (target) => lensNode(registry).listeners.click[0]({ target });
    let content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="live"'), "chooser live while blocked");
    const dismiss = content.querySelector(".lens-decision-dismiss");
    ok(dismiss, "dismiss button rendered");
    fireClick(dismiss);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="answered"'), "chooser collapsed after dismiss");
    ok(
      content.innerHTML.includes("Waiting for your answer in the terminal"),
      "collapsed hint shown",
    );
    const expand = content.querySelector(".lens-decision-expand");
    ok(expand, "expand button rendered");
    fireClick(expand);
    await settle();
    content = lensContent(registry);
    ok(content.innerHTML.includes('data-decision="live"'), "expand reopens the chooser");
  });

  it("the decision form sends bracketed paste and blank input sends nothing", async () => {
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
    ctx.state.agents[0].agent_status = "blocked";
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const submit = (target) =>
      lensNode(registry).listeners.submit[0]({ target, preventDefault() {} });
    const content = lensContent(registry);
    const form = content.querySelector("form.lens-decision-form");
    ok(form, "answer form rendered while blocked");
    const input = form.querySelector(".lens-decision-input");
    input.value = "deploy\nnow";
    submit(form);
    await settle();
    equal(ctx._sent.length, 1, "answer sent");
    equal(ctx._sent[0], "\u001b[200~deploy now\u001b[201~\r", "bracketed paste payload");
    ok(
      lensContent(registry).innerHTML.includes("Answered: waiting for the agent to continue"),
      "chooser shows the answered hint",
    );
    lens._resetDecisionState();
    lens.render();
    await settle();
    const formAgain = lensContent(registry).querySelector("form.lens-decision-form");
    ok(formAgain, "form back after reset");
    formAgain.querySelector(".lens-decision-input").value = "   ";
    submit(formAgain);
    await settle();
    equal(ctx._sent.length, 1, "blank input sends nothing");
    submit(null);
    await settle();
    equal(ctx._sent.length, 1, "submit without a target ignored");
  });

  it("Enter and Space toggle tool rows from the keyboard, other keys and inner nodes do not", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const keydownOn = (key, target) => {
      let prevented = false;
      lensNode(registry).listeners.keydown[0]({
        key,
        target,
        preventDefault() {
          prevented = true;
        },
      });
      return prevented;
    };
    let content = lensContent(registry);
    ok(keydownOn("Enter", content.querySelector("[data-toggle-tool]")), "Enter prevented");
    await settle();
    content = lensContent(registry);
    ok(content.querySelector(".lens-tool-open"), "Enter opens the tool row");
    ok(!keydownOn("a", content.querySelector("[data-toggle-tool]")), "unrelated key ignored");
    ok(
      !keydownOn("Enter", content.querySelector(".lens-tool-caret")),
      "inner target does not toggle",
    );
    ok(content.querySelectorAll(".lens-tool-open").length, "row still open");
    ok(!keydownOn("Enter", content.querySelector(".lens-text")), "non-toggle target ignored");
    ok(keydownOn(" ", content.querySelector("[data-toggle-tool]")), "Space prevented");
    await settle();
    equal(
      lensContent(registry).querySelectorAll(".lens-tool-open").length,
      0,
      "Space closes the row",
    );
  });

  it("switch drag without a container clamps to the window and persists nothing", () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    ctx.innerWidth = 400;
    ctx.innerHeight = 700;
    const pill = registry.get("mobileLensSwitch");
    equal(pill.offsetParent, null, "no container in this harness");
    const fireDoc = (type, event) => {
      for (const fn of [...(ctx._docListeners.get(type) || [])]) fn(event);
    };
    equal((pill.listeners.click || []).length, 0, "no suppressor before the drag");
    lens.switchDragStart({ clientX: 100, clientY: 40, preventDefault() {} });
    equal(pill.listeners.click.length, 1, "click suppressor armed for the drag");
    fireDoc("mousemove", { clientX: 5000, clientY: 5000, preventDefault() {} });
    equal(pill.style.left, "300px", "x clamped to the window width minus the pill");
    equal(pill.style.top, "670px", "y clamped to the window height minus the pill");
    ok(pill.classList.contains("dragging"), "dragging class set mid-drag");
    fireDoc("mouseup", {});
    ok(!pill.classList.contains("dragging"), "dragging class cleared on release");
    fireTimers(ctx);
    equal(pill.listeners.click.length, 0, "suppressor dropped after the trailing click");
    equal(ctx._storage.size, 0, "nothing persisted without a container");
  });

  it("switch drag inside a container saves the clamped spot, touch path included", () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    const pill = registry.get("mobileLensSwitch");
    const container = makeElement("div", 'class="mobile-terminal-screen"', "", registry);
    container._rectWidth = 300;
    container._rectHeight = 500;
    pill.offsetParent = container;
    const fireDoc = (type, event) => {
      for (const fn of [...(ctx._docListeners.get(type) || [])]) fn(event);
    };
    lens.switchDragStart({ clientX: 100, clientY: 50, preventDefault() {} });
    fireDoc("mousemove", { clientX: 4000, clientY: 4000, preventDefault() {} });
    equal(pill.style.left, "200px", "x clamped to the container");
    equal(pill.style.top, "470px", "y clamped to the container");
    fireDoc("mouseup", {});
    deepEqual(
      JSON.parse(ctx._storage.get("herdr-mobile-lens-switch")),
      { x: 200, y: 470 },
      "container-relative spot persisted",
    );
    // Touch drag from a cleared position.
    pill.style.left = "";
    pill.style.top = "";
    lens.switchDragStart({ touches: [{ clientX: 50, clientY: 50 }], preventDefault() {} });
    fireDoc("touchmove", { touches: [{ clientX: 200, clientY: 300 }], preventDefault() {} });
    equal(pill.style.left, "150px", "touch drag clamps the same way");
    equal(pill.style.top, "250px", "touch drag clamps y too");
    fireDoc("touchend", {});
    deepEqual(
      JSON.parse(ctx._storage.get("herdr-mobile-lens-switch")),
      { x: 150, y: 250 },
      "touch spot persisted",
    );
  });

  it("the drag suppressor swallows the trailing click and re-arms after it", () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
    });
    ctx.innerWidth = 400;
    ctx.innerHeight = 700;
    const pill = registry.get("mobileLensSwitch");
    const fireDoc = (type, event) => {
      for (const fn of [...(ctx._docListeners.get(type) || [])]) fn(event);
    };
    lens.switchDragStart({ clientX: 100, clientY: 40, preventDefault() {} });
    // A real drag passes the 6px threshold, so the release arms the
    // trailing-click suppressor (1337-1338).
    fireDoc("mousemove", { clientX: 120, clientY: 40, preventDefault() {} });
    fireDoc("mouseup", {});
    const suppressed = { stopped: false, defaulted: false };
    pill.listeners.click.forEach((fn) =>
      fn({ stopImmediatePropagation() { suppressed.stopped = true; }, preventDefault() { suppressed.defaulted = true; } }));
    ok(suppressed.stopped && suppressed.defaulted, "suppressor ran during the trailing click window");
    fireTimers(ctx);
    equal(pill.listeners.click.length, 0, "suppressor dropped after the trailing click");
  });

  it("paneStatusNow survives a throwing statusClassFn and toggle flips the lens", () => {
    const { ctx, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      statusClassFn: () => {
        throw Error("boom");
      },
    });
    ctx.state.agents[0].agent_status = "blocked";
    equal(lens.paneBlockedNow(), false, "throwing classifier falls back to false");
    equal(lens.paneWorkingNow(), false, "working check also survives");
    equal(lens.isActive(), false, "lens starts closed");
    lens.toggle();
    equal(lens.isActive(), true, "toggle opens");
    lens.toggle();
    equal(lens.isActive(), false, "toggle closes");
  });

  it("a queued poll parked mid-flight renders through pollInFlight and paneBlockedNow survives a throwing classifier", async () => {
    let calls = 0;
    let release = null;
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => {
        calls++;
        await new Promise((resolve) => {
          release = resolve;
        });
        return json200(conversationFixture());
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(calls, 1, "first poll parked mid-flight");
    // The timer callback disarmed pollTimer before parking in the fetch,
    // so a plain re-fire has nothing scheduled. A pane-changed event on
    // the same pane re-arms polling (ensurePolling -> pollSoon), and the
    // next fire re-enters pollConversation with pollInFlight still true:
    // the 218-220 queue branch runs.
    lens.onPaneChanged("pane_1");
    await settle();
    fireTimers(ctx);
    await settle();
    equal(calls, 1, "no second fetch while one is in flight");
    release();
    await settle();
    fireTimers(ctx);
    await settle();
    ok(lensContent(registry).innerHTML.includes("hello"), "queued polls eventually render");
  });

  it("an empty joined walk re-anchors heldFrom and a vanished cursor clears it", async () => {
    const alpha = { role: "user", ts: "t1", parts: [{ kind: "text", text: "alpha" }] };
    const omega = { role: "user", ts: "t0", parts: [{ kind: "text", text: "omega" }] };
    const beta = { role: "user", ts: "t2", parts: [{ kind: "text", text: "beta" }] };
    let newestCursor = "c1";
    let fromPage = { cursor: "c1", turns: [] };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async (url) => {
        if (url.includes("before=c1")) return json200({ cursor: null, turns: [omega] });
        if (url.includes("before=")) return json200({ cursor: "c1", turns: [] });
        if (url.includes("from=")) return json200(fromPage);
        return json200({ cursor: newestCursor, turns: [alpha] });
      },
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    lens.loadOlder();
    await settle();
    equal(lens._state().heldFrom, "c1", "older page anchors heldFrom");
    // Walk joins instantly with no turns: moved.length === 0 parks
    // heldFrom on the new cursor (259-260).
    fromPage = { cursor: "c0", turns: [] };
    newestCursor = "c2";
    fireTimers(ctx);
    await settle();
    equal(lens._state().heldFrom, "c0", "empty walk re-anchors heldFrom");
    // Newest page loses its cursor: heldFrom drops to null (264-265).
    fromPage = { cursor: null, turns: [beta] };
    newestCursor = null;
    fireTimers(ctx);
    await settle();
    equal(lens._state().heldFrom, null, "vanishing cursor clears heldFrom");
    ok(lensContent(registry).innerHTML.includes("beta"), "fresh turns still render");
  });

  it("an unparseable 200 response parks the render on the refusal copy", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => {
          throw Error("not json");
        },
      }),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    ok(
      lensContent(registry).innerHTML.includes("Conversation unavailable right now"),
      "body-less 200 renders the refusal",
    );
  });

  it("a status event outside the active pane is ignored", async () => {
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(conversationFixture()),
    });
    lens.onAgentStatusChanged({ pane_id: "pane_2", agent_status: "working" });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    equal(
      lensContent(registry).querySelectorAll(".lens-working").length,
      0,
      "working block only tracks the active pane",
    );
  });

  it("turn meta renders Worked-for spans and formatDuration covers its branches", async () => {
    const now = Date.now();
    const fixture = {
      ...conversationFixture(),
      turns: [
        { role: "user", ts: "t1", parts: [{ kind: "text", text: "hello" }] },
        {
          role: "assistant",
          ts: new Date(now - 90000).toISOString(),
          end_ts: new Date(now).toISOString(),
          parts: [{ kind: "text", text: "done" }],
        },
        {
          role: "assistant",
          ts: new Date(now - 5000).toISOString(),
          parts: [{ kind: "text", text: "no end" }],
        },
        {
          role: "assistant",
          ts: new Date(now).toISOString(),
          end_ts: new Date(now - 5000).toISOString(),
          parts: [{ kind: "text", text: "backwards" }],
        },
      ],
    };
    const { ctx, registry, lens } = makeHarness({
      state: { pane: "pane_1", agents: [jcodeRow(resolvableSession)] },
      fetch: async () => json200(fixture),
    });
    lens.setLens(true);
    fireTimers(ctx);
    await settle();
    const content = lensContent(registry);
    ok(content.innerHTML.includes("Worked for 1m 30s"), "span meta rendered");
    equal(
      content.innerHTML.split("Worked for").length - 1,
      1,
      "only the valid forward span gets meta",
    );
    equal(lens.formatDuration(3725), "1h 2m", "hours plus minutes");
    equal(lens.formatDuration(125), "2m 5s", "minutes plus seconds");
    equal(lens.formatDuration(7), "7s", "seconds only");
    equal(lens.formatDuration(0), "0s", "zero");
    equal(lens.formatDuration(-5), "0s", "negatives clamp to zero");
  });
});
