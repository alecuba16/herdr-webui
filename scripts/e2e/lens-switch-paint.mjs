// Final-paint check: cropped screenshots of the switch region prove the
// compositor actually painted it above the lens overlay (DOM hit-tests
// already prove hit order; this proves the rendered pixels).
// Design 6: the switch only shows on jcode panes with a resolvable
// agent_session, so the pane is flipped into a seeded jcode pane first
// (lens-switch-helpers); the pixel proof then runs against that pane.
import { connectToPage } from './cdp-driver.mjs';
import { readShellPid, readShellPwd, seedSession, flipToJcodePane } from './lens-switch-helpers.mjs';
import fs from 'node:fs';

const URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8799/';
const OUT = process.env.VIS_OUT || '/tmp';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdp = await connectToPage();
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: URL });
await sleep(3000);

const created = await cdp.evalExpr(`(async () => {
  try {
    const r = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'lens-paint', cwd: ${JSON.stringify(process.env.ACCEPT_ROOT || '.')} }),
    });
    return await r.json();
  } catch (e) { return { error: String(e) }; }
})()`, true);
const wsId = created && created.result && created.result.workspace && created.result.workspace.workspace_id;
check('create workspace', !!wsId, `wsId=${wsId}`);
if (!wsId) process.exit(1);
await cdp.evalExpr(`go(${JSON.stringify(wsId)})`);
await sleep(2000);

let attached = false;
for (let i = 0; i < 20 && !attached; i++) {
  attached = !!(await cdp.evalExpr(`(() => !!(state.terminalId && document.querySelectorAll('#terminal .term-row').length))()`, true));
  if (!attached) await sleep(500);
}
check('terminal attached', attached);
if (!attached) process.exit(1);

// Design-6 setup: shell pid -> seeded session -> jcode label flip. The
// pixel proof needs the switch visible, which only happens on the
// jcode pane.
const pid = await readShellPid(cdp);
check('read shell pid off the screen', !!pid, `pid=${pid}`);
if (!pid) process.exit(1);
const shellCwd = await readShellPwd(cdp);
check('read shell cwd off the screen', !!shellCwd, `cwd=${shellCwd}`);
if (!shellCwd) process.exit(1);
const { sessionId } = seedSession({ pid, cwd: shellCwd });
const sessionRow = await flipToJcodePane(cdp, { expectSessionId: sessionId });
check('seeded session resolves after jcode label flip',
  !!sessionRow && sessionRow.sid === `session_${sessionId}`, JSON.stringify(sessionRow));
if (!sessionRow) process.exit(1);

// Clip rect around the switch, padded for its shadow/rounded corners.
const clipFor = () => cdp.evalExpr(`(() => {
  const sw = document.getElementById('terminalLensSwitch');
  if (!sw) return null;
  const r = sw.getBoundingClientRect();
  return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8),
    width: Math.min(innerWidth, r.width + 16), height: Math.min(innerHeight, r.height + 16),
    scale: 1 };
})()`, true);

const shot = async (name) => {
  const clip = await clipFor();
  if (!clip) return null;
  const img = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
  const file = `${OUT}/${name}`;
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return file;
};

// Terminal view clip.
const termShot = await shot('switch-terminal.png');
check('terminal-view switch clip captured', !!termShot, termShot || '');

// Flip to Chat, clip again.
await cdp.evalExpr(`document.getElementById('lensToggleChat').click()`, true);
await sleep(600);
const chatShot = await shot('switch-chat.png');
check('chat-view switch clip captured', !!chatShot, chatShot || '');

// Pixel proof (pure Node PNG decode): the switch's own surface colors
// must appear in BOTH clips, and the accent/muted distribution must flip
// between views (active button swaps sides: Terminal active -> Terminal
// accent; Chat active -> Chat accent + Terminal goes muted).
const segBg = await cdp.evalExpr(`getComputedStyle(document.getElementById('terminalLensSwitch')).backgroundColor`, true);
const parseRgb = (s) => s.match(/\d+/g).map(Number);
const zlib = await import('node:zlib');
const struct = {
  u32: (b, o) => b.readUInt32BE(o),
};
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8, w = 0, h = 0, bd = 0, ct = 0, idat = [];
  while (pos < buf.length) {
    const ln = struct.u32(buf, pos);
    const typ = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + ln);
    if (typ === 'IHDR') { w = struct.u32(buf, pos + 8); h = struct.u32(buf, pos + 12); bd = chunk[8]; ct = chunk[9]; }
    if (typ === 'IDAT') idat.push(chunk);
    pos += 12 + ln;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported png depth=${bd} ct=${ct}`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp + 1;
  const out = new Uint8Array(w * h * bpp);
  let prev = new Uint8Array(w * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const line = Uint8Array.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    for (let i = 0; i < line.length; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 0xff;
      }
      line[i] = v;
    }
    prev = line;
    out.set(line, y * w * bpp);
  }
  return { w, h, bpp, px: out };
}
function colorCounts(img) {
  const counts = new Map();
  const pad = 4; // skip clip padding
  for (let y = pad; y < img.h - pad; y++) {
    for (let x = pad; x < img.w - pad; x++) {
      const i = (y * img.w + x) * img.bpp;
      const key = `${img.px[i]},${img.px[i + 1]},${img.px[i + 2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}
const near = (hex, key) => {
  const [r, g, b] = key.split(',').map(Number);
  return Math.abs(r - hex[0]) <= 2 && Math.abs(g - hex[1]) <= 2 && Math.abs(b - hex[2]) <= 2;
};
const segBgHex = parseRgb(segBg);
const termImg = decodePng(fs.readFileSync(termShot));
const chatImg = decodePng(fs.readFileSync(chatShot));
const termCounts = colorCounts(termImg);
const chatCounts = colorCounts(chatImg);
const segInTerm = [...termCounts.entries()].find(([k]) => near(segBgHex, k));
const segInChat = [...chatCounts.entries()].find(([k]) => near(segBgHex, k));
check('switch surface pixels present in terminal-view clip', !!segInTerm, segInTerm ? `${segInTerm[0]} x${segInTerm[1]}` : 'none');
check('switch surface pixels present in chat-view clip (painted above lens)',
  !!segInChat, segInChat ? `${segInChat[0]} x${segInChat[1]}` : 'none');
// Accent pixels exist in both (active button), and the muted-label pixels
// grow in chat view because the inactive Terminal button text is muted
// there (in terminal view it is bold white-on-accent instead).
const mutedKey = [...chatCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  .find((k) => near(parseRgb('rgb(82, 87, 105)'), k));
const mutedInChat = mutedKey ? chatCounts.get(mutedKey) : 0;
const mutedInTerm = mutedKey ? termCounts.get(mutedKey) : 0;
check('inactive-button muted label visible in chat view (state flip in pixels)',
  mutedInChat > 0 && mutedInChat >= mutedInTerm,
  `chat=${mutedInChat} term=${mutedInTerm}`);

// The clips must NOT be byte-identical (lens repainted the background).
check('chat-view clip differs from terminal clip (lens painted around switch)',
  !fs.readFileSync(chatShot).equals(fs.readFileSync(termShot)),
  `term=${fs.statSync(termShot).size}B chat=${fs.statSync(chatShot).size}B`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);