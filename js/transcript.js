// Transcript helpers: merge chunked speech-to-text results, clean them, build display
// tokens (works for Thai, which has no spaces, via Intl.Segmenter) and the text sent to
// the AI clip picker.
import { isThaiChar, visLen } from './util.js';

const LANG_MAP = { thai: 'th', english: 'en', th: 'th', en: 'en' };
export const normLang = (l) => LANG_MAP[String(l || '').toLowerCase()] || String(l || '').slice(0, 2).toLowerCase();

const HALLUCINATION = /^(\s*(thank you( so much)?( for watching)?|thanks for watching|please subscribe|subtitles? by.*|ขอบคุณ(ที่รับชม|ครับ|ค่ะ)?|โปรดติดตามตอนต่อไป|ฝากกดติดตาม.*|ซับไตเติ้ล.*)[.!\s]*)$/i;

/**
 * results: [{ start, own:[a,b], data:{ language, segments:[{s,e,t,nsp}], words:[{w,s,e}] } }]
 * Returns { language, segments:[{start,end,text}], words:[{w,start,end}] } in source time.
 */
export function mergeChunks(results) {
  const segments = [];
  const words = [];
  const langCount = {};
  for (const r of [...results].sort((a, b) => a.start - b.start)) {
    const off = r.start;
    const [a, b] = r.own;
    const lang = normLang(r.data.language);
    if (lang) langCount[lang] = (langCount[lang] || 0) + 1;
    const dropped = [];
    for (const s of r.data.segments || []) {
      const start = off + s.s;
      const end = off + s.e;
      if (start < a - 0.01 || start >= b) continue;
      const text = String(s.t || '').trim();
      if (!text || (s.nsp > 0.6 && HALLUCINATION.test(text)) || s.nsp > 0.92) {
        dropped.push([start, end]);
        continue;
      }
      segments.push({ start, end, text });
    }
    for (const w of r.data.words || []) {
      const start = off + w.s;
      const end = off + w.e;
      if (start < a - 0.01 || start >= b) continue;
      if (dropped.some(([x, y]) => start >= x - 0.05 && start < y + 0.05)) continue;
      words.push({ w: w.w, start, end: Math.max(end, start + 0.02) });
    }
  }
  segments.sort((x, y) => x.start - y.start);
  words.sort((x, y) => x.start - y.start);
  const language = Object.entries(langCount).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  return { language, segments, words };
}

let segmenter;
const seg = () => (segmenter ||= new Intl.Segmenter('th', { granularity: 'word' }));

/** Splits text into display tokens [{text, sp}] (sp = space before). */
export function tokenizeText(text) {
  const out = [];
  const str = String(text || '');
  for (const s of seg().segment(str)) {
    const t = s.segment;
    if (/^\s+$/.test(t)) continue;
    const sp = s.index > 0 && /\s/.test(str[s.index - 1]);
    if (!s.isWordLike && out.length && !sp && !/^[("'“‘\[]/.test(t)) {
      out[out.length - 1].text += t;
      continue;
    }
    out.push({ text: t, sp });
  }
  return out;
}

/**
 * Builds timed display tokens from STT words. Characters inherit the time of the word they
 * came from, then the text is re-segmented into real words, so Thai (no spaces) gets sensible
 * word boundaries and English keeps its spacing.
 */
export function buildTokens(words, segments = []) {
  if (!words.length && segments.length) words = wordsFromSegments(segments);
  let text = '';
  const times = [];
  for (const w of words) {
    let str = String(w.w ?? '');
    if (!str) continue;
    const prev = text[text.length - 1];
    const first = str[0];
    if (prev && !/\s/.test(prev) && !/\s/.test(first) && !(isThaiChar(prev) && isThaiChar(first)) && /[\p{L}\p{N}]/u.test(first)) {
      str = ' ' + str;
    }
    const n = str.length;
    const dur = Math.max(0.02, w.end - w.start);
    for (let i = 0; i < n; i++) {
      text += str[i];
      times.push([w.start + (dur * i) / n, w.start + (dur * (i + 1)) / n]);
    }
  }
  const tokens = [];
  for (const s of seg().segment(text)) {
    const t = s.segment;
    if (/^\s+$/.test(t)) continue;
    const i0 = s.index;
    const i1 = s.index + t.length - 1;
    const sp = i0 > 0 && /\s/.test(text[i0 - 1]);
    const start = times[i0][0];
    const end = times[i1][1];
    if (!s.isWordLike && tokens.length && !sp && !/^[("'“‘\[]/.test(t)) {
      const p = tokens[tokens.length - 1];
      p.text += t;
      p.end = Math.max(p.end, end);
      continue;
    }
    tokens.push({ text: t.trim(), start, end, sp });
  }
  for (let i = 1; i < tokens.length; i++) if (tokens[i].start < tokens[i - 1].start) tokens[i].start = tokens[i - 1].start;
  return tokens;
}

function wordsFromSegments(segments) {
  const out = [];
  for (const s of segments) {
    const toks = tokenizeText(s.text);
    const total = toks.reduce((a, t) => a + Math.max(1, visLen(t.text)), 0) || 1;
    let t = s.start;
    for (const tok of toks) {
      const d = ((s.end - s.start) * Math.max(1, visLen(tok.text))) / total;
      out.push({ w: (tok.sp ? ' ' : '') + tok.text, start: t, end: t + d });
      t += d;
    }
  }
  return out;
}

/** Re-times free text across [start,end] proportionally to visible length. */
export function retimeText(text, start, end) {
  const toks = tokenizeText(text);
  const total = toks.reduce((a, t) => a + Math.max(1, visLen(t.text)), 0) || 1;
  let t = start;
  return toks.map((tok) => {
    const d = ((end - start) * Math.max(1, visLen(tok.text))) / total;
    const o = { text: tok.text, start: t, end: t + d, sp: tok.sp };
    t += d;
    return o;
  });
}

/** Text for the AI: "[start-end] text" lines plus loud no-speech moments. */
export function transcriptForAI(tr, energyInfo, maxChars = 380000) {
  const { energy = [], bin = 0.5 } = energyInfo || {};
  const voiced = energy.filter((v) => v > 0.002).sort((a, b) => a - b);
  const p90 = voiced.length ? voiced[Math.floor(voiced.length * 0.9)] : Infinity;
  const loudAt = (s, e) => {
    let sum = 0, n = 0;
    for (let i = Math.floor(s / bin); i <= Math.floor(e / bin) && i < energy.length; i++) { sum += energy[i]; n++; }
    return n ? sum / n : 0;
  };
  const lines = tr.segments.map((s) => ({ s: s.start, e: s.end, text: s.text + (loudAt(s.start, s.end) >= p90 ? ' (loud)' : '') }));

  // Loud stretches without speech (explosions, music drops, screaming crowds...)
  if (Number.isFinite(p90)) {
    const speech = tr.segments;
    let k = 0;
    let runStart = -1;
    for (let i = 0; i <= energy.length; i++) {
      const loud = i < energy.length && energy[i] >= p90 * 1.05;
      if (loud && runStart < 0) runStart = i;
      if (!loud && runStart >= 0) {
        const s = runStart * bin;
        const e = i * bin;
        runStart = -1;
        if (e - s < 1.5) continue;
        while (k < speech.length && speech[k].end < s) k++;
        const overlaps = speech.slice(Math.max(0, k - 1), k + 3).some((x) => x.start < e && x.end > s);
        if (!overlaps) lines.push({ s, e, text: '(no speech, loud action/sound)' });
      }
    }
  }
  lines.sort((a, b) => a.s - b.s);

  let merged = lines;
  let out = render(merged);
  // Very long videos: merge neighbouring lines until it fits the budget.
  let span = 20;
  while (out.length > maxChars && span < 600) {
    merged = mergeLines(lines, span);
    out = render(merged);
    span *= 1.6;
  }
  return out.slice(0, maxChars);

  function render(ls) {
    return ls.map((l) => `[${l.s.toFixed(1)}-${l.e.toFixed(1)}] ${l.text}`).join('\n');
  }
  function mergeLines(ls, maxSpan) {
    const res = [];
    for (const l of ls) {
      const p = res[res.length - 1];
      if (p && l.e - p.s <= maxSpan) { p.e = l.e; p.text += ' ' + l.text; } else res.push({ ...l });
    }
    return res;
  }
}
