// KlipDed main app: source -> AI clip picking -> vertical previews -> MP4 export.
import { $, $$, el, toast, fmtTime, fmtHours, fmtBytes, copyText, downloadBlob, safeFileName, loadJSON, saveJSON, clamp, debounce, sleep } from './util.js';
import { api, errorText } from './api.js';
import * as License from './license.js';
import { openVideo, extractAudioChunks, grabFrame } from './media.js';
import { mergeChunks, buildTokens, transcriptForAI, retimeText } from './transcript.js';
import { refineClips, lengthRange } from './highlights.js';
import { sampleFaces, autoPlan } from './facetrack.js';
import { LAYOUTS, planFor, planBoxes, boxRect, defaultAuto, fullHeightW } from './layout.js';
import { CAPTION_STYLES, CHUNK_SIZES, makeChunks, chunkText, ensureFonts } from './captions.js';
import { drawScene, exportClip, makeScratch } from './render.js';
import { helper, waitForJob, youtubeId, looksLikeUrl } from './helper.js';
import { fileKey, saveSession, loadSession } from './store.js';

const DEFAULT_SETTINGS = { style: 'pop', size: 84, captionY: 'auto', chunk: 'normal', upper: true, showHook: true, hookSec: 3, watermark: '', progress: false, fps: 30 };
const DEFAULT_OPTIONS = { type: 'gaming', lang: 'auto', length: 'mid', count: '5', mode: 'speech', topic: '', vocab: '' };
const LAYOUT_TAG = { track: 'ตามหน้าคน', center: 'ครอปเต็มจอ', split: 'แบ่งจอ 2 คน', stream: 'เกม + เฟซแคม', fit: 'ย่อพอดี + เบลอ' };

const S = {
  settings: { ...DEFAULT_SETTINGS, ...loadJSON('kd.settings', {}) },
  options: { ...DEFAULT_OPTIONS, ...loadJSON('kd.options', {}) },
  src: null, // { kind:'file'|'url', file?, url?, ytId?, title, key, duration?, jobId?, ready? }
  info: null,
  videoUrl: null,
  transcript: null,
  energy: null,
  clips: [],
  saveDir: null,
  busy: false,
  ctrl: null,
};
const ui = new Map(); // clip id -> { card, cv, tag, status }
const chunkCache = new Map();
const thumbScratch = makeScratch();
let layoutRun = 0;

const saveSettings = () => saveJSON('kd.settings', S.settings);
const saveOptions = () => saveJSON('kd.options', S.options);
const show = (sel, on = true) => $(sel).classList.toggle('hidden', !on);

/* ================================================================ key */

function refreshKeyPill() {
  const lic = License.cachedLicense();
  const pill = $('#keyPill');
  const txt = $('#keyText');
  pill.classList.remove('ok', 'bad');
  if (!License.savedKey() || !lic) { txt.textContent = 'ใส่คีย์'; return; }
  const expired = lic.expiresAt && new Date(lic.expiresAt) <= new Date();
  if (expired || (lic.status && lic.status !== 'active')) {
    pill.classList.add('bad');
    txt.textContent = lic.status === 'revoked' ? 'คีย์ถูกระงับ' : 'คีย์หมดอายุ';
    return;
  }
  pill.classList.add('ok');
  txt.textContent = `เหลือ ${License.daysLeft(lic)} วัน · ${fmtHours(lic.remainingSeconds)}`;
}

function renderKeyInfo(msg = '') {
  const box = $('#keyInfo');
  box.innerHTML = '';
  if (msg) box.append(el('div', { class: 'notice' }, msg));
  const lic = License.cachedLicense();
  const k = License.savedKey();
  $('#keyForget').classList.toggle('hidden', !k);
  if (!k || !lic) return;
  const exp = lic.expiresAt ? new Date(lic.expiresAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : `${lic.durationDays} วัน (เริ่มนับเมื่อใช้งาน)`;
  box.append(el('div', { class: 'copy-box', style: { marginTop: '10px' } },
    el('div', {}, '🔑 ', el('span', { class: 'mono' }, k)),
    el('div', {}, `หมดอายุ: ${exp}`),
    el('div', {}, `โควตาวิดีโอ: ใช้ไป ${fmtHours(lic.usedSeconds)} จาก ${fmtHours(lic.quotaSeconds)} (เหลือ ${fmtHours(lic.remainingSeconds)})`),
    el('div', {}, `เครื่องที่ใช้: ${lic.deviceCount}/${lic.maxDevices}`)));
}

function openKeyModal(msg = '') {
  $('#keyInput').value = License.savedKey();
  renderKeyInfo(msg);
  show('#mKey');
  setTimeout(() => $('#keyInput').focus(), 50);
}

async function ensureKey() {
  const k = License.savedKey();
  if (!k) { openKeyModal('ใส่คีย์ก่อนเริ่มใช้งาน'); return false; }
  try {
    await License.activate(k);
    refreshKeyPill();
    return true;
  } catch (e) {
    if (e.code === 'network') { toast(errorText(e), 'err', 7000); return false; }
    markLicense(e);
    openKeyModal(errorText(e));
    return false;
  }
}

function markLicense(e) {
  if (!['expired', 'revoked', 'invalid_key'].includes(e.code)) return;
  const lic = License.cachedLicense();
  if (lic) { lic.status = e.code === 'expired' ? 'active' : 'revoked'; if (e.code === 'expired' && e.data?.expiresAt) lic.expiresAt = e.data.expiresAt; saveJSON('kd.license', lic); }
  refreshKeyPill();
}

/* ============================================================ options */

function renderOptions() {
  for (const seg of $$('.seg[data-opt]')) {
    const k = seg.dataset.opt;
    for (const b of $$('button', seg)) b.classList.toggle('on', String(S.options[k]) === b.dataset.v);
  }
  $('#optTopic').value = S.options.topic || '';
  $('#optVocab').value = S.options.vocab || '';
  updateNotes();
}

function updateNotes() {
  const vision = S.options.mode === 'vision';
  const yt = !!S.src?.ytId;
  $('#modeNote').textContent = vision
    ? (yt || !S.src ? 'AI ดูทั้งภาพและฟังเสียงจากลิงก์ YouTube (ต้องเป็นคลิปสาธารณะ) เหมาะกับคลิปเกมที่พูดน้อย' : 'โหมดดูภาพใช้ได้กับลิงก์ YouTube เท่านั้น ไฟล์นี้จะใช้โหมดเสียงพูดแทน')
    : 'AI ฟังเสียงพูดทั้งคลิป ได้ซับแม่นยำ เหมาะกับพอดแคสต์ / สตรีมที่มีคนพูด';
  const d = S.info?.duration || S.src?.duration || 0;
  const lic = License.cachedLicense();
  $('#quotaNote').textContent = d
    ? `วิดีโอยาว ${fmtTime(d)} · ใช้โควตาประมาณ ${fmtHours(d)}${lic ? ` (คีย์เหลือ ${fmtHours(lic.remainingSeconds)})` : ''}`
    : '';
}

/* ============================================================= source */

function resetSource() {
  pausePreview();
  layoutRun++;
  if (S.videoUrl && S.videoUrl.startsWith('blob:')) URL.revokeObjectURL(S.videoUrl);
  Object.assign(S, { src: null, info: null, videoUrl: null, transcript: null, energy: null, clips: [] });
  ui.clear();
  chunkCache.clear();
  $('#clips').innerHTML = '';
  $('#srcVideo').removeAttribute('src');
  $('#srcVideo').removeAttribute('poster');
  $('#pvVideo').removeAttribute('src');
  show('#restoreBox', false);
  show('#secResults', false);
  show('#faceNote', false);
  show('#dlBar', false);
}

function backToInput() {
  resetSource();
  show('#secSource', false);
  show('#secProgress', false);
  show('#secInput');
}

function setSourceHeader({ title, chips = [], note = '' }) {
  if (title !== undefined) $('#srcTitle').textContent = title;
  $('#srcChips').replaceChildren(...chips.map((c) => el('span', { class: 'chip' + (c.pink ? ' pink' : '') }, c.text || c)));
  setNote(note);
}
const setNote = (t) => { $('#srcNote').textContent = t || ''; };
const setBar = (sel, p) => { $(sel).firstElementChild.style.width = `${Math.round(clamp(p || 0, 0, 1) * 100)}%`; };

function infoChips(info) {
  const chips = [{ text: `⏱ ${fmtTime(info.duration)}` }, { text: `${info.width}×${info.height}` }, { text: `${Math.round(info.fps)} fps` }];
  if (S.src?.ytId) chips.unshift({ text: 'YouTube', pink: true });
  if (!info.aTrack) chips.push({ text: 'ไม่มีเสียง', pink: true });
  return chips;
}

function attachInfo(info, url, remote) {
  S.info = info;
  S.videoUrl = url;
  for (const v of [$('#srcVideo'), $('#pvVideo')]) {
    if (remote) v.crossOrigin = 'anonymous'; else v.removeAttribute('crossorigin');
    v.src = url;
  }
  setSourceHeader({ title: S.src.title, chips: infoChips(info) });
  if (!info.canDecodeVideo) setNote('⚠️ เบราว์เซอร์นี้ถอดรหัสภาพของไฟล์นี้ไม่ได้ ลองใช้ Chrome/Edge หรือแปลงเป็น MP4 (H.264)');
  else if (!info.aTrack) setNote('⚠️ วิดีโอนี้ไม่มีเสียง จึงใช้ได้เฉพาะโหมดดูภาพ (ลิงก์ YouTube)');
  updateNotes();
}

async function loadFile(file) {
  if (S.busy) return toast('รอให้งานปัจจุบันเสร็จก่อน', 'err');
  if (!file) return;
  resetSource();
  S.src = { kind: 'file', file, title: file.name, key: fileKey(file) };
  show('#secInput', false);
  show('#secSource');
  setSourceHeader({ title: file.name, note: 'กำลังอ่านไฟล์…' });
  try {
    const info = await openVideo(file);
    attachInfo(info, URL.createObjectURL(file), false);
    await offerRestore();
  } catch (e) {
    console.error(e);
    toast(errorText(e), 'err', 7000);
    backToInput();
  }
}

let pendingUrl = '';
async function loadUrl(url) {
  url = String(url || '').trim();
  if (S.busy) return toast('รอให้งานปัจจุบันเสร็จก่อน', 'err');
  if (!looksLikeUrl(url)) return toast('วางลิงก์ให้ถูกต้อง เช่น https://www.youtube.com/watch?v=…', 'err');
  try {
    await helper.health();
  } catch {
    openHelperModal(url);
    return;
  }
  resetSource();
  const ytId = youtubeId(url);
  S.src = { kind: 'url', url, ytId, title: url, key: ytId ? `yt:${ytId}` : `url:${url}` };
  show('#secInput', false);
  show('#secSource');
  setSourceHeader({ title: 'กำลังอ่านข้อมูลลิงก์…', note: '' });
  try {
    const meta = await helper.info(url);
    if (meta.is_live) throw Object.assign(new Error('live'), { code: 'bad_url' });
    S.src.title = meta.title || url;
    S.src.duration = meta.duration || 0;
    if (meta.thumbnail) $('#srcVideo').poster = meta.thumbnail;
    setSourceHeader({ title: S.src.title, chips: [{ text: S.src.ytId ? 'YouTube' : 'ลิงก์', pink: true }, { text: `⏱ ${fmtTime(S.src.duration)}` }, meta.uploader ? { text: meta.uploader } : null].filter(Boolean), note: 'กำลังโหลดวิดีโอผ่านโปรแกรมช่วยโหลด…' });
    updateNotes();
    const job = await helper.download(url, 1080);
    S.src.jobId = job.id;
    const src = S.src;
    show('#dlBar');
    src.ready = (async () => {
      await waitForJob(job.id, (st) => { if (S.src === src) { setBar('#dlBar', st.progress); setNote(dlNote(st)); } });
      const fileUrl = helper.fileUrl(job.id);
      const info = await openVideo(fileUrl);
      if (S.src === src) { attachInfo(info, fileUrl, true); show('#dlBar', false); setNote('โหลดวิดีโอเสร็จแล้ว ✓'); }
      return info;
    })();
    src.ready.catch((e) => { if (S.src === src) setNote(`⚠️ ${errorText(e)}${e.data?.error ? ' — ' + e.data.error : ''}`); });
    await offerRestore();
  } catch (e) {
    console.error(e);
    toast(`${errorText(e)}${e.data?.detail ? ' — ' + e.data.detail : ''}`, 'err', 8000);
    backToInput();
  }
}

function dlNote(st) {
  if (st.status === 'merging') return 'กำลังรวมไฟล์ภาพ + เสียง…';
  if (st.status === 'done') return 'โหลดวิดีโอเสร็จแล้ว ✓';
  if (st.status === 'queued') return 'รอคิวโหลด…';
  return `กำลังโหลดวิดีโอ ${Math.round((st.progress || 0) * 100)}%`;
}

// A link's video is served by the helper under a job id that only lives while the helper runs.
// If the helper was closed (or restarted) the old file URL is dead: ask it for the same link again
// (it reuses the file already on disk) and re-attach. Resolves true when the video was re-attached.
let recovering = null;
let helperWarnedAt = 0;
function recoverHelperVideo() {
  const src = S.src;
  if (src?.kind !== 'url' || !S.videoUrl) return Promise.resolve(false);
  recovering ||= (async () => {
    try {
      await helper.health();
    } catch {
      if (Date.now() - helperWarnedAt > 10000) {
        helperWarnedAt = Date.now();
        toast('โปรแกรมช่วยโหลดปิดอยู่ — ดับเบิลคลิก start-helper.bat เปิดค้างไว้ แล้วกดเล่นอีกครั้ง', 'err', 9000);
      }
      return false;
    }
    try {
      const r = await fetch(S.videoUrl, { headers: { Range: 'bytes=0-0' } });
      if (r.ok) return false; // file is fine, the problem is something else
    } catch {}
    toast('กำลังเชื่อมวิดีโอกับโปรแกรมช่วยโหลดใหม่…');
    const job = await helper.download(src.url, 1080);
    await waitForJob(job.id);
    if (S.src !== src) return false;
    const fileUrl = helper.fileUrl(job.id);
    src.jobId = job.id;
    attachInfo(await openVideo(fileUrl), fileUrl, true);
    S.clips.forEach((c) => drawThumb(c));
    if (E.clip) seekPreview(E.clip.start + 0.02);
    toast('เชื่อมวิดีโอได้แล้ว ✓', 'ok');
    return true;
  })().catch((e) => { console.warn('helper recover failed', e); return false; }).finally(() => { recovering = null; });
  return recovering;
}

function openHelperModal(url) {
  pendingUrl = url || pendingUrl;
  $('#helperState').textContent = '';
  show('#mHelper');
}

async function offerRestore() {
  const ses = await loadSession(S.src.key);
  const box = $('#restoreBox');
  if (!ses?.clips?.length) { show('#restoreBox', false); return; }
  box.replaceChildren(
    `พบผลวิเคราะห์เดิมของวิดีโอนี้ (${ses.clips.length} คลิป) เปิดดูได้โดยไม่เสียโควตา `,
    el('button', { class: 'btn sm', onclick: () => restoreSession(ses) }, 'เปิดผลเดิม'),
  );
  show('#restoreBox');
}

async function restoreSession(ses) {
  show('#restoreBox', false);
  if (!S.info && S.src.ready) {
    setNote('รอโหลดวิดีโอให้เสร็จก่อน…');
    try { await S.src.ready; } catch (e) { return toast(errorText(e), 'err'); }
  }
  if (!S.info) return;
  S.transcript = ses.transcript;
  S.energy = ses.energy;
  S.options = { ...S.options, ...ses.options };
  S.clips = ses.clips.map((c) => ({ ...c, status: '' }));
  renderOptions();
  showResults();
  analyzeLayouts();
}

const persist = debounce(() => {
  if (!S.src || !S.clips.length) return;
  const clips = JSON.parse(JSON.stringify(S.clips, (k, v) => (k === 'status' || k.startsWith('_') ? undefined : v)));
  saveSession(S.src.key, { title: S.src.title, options: S.options, transcript: S.transcript, energy: S.energy, clips });
}, 800);

/* =========================================================== analysis */

function makeSteps(defs) {
  const box = $('#steps');
  box.innerHTML = '';
  const map = new Map();
  defs.forEach((d, i) => {
    const bar = el('div', { class: 'bar' }, el('i'));
    const note = el('div', { class: 'tiny' });
    const row = el('div', { class: 'step' }, el('div', { class: 'num' }, String(i + 1)), el('div', {}, el('b', {}, d.label), bar, note));
    box.append(row);
    map.set(d.id, {
      start(text) { row.classList.add('active'); if (text) note.textContent = text; },
      progress(p, text) { if (Number.isFinite(p)) bar.firstChild.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`; if (text !== undefined) note.textContent = text; },
      done(text) { row.classList.remove('active'); row.classList.add('done'); bar.firstChild.style.width = '100%'; if (text) note.textContent = text; },
      skip(text) { row.classList.add('done'); bar.firstChild.style.width = '100%'; note.textContent = text || 'ข้าม'; },
    });
  });
  return map;
}

function slowProgress(step, from, to, ms, text) {
  const t0 = performance.now();
  const id = setInterval(() => {
    const u = 1 - Math.exp(-(performance.now() - t0) / ms);
    step.progress(from + (to - from) * u, text);
  }, 400);
  return { stop: () => clearInterval(id) };
}

const abortable = (p, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
  signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  p.then(resolve, reject);
});

async function waitForSource(step, signal) {
  if (S.src.kind === 'file') { step?.skip('ไฟล์อยู่ในเครื่องแล้ว'); return S.info; }
  if (S.info) { step?.done('โหลดเสร็จแล้ว'); return S.info; }
  step?.start('กำลังโหลดวิดีโอ…');
  const tick = setInterval(async () => {
    try { const st = await helper.job(S.src.jobId); step?.progress(st.progress, dlNote(st)); } catch {}
  }, 1000);
  try {
    const info = await abortable(S.src.ready, signal);
    step?.done('โหลดเสร็จแล้ว');
    return info;
  } finally {
    clearInterval(tick);
  }
}

async function transcribe(info, ranges, o, step, signal) {
  const key = License.savedKey();
  const dev = License.deviceId();
  const lang = o.lang === 'auto' ? '' : o.lang;
  const prompt = [o.topic, o.vocab].filter(Boolean).join(', ');
  const results = [];
  const inflight = new Set();
  let firstErr = null;
  let done = 0;
  let total = 1;
  let extractP = 0;
  const update = () => step.progress(extractP * 0.3 + (done / total) * 0.7, `ถอดเสียงแล้ว ${done}/${total} ช่วง`);
  const upload = async (ch) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await api.transcribe(key, dev, ch.blob, { lang, prompt, seconds: ch.seconds, signal });
        License.updateUsage(data.usage);
        results.push({ start: ch.start, own: ch.own, data });
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (['stt_busy', 'network', 'stt_failed', 'upstream_unreachable'].includes(e.code) && attempt < 3) {
          step.progress(undefined, `ระบบถอดเสียงไม่ว่าง กำลังลองใหม่… (${attempt + 1}/3)`);
          await sleep(3000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    done++;
    update();
  };
  const { energy, bin } = await extractAudioChunks(info, {
    ranges,
    signal,
    onProgress: (p) => { extractP = p; update(); },
    onChunk: async (ch) => {
      if (firstErr) throw firstErr;
      total = ch.count;
      const p = upload(ch).catch((e) => { firstErr = firstErr || e; }).finally(() => inflight.delete(p));
      inflight.add(p);
      while (inflight.size >= 3) await Promise.race(inflight);
      if (firstErr) throw firstErr;
    },
  });
  await Promise.all(inflight);
  if (firstErr) throw firstErr;
  refreshKeyPill();
  return { results, energy: { energy, bin } };
}

function finishTranscript(results) {
  const tr = mergeChunks(results);
  tr.tokens = buildTokens(tr.words, tr.segments);
  delete tr.words;
  return tr;
}

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const p = out[out.length - 1];
    if (p && r[0] <= p[1] + 1) p[1] = Math.max(p[1], r[1]); else out.push([...r]);
  }
  return out;
}

async function speechPipeline(o, steps, signal, cfg) {
  const info = await waitForSource(steps.get('download'), signal);
  const st = steps.get('stt');
  st.start('กำลังแยกเสียง…');
  const { results, energy } = await transcribe(info, null, o, st, signal);
  const tr = finishTranscript(results);
  if (!tr.segments.length) throw Object.assign(new Error('empty_transcript'), { code: 'empty_transcript' });
  st.done(`ได้ข้อความ ${tr.segments.length} ประโยค${tr.language ? ' · ภาษา ' + tr.language : ''}`);

  const ai = steps.get('ai');
  ai.start();
  const pulse = slowProgress(ai, 0.05, 0.92, 35000, 'AI กำลังอ่านทั้งคลิปและให้คะแนนแต่ละช่วง…');
  let res;
  try {
    res = await api.highlights({
      key: License.savedKey(), deviceId: License.deviceId(),
      transcript: transcriptForAI(tr, energy),
      options: { ...cfg, duration: info.duration },
    }, signal);
  } finally { pulse.stop(); }
  const clips = refineClips(res.clips, tr, { minSec: cfg.minSec, maxSec: cfg.maxSec, duration: info.duration });
  ai.done(`ได้ ${clips.length} คลิป`);
  return { tr, energy, clips };
}

async function visionPipeline(o, steps, signal, cfg) {
  const duration = S.info?.duration || S.src.duration;
  if (!duration) throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
  const vs = steps.get('vision');
  vs.start();
  const WIN = 2400;
  const windows = [];
  if (duration <= WIN + 600) windows.push(null);
  else for (let s = 0; s < duration; s += WIN) windows.push([Math.max(0, s - (s ? 20 : 0)), Math.min(duration, s + WIN)]);
  const all = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const label = w ? `AI กำลังดูช่วง ${fmtTime(w[0])}–${fmtTime(w[1])}` : 'AI กำลังดูวิดีโอทั้งคลิป…';
    const pulse = slowProgress(vs, i / windows.length, (i + 0.95) / windows.length, 60000, label);
    try {
      const res = await api.highlightsVideo({
        key: License.savedKey(), deviceId: License.deviceId(), url: S.src.url,
        window: w ? { start: w[0], end: w[1] } : null,
        options: { ...cfg, count: w ? Math.ceil((cfg.count * (w[1] - w[0])) / duration) + 2 : cfg.count, duration },
      }, signal);
      License.updateUsage(res.usage);
      refreshKeyPill();
      all.push(...res.clips);
    } finally { pulse.stop(); }
  }
  all.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of all) if (!picked.some((k) => Math.min(k.end, c.end) - Math.max(k.start, c.start) > 3)) picked.push(c);
  const raw = picked.slice(0, cfg.count);
  if (!raw.length) throw Object.assign(new Error('vision_failed'), { code: 'vision_failed' });
  vs.done(`AI เลือกได้ ${raw.length} ช่วง`);

  const info = await waitForSource(steps.get('download'), signal);
  const st = steps.get('stt');
  st.start('ถอดเสียงเฉพาะช่วงที่เลือก (สำหรับทำซับ)…');
  let tr = { language: '', segments: [], tokens: [] };
  let energy = null;
  if (info.aTrack) {
    const ranges = mergeRanges(raw.map((c) => [Math.max(0, c.start - 4), Math.min(info.duration, c.end + 4)]));
    const out = await transcribe(info, ranges, o, st, signal);
    tr = finishTranscript(out.results);
    energy = out.energy;
    st.done(`ได้ข้อความ ${tr.segments.length} ประโยค`);
  } else st.skip('วิดีโอไม่มีเสียง');
  const clips = refineClips(raw, tr, { minSec: cfg.minSec, maxSec: cfg.maxSec, duration: info.duration });
  return { tr, energy, clips };
}

async function analyze() {
  if (S.busy || !S.src) return;
  S.options.topic = $('#optTopic').value.trim();
  S.options.vocab = $('#optVocab').value.trim();
  saveOptions();
  if (!(await ensureKey())) return;
  const o = { ...S.options };
  let vision = o.mode === 'vision' && !!S.src.ytId;
  const duration = S.info?.duration || S.src.duration || 0;
  const lic = License.cachedLicense();
  if (lic && duration && lic.remainingSeconds < duration * 0.9) {
    toast(`โควตาไม่พอ: วิดีโอยาว ${fmtHours(duration)} แต่คีย์เหลือ ${fmtHours(lic.remainingSeconds)}`, 'err', 8000);
    return;
  }
  if (!vision && S.info && !S.info.aTrack) return toast('วิดีโอนี้ไม่มีเสียง ใช้โหมด "ดูภาพ + เสียง" กับลิงก์ YouTube แทน', 'err', 7000);
  const [minSec, maxSec] = lengthRange(o.length);
  const cfg = { count: Number(o.count) || 5, minSec, maxSec, lang: o.lang, type: o.type, topic: o.topic };

  S.busy = true;
  S.ctrl = new AbortController();
  const signal = S.ctrl.signal;
  show('#secSource', false);
  show('#secResults', false);
  show('#secProgress');
  const needDl = S.src.kind === 'url';
  try {
    let out;
    if (vision) {
      const steps = makeSteps([{ id: 'vision', label: 'AI ดูวิดีโอ (ภาพ + เสียง)' }, ...(needDl ? [{ id: 'download', label: 'โหลดวิดีโอมาตัดต่อ' }] : []), { id: 'stt', label: 'ถอดเสียงทำซับ' }]);
      try {
        out = await visionPipeline(o, steps, signal, cfg);
      } catch (e) {
        if (e.name === 'AbortError' || !['vision_failed', 'vision_not_available', 'bad_url', 'llm_failed'].includes(e.code)) throw e;
        toast(`${errorText(e)} — เปลี่ยนไปใช้โหมดเสียงพูดให้อัตโนมัติ`, 'err', 8000);
        vision = false;
      }
    }
    if (!vision) {
      const steps = makeSteps([...(needDl ? [{ id: 'download', label: 'โหลดวิดีโอ' }] : []), { id: 'stt', label: 'แยกเสียง + ถอดเสียง' }, { id: 'ai', label: 'AI คัดช่วงเด็ด' }]);
      out = await speechPipeline(o, steps, signal, cfg);
    }
    S.transcript = out.tr;
    S.energy = out.energy;
    S.clips = out.clips.map((c) => newClip(c));
    chunkCache.clear();
    persist();
    show('#secProgress', false);
    show('#secSource');
    showResults();
    toast(S.clips.length ? `ได้ ${S.clips.length} คลิปเด็ด 🎉` : 'AI ไม่พบช่วงที่เหมาะ ลองเปลี่ยนความยาวคลิปหรือโหมด', S.clips.length ? 'ok' : 'err', 6000);
    analyzeLayouts();
  } catch (e) {
    console.error(e);
    show('#secProgress', false);
    show('#secSource');
    if (e.name !== 'AbortError') {
      markLicense(e);
      let msg = errorText(e);
      if (e.code === 'empty_transcript' && S.src?.ytId) msg += ' — ลองโหมด "ดูภาพ + เสียง"';
      if (e.data?.detail) console.warn('detail:', e.data.detail);
      toast(msg, 'err', 9000);
    } else toast('ยกเลิกแล้ว');
  } finally {
    S.busy = false;
    S.ctrl = null;
    refreshKeyPill();
    updateNotes();
  }
}

function newClip(c) {
  return {
    ...c,
    orig: { start: c.start, end: c.end },
    layout: 'auto',
    plan: defaultAuto(S.info.width, S.info.height, S.options.type),
    auto: null,
    captions: null,
    captionsEdited: false,
    selected: true,
    status: '',
  };
}

/* ============================================================ results */

function chunksFor(c) {
  if (c.captionsEdited && c.captions) return c.captions;
  const key = `${c.id}|${c.start}|${c.end}|${S.settings.chunk}`;
  if (!chunkCache.has(key)) chunkCache.set(key, makeChunks(S.transcript?.tokens || [], c.start, c.end, CHUNK_SIZES[S.settings.chunk] || 18));
  return chunkCache.get(key);
}

const jobFor = (c) => ({ plan: c.plan, chunks: chunksFor(c), settings: S.settings, hook: c.hook, clipStart: c.start, clipEnd: c.end });

function layoutTag(c) {
  if (c._analyzing) return '🔍 กำลังหาใบหน้า…';
  return (c.layout === 'auto' ? '✨ ' : '') + (LAYOUT_TAG[c.plan?.mode] || '');
}

function showResults() {
  show('#secResults');
  $('#clipCount').textContent = `(${S.clips.length})`;
  const box = $('#clips');
  box.innerHTML = '';
  ui.clear();
  S.clips.forEach((c, i) => box.append(clipCard(c, i)));
  $('#selAll').checked = S.clips.every((c) => c.selected);
  S.clips.forEach((c) => drawThumb(c));
}

function clipCard(c, i) {
  const cv = el('canvas', { width: 270, height: 480 });
  const tag = el('div', { class: 'layout-tag' }, layoutTag(c));
  const status = el('div', { class: 'status' });
  const title = el('div', { class: 'title' }, c.title);
  const meta = el('div', { class: 'meta' });
  const card = el('div', { class: 'clip' },
    el('div', { class: 'thumb', onclick: () => openEditor(c) },
      cv,
      el('div', { class: 'play' }, '▶'),
      el('div', { class: 'score' + (c.score >= 80 ? ' hot' : '') }, `🔥 ${c.score}`),
      el('input', { type: 'checkbox', class: 'sel', checked: !!c.selected, onclick: (e) => e.stopPropagation(), onchange: (e) => { c.selected = e.target.checked; } }),
      tag),
    el('div', { class: 'body' },
      title,
      meta,
      c.reason ? el('div', { class: 'reason' }, '💡 ' + c.reason) : null,
      el('div', { class: 'tags' }, (c.hashtags || []).join(' ')),
      status,
      el('div', { class: 'actions' },
        el('button', { class: 'btn sm', onclick: () => openEditor(c) }, '✏️ แก้ไข / พรีวิว'),
        el('button', { class: 'btn sm primary', onclick: () => renderOne(c) }, '⬇ เรนเดอร์'))));
  ui.set(c.id, { card, cv, tag, status, title, meta, index: i });
  refreshCard(c);
  return card;
}

function refreshCard(c) {
  const u = ui.get(c.id);
  if (!u) return;
  u.title.textContent = c.title;
  u.meta.textContent = `#${S.clips.indexOf(c) + 1} · ${fmtTime(c.start)}–${fmtTime(c.end)} · ${Math.round(c.end - c.start)} วิ`;
  u.tag.textContent = layoutTag(c);
}

function setStatus(c, text, err = false) {
  const u = ui.get(c.id);
  if (u) { u.status.textContent = text; u.status.classList.toggle('err', err); }
  if (E.clip === c) { $('#edStatus').textContent = text; }
}

let thumbQueue = Promise.resolve();
function drawThumb(c) {
  thumbQueue = thumbQueue.then(() => drawThumbNow(c)).catch(() => {});
  return thumbQueue;
}

async function drawThumbNow(c) {
  const u = ui.get(c.id);
  if (!u || !S.info) return;
  const t = c.start + Math.min(1.5, (c.end - c.start) / 3);
  try {
    const frame = await grabFrame(S.info, t, 640);
    if (!frame) return;
    const ctx = u.cv.getContext('2d');
    ctx.setTransform(u.cv.width / 1080, 0, 0, u.cv.height / 1920, 0, 0);
    drawScene(ctx, (cx, ...a) => cx.drawImage(frame, ...a), frame.width, frame.height, t, jobFor(c), thumbScratch);
  } catch (e) {
    console.warn('thumbnail failed', e);
    recoverHelperVideo();
  }
}

async function analyzeLayouts(force = false) {
  const run = ++layoutRun;
  for (const c of S.clips) {
    if (run !== layoutRun) return;
    if (c.auto && !force) continue;
    await analyzeClipLayout(c);
    if (run !== layoutRun) return;
  }
  persist();
}

async function analyzeClipLayout(c) {
  c._analyzing = true;
  refreshCard(c);
  try {
    const samples = await sampleFaces(S.info, c.start, c.end, { fps: 2, contentType: S.options.type });
    c.auto = autoPlan(samples, S.info.width, S.info.height, S.options.type);
  } catch (e) {
    console.warn('face analysis failed', e);
    c.auto = { plan: defaultAuto(S.info.width, S.info.height, S.options.type), detected: {}, why: 'failed' };
    const n = $('#faceNote');
    n.textContent = 'โหลดตัวหาใบหน้าไม่ได้ (เน็ตบล็อก CDN?) ใช้การครอปกลางแทน — ปรับกรอบเองได้ในหน้าแก้ไข';
    show('#faceNote');
  }
  delete c._analyzing;
  if (c.layout === 'auto') c.plan = structuredClone(c.auto.plan);
  refreshCard(c);
  drawThumb(c);
  if (E.clip === c) { fillLayouts(); previewDraw(); }
}

async function renderOne(c, batch = false) {
  if (c.status === 'rendering') return;
  if (!S.info) return toast('ยังโหลดวิดีโอไม่เสร็จ', 'err');
  c.status = 'rendering';
  setStatus(c, 'กำลังเรนเดอร์ 0%');
  try {
    const res = await exportClip(S.info, jobFor(c), { onProgress: (p) => setStatus(c, `กำลังเรนเดอร์ ${Math.round(p * 100)}%`) });
    const name = `${String(S.clips.indexOf(c) + 1).padStart(2, '0')}_${safeFileName(c.title)}.${res.ext}`;
    if (S.saveDir) await writeToDir(name, res.blob); else downloadBlob(res.blob, name);
    c.status = 'done';
    setStatus(c, `✓ ${name} (${fmtBytes(res.blob.size)})`);
    if (!batch) toast('เรนเดอร์เสร็จแล้ว ✓', 'ok');
  } catch (e) {
    console.error(e);
    c.status = 'error';
    setStatus(c, '✗ ' + errorText(e), true);
    if (!batch) toast(errorText(e), 'err', 7000);
  }
}

async function writeToDir(name, blob) {
  const dir = S.saveDir;
  if (dir.queryPermission && (await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    await dir.requestPermission({ mode: 'readwrite' });
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

async function renderSelected() {
  const list = S.clips.filter((c) => c.selected);
  if (!list.length) return toast('เลือกคลิปอย่างน้อย 1 คลิป', 'err');
  if (!S.saveDir && window.showDirectoryPicker && list.length > 1) {
    toast('แนะนำกด “โฟลเดอร์บันทึก” ก่อน จะได้ไม่ต้องกดยืนยันดาวน์โหลดทีละไฟล์');
  }
  const btn = $('#btnRenderSel');
  btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    btn.textContent = `⏳ เรนเดอร์ ${i + 1}/${list.length}`;
    await renderOne(list[i], true);
    if (list[i].status === 'done') ok++;
  }
  btn.disabled = false;
  btn.textContent = '⬇ เรนเดอร์ที่เลือก';
  toast(`เรนเดอร์เสร็จ ${ok}/${list.length} คลิป`, ok === list.length ? 'ok' : 'err', 6000);
}

/* ====================================================== style controls */

function buildStyleControls(box, onChange) {
  box.innerHTML = '';
  const st = S.settings;
  const set = (k, v) => { st[k] = v; saveSettings(); chunkCache.clear(); onChange?.(); };
  const seg = (items, cur, onPick) => {
    const s = el('div', { class: 'seg' });
    for (const [v, label] of items) {
      s.append(el('button', { class: String(cur) === String(v) ? 'on' : '', onclick: (e) => { $$('button', s).forEach((b) => b.classList.toggle('on', b === e.currentTarget)); onPick(v); } }, label));
    }
    return s;
  };
  const row = (title, node) => el('div', {}, el('div', { class: 'opt-title' }, title), node);
  box.append(
    row('สไตล์ซับ', seg(Object.entries(CAPTION_STYLES).map(([k, s]) => [k, s.name]), st.style, (v) => set('style', v))),
    row('ความยาวซับต่อครั้ง', seg([['short', 'สั้น (ทีละคำ)'], ['normal', 'ปกติ'], ['long', 'ยาว']], st.chunk, (v) => set('chunk', v))),
  );
  const size = el('input', { type: 'range', min: 56, max: 124, value: st.size, oninput: (e) => set('size', Number(e.target.value)) });
  const posAuto = el('input', { type: 'checkbox', checked: st.captionY === 'auto' });
  const pos = el('input', { type: 'range', min: 0.12, max: 0.9, step: 0.01, value: st.captionY === 'auto' ? 0.7 : st.captionY, disabled: st.captionY === 'auto' });
  posAuto.onchange = () => { pos.disabled = posAuto.checked; set('captionY', posAuto.checked ? 'auto' : Number(pos.value)); };
  pos.oninput = () => set('captionY', Number(pos.value));
  box.append(
    el('div', { class: 'grid2' },
      el('label', { class: 'field' }, 'ขนาดตัวอักษร', size),
      el('label', { class: 'field' }, el('span', {}, 'ตำแหน่งซับ ', el('label', { class: 'check', style: { display: 'inline-flex', fontSize: '12px' } }, posAuto, 'อัตโนมัติ')), pos)),
  );
  const chk = (label, key) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => set(key, e.target.checked) }), label);
  box.append(el('div', { class: 'row' }, chk('ตัวพิมพ์ใหญ่ (อังกฤษ)', 'upper'), chk('ข้อความ Hook ช่วงต้นคลิป', 'showHook'), chk('แถบความคืบหน้า', 'progress')));
  box.append(
    el('div', { class: 'grid2' },
      el('label', { class: 'field' }, 'ลายน้ำ / ชื่อช่อง', el('input', { type: 'text', value: st.watermark, placeholder: '@ชื่อช่องของคุณ', oninput: debounce((e) => set('watermark', e.target.value.trim()), 250) })),
      row('เฟรมเรต', seg([[30, '30 fps'], [60, '60 fps (เกม)']], st.fps, (v) => set('fps', Number(v))))),
  );
}

/* ============================================================== editor */

const E = { clip: null, raf: 0, playing: false, scratch: makeScratch(), sel: null, drag: null, still: null, stillT: 0, useStill: false };

function openEditor(c) {
  if (!S.info) return toast('ยังโหลดวิดีโอไม่เสร็จ', 'err');
  E.clip = c;
  E.useStill = false;
  $('#edTitle').textContent = c.title;
  $('#edStatus').textContent = ui.get(c.id)?.status.textContent || '';
  fillTime();
  fillLayouts();
  fillSubs();
  fillPost();
  setTab('time');
  show('#mEditor');
  const v = $('#pvVideo');
  v.muted = false;
  seekPreview(c.start + 0.02);
}

function closeEditor() {
  pausePreview();
  show('#mEditor', false);
  const c = E.clip;
  E.clip = null;
  if (c) { refreshCard(c); drawThumb(c); persist(); }
}

function setTab(name) {
  $$('#edTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('#mEditor [data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
  if (name === 'frame') requestAnimationFrame(drawBoxEditor);
}

const curT = () => (E.useStill ? E.stillT : $('#pvVideo').currentTime);

function previewDraw() {
  const c = E.clip;
  if (!c) return;
  const v = $('#pvVideo');
  const cv = $('#pvCanvas');
  const ctx = cv.getContext('2d');
  ctx.setTransform(cv.width / 1080, 0, 0, cv.height / 1920, 0, 0);
  if (E.useStill) {
    if (E.still) drawScene(ctx, (cx, ...a) => cx.drawImage(E.still, ...a), E.still.width, E.still.height, E.stillT, jobFor(c), E.scratch);
  } else if (v.readyState >= 2 && v.videoWidth) {
    drawScene(ctx, (cx, ...a) => cx.drawImage(v, ...a), v.videoWidth, v.videoHeight, v.currentTime, jobFor(c), E.scratch);
  }
  const t = curT();
  const dur = c.end - c.start;
  $('#pvSeek').value = String(Math.round(clamp((t - c.start) / dur, 0, 1) * 1000));
  $('#pvTime').textContent = `${fmtTime(Math.max(0, t - c.start), true)} / ${fmtTime(dur, true)}`;
  if (!$('[data-pane="frame"]').classList.contains('hidden')) drawBoxEditor();
}

function loop() {
  if (!E.playing || !E.clip) return;
  const v = $('#pvVideo');
  if (v.currentTime >= E.clip.end - 0.03 || v.currentTime < E.clip.start - 0.5) v.currentTime = E.clip.start;
  previewDraw();
  E.raf = requestAnimationFrame(loop);
}

function playPreview() {
  if (E.useStill) return toast('เบราว์เซอร์เล่นไฟล์นี้ไม่ได้ ดูพรีวิวแบบภาพนิ่งแทน (เรนเดอร์ได้ปกติ)', 'err');
  const v = $('#pvVideo');
  if (E.starting) return;
  if (v.currentTime < E.clip.start || v.currentTime >= E.clip.end - 0.05) v.currentTime = E.clip.start;
  E.starting = true;
  v.play().then(() => {
    E.playing = true;
    $('#pvPlay').textContent = '⏸';
    loop();
  }).catch(async (err) => {
    if (err.name === 'AbortError') return; // paused before playback started
    if (await recoverHelperVideo()) return;
    toast('เล่นวิดีโอไม่ได้: ' + err.message, 'err');
  }).finally(() => { E.starting = false; });
}

function pausePreview() {
  const v = $('#pvVideo');
  try { v.pause(); } catch {}
  E.playing = false;
  cancelAnimationFrame(E.raf);
  $('#pvPlay').textContent = '▶';
}

async function seekPreview(t) {
  const v = $('#pvVideo');
  if (E.useStill || v.error) {
    E.useStill = true;
    E.stillT = t;
    E.still = await grabFrame(S.info, t, 960);
    previewDraw();
    return;
  }
  try { v.currentTime = t; } catch {}
}

/* time pane */
function parseTime(str) {
  const parts = String(str).trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.some((x) => Number.isNaN(x))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function fillTime() {
  const c = E.clip;
  $('#edStart').value = fmtTime(c.start, true);
  $('#edEnd').value = fmtTime(c.end, true);
  $('#edDur').textContent = `ความยาว ${(c.end - c.start).toFixed(1)} วินาที (เดิม ${fmtTime(c.orig.start)}–${fmtTime(c.orig.end)})`;
  $('#edReason').textContent = c.reason ? `💡 เหตุผลที่ AI เลือก: ${c.reason}` : '';
  show('#edReason', !!c.reason);
}

function setClipTime(start, end) {
  const c = E.clip;
  const D = S.info.duration;
  if (!Number.isFinite(start) || !Number.isFinite(end)) { fillTime(); return; }
  start = clamp(start, 0, D - 1);
  end = clamp(end, start + 1, D);
  c.start = Math.round(start * 100) / 100;
  c.end = Math.round(end * 100) / 100;
  fillTime();
  fillSubs();
  seekPreview(c.start + 0.02);
}

/* frame pane */
function fillLayouts() {
  const c = E.clip;
  const box = $('#edLayouts');
  box.replaceChildren(...Object.entries(LAYOUTS).map(([k, label]) => el('button', { class: c.layout === k ? 'on' : '', onclick: () => chooseLayout(k) }, label)));
  const boxes = planBoxes(c.plan, S.info.width, S.info.height, curT());
  if (!boxes.some((b) => b.key === E.sel)) E.sel = boxes[0]?.key || null;
  updateZoomSlider();
  const why = { 'one-person': 'เจอ 1 คน → ภาพตามหน้าคนพูด', 'two-people': 'เจอ 2 คนอยู่ห่างกัน → แบ่งจอบน-ล่าง', 'two-close': 'เจอ 2 คนอยู่ใกล้กัน → ครอปให้เห็นทั้งคู่', facecam: 'เจอเฟซแคม → เกมด้านล่าง + หน้าคนด้านบน', gameplay: 'ไม่เจอเฟซแคม → ย่อภาพเกมให้เห็นเต็มจอ', 'no-face': 'ไม่เจอใบหน้า → ครอปกลาง', failed: 'หาใบหน้าไม่สำเร็จ → ใช้ค่าเริ่มต้น', vertical: 'วิดีโอแนวตั้งอยู่แล้ว' };
  $('#edFaceState').textContent = c._analyzing ? 'กำลังหาใบหน้า…' : c.auto ? `AI: ${why[c.auto.why] || ''}` : 'ยังไม่ได้วิเคราะห์ใบหน้า';
}

function chooseLayout(k) {
  const c = E.clip;
  c.layout = k;
  c.plan = planFor(k, S.info.width, S.info.height, c.auto, S.options.type);
  E.sel = null;
  fillLayouts();
  previewDraw();
  drawBoxEditor();
}

function updateZoomSlider() {
  const c = E.clip;
  const z = $('#boxZoom');
  const W = S.info.width;
  const H = S.info.height;
  const b = planBoxes(c.plan, W, H, curT()).find((x) => x.key === E.sel);
  z.disabled = !b && c.plan.mode !== 'fit';
  if (c.plan.mode === 'fit') z.value = c.plan.zoom || 1;
  else if (c.plan.mode === 'track' || c.plan.mode === 'center') z.value = c.plan.zoom || 1;
  else if (b) z.value = fullHeightW(b.aspect, W, H) / b.box.w;
}

function setPlanBox(key, box) {
  const c = E.clip;
  const p = c.plan;
  if (p.mode === 'track' || p.mode === 'center') {
    p.mode = 'center';
    p.x = clamp(box.x, 0, 1);
    p.y = clamp(box.y, 0, 1);
    delete p.keys;
  } else {
    p[key] = { ...box, x: clamp(box.x, 0, 1), y: clamp(box.y, 0, 1) };
  }
  if (c.layout === 'auto' || c.layout === 'track') {
    c.layout = p.mode;
    $$('#edLayouts button').forEach((b, i) => b.classList.toggle('on', Object.keys(LAYOUTS)[i] === c.layout));
  }
}

function drawBoxEditor() {
  const c = E.clip;
  const cv = $('#boxCanvas');
  if (!c || !S.info || cv.offsetParent === null) return;
  const W = S.info.width;
  const H = S.info.height;
  const h = Math.round((cv.width * H) / W);
  if (cv.height !== h) cv.height = h;
  const ctx = cv.getContext('2d');
  const v = $('#pvVideo');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (E.useStill && E.still) ctx.drawImage(E.still, 0, 0, cv.width, cv.height);
  else if (v.readyState >= 2) ctx.drawImage(v, 0, 0, cv.width, cv.height);
  const boxes = planBoxes(c.plan, W, H, curT());
  const colors = { main: '#FF3D8B', a: '#FF3D8B', b: '#3DE0FF', cam: '#FFA53A', game: '#3DE0FF' };
  const names = { main: 'ภาพหลัก', a: 'บน', b: 'ล่าง', cam: 'เฟซแคม (บน)', game: 'เกม (ล่าง)' };
  const sx = cv.width / W;
  const sy = cv.height / H;
  ctx.font = '600 14px sans-serif';
  for (const b of boxes) {
    const r = boxRect(b.box, b.aspect, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.0)';
    ctx.lineWidth = b.key === E.sel ? 4 : 2;
    ctx.strokeStyle = colors[b.key];
    ctx.strokeRect(r.sx * sx, r.sy * sy, r.sw * sx, r.sh * sy);
    ctx.fillStyle = colors[b.key];
    ctx.fillRect(r.sx * sx, r.sy * sy, ctx.measureText(names[b.key]).width + 12, 20);
    ctx.fillStyle = '#000';
    ctx.fillText(names[b.key], r.sx * sx + 6, r.sy * sy + 15);
  }
  if (!boxes.length) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, cv.height / 2 - 18, cv.width, 36);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('โหมดนี้แสดงภาพเต็ม (ใช้แถบซูมเพื่อขยาย)', cv.width / 2, cv.height / 2 + 5);
    ctx.textAlign = 'left';
  }
}

function boxPointer(e) {
  const cv = $('#boxCanvas');
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function initBoxEditor() {
  const cv = $('#boxCanvas');
  cv.addEventListener('pointerdown', (e) => {
    const c = E.clip;
    if (!c) return;
    const p = boxPointer(e);
    const W = S.info.width;
    const H = S.info.height;
    const boxes = planBoxes(c.plan, W, H, curT());
    let hit = null;
    let hitArea = Infinity;
    for (const b of boxes) {
      const r = boxRect(b.box, b.aspect, W, H);
      const inside = p.x * W >= r.sx && p.x * W <= r.sx + r.sw && p.y * H >= r.sy && p.y * H <= r.sy + r.sh;
      if (inside && r.sw * r.sh < hitArea) { hit = { ...b, r }; hitArea = r.sw * r.sh; }
    }
    if (!hit) return;
    E.sel = hit.key;
    const centre = { x: (hit.r.sx + hit.r.sw / 2) / W, y: (hit.r.sy + hit.r.sh / 2) / H };
    E.drag = { key: hit.key, p0: p, box: { ...hit.box, ...centre } };
    cv.setPointerCapture(e.pointerId);
    updateZoomSlider();
    drawBoxEditor();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!E.drag) return;
    const p = boxPointer(e);
    const d = E.drag;
    setPlanBox(d.key, { ...d.box, x: d.box.x + (p.x - d.p0.x), y: d.box.y + (p.y - d.p0.y) });
    previewDraw();
    drawBoxEditor();
  });
  const end = () => { if (E.drag) { E.drag = null; persist(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  $('#boxZoom').addEventListener('input', (e) => {
    const c = E.clip;
    if (!c) return;
    const z = Number(e.target.value);
    const p = c.plan;
    if (p.mode === 'fit' || p.mode === 'track' || p.mode === 'center') p.zoom = z;
    else if (E.sel && p[E.sel]) {
      const W = S.info.width;
      const H = S.info.height;
      const b = planBoxes(p, W, H, curT()).find((x) => x.key === E.sel);
      p[E.sel] = { ...p[E.sel], w: fullHeightW(b.aspect, W, H) / z };
    }
    if (c.layout === 'auto') { c.layout = p.mode === 'track' ? 'track' : p.mode; fillLayouts(); }
    previewDraw();
    drawBoxEditor();
  });
}

/* subs pane */
function fillSubs() {
  buildStyleControls($('#edStyleBox'), () => { previewDraw(); fillSubsList(); });
  fillSubsList();
}

function fillSubsList() {
  const c = E.clip;
  if (!c) return;
  const list = $('#edCaps');
  list.innerHTML = '';
  const chunks = chunksFor(c);
  if (!chunks.length) list.append(el('div', { class: 'tiny' }, S.transcript?.tokens?.length ? 'ช่วงนี้ไม่มีเสียงพูด' : 'ไม่มีข้อมูลเสียงพูดสำหรับทำซับ'));
  chunks.forEach((ch, i) => {
    const inp = el('input', { type: 'text', value: chunkText(ch) });
    inp.addEventListener('input', debounce(() => editChunk(i, inp.value), 250));
    inp.addEventListener('focus', () => { pausePreview(); seekPreview(ch.start + 0.05); });
    list.append(el('div', { class: 'cap-item' }, el('span', {}, fmtTime(Math.max(0, ch.start - c.start), true)), inp));
  });
  $('#edSubsNote').textContent = c.captionsEdited ? 'แก้ซับเองแล้ว — ถ้าเปลี่ยนช่วงเวลาคลิป กด “สร้างซับใหม่จากเสียง”' : 'แก้คำผิดได้เลย เวลาจะถูกจัดให้อัตโนมัติ';
}

function editChunk(i, text) {
  const c = E.clip;
  if (!c) return;
  if (!c.captionsEdited) {
    c.captions = JSON.parse(JSON.stringify(chunksFor(c)));
    c.captionsEdited = true;
    $('#edSubsNote').textContent = 'แก้ซับเองแล้ว — ถ้าเปลี่ยนช่วงเวลาคลิป กด “สร้างซับใหม่จากเสียง”';
  }
  const ch = c.captions[i];
  if (!ch) return;
  ch.tokens = text.trim() ? retimeText(text, ch.start, ch.end) : [];
  previewDraw();
}

/* post pane */
function bindInput(sel, value, fn) {
  const n = $(sel);
  n.value = value || '';
  n.oninput = () => fn(n.value);
}

function fillPost() {
  const c = E.clip;
  bindInput('#edHook', c.hook, (v) => { c.hook = v; previewDraw(); });
  bindInput('#edClipTitle', c.title, (v) => { c.title = v; $('#edTitle').textContent = v; });
  bindInput('#edCaption', c.caption, (v) => { c.caption = v; });
  bindInput('#edTags', (c.hashtags || []).join(' '), (v) => {
    c.hashtags = v.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));
  });
}

function postText(c, kind) {
  const tags = (c.hashtags || []).join(' ');
  if (kind === 'yt') return `${c.title}\n\n${c.caption}\n\n${tags} #shorts`.trim();
  if (kind === 'ig') return `${c.caption}\n\n${tags}`.trim();
  return `${c.title}\n${c.caption}\n\n${tags}`.trim();
}

/* ================================================================ wire */

function wire() {
  // modals
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    const m = b.closest('.modal');
    if (m.id === 'mEditor') closeEditor(); else m.classList.add('hidden');
  }));
  $$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => {
    if (e.target !== m) return;
    if (m.id === 'mEditor') closeEditor(); else m.classList.add('hidden');
  }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#mEditor').classList.contains('hidden')) closeEditor();
    $$('.modal').forEach((m) => { if (m.id !== 'mEditor') m.classList.add('hidden'); });
  });

  // key
  $('#keyPill').addEventListener('click', () => openKeyModal());
  $('#keySave').addEventListener('click', async () => {
    const k = $('#keyInput').value.trim();
    if (!k) return;
    const btn = $('#keySave');
    btn.disabled = true;
    try {
      await License.activate(k);
      refreshKeyPill();
      renderKeyInfo();
      updateNotes();
      toast('ใช้งานคีย์ได้แล้ว ✓', 'ok');
    } catch (e) {
      renderKeyInfo(errorText(e));
    } finally {
      btn.disabled = false;
    }
  });
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#keySave').click(); });
  $('#keyForget').addEventListener('click', () => { License.forgetKey(); refreshKeyPill(); renderKeyInfo(); $('#keyInput').value = ''; });

  // input
  $('#urlGo').addEventListener('click', () => loadUrl($('#urlInput').value));
  $('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadUrl($('#urlInput').value); });
  $('#helperHow').addEventListener('click', (e) => { e.preventDefault(); openHelperModal(''); });
  $('#helperRetry').addEventListener('click', async () => {
    $('#helperState').textContent = 'กำลังเชื่อมต่อ…';
    try {
      const h = await helper.health();
      const warn = [!h.ytdlp && 'ยังไม่มี yt-dlp', !h.ffmpeg && 'ยังไม่มี ffmpeg', !(h.deno || h.node) && 'ยังไม่มี Deno'].filter(Boolean);
      $('#helperState').textContent = `เชื่อมต่อได้ ✓ (yt-dlp ${h.ytdlp || '-'})${warn.length ? ' · ⚠️ ' + warn.join(', ') : ''}`;
      if (pendingUrl) { show('#mHelper', false); const u = pendingUrl; pendingUrl = ''; loadUrl(u); }
    } catch {
      $('#helperState').textContent = '❌ ยังเชื่อมต่อไม่ได้ — เปิด start-helper.bat ค้างไว้หรือยัง?';
    }
  });
  const drop = $('#drop');
  drop.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('video') && !S.busy) loadFile(f);
  });

  // options
  for (const seg of $$('.seg[data-opt]')) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.options[seg.dataset.opt] = b.dataset.v;
      saveOptions();
      renderOptions();
    });
  }
  $('#btnChange').addEventListener('click', () => { if (!S.busy) backToInput(); });
  $('#btnAnalyze').addEventListener('click', analyze);
  $('#btnCancel').addEventListener('click', () => S.ctrl?.abort());

  // results
  $('#selAll').addEventListener('change', (e) => {
    S.clips.forEach((c) => { c.selected = e.target.checked; });
    $$('#clips .sel').forEach((x) => { x.checked = e.target.checked; });
  });
  $('#btnRenderSel').addEventListener('click', renderSelected);
  $('#btnFolder').addEventListener('click', async () => {
    if (!window.showDirectoryPicker) return toast('เบราว์เซอร์นี้เลือกโฟลเดอร์ไม่ได้ ไฟล์จะถูกดาวน์โหลดตามปกติ', 'err');
    try {
      S.saveDir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'klipded' });
      $('#btnFolder').textContent = `📁 ${S.saveDir.name}`;
    } catch {}
  });
  $('#btnStyle').addEventListener('click', () => {
    buildStyleControls($('#styleBox'), () => { S.clips.forEach((c) => drawThumbDebounced(c)); });
    show('#mStyle');
  });

  // editor
  $$('#edTabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#pvPlay').addEventListener('click', () => (E.playing ? pausePreview() : playPreview()));
  $('#pvSeek').addEventListener('input', (e) => {
    const c = E.clip;
    if (!c) return;
    seekPreview(c.start + (Number(e.target.value) / 1000) * (c.end - c.start));
  });
  const pv = $('#pvVideo');
  pv.addEventListener('seeked', previewDraw);
  pv.addEventListener('loadeddata', previewDraw);
  pv.addEventListener('error', async () => {
    if (await recoverHelperVideo()) return;
    if (E.clip) { E.useStill = true; seekPreview(E.clip.start); }
  });
  $('#edStart').addEventListener('change', (e) => setClipTime(parseTime(e.target.value), E.clip.end));
  $('#edEnd').addEventListener('change', (e) => setClipTime(E.clip.start, parseTime(e.target.value)));
  $$('#mEditor [data-nudge]').forEach((b) => b.addEventListener('click', () => {
    const [which, d] = b.dataset.nudge.split(':');
    const c = E.clip;
    if (which === 'start') setClipTime(c.start + Number(d), c.end); else setClipTime(c.start, c.end + Number(d));
  }));
  $('#edResetTime').addEventListener('click', () => setClipTime(E.clip.orig.start, E.clip.orig.end));
  $('#edReface').addEventListener('click', async () => {
    const c = E.clip;
    $('#edFaceState').textContent = 'กำลังหาใบหน้า…';
    c.layout = 'auto';
    await analyzeClipLayout(c);
    fillLayouts();
    previewDraw();
  });
  $('#edResetSubs').addEventListener('click', () => {
    const c = E.clip;
    c.captionsEdited = false;
    c.captions = null;
    chunkCache.clear();
    fillSubsList();
    previewDraw();
  });
  $$('#mEditor [data-copy]').forEach((b) => b.addEventListener('click', () => copyText(postText(E.clip, b.dataset.copy))));
  $('#edRender').addEventListener('click', () => { pausePreview(); renderOne(E.clip); });
  initBoxEditor();

  window.addEventListener('beforeunload', (e) => {
    if (S.busy || S.clips.some((c) => c.status === 'rendering')) { e.preventDefault(); e.returnValue = ''; }
  });
}

const thumbTimers = new Map();
function drawThumbDebounced(c) {
  clearTimeout(thumbTimers.get(c.id));
  thumbTimers.set(c.id, setTimeout(() => drawThumb(c), 300));
}

function init() {
  wire();
  renderOptions();
  refreshKeyPill();
  ensureFonts();
  if (License.savedKey()) {
    License.activate(License.savedKey()).then(() => { refreshKeyPill(); updateNotes(); }).catch((e) => { markLicense(e); });
  }
  if (!('VideoEncoder' in window)) {
    toast('เบราว์เซอร์นี้ไม่รองรับการตัดต่อวิดีโอ กรุณาใช้ Chrome หรือ Edge บนคอมพิวเตอร์', 'err', 12000);
  }
  const q = new URLSearchParams(location.search).get('url');
  if (q) $('#urlInput').value = q;
}

init();

// small debug handle for testing in the console
window.__kd = { S, E, analyze, loadFile, loadUrl, renderOne, openEditor };
