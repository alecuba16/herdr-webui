// Minimal CDP (Chrome DevTools Protocol) driver over WebSocket.
// Uses Node's global WebSocket (Node >= 21; pass NODE_OPTIONS=--experimental-websocket
// or use a polyfill for older versions).
import http from 'node:http';

const CDP_PORT = Number(process.env.CDP_PORT || 9222);

function getJson(path, port = CDP_PORT) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

export async function connectToPage() {
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no CDP page target found (is headless Chrome running?)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, (msg) =>
        msg.error ? rej(new Error(method + ': ' + JSON.stringify(msg.error))) : res(msg.result)
      );
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalExpr = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails)
      throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result?.value;
  };
  return { send, evalExpr, close: () => ws.close() };
}
