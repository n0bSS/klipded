// Face analysis for auto-reframing: MediaPipe face detector (loaded from CDN on demand),
// run on several tiles per frame so small faces (wide podcast shots, facecams) are found.
import { framesAt } from './media.js';
import { median, clamp } from './util.js';
import { aspectOf, fullHeightW, faceBox, camBox, defaultAuto } from './layout.js';

const MP_VER = '1.2.3';
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

let detectorP = null;

export function loadDetector() {
  if (globalThis.__KD_FACE_DETECTOR__) return Promise.resolve(globalThis.__KD_FACE_DETECTOR__); // test hook
  if (!detectorP) {
    detectorP = (async () => {
      const vision = await import(/* @vite-ignore */ MP_URL);
      const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
      const make = (delegate) => vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.5,
      });
      try { return await make('GPU'); } catch { return await make('CPU'); }
    })().catch((e) => { detectorP = null; throw e; });
  }
  return detectorP;
}

const tileCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(384, 384) : null;

function detectTile(detector, src, t) {
  const scale = Math.min(1, 384 / Math.max(t.w, t.h));
  const cw = Math.max(16, Math.round(t.w * scale));
  const ch = Math.max(16, Math.round(t.h * scale));
  const c = tileCanvas || document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, cw, ch);
  const res = detector.detect(c);
  return (res?.detections || []).map((d) => {
    const b = d.boundingBox;
    return {
      x0: t.x + b.originX / scale,
      y0: t.y + b.originY / scale,
      w: b.width / scale,
      h: b.height / scale,
      score: d.categories?.[0]?.score ?? 0.6,
    };
  });
}

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x0 + a.w, b.x0 + b.w);
  const y1 = Math.min(a.y0 + a.h, b.y0 + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

export function detectFaces(detector, canvas, { deep = false } = {}) {
  const W = canvas.width;
  const H = canvas.height;
  const tiles = [{ x: 0, y: 0, w: W, h: H }];
  if (W > H * 1.2) {
    const tw = H;
    for (const fx of [0, 0.5, 1]) tiles.push({ x: (W - tw) * fx, y: 0, w: tw, h: H });
  }
  let all = [];
  for (const t of tiles) all.push(...detectTile(detector, canvas, t));
  if (deep || !all.length) {
    const gw = W / 2.2;
    const gh = H / 1.6;
    for (const fy of [0, 1]) for (const fx of [0, 0.5, 1]) all.push(...detectTile(detector, canvas, { x: (W - gw) * fx, y: (H - gh) * fy, w: gw, h: gh }));
  }
  all = all.filter((f) => f.score >= 0.55 && f.w > 6).sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of all) if (!kept.some((k) => iou(k, f) > 0.3)) kept.push(f);
  return kept.map((f) => ({ x: (f.x0 + f.w / 2) / W, y: (f.y0 + f.h / 2) / H, w: f.w / W, h: f.h / H, score: f.score }));
}

/** Samples frames in [start,end] and detects faces. */
export async function sampleFaces(info, start, end, { fps = 2, contentType = 'podcast', onProgress, signal } = {}) {
  const detector = await loadDetector();
  const times = [];
  const step = 1 / fps;
  for (let t = start + 0.05; t < end; t += step) times.push(Math.round(t * 1000) / 1000);
  if (!times.length) times.push(start);
  const samples = [];
  let i = 0;
  for await (const fr of framesAt(info, times, 960)) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const faces = fr.canvas ? detectFaces(detector, fr.canvas, { deep: contentType === 'gaming' }) : [];
    samples.push({ t: fr.t, faces });
    onProgress?.(++i / times.length);
  }
  return samples;
}

/** Turns face samples into an automatic layout plan. */
export function autoPlan(samples, W, H, contentType) {
  const n = samples.length;
  const detected = {};
  if (W / H < 0.8) return { plan: { mode: 'center', x: 0.5, y: 0.5, zoom: 1 }, detected, why: 'vertical' };
  if (!n) return { plan: defaultAuto(W, H, contentType), detected, why: 'no-samples' };

  const clusters = [];
  for (const s of samples) {
    for (const f of s.faces) {
      let best = null;
      let bd = 1e9;
      for (const c of clusters) {
        const d = Math.hypot(c.x - f.x, (c.y - f.y) * 0.6);
        if (d < bd) { bd = d; best = c; }
      }
      if (best && bd < Math.max(0.08, f.w * 1.5)) {
        best.items.push({ ...f, t: s.t });
        best.x = median(best.items.map((q) => q.x));
        best.y = median(best.items.map((q) => q.y));
      } else {
        clusters.push({ x: f.x, y: f.y, items: [{ ...f, t: s.t }] });
      }
    }
  }
  for (const c of clusters) {
    c.presence = new Set(c.items.map((q) => q.t)).size / n;
    c.w = median(c.items.map((q) => q.w));
    c.h = median(c.items.map((q) => q.h));
  }
  const strong = clusters.filter((c) => c.presence >= 0.3).sort((a, b) => b.presence * b.w - a.presence * a.w);
  detected.faces = strong.slice(0, 2).sort((a, b) => a.x - b.x).map(({ x, y, w, h, presence }) => ({ x, y, w, h, presence }));
  if (strong[0]) detected.main = { x: strong[0].x, y: strong[0].y };

  const mainW = fullHeightW(aspectOf('main'), W, H);

  if (contentType === 'gaming') {
    const cam = strong.find((c) => c.w < 0.16 && (c.x < 0.34 || c.x > 0.66 || c.y < 0.3 || c.y > 0.7));
    if (cam) {
      detected.cam = { x: cam.x, y: cam.y, w: cam.w, h: cam.h };
      return {
        plan: { mode: 'stream', cam: camBox(cam, W, H), game: { x: 0.5, y: 0.5, w: fullHeightW(aspectOf('game'), W, H) } },
        detected, why: 'facecam',
      };
    }
    if (!strong.length || strong[0].w < 0.12) return { plan: { mode: 'fit' }, detected, why: 'gameplay' };
  }

  if (strong.length >= 2) {
    const [a, b] = detected.faces;
    const span = Math.abs(a.x - b.x) + Math.max(a.w, b.w) * 1.2;
    if (span > mainW * 0.95) {
      return { plan: { mode: 'split', a: faceBox(a, aspectOf('a'), W, H), b: faceBox(b, aspectOf('b'), W, H) }, detected, why: 'two-people' };
    }
    return { plan: { mode: 'center', x: (a.x + b.x) / 2, y: 0.5, zoom: 1 }, detected, why: 'two-close' };
  }

  if (strong.length === 1) {
    detected.trackKeys = trackKeys(samples, strong[0].x, mainW);
    return { plan: { mode: 'track', keys: detected.trackKeys, y: 0.5, zoom: 1 }, detected, why: 'one-person' };
  }
  return { plan: defaultAuto(W, H, contentType), detected, why: 'no-face' };
}

function trackKeys(samples, startX, cropW) {
  let cur = startX;
  const keys = [];
  for (const s of samples) {
    let target = cur;
    if (s.faces.length) {
      let best = s.faces[0];
      for (const f of s.faces) {
        const cost = Math.abs(f.x - cur) - f.w * 0.8;
        if (cost < Math.abs(best.x - cur) - best.w * 0.8) best = f;
      }
      target = best.x;
    }
    const d = target - cur;
    if (Math.abs(d) > cropW * 0.9) cur = target; // camera cut -> jump
    else if (Math.abs(d) > cropW * 0.15) cur += d * 0.6; // outside dead zone -> follow smoothly
    keys.push({ t: s.t, x: clamp(Math.round(cur * 1000) / 1000, 0, 1) });
  }
  return keys;
}
