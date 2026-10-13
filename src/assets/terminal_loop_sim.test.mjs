import { describe, it } from "node:test";
import { ok, equal } from "node:assert/strict";

// Faithful model of the live Arc oscillation (2026-10 repro). Mechanism, from
// upstream @wterm/dom 0.5.4 source plus the live CDP stack traces:
// - A window drag makes wterm drop its own follow (_shouldScrollToBottom=false)
//   and leaves the bridge scrollback count transiently wrong during spacer
//   re-layout (flips between 0 and n across render frames).
// - The app, however, still follows: every output frame it calls
//   adapter.scrollToBottom().
// PRE-FIX: the adapter writes element.scrollTop directly. Upstream sees an
//   unattributed scroll event, then its render loop takes the no-scrollback
//   reset branch (bridge says 0) and pins scrollTop to 0; the app immediately
//   writes bottom again; the two writers alternate every frame:
//   scrollTop oscillates 0 <-> maxScroll, which painted as the terminal
//   blinking between two scroll positions.
// POST-FIX: the adapter routes through wterm._setScrollTop (event is
//   attributed, no user-gesture confusion), and the vendored reset branch
//   only pins 0 when the host is genuinely unscrollable (scrollHeight -
//   clientHeight <= 4), so a transient overflow can never arm the zero-writer.

const SCROLL_HEIGHT = 4282;
const CLIENT_HEIGHT = 830;
const MAX_SCROLL = SCROLL_HEIGHT - CLIENT_HEIGHT; // 3452, matches live viewport

class WtermHost {
  constructor(guardedZeroWriter) {
    this.guarded = guardedZeroWriter;
    this.scrollHeight = SCROLL_HEIGHT;
    this.clientHeight = CLIENT_HEIGHT;
    this.scrollTop = 0;
    this._shouldScrollToBottom = false; // resize canceled wterm's own follow
    this._programmaticScrollTop = null;
    this.bridgeScrollback = 0;
    this.zeroWrites = 0;
    this.followCancels = 0;
  }
  _setScrollTop(value) {
    const before = this.scrollTop;
    this.scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    if (this.scrollTop !== before) {
      this._programmaticScrollTop = this.scrollTop;
      this._onScrollEvent();
    }
  }
  _onScrollEvent() {
    if (this._shouldScrollToBottom && this.scrollHeight - this.scrollTop - this.clientHeight < 5) {
      this._programmaticScrollTop = null;
      return;
    }
    if (this._programmaticScrollTop !== null && Math.abs(this.scrollTop - this._programmaticScrollTop) <= 1) {
      this._programmaticScrollTop = null;
      return;
    }
    this._programmaticScrollTop = null;
    if (this._shouldScrollToBottom) {
      this._shouldScrollToBottom = false;
      this.followCancels++;
    }
  }
  render() {
    const hasScrollback = this.bridgeScrollback > 0;
    if (this._shouldScrollToBottom) {
      this._setScrollTop(this.scrollHeight);
    } else if (this.guarded
        ? this.scrollHeight - this.clientHeight <= 4 && this.scrollTop !== 0
        : !hasScrollback && this.scrollTop !== 0) {
      this.zeroWrites++;
      this._setScrollTop(0);
    }
  }
}

function adapterScrollToBottom(host, routed) {
  if (routed) {
    host._setScrollTop(host.scrollHeight); // post-fix: through wterm's writer
  } else {
    // pre-fix: direct DOM write, no _programmaticScrollTop attribution
    const before = host.scrollTop;
    host.scrollTop = host.scrollHeight;
    if (host.scrollTop !== before) host._onScrollEvent();
  }
}

function simulateFrames(host, routed, frames) {
  const positions = [];
  for (let f = 0; f < frames; f++) {
    adapterScrollToBottom(host, routed);
    // spacer churn during the resize settle: bridge count flips across frames
    host.bridgeScrollback = f % 2 === 0 ? 0 : 40;
    host.render();
    positions.push(host.scrollTop);
    if (host.zeroWrites > 40) break;
  }
  return positions;
}

const oscillates = (positions) => {
  const distinct = new Set(positions.map((p) => p > 1000));
  return distinct.size > 1 && positions.filter((p) => p === 0).length > 10;
};

describe("terminal scroll oscillation loop simulation", () => {
  it("pre-fix adapter routing reproduces the live 0<->maxScroll oscillation", () => {
  const host = new WtermHost(false);
  const positions = simulateFrames(host, false, 90);
  ok(oscillates(positions), `expected 0<->${MAX_SCROLL} oscillation, got ${positions.slice(0, 12)}`);
  ok(host.zeroWrites > 10, "zero-writer must fire repeatedly");
});

  it("post-fix adapter routing and guarded reset hold the bottom", () => {
  const host = new WtermHost(true);
  const positions = simulateFrames(host, true, 90);
  ok(positions.every((p) => p === MAX_SCROLL), `expected stable bottom, got ${positions.slice(0, 12)}`);
  equal(host.zeroWrites, 0, "zero-writer must never fire with transient overflow");
  equal(host.followCancels, 0, "routed writes must not look like user scrolls");
});

  it("guard alone (unrouted adapter) still beats the loop", () => {
  // Fix B without Fix A: adapter still writes directly, but the vendored
  // reset branch checks overflow. The zero-writer stays disarmed while the
  // DOM keeps a real overflow, so no oscillation either.
  const host = new WtermHost(true);
  const positions = simulateFrames(host, false, 90);
  ok(!oscillates(positions), "guard alone must stop the 0<->maxScroll fight");
  equal(host.zeroWrites, 0);
});
});
