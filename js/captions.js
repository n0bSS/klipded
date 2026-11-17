// Caption chunking and drawing (big bold "karaoke" captions with the spoken word highlighted).
import { visLen } from './util.js';
import { OUT_W, OUT_H } from './layout.js';

export const CAPTION_STYLES = {
  pop: { name: 'ป็อป (ขาว/เหลือง)', fill: '#FFFFFF', active: '#FFE14D', stroke: '#000000', strokeW: 0.17, shadow: 'rgba(0,0,0,0.55)' },
  box: { name: 'กล่องไฮไลต์', fill: '#FFFFFF', active: '#FFFFFF', activeBg: '#FF3D8B', stroke: '#000000', strokeW: 0.14, shadow: 'rgba(0,0,0,0.5)' },
  neon: { name: 'นีออน Vice City', fill: '#FFFFFF', active: '#3DE0FF', stroke: '#2A0B3D', strokeW: 0.16, glow: '#FF3D8B' },
  clean: { name: 'มินิมอล', fill: '#FFFFFF', active: '#FFA53A', stroke: null, strokeW: 0, shadow: 'rgba(0,0,0,0.9)' },
  none: { name: 'ไม่ใส่ซับ' },
};

export const CHUNK_SIZES = { short: 12, normal: 18, long: 26 };

/** Groups timed tokens into caption chunks (absolute source times). */
export function makeChunks(tokens, start, end, maxChars = 18) {
  const toks = tokens.filter((t) => t.end > start + 0.05 && t.start < end - 0.05);
  const chunks = [];
  let cur = null;
  for (const t of toks) {
    const len = visLen(t.text);
    const prev = cur && cur.tokens[cur.tokens.length - 1];
    const brk = !cur
      || cur.len + len + (t.sp ? 1 : 0) > maxChars
      || t.start - prev.end > 0.55
      || t.end - cur.start > 2.8
      || /[.!?…。！？]$/.test(prev.text);
    if (brk) {
      cur = { start: t.start, end: t.end, tokens: [{ ...t }], len };
      chunks.push(cur);
    } else {
      cur.tokens.push({ ...t });
      cur.end = t.end;
      cur.len += len + (t.sp ? 1 : 0);
    }
  }
  for (let i = 0; i < chunks.length; i++) {
    const nx = chunks[i + 1];
    const c = chunks[i];
    if (nx && nx.start - c.end < 0.7) c.end = nx.start;
    else c.end = Math.min(c.end + 0.35, nx ? nx.start : end);
    delete c.len;
  }
  return chunks;
}

export function chunkText(c) {
  return c.tokens.map((t, i) => (i && t.sp ? ' ' : '') + t.text).join('');
}

const FONT_STACK = '"Kanit", "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif';

function layoutLines(ctx, tokens, size, maxW, upper) {
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  // a little extra room so outlines and the "pop" of the active word never touch neighbours
  const space = ctx.measureText(' ').width + size * 0.16;
  const lines = [];
  let line = { items: [], w: 0 };
  for (const t of tokens) {
    const text = upper ? t.text.toUpperCase() : t.text;
    const w = ctx.measureText(text).width;
    const gap = line.items.length && t.sp ? space : 0;
    if (line.items.length && line.w + gap + w > maxW) {
      lines.push(line);
      line = { items: [], w: 0 };
    }
    const g = line.items.length && t.sp ? space : 0;
    line.items.push({ t, text, w, gap: g });
    line.w += g + w;
  }
  if (line.items.length) lines.push(line);
  return lines;
}

/**
 * Draws the caption chunk active at source time t.
 * opts: { style, size, y (0..1 of height), upper }
 */
export function drawCaptions(ctx, chunks, t, opts) {
  const st = CAPTION_STYLES[opts.style] || CAPTION_STYLES.pop;
  if (!st.fill || !chunks?.length) return;
  const c = chunks.find((x) => t >= x.start && t < x.end);
  if (!c) return;
  const maxW = OUT_W - 150;
  let size = opts.size || 84;
  let lines = layoutLines(ctx, c.tokens, size, maxW, opts.upper);
  while (lines.length > 2 && size > 46) {
    size = Math.round(size * 0.9);
    lines = layoutLines(ctx, c.tokens, size, maxW, opts.upper);
  }
  const lineH = size * 1.32;
  const totalH = lines.length * lineH;
  let y = (opts.y ?? 0.68) * OUT_H - totalH / 2 + lineH / 2;

  let activeIdx = -1;
  c.tokens.forEach((tok, i) => { if (t >= tok.start - 0.02) activeIdx = i; });

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  let idx = 0;
  for (const line of lines) {
    let x = OUT_W / 2 - line.w / 2;
    for (const it of line.items) {
      x += it.gap;
      const isActive = idx === activeIdx;
      const pop = isActive ? 1 + 0.06 * Math.min(1, (t - it.t.start) / 0.12) : 1;
      ctx.save();
      ctx.translate(x + it.w / 2, y);
      ctx.scale(pop, pop);
      ctx.font = `800 ${size}px ${FONT_STACK}`;
      if (isActive && st.activeBg) {
        const padX = size * 0.16;
        const h = size * 1.18;
        ctx.fillStyle = st.activeBg;
        roundRect(ctx, -it.w / 2 - padX, -h / 2, it.w + padX * 2, h, size * 0.2);
        ctx.fill();
      }
      if (st.glow) { ctx.shadowColor = st.glow; ctx.shadowBlur = size * 0.35; }
      else if (st.shadow) { ctx.shadowColor = st.shadow; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.05; }
      if (st.stroke && st.strokeW) {
        ctx.strokeStyle = st.stroke;
        ctx.lineWidth = size * st.strokeW;
        ctx.strokeText(it.text, -it.w / 2, 0);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = isActive ? st.active : st.fill;
      ctx.fillText(it.text, -it.w / 2, 0);
      ctx.restore();
      x += it.w;
      idx++;
    }
    y += lineH;
  }
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Big hook title shown during the first seconds. */
export function drawHook(ctx, text, tRel, opts) {
  const dur = opts.hookSec || 3;
  if (!text || tRel > dur) return;
  const alpha = tRel > dur - 0.3 ? Math.max(0, (dur - tRel) / 0.3) : 1;
  const size = 62;
  const maxW = OUT_W - 160;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px ${FONT_STACK}`;
  const words = [];
  const seg = new Intl.Segmenter('th', { granularity: 'word' });
  for (const s of seg.segment(text)) words.push(s.segment);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line + w;
    if (line && ctx.measureText(test).width > maxW) { lines.push(line.trim()); line = w.trimStart(); } else line = test;
  }
  if (line.trim()) lines.push(line.trim());
  const shown = lines.slice(0, 3);
  const lineH = size * 1.3;
  const boxW = Math.min(OUT_W - 100, Math.max(...shown.map((l) => ctx.measureText(l).width)) + 70);
  const boxH = shown.length * lineH + 40;
  const cy = (opts.hookY ?? 0.2) * OUT_H;
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24;
  roundRect(ctx, OUT_W / 2 - boxW / 2, cy - boxH / 2, boxW, boxH, 26);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  shown.forEach((l, i) => ctx.fillText(l, OUT_W / 2, cy - boxH / 2 + 20 + lineH * (i + 0.5)));
  ctx.restore();
}

export function drawWatermark(ctx, text) {
  if (!text) return;
  ctx.save();
  ctx.font = `700 38px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeText(text, OUT_W / 2, OUT_H * 0.115);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, OUT_W / 2, OUT_H * 0.115);
  ctx.restore();
}

export async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load(`800 80px "Kanit"`, 'กขAa'),
      document.fonts.load(`700 40px "Kanit"`, 'กขAa'),
    ]);
  } catch {}
}
