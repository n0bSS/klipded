export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
// Timers run in a worker: Chrome throttles page timers in background tabs to once a minute,
// worker timers keep their pace, so long jobs don't stall when the user switches tabs.
let timerWorker = null;
let timerSeq = 0;
const timerWaits = new Map();
function workerTimer() {
  if (timerWorker === null) {
    try {
      const src = 'onmessage=(e)=>setTimeout(()=>postMessage(e.data[0]),e.data[1])';
      timerWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      timerWorker.onmessage = (e) => { timerWaits.get(e.data)?.(); timerWaits.delete(e.data); };
    } catch {
      timerWorker = false;
    }
  }
  return timerWorker;
}
export const sleep = (ms) => new Promise((r) => {
  const w = workerTimer();
  if (!w) return setTimeout(r, ms);
  const id = ++timerSeq;
  timerWaits.set(id, r);
  w.postMessage([id, ms]);
});

// Keeps a long job alive while the tab is in the background: a held Web Lock stops Chrome from
// freezing or discarding the tab, and a screen wake lock (re-taken whenever the tab is visible again)
// stops the PC from going to sleep. Returns a function that releases both.
export function keepAlive(name) {
  let releaseLock = null;
  let wake = null;
  let stopped = false;
  if (navigator.locks) navigator.locks.request(name, () => new Promise((r) => { releaseLock = r; if (stopped) r(); })).catch(() => {});
  const takeWake = async () => {
    if (stopped || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try { wake = await navigator.wakeLock.request('screen'); } catch {}
  };
  document.addEventListener('visibilitychange', takeWake);
  takeWake();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', takeWake);
    releaseLock?.();
    wake?.release().catch(() => {});
  };
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(sec, withMs = false) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const base = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}.${Math.floor((sec % 1) * 10)}` : base;
}

export function fmtHours(seconds) {
  const h = (Number(seconds) || 0) / 3600;
  if (h >= 10) return `${Math.round(h)} ชม.`;
  if (h >= 1) return `${h.toFixed(1)} ชม.`;
  return `${Math.round(h * 60)} นาที`;
}

export function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function safeFileName(s, max = 60) {
  return String(s || 'clip')
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim() || 'clip';
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('คัดลอกแล้ว', 'ok');
}

let toastBox;
export function toast(msg, kind = '', ms = 3500) {
  if (!toastBox) {
    toastBox = el('div', { class: 'toasts' });
    document.body.append(toastBox);
  }
  const t = el('div', { class: `toast ${kind}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

export const isThaiChar = (ch) => /[฀-๿]/.test(ch);
// Thai vowel/tone marks that sit above/below the base letter take no horizontal space
export const visLen = (s) => String(s).replace(/[ัิ-ฺ็-๎]/g, '').length;

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
