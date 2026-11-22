// Shared terminal input/paste plumbing.
//
// desktop/app_js/terminal.js and mobile/terminal.js kept two copies of
// the input WebSocket send path: chunked sendInputData with a buffered-
// amount queue, and the desktop chunked paste pipeline (CR/LF
// normalization, frame budget, progress callbacks) that mobile sends
// through the same queue in one shot. createTerminalInput({ ws, encoder,
// stripMouseReports }) owns both; the host keeps its socket, mouse-report
// stripping, and paste progress UI.
(function (root) {
  const DEFAULT_CHUNK = 16 * 1024;
  const DEFAULT_MAX_BUFFERED = 65536;

  function createTerminalInput({ ws, encode, stripMouseReports, progress }) {
    // ws(): live socket getter (readiness checked per call)
    // encode(s): TextEncoder.encode
    // stripMouseReports(data, opts): optional input filter
    // progress: { show(total), update(done,total), hide() } paste UI
    let queue = [];
    let maxBuffered = DEFAULT_MAX_BUFFERED;
    let flushTimer = null;
    let pasteJob = null;
    let pasteTimer = null;
    let pasteFrameUntil = 0;
    let pasteHideTimer = null;

    // Desktop paste rhythm: flush in ~4ms frames, stop feeding the socket
    // above 128KiB buffered, keep one paste "frame" alive so a program
    // reading line-by-line does not see half-finished lines.
    const PASTE_FLUSH_DELAY_MS = 4;
    const PASTE_BUFFER_LIMIT = 128 * 1024;
    const PASTE_TEXT_CHUNK_SIZE = 4096;
    const PASTE_BYTE_CHUNK_SIZE = 16 * 1024;
    const PASTE_FLUSH_BUDGET_MS = 8;

    function socket() {
      const s = typeof ws === "function" ? ws() : ws;
      return s && s.readyState === 1 ? s : null;
    }

    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(flushQueue, 4);
    }

    function flushQueue() {
      flushTimer = null;
      const s = socket();
      if (!s) {
        queue = [];
        maxBuffered = DEFAULT_MAX_BUFFERED;
        return;
      }
      while (queue.length && s.bufferedAmount < maxBuffered) s.send(queue.shift());
      if (queue.length) scheduleFlush();
      else maxBuffered = DEFAULT_MAX_BUFFERED;
    }

    function sendInputData(data, inputOptions = {}) {
      const s = socket();
      if (!s || !data) return;
      if (!inputOptions.allowMouseReports && stripMouseReports)
        data = stripMouseReports(data);
      if (!data) return;
      const bytes = encode(data);
      const chunkSize = inputOptions.chunkSize || DEFAULT_CHUNK;
      const limit = inputOptions.maxBufferedAmount || DEFAULT_MAX_BUFFERED;
      if (bytes.length <= chunkSize && queue.length === 0 && s.bufferedAmount < limit) {
        s.send(bytes);
        return;
      }
      for (let i = 0; i < bytes.length; i += chunkSize)
        queue.push(bytes.slice(i, i + chunkSize));
      maxBuffered = Math.max(maxBuffered, limit);
      flushQueue();
    }

    // Desktop-style chunked paste with a paste frame. Sends whole lines
    // where possible (a trailing bare CR waits for the next chunk), shows
    // progress through the host callbacks, and hides when done.
    function sendPaste(text, opts = {}) {
      const s = socket();
      if (!s || !text) return;
      const value = String(text || "");
      if (!value) return;
      if (pasteJob) {
        pasteJob.text += value;
        pasteJob.total = pasteJob.text.length;
      } else {
        pasteJob = { text: value, offset: 0, total: value.length, pendingCR: false };
      }
      pasteFrameUntil = Date.now() + Math.max(400, Math.min(8000, Math.ceil(pasteJob.total / 128)));
      if (progress) progress.show(pasteJob.total);
      schedulePasteFlush(0);
    }

    function schedulePasteFlush(delay = PASTE_FLUSH_DELAY_MS) {
      if (pasteTimer) return;
      pasteTimer = setTimeout(flushPaste, delay);
    }

    // A trailing bare CR could land at a chunk edge and double as the
    // frame's Enter: hold it back for the next chunk (or the final flush,
    // where it goes out alone).
    function normalizePasteChunk(job, chunk, isFinal) {
      if (job.pendingCR) {
        chunk = "\r" + chunk;
        job.pendingCR = false;
      }
      if (!isFinal && chunk.endsWith("\r")) {
        chunk = chunk.slice(0, -1);
        job.pendingCR = true;
      }
      return chunk.replace(/\r\n|\r/g, "\n");
    }

    function flushPaste() {
      pasteTimer = null;
      if (!pasteJob) return;
      const s = socket();
      if (!s) {
        pasteJob = null;
        pasteFrameUntil = 0;
        if (progress) progress.hide();
        return;
      }
      const start = Date.now();
      while (
        pasteJob &&
        pasteJob.offset < pasteJob.total &&
        s.bufferedAmount < PASTE_BUFFER_LIMIT
      ) {
        const end = Math.min(pasteJob.total, pasteJob.offset + PASTE_TEXT_CHUNK_SIZE);
        const rawChunk = pasteJob.text.slice(pasteJob.offset, end);
        pasteJob.offset = end;
        const chunk = normalizePasteChunk(pasteJob, rawChunk, pasteJob.offset >= pasteJob.total);
        if (chunk) {
          const bytes = encode(chunk);
          for (let i = 0; i < bytes.length; i += PASTE_BYTE_CHUNK_SIZE)
            s.send(bytes.slice(i, i + PASTE_BYTE_CHUNK_SIZE));
        }
        if (progress) progress.update(pasteJob.offset, pasteJob.total);
        if (Date.now() - start >= PASTE_FLUSH_BUDGET_MS) break;
      }
      if (!pasteJob) return;
      if (pasteJob.offset >= pasteJob.total) {
        pasteJob = null;
        if (progress) progress.update(1, 1);
        if (progress) {
          pasteHideTimer = setTimeout(() => {
            pasteHideTimer = null;
            pasteFrameUntil = 0;
            progress.hide();
          }, 250);
        }
        return;
      }
      schedulePasteFlush(s.bufferedAmount >= PASTE_BUFFER_LIMIT ? PASTE_FLUSH_DELAY_MS : 0);
    }

    function pasteActive() {
      return !!pasteJob;
    }

    // Socket loss or teardown: drop the paste frame and queued input so
    // the next attach starts clean.
    function reset() {
      queue = [];
      pasteJob = null;
      pasteFrameUntil = 0;
      if (pasteTimer) {
        clearTimeout(pasteTimer);
        pasteTimer = null;
      }
      if (pasteHideTimer) {
        clearTimeout(pasteHideTimer);
        pasteHideTimer = null;
      }
      if (progress) progress.hide();
    }

    return {
      sendInputData,
      sendPaste,
      flushQueue,
      scheduleFlush,
      pasteActive,
      reset,
      // Exposed for unit tests of the chunk-boundary CR/LF rule.
      normalizePasteChunk,
      constants: {
        PASTE_FLUSH_DELAY_MS,
        PASTE_BUFFER_LIMIT,
        PASTE_TEXT_CHUNK_SIZE,
        PASTE_BYTE_CHUNK_SIZE,
        PASTE_FLUSH_BUDGET_MS,
        DEFAULT_CHUNK,
        DEFAULT_MAX_BUFFERED,
      },
    };
  }

  root.HerdrTerminalInput = { createTerminalInput };
  if (typeof module !== "undefined" && module.exports) module.exports = root.HerdrTerminalInput;
})(typeof globalThis !== "undefined" ? globalThis : window);