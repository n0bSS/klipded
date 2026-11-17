// Post-processing of AI clip suggestions: clamp, snap to sentence/word boundaries,
// enforce length limits and remove overlaps.
import { clamp } from './util.js';

const r2 = (x) => Math.round(x * 100) / 100;

function nearest(values, x, maxDist) {
  let best = null;
  let bd = maxDist;
  for (const v of values) {
    const d = Math.abs(v - x);
    if (d <= bd) { bd = d; best = v; }
  }
  return best;
}

export function refineClips(raw, tr, { minSec, maxSec, duration }) {
  const segs = tr?.segments || [];
  const toks = tr?.tokens || [];
  const segStarts = segs.map((s) => s.start);
  const segEnds = segs.map((s) => s.end);
  const out = [];
  for (const c of raw || []) {
    let s = clamp(Number(c.start) || 0, 0, duration);
    let e = clamp(Number(c.end) || 0, 0, duration);
    if (e - s < 3) continue;

    const ss = nearest(segStarts, s, 3);
    if (ss !== null) s = ss;
    const ee = nearest(segEnds, e, 3);
    if (ee !== null) e = ee;

    if (e - s > maxSec + 3) {
      const cand = segs.filter((x) => x.end > s + minSec && x.end <= s + maxSec).pop();
      e = cand ? cand.end : s + maxSec;
    }
    if (e - s < Math.min(minSec, duration) - 3) {
      const cand = segs.find((x) => x.end >= s + minSec && x.end <= s + maxSec);
      if (cand) e = cand.end;
      else e = Math.min(duration, s + minSec);
    }

    // Fine snap with word timings: start just before the first word, end just after the last.
    const first = toks.find((t) => t.end > s + 0.05);
    if (first && first.start - s < 1.2 && first.start >= s - 1.2) s = first.start - 0.12;
    let last = null;
    for (const t of toks) { if (t.start < e - 0.05) last = t; else break; }
    if (last && e - last.end < 1.5 && last.end - e < 1.2) e = last.end + 0.35;

    s = clamp(s, 0, duration);
    e = clamp(e, s + 1, duration);
    out.push({ ...c, start: r2(s), end: r2(e) });
  }
  out.sort((a, b) => (b.score || 0) - (a.score || 0));
  const kept = [];
  for (const c of out) {
    if (!kept.some((k) => Math.min(k.end, c.end) - Math.max(k.start, c.start) > 1.5)) kept.push(c);
  }
  const stamp = Date.now().toString(36);
  return kept.map((c, i) => ({
    id: `c${stamp}${i}`,
    title: c.title || `คลิป ${i + 1}`,
    hook: c.hook || '',
    caption: c.caption || '',
    hashtags: c.hashtags || [],
    reason: c.reason || '',
    score: Math.round(Number(c.score) || 0),
    start: c.start,
    end: c.end,
  }));
}

export function lengthRange(key) {
  return { short: [15, 30], mid: [30, 60], long: [60, 90] }[key] || [30, 60];
}
