// Unit tests for the shared compose policy (src/assets/shared/compose.js).
//
// DOM-free module, DOM-free tests. The interesting contract is parity with
// the server pair in builtin_backend.rs (composer_message /
// bracketed_paste_payload): both sides must shape the same message or the
// draft that stays in the box after a refusal will not match what the
// server would accept next time.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { equal, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(
  new URL("./shared/compose.js", import.meta.url),
  "utf8",
);

function loadCompose() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.runInContext(SOURCE, vm.createContext(ctx));
  return ctx.HerdrCompose;
}

describe("compose policy", () => {
  it("exposes the HerdrCompose API", () => {
    const compose = loadCompose();
    ok(compose, "globalThis.HerdrCompose must exist");
    equal(typeof compose.composerMessage, "function");
    equal(typeof compose.submitNote, "function");
    equal(compose.MAX_COMPOSER_CHARS, 20000);
    ok(compose.QUEUE_READY_STATUS.done && compose.QUEUE_READY_STATUS.idle);
  });

  it("strips trailing newlines and normalizes line ends", () => {
    const compose = loadCompose();
    // Mirror of composer_message_normalizes_line_ends in builtin_backend.rs.
    equal(compose.composerMessage("hello\n\n"), "hello");
    equal(compose.composerMessage("hello\r\n\r\n"), "hello");
    equal(compose.composerMessage("a\r\nb"), "a\nb");
    equal(compose.composerMessage("a\rb"), "a\nb");
    equal(compose.composerMessage("\n\nhello"), "\n\nhello");
    equal(compose.composerMessage("plain"), "plain");
    equal(compose.composerMessage(42), "42", "coerces non-strings");
  });

  it("maps refusal codes to actionable copy", () => {
    const compose = loadCompose();
    ok(
      /waiting for an answer/i.test(compose.submitNote("agent_blocked")),
      "blocked copy tells the user to answer the dialog first",
    );
    ok(/gone/i.test(compose.submitNote("agent_not_found")));
    ok(/gone/i.test(compose.submitNote("agent_exited")));
    ok(/20000/i.test(compose.submitNote("message_too_long")));
    ok(/empty/i.test(compose.submitNote("empty_agent_prompt")));
    ok(/reload/i.test(compose.submitNote("unauthorized")));
  });

  it("degrades unknown codes to the server's message", () => {
    const compose = loadCompose();
    equal(compose.submitNote("io_error", "io_error: write failed"),
      "Not sent: io_error: write failed");
    equal(compose.submitNote(null, null), "Not sent.");
  });

  it("keeps queue-ready statuses a closed set", () => {
    const compose = loadCompose();
    ok(!compose.QUEUE_READY_STATUS.working, "working is not queue-ready");
    ok(!compose.QUEUE_READY_STATUS.blocked, "blocked is not queue-ready");
  });
});
