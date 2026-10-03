// Composer message shaping (chat composer over the terminal, ux overhaul).
//
// DOM-free on purpose so the policy is unit-testable (see
// compose.test.mjs), mirroring the server-side pair in builtin_backend.rs
// (composer_message / bracketed_paste_payload). The SERVER owns the actual
// paste+Enter: this module only decides what the browser sends and how it
// reacts to the server's answer (ok / agent_blocked / gone).
(function () {
  /** Cap matching the server's MAX_COMPOSER_CHARS: one message per submit. */
  const MAX_COMPOSER_CHARS = 20000;

  /** A composer message as written: trailing newlines are the composer's,
   * not the text's; CRLF reads as one newline. */
  function composerMessage(text) {
    return String(text).replace(/[\r\n]+$/, "").replace(/\r\n?/g, "\n");
  }

  /** Refusal copy for a submit error: what happened and what to do next.
   * Unknown codes degrade to the server's own message. */
  function submitNote(code, message) {
    if (code === "agent_blocked")
      return "Not sent: the agent is waiting for an answer in the terminal. Answer it first.";
    if (code === "agent_not_found" || code === "agent_exited")
      return "Not sent: this panel is gone. Pick another panel.";
    if (code === "message_too_long")
      return "Not sent: message is too long (20000 characters max).";
    if (code === "empty_agent_prompt") return "Not sent: the message is empty.";
    if (code === "unauthorized") return "Not sent: session expired. Reload.";
    return message ? `Not sent: ${message}` : "Not sent.";
  }

  /** Queue-ready statuses: a held message is released only when the agent
   * finished its turn. Sending while "working" would interleave with the
   * turn; "blocked" must go through the prompt-card answer path instead. */
  const QUEUE_READY_STATUS = { done: true, idle: true };

  globalThis.HerdrCompose = {
    MAX_COMPOSER_CHARS,
    composerMessage,
    submitNote,
    QUEUE_READY_STATUS,
  };
})();