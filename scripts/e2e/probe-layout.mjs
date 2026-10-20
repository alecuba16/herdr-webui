// Probe the live KEEP page: box metrics of the scroller chain, why
// scrollTop/scrollHeight read 0. Read-only observation.
import { attach, sleep } from "./cdp-driver-helpers.mjs";
const CDP_PORT = process.env.CDP_PORT;
const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
const cdp = await attach(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
async function ev(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
const info = await ev(`(() => {
  const side = document.querySelector('.file-browser-side');
  if (!side) return { error: 'no side' };
  const panel = document.getElementById('fileBrowserPanel');
  const host = document.getElementById('rightSidebarContent');
  const chain = [];
  let node = side;
  while (node && node.nodeType === 1) {
    const cs = getComputedStyle(node);
    const r = node.getBoundingClientRect();
    chain.push({
      tag: node.tagName.toLowerCase(),
      cls: (node.className || '').toString().slice(0, 40),
      id: node.id || '',
      display: cs.display,
      overflow: cs.overflow,
      height: cs.height,
      visible: cs.visibility,
      hidden: node.hidden,
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
    });
    if (node === document.body) break;
    node = node.parentElement;
  }
  return {
    side: { scrollHeight: side.scrollHeight, clientHeight: side.clientHeight, scrollTop: side.scrollTop },
    layout: document.documentElement.dataset.herdrLayout,
    chain,
  };
})()`);
console.log(JSON.stringify(info, null, 2));