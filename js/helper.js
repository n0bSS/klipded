// Client for "KlipDed Helper" (helper/klipded_helper.py), a small local program that
// downloads YouTube links with yt-dlp, because a website cannot do that by itself.
import { sleep } from './util.js';

export const HELPER_BASE = 'http://127.0.0.1:7788';

async function call(path, init = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const outer = init.signal;
  if (outer) outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(HELPER_BASE + path, { ...init, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'helper_error'), { code: data.error || 'helper_error', data });
    return data;
  } catch (e) {
    if (outer?.aborted) throw new DOMException('aborted', 'AbortError');
    if (e.code) throw e;
    throw Object.assign(new Error('helper_offline'), { code: 'helper_offline' });
  } finally {
    clearTimeout(timer);
  }
}

export const helper = {
  health: () => call('/health', {}, 15000),
  info: (url) => call('/info?url=' + encodeURIComponent(url), {}, 150000),
  download: (url, maxHeight = 1080) => call('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, maxHeight }),
  }),
  job: (id) => call('/jobs/' + id, {}, 15000),
  fileUrl: (id) => `${HELPER_BASE}/files/${id}`,
};

export async function waitForJob(id, onProgress, signal) {
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const st = await helper.job(id);
    onProgress?.(st);
    if (st.status === 'done') return st;
    if (st.status === 'error') throw Object.assign(new Error('download_failed'), { code: 'download_failed', data: st });
    await sleep(800);
  }
}

export function youtubeId(u) {
  try {
    const url = new URL(String(u || '').trim());
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return url.pathname.slice(1, 12) || null;
    if (host === 'youtube.com') {
      const v = url.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

export const looksLikeUrl = (s) => /^https?:\/\/\S+\.\S+/i.test(String(s || '').trim());
