// Vertical (9:16) layout plans. A plan says which part(s) of the 16:9 source go where.
// Boxes are normalised: x,y = centre (0..1 of source width/height), w = width fraction.
import { clamp } from './util.js';

export const OUT_W = 1080;
export const OUT_H = 1920;

export const LAYOUTS = {
  auto: 'อัตโนมัติ (AI เลือกให้)',
  track: 'ตามหน้าคนพูด',
  center: 'ครอปเต็มจอ (เลื่อนเอง)',
  split: 'แบ่งจอบน-ล่าง 2 คน',
  stream: 'เกม + เฟซแคม',
  fit: 'ย่อพอดีจอ + เบลอพื้นหลัง',
};

export const PANELS = {
  main: { y: 0, h: OUT_H },
  a: { y: 0, h: OUT_H / 2 },
  b: { y: OUT_H / 2, h: OUT_H / 2 },
  cam: { y: 0, h: Math.round(OUT_H * 0.4) },
  game: { y: Math.round(OUT_H * 0.4), h: OUT_H - Math.round(OUT_H * 0.4) },
};
export const aspectOf = (key) => OUT_W / PANELS[key].h;

/** Width fraction of a full-height crop with the given panel aspect. */
export const fullHeightW = (aspect, W, H) => Math.min(1, (H * aspect) / W);

export function boxRect(box, aspect, W, H) {
  let sw = clamp(box.w, 0.03, 1) * W;
  let sh = sw / aspect;
  if (sh > H) { sh = H; sw = sh * aspect; }
  if (sw > W) { sw = W; sh = sw / aspect; }
  const sx = clamp(box.x * W - sw / 2, 0, W - sw);
  const sy = clamp(box.y * H - sh / 2, 0, H - sh);
  return { sx, sy, sw, sh };
}

export function interpKeys(keys, t, cut = 0.2) {
  if (!keys || !keys.length) return 0.5;
  if (t <= keys[0].t) return keys[0].x;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.x;
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (keys[m].t <= t) lo = m; else hi = m;
  }
  const a = keys[lo];
  const b = keys[hi];
  if (Math.abs(b.x - a.x) > cut) return t < b.t - 0.04 ? a.x : b.x; // camera cut: jump, don't pan
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const s = u * u * (3 - 2 * u);
  return a.x + (b.x - a.x) * s;
}

/** Returns the boxes a plan uses at source time t: [{key, aspect, box}] */
export function planBoxes(plan, W, H, t = 0) {
  if (!plan) return [];
  const mainW = fullHeightW(aspectOf('main'), W, H);
  switch (plan.mode) {
    case 'track':
      return [{ key: 'main', aspect: aspectOf('main'), box: { x: interpKeys(plan.keys, t, mainW * 0.9), y: plan.y ?? 0.5, w: mainW / (plan.zoom || 1) } }];
    case 'center':
      return [{ key: 'main', aspect: aspectOf('main'), box: { x: plan.x ?? 0.5, y: plan.y ?? 0.5, w: mainW / (plan.zoom || 1) } }];
    case 'split':
      return [{ key: 'a', aspect: aspectOf('a'), box: plan.a }, { key: 'b', aspect: aspectOf('b'), box: plan.b }];
    case 'stream':
      return [{ key: 'cam', aspect: aspectOf('cam'), box: plan.cam }, { key: 'game', aspect: aspectOf('game'), box: plan.game }];
    default:
      return [];
  }
}

/** Builds a plan for a chosen layout, reusing what face analysis found when possible. */
export function planFor(mode, W, H, auto, contentType) {
  const det = auto?.detected || {};
  switch (mode) {
    case 'auto':
      return auto?.plan ? structuredClone(auto.plan) : defaultAuto(W, H, contentType);
    case 'track':
      if (auto?.plan?.mode === 'track') return structuredClone(auto.plan);
      return { mode: 'track', keys: det.trackKeys || [{ t: 0, x: det.main?.x ?? 0.5 }], zoom: 1 };
    case 'center':
      return { mode: 'center', x: det.main?.x ?? 0.5, y: 0.5, zoom: 1 };
    case 'split': {
      const a = det.faces?.[0];
      const b = det.faces?.[1];
      return {
        mode: 'split',
        a: a ? faceBox(a, aspectOf('a'), W, H) : { x: 0.27, y: 0.45, w: 0.42 },
        b: b ? faceBox(b, aspectOf('b'), W, H) : { x: 0.73, y: 0.45, w: 0.42 },
      };
    }
    case 'stream':
      return {
        mode: 'stream',
        cam: det.cam ? camBox(det.cam, W, H) : { x: 0.14, y: 0.2, w: 0.26 },
        game: { x: 0.5, y: 0.5, w: fullHeightW(aspectOf('game'), W, H) },
      };
    case 'fit':
    default:
      return { mode: 'fit' };
  }
}

export function defaultAuto(W, H, contentType) {
  if (W / H < 0.8) return { mode: 'center', x: 0.5, y: 0.5, zoom: 1 };
  return contentType === 'gaming' ? { mode: 'fit' } : { mode: 'center', x: 0.5, y: 0.5, zoom: 1 };
}

/** Box around a detected face for a panel of the given aspect (face in the upper-middle). */
export function faceBox(f, aspect, W, H) {
  const faceH = f.h * H;
  let bh = clamp(faceH * 3.2, H * 0.32, H);
  let bw = bh * aspect;
  if (bw > W) { bw = W; bh = bw / aspect; }
  return { x: f.x, y: clamp((f.y * H + faceH * 0.45) / H, 0, 1), w: bw / W };
}

/** Box around a facecam overlay (face plus some shoulders). */
export function camBox(f, W, H) {
  const aspect = aspectOf('cam');
  const faceH = f.h * H;
  let bh = clamp(faceH * 2.4, H * 0.12, H * 0.6);
  let bw = bh * aspect;
  return { x: f.x, y: clamp((f.y * H + faceH * 0.25) / H, 0, 1), w: Math.min(1, bw / W) };
}
