// cli/render.js — compose several @xterm/headless terminals into a grid that fills
// the host terminal, like the cnos web grid: every agent gets a live pane with a
// header, all visible at once. Pure + testable — renderFrame() returns the full
// ANSI frame string. cnos.js feeds each agent's bytes into its headless Terminal
// (sized to its pane), so the pane is a faithful 1:1 view of that agent's screen.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

export function makeTerm(cols, rows) {
  return new Terminal({ cols: Math.max(2, cols | 0), rows: Math.max(1, rows | 0), scrollback: 2000, allowProposedApi: true });
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
// Split `total` cells into `k` parts (>=1 each), reserving `gap` cells between parts;
// any remainder goes to the last part so the parts + gaps exactly fill `total`.
function splitSpan(total, k, gap) {
  const avail = Math.max(k, total - gap * (k - 1));
  const base = Math.floor(avail / k);
  const arr = Array(k).fill(base);
  arr[k - 1] += avail - base * k;
  return arr;
}

// Pick a near-web grid: as many columns as fit at >= minW, then rows; the last row
// stretches its (possibly fewer) panes across the full width. Returns pane rects
// (x,y,w,h are 0-based screen cells) with inner content size (header takes 1 row).
export function computeLayout(n, W, H, opts = {}) {
  const minW = opts.minW || 32, gap = 1;
  if (n <= 0) return { cols: 0, rows: 0, W, H, panes: [] };
  const maxCols = Math.max(1, Math.floor((W + gap) / (minW + gap)));
  const cols = Math.min(n, maxCols);
  const rows = Math.ceil(n / cols);
  const rowH = splitSpan(H, rows, 0);
  const panes = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const cThis = Math.min(cols, n - idx);
    const colW = splitSpan(W, cThis, gap);
    const y = sum(rowH.slice(0, r));
    let x = 0;
    for (let c = 0; c < cThis; c++) {
      const w = colW[c], h = rowH[r];
      panes.push({ x, y, w, h, innerCols: Math.max(2, w), innerRows: Math.max(1, h - 1) });
      x += w + gap;
      idx++;
    }
  }
  return { cols, rows, W, H, panes };
}

const move = (row, col) => `\x1b[${row + 1};${col + 1}H`;     // 0-based -> 1-based CUP

// SGR parameter list for one buffer cell (color + attributes).
function sgrFor(c) {
  const p = [];
  if (c.isInverse()) p.push(7);
  if (c.isBold()) p.push(1);
  if (c.isDim()) p.push(2);
  if (c.isItalic()) p.push(3);
  if (c.isUnderline()) p.push(4);
  if (c.isStrikethrough && c.isStrikethrough()) p.push(9);
  if (c.isFgRGB()) { const v = c.getFgColor(); p.push(38, 2, (v >> 16) & 255, (v >> 8) & 255, v & 255); }
  else if (c.isFgPalette()) p.push(38, 5, c.getFgColor());
  if (c.isBgRGB()) { const v = c.getBgColor(); p.push(48, 2, (v >> 16) & 255, (v >> 8) & 255, v & 255); }
  else if (c.isBgPalette()) p.push(48, 5, c.getBgColor());
  return p.join(';');
}

// One pane content row -> ANSI (exactly `width` cells wide), minimal SGR changes.
function rowAnsi(buf, y, width) {
  const line = buf.getLine(buf.baseY + y);
  if (!line) return '\x1b[0m' + ' '.repeat(width);
  let out = '\x1b[0m', cur = '', x = 0;
  while (x < width) {
    const cell = line.getCell(x);
    if (!cell) { if (cur) { out += '\x1b[0m'; cur = ''; } out += ' '; x++; continue; }
    const w = cell.getWidth();
    if (w === 0) { x++; continue; }                  // spillover of a preceding wide char
    if (w === 2 && x + 2 > width) { out += ' '; x++; continue; } // wide char won't fit at edge
    const sgr = sgrFor(cell);
    if (sgr !== cur) { out += sgr ? `\x1b[0;${sgr}m` : '\x1b[0m'; cur = sgr; }
    out += cell.getChars() || ' ';
    x += w === 2 ? 2 : 1;
  }
  return out + '\x1b[0m';
}

// Paint the agent panes. `agents[i]` (with .term/.name/.type) maps to panes[i]; the
// focused pane gets a highlighted header. Returns { paint, cursor } where `paint` is
// absolute-positioned cell output (no screen-clear, no sync wrap — the caller composes
// the full frame, e.g. grid + command bar) and `cursor` is [row,col] of the focused
// pane's cursor (0-based) or null. accent = SGR color for the focused header.
export function renderFrame(agents, layout, focusIdx, opts = {}) {
  const { panes, W } = layout;
  const accent = opts.accent || '36';
  let s = '';
  let cursor = null;

  for (let i = 0; i < panes.length; i++) {
    const p = panes[i], a = agents[i], focused = i === focusIdx;
    const tag = a ? ` ${i + 1} ${a.name}${a.type ? ' · ' + a.type : ''}${a.promptLabel ? ' · ' + a.promptLabel : ''} ` : ' — ';
    const label = (tag.length > p.w ? tag.slice(0, p.w) : tag.padEnd(p.w));
    s += move(p.y, p.x) + (focused ? `\x1b[1;7;${accent}m` : '\x1b[7;2m') + label + '\x1b[0m';
    if (a && a.term) {
      const buf = a.term.buffer.active;
      for (let y = 0; y < p.h - 1; y++) s += move(p.y + 1 + y, p.x) + rowAnsi(buf, y, p.w);
      if (focused) {
        const cx = Math.max(0, Math.min(p.w - 1, buf.cursorX));
        const cy = Math.max(0, Math.min(p.h - 2, buf.cursorY));
        cursor = [p.y + 1 + cy, p.x + cx];
      }
    } else {
      for (let y = 0; y < p.h - 1; y++) s += move(p.y + 1 + y, p.x) + ' '.repeat(p.w);
    }
    const gx = p.x + p.w;                              // separator column (not at screen edge)
    if (gx < W) for (let y = 0; y < p.h; y++) s += move(p.y + y, gx) + '\x1b[0;2m│\x1b[0m';
  }
  return { paint: s, cursor };
}

export const cup = move;   // 0-based cursor position helper for the caller's command bar
