// Live broadcast-contract probe (paired with notes-broadcast-probe.sh).
// Two subscribers open /ws/events; a third party creates a note through
// the real API. Both subscribers must receive a notes_changed frame that
// carries the full server contract: newest-first notes, display_title,
// and the language table. Uses only Node built-ins (no ws dependency),
// speaking the RFC 6455 handshake by hand: the 101 response and the first
// frames may share one TCP chunk, so parsing only starts after the
// \r\n\r\n handshake terminator.
import crypto from "node:crypto";
import net from "node:net";

const [wsUrl, session, baseUrl] = process.argv.slice(2);
if (!wsUrl || !session || !baseUrl) {
  console.error("usage: node notes-broadcast-contract.mjs <ws-url> <session-token> <base-url>");
  process.exit(2);
}

class WsClient {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.socket = null;
    this.handshake = null;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // The HTTP 101 response ends at the first \r\n\r\n; frames follow.
    while (!this.handshake.done) {
      const at = this.buffer.indexOf("\r\n\r\n");
      if (at === -1) return;
      const head = this.buffer.subarray(0, at).toString("latin1");
      this.buffer = this.buffer.subarray(at + 4);
      if (!head.includes("101 ")) {
        this.handshake.reject(new Error("websocket rejected: " + head.split("\r\n")[0]));
        return;
      }
      this.handshake.resolve();
    }
    while (true) {
      if (this.buffer.length < 2) return;
      const len0 = this.buffer[1] & 0x7f;
      let headerLen = 2;
      let payloadLen = len0;
      if (len0 === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (len0 === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        headerLen = 10;
      }
      if (this.buffer.length < headerLen + payloadLen) return;
      const opcode = this.buffer[0] & 0x0f;
      const payload = this.buffer.subarray(headerLen, headerLen + payloadLen);
      this.buffer = this.buffer.subarray(headerLen + payloadLen);
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        const text = payload.toString("utf8");
        const waiter = this.waiters.shift();
        if (waiter) waiter(text);
        else this.messages.push(text);
      } else if (opcode === 0x8) {
        return; // server closed; pending waits time out on their own
      } else if (opcode === 0x9) {
        // Ping: reply with a masked pong (opcode 0xA).
        const mask = crypto.randomBytes(4);
        const header = Buffer.from([0x8a, 0x80 | payload.length]);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        this.socket.write(Buffer.concat([header, mask, masked]));
      }
    }
  }

  async connect(url) {
    const parsed = new URL(url.replace("ws://", "http://"));
    const key = crypto.randomBytes(16).toString("base64");
    this.handshake = {};
    this.handshake.promise = new Promise((resolve, reject) => {
      this.handshake.resolve = resolve;
      this.handshake.reject = reject;
    });
    this.handshake.done = false;
    this.socket = net.connect(Number(parsed.port), parsed.hostname);
    this.socket.on("error", (err) => {
      if (!this.handshake.done) this.handshake.reject(err);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.write(
      `GET ${parsed.pathname} HTTP/1.1\r\n` +
        `Host: ${parsed.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Cookie: herdr_web_session=${session}\r\n` +
        `\r\n`,
    );
    await this.handshake.promise;
    this.handshake.done = true;
    return this;
  }

  async nextMessage(timeoutMs) {
    if (this.messages.length) return this.messages.shift();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        timeoutMs,
      );
      this.waiters.push((text) => {
        clearTimeout(timer);
        resolve(text);
      });
    });
  }
}

function fail(message) {
  console.error("FAIL " + message);
  process.exit(1);
}

async function expectFrame(client, label) {
  // The events socket carries other frames too (settings hello, agent
  // status, ...); wait for the notes_changed one specifically.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const text = await client.nextMessage(15000);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (value && value.type === "notes_changed") {
      if (!Array.isArray(value.notes) || value.notes.length !== 1)
        fail(`${label}: notes array missing or wrong length`);
      const note = value.notes[0];
      if (!note.display_title) fail(`${label}: display_title missing from the frame`);
      if (!Array.isArray(value.languages) || value.languages.length !== 14)
        fail(
          `${label}: language table missing from the frame (len=${value.languages && value.languages.length})`,
        );
      const rust = value.languages.find((e) => e.value === "rust");
      if (!rust || rust.label !== "Rust" || rust.ext !== "rs")
        fail(`${label}: rust entry wrong in the language table`);
      return note;
    }
  }
  fail(`${label}: no notes_changed frame within the deadline`);
}

const one = await new WsClient().connect(wsUrl);
const two = await new WsClient().connect(wsUrl);
console.log("ok   two subscribers connected to /ws/events");

// Create a note with an empty title and multi-line content: the frame's
// display_title must be the first content line, resolved by the server.
const create = await fetch(`${baseUrl}/api/notes`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `herdr_web_session=${session}` },
  body: JSON.stringify({
    title: "",
    content: "probe first line\nprobe second line",
    language: "rust",
  }),
});
if (create.status !== 201) fail("create returned " + create.status);
const created = await create.json();
if (typeof created.created_note_id !== "string" || !created.created_note_id)
  fail("create response lacks created_note_id");
console.log("ok   created_note_id in the create response: " + created.created_note_id.slice(0, 12) + "...");
if (!Array.isArray(created.languages) || created.languages.length !== 14)
  fail("create response lacks the language table");
const frameOne = await expectFrame(one, "subscriber 1");
const frameTwo = await expectFrame(two, "subscriber 2");
if (frameOne.id !== created.created_note_id || frameTwo.id !== created.created_note_id)
  fail("frame does not carry the created note id");
if (frameOne.display_title !== "probe first line")
  fail(
    "display_title did not fall back to the first content line: " +
      JSON.stringify(frameOne.display_title),
  );
console.log("ok   both subscribers got the frame with display_title fallback resolved");
console.log("==> broadcast contract probe: PASSED");
process.exit(0);