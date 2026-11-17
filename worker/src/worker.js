/**
 * KlipDed API — Cloudflare Worker (single file, no dependencies)
 *
 * What it does
 *   1. License keys: customers rent a key; the key has an expiry (starts on first use),
 *      a quota (seconds of video audio that may be transcribed) and a device limit.
 *   2. AI proxy: the browser never sees your AI API keys. Audio goes to Groq Whisper,
 *      the transcript goes to Gemini (falls back to a Groq LLM) to pick viral clips.
 *   3. Admin API for issuing / extending / revoking keys (used by admin.html).
 *
 * Bindings / settings (see wrangler.toml)
 *   DB                     D1 database (schema.sql)
 *   GROQ_API_KEY           secret
 *   GEMINI_API_KEY         secret (optional but recommended)
 *   ADMIN_TOKEN            secret, long random string for admin.html
 *   ALLOWED_ORIGINS        comma separated origins, or "*"
 *   GROQ_STT_MODEL         default whisper-large-v3
 *   GROQ_LLM_MODEL         default openai/gpt-oss-120b ("off" disables the fallback)
 *   GEMINI_MODEL           default gemini-flash-latest
 *   GEMINI_FALLBACK_MODEL  default gemini-flash-lite-latest
 *   KEY_PREFIX             default KD
 *   HIGHLIGHTS_PER_DAY     default 40 (AI clip-picking calls per key per 24h)
 *   GROQ_BASE_URL / GEMINI_BASE_URL   only for local testing
 */

const VERSION = '1.0.0';
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // Groq free tier limit is 25 MB per file
const MAX_TRANSCRIPT_CHARS = 400000;
const KEY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      const body = { error: err.code || 'server_error', ...(err.extra || {}) };
      if (status >= 500 && !err.code) body.detail = String(err && err.message || err).slice(0, 300);
      return json(body, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (p === '/' || p === '/api/health') {
    return json({ ok: true, service: 'klipded-api', version: VERSION, time: new Date().toISOString() });
  }
  if (p === '/api/license/activate' && m === 'POST') return handleActivate(request, env);
  if (p === '/api/transcribe' && m === 'POST') return handleTranscribe(request, env);
  if (p === '/api/highlights' && m === 'POST') return handleHighlights(request, env);
  if (p === '/api/highlights-video' && m === 'POST') return handleHighlightsVideo(request, env);

  if (p.startsWith('/api/admin/')) {
    requireAdmin(request, env);
    if (p === '/api/admin/keys' && m === 'GET') return adminListKeys(url, env);
    if (p === '/api/admin/keys' && m === 'POST') return adminCreateKeys(request, env);
    if (p === '/api/admin/key-action' && m === 'POST') return adminKeyAction(request, env);
    if (p === '/api/admin/stats' && m === 'GET') return adminStats(env);
  }
  throw httpError(404, 'not_found');
}

/* ------------------------------------------------------------------ helpers */

function httpError(status, code, extra) {
  const e = new Error(code);
  e.status = status; e.code = code; e.extra = extra;
  return e;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  let allow = '*';
  if (!allowed.includes('*')) allow = allowed.includes(origin) ? origin : (allowed[0] || 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-License-Key, X-Device-Id, X-Lang, X-Prompt, X-Chunk-Seconds',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const nowIso = () => new Date().toISOString();
const clampNum = (v, lo, hi, d) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

function normalizeKey(k) {
  return String(k || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '').slice(0, 64);
}

function randomKey(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 12) throw httpError(500, 'admin_token_not_set');
  if (!safeEqual(token, env.ADMIN_TOKEN)) throw httpError(401, 'unauthorized');
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError(400, 'bad_json'); }
}

function publicLicense(lic) {
  const remaining = Math.max(0, (lic.quota_seconds || 0) - (lic.used_seconds || 0));
  let devices = [];
  try { devices = JSON.parse(lic.devices || '[]'); } catch {}
  return {
    key: lic.license_key,
    plan: lic.plan,
    status: lic.status,
    durationDays: lic.duration_days,
    activatedAt: lic.activated_at,
    expiresAt: lic.expires_at,
    quotaSeconds: lic.quota_seconds,
    usedSeconds: lic.used_seconds,
    remainingSeconds: remaining,
    maxDevices: lic.max_devices,
    deviceCount: devices.length,
  };
}

/* ------------------------------------------------------------------ license */

async function checkLicense(env, rawKey, deviceId) {
  const key = normalizeKey(rawKey);
  if (!key) throw httpError(401, 'missing_key');
  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(key).first();
  if (!lic) throw httpError(403, 'invalid_key');
  if (lic.status !== 'active') throw httpError(403, 'revoked');

  const now = new Date();
  const sets = [];
  const vals = [];

  if (!lic.activated_at) {
    lic.activated_at = now.toISOString();
    lic.expires_at = new Date(now.getTime() + lic.duration_days * 86400000).toISOString();
    sets.push('activated_at = ?', 'expires_at = ?');
    vals.push(lic.activated_at, lic.expires_at);
  }
  if (lic.expires_at && new Date(lic.expires_at) <= now) {
    throw httpError(403, 'expired', { expiresAt: lic.expires_at });
  }

  let devices = [];
  try { devices = JSON.parse(lic.devices || '[]'); } catch {}
  const dev = String(deviceId || '').slice(0, 64);
  if (dev && !devices.includes(dev)) {
    if (devices.length >= lic.max_devices) throw httpError(403, 'device_limit', { maxDevices: lic.max_devices });
    devices.push(dev);
    lic.devices = JSON.stringify(devices);
    sets.push('devices = ?');
    vals.push(lic.devices);
  }

  lic.last_used_at = now.toISOString();
  sets.push('last_used_at = ?');
  vals.push(lic.last_used_at);
  await env.DB.prepare(`UPDATE licenses SET ${sets.join(', ')} WHERE license_key = ?`).bind(...vals, key).run();
  return lic;
}

async function handleActivate(request, env) {
  const body = await readJson(request);
  const lic = await checkLicense(env, body.key, body.deviceId);
  return json({ ok: true, license: publicLicense(lic) });
}

/* --------------------------------------------------------------- transcribe */

async function handleTranscribe(request, env) {
  const lic = await checkLicense(env, request.headers.get('X-License-Key'), request.headers.get('X-Device-Id'));
  const declared = clampNum(request.headers.get('X-Chunk-Seconds'), 0, 7200, 0);
  const remaining = lic.quota_seconds - lic.used_seconds;
  if (remaining <= 0 || declared > remaining + 10) {
    throw httpError(402, 'quota_exceeded', { remainingSeconds: Math.max(0, remaining) });
  }
  if (!env.GROQ_API_KEY) throw httpError(500, 'groq_key_not_set');

  const lang = String(request.headers.get('X-Lang') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
  let prompt = '';
  try { prompt = decodeURIComponent(request.headers.get('X-Prompt') || ''); } catch {}
  prompt = prompt.slice(0, 500);

  const type = (request.headers.get('Content-Type') || 'audio/ogg').split(';')[0].trim();
  const ext = type.includes('webm') ? 'webm' : type.includes('mp4') || type.includes('m4a') ? 'm4a'
    : type.includes('wav') ? 'wav' : type.includes('mpeg') || type.includes('mp3') ? 'mp3' : type.includes('flac') ? 'flac' : 'ogg';
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 200) throw httpError(400, 'empty_audio');
  if (audio.byteLength > MAX_AUDIO_BYTES) throw httpError(413, 'file_too_large');

  const model = env.GROQ_STT_MODEL || 'whisper-large-v3';
  const form = new FormData();
  form.append('file', new Blob([audio], { type }), `chunk.${ext}`);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  if (lang && lang !== 'auto') form.append('language', lang);
  if (prompt) form.append('prompt', prompt);

  const base = (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const res = await fetchWithRetry(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  }, 3);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw httpError(502, res.status === 429 ? 'stt_busy' : 'stt_failed', { upstreamStatus: res.status, detail });
  }
  const data = await res.json();
  const seconds = Math.max(1, Math.ceil(Number(data.duration) || declared || 1));
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE licenses SET used_seconds = used_seconds + ? WHERE license_key = ?').bind(seconds, lic.license_key),
    env.DB.prepare('INSERT INTO usage_log (license_key, kind, seconds, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(lic.license_key, 'transcribe', seconds, `${model}|${data.language || lang || ''}`, t),
  ]);

  const r2 = (x) => Math.round(Number(x) * 100) / 100;
  return json({
    language: data.language || lang || '',
    duration: Number(data.duration) || declared,
    segments: (data.segments || []).map((s) => ({ s: r2(s.start), e: r2(s.end), t: s.text, nsp: r2(s.no_speech_prob || 0) })),
    words: (data.words || []).map((w) => ({ w: w.word, s: r2(w.start), e: r2(w.end) })),
    usage: { usedSeconds: lic.used_seconds + seconds, quotaSeconds: lic.quota_seconds },
  });
}

async function fetchWithRetry(url, init, attempts) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await fetch(url, init);
      if (last.status !== 429 && last.status < 500) return last;
    } catch (e) {
      if (i === attempts - 1) throw httpError(502, 'upstream_unreachable', { detail: String(e.message || e).slice(0, 200) });
    }
    if (i < attempts - 1) {
      const ra = Number(last && last.headers.get('retry-after'));
      try { if (last && last.body) await last.body.cancel(); } catch {}
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 12) * 1000 : 1500 * (i + 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return last;
}

/* --------------------------------------------------------------- highlights */

const CLIP_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'clip start in seconds' },
          end: { type: 'number', description: 'clip end in seconds' },
          title: { type: 'string' },
          hook: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          score: { type: 'integer' },
        },
        required: ['start', 'end', 'title', 'hook', 'caption', 'hashtags', 'reason', 'score'],
      },
    },
  },
  required: ['clips'],
};

const TYPE_TEXT = {
  podcast: 'Podcast / interview / people talking. Viewers love strong opinions, funny banter, surprising stories and quotable lines.',
  gaming: 'Gaming stream or gameplay with commentary (for example GTA 6). Viewers love chaotic or funny moments, big wins and fails, rage or hype reactions, surprising discoveries, tips and secrets.',
  general: 'General video (vlog, talk, commentary, tutorial or news). Viewers love surprising facts, useful tips, emotional moments and stories with a payoff.',
};

function langRuleOf(o) {
  return o.lang === 'th' ? 'Thai'
    : o.lang === 'en' ? 'English'
    : 'the main language spoken in the video (Thai if the speech is mostly Thai)';
}

const SYSTEM_PROMPT = [
  'You are a senior short-form video editor who has cut thousands of viral TikToks, YouTube Shorts and Instagram Reels.',
  'You choose the moments of a long video that will perform best as standalone vertical clips.',
  'You answer with JSON only.',
].join(' ');

function pickRules(o) {
  const target = Math.round((o.minSec + o.maxSec) / 2);
  return `VIDEO TYPE: ${TYPE_TEXT[o.type] || TYPE_TEXT.general}
TOPIC / GAME: ${o.topic || 'not specified'}
CLIP LENGTH: between ${o.minSec} and ${o.maxSec} seconds (aim for about ${target} s)
NUMBER OF CLIPS: up to ${o.count}, best first. Return fewer if there are not enough strong moments.
LANGUAGE of title, hook, caption and hashtags: ${langRuleOf(o)}. The "reason" field must always be written in Thai.

HOW TO PICK
1. Self-contained: a viewer with zero context must understand the clip. Start at the beginning of a sentence or action and end right after the punchline, answer, payoff or conclusion. Never end mid-sentence.
2. Hook first: the first 3 seconds must grab attention (bold claim, question, conflict, surprise, strong emotion, a joke, a crazy action). Cut slow setup when possible.
3. Prefer: funny moments, hot takes, stories with a payoff, emotional peaks, surprising facts, practical tips, intense or chaotic moments with strong reactions (laughing, screaming, rage, hype), epic wins and fails.
4. Avoid: intros, outros, greetings, sponsor reads, "like and subscribe", menus/loading screens, technical setup talk, long silences, overlapping clips.
5. Clips must not overlap.
6. score = predicted viral potential from 0 to 100. Be honest and spread the scores.

FIELDS
- start, end: seconds (numbers)
- title: catchy, max 60 characters, creates curiosity, no false claims
- hook: max 8 words, big text shown during the first seconds of the clip
- caption: 1-2 sentence post caption
- hashtags: 4-8 relevant hashtags each starting with #, include the topic/game when known
- reason: why this moment works, in Thai, max 120 characters

Return JSON: {"clips":[{"start":0,"end":0,"title":"","hook":"","caption":"","hashtags":[],"reason":"","score":0}]}`;
}

function buildPrompt(transcript, o) {
  const user = `${pickRules(o)}

VIDEO LENGTH: ${Math.round(o.duration)} seconds
The input is a timestamped transcript. Use its timestamps (seconds) for start and end.
Lines marked "(no speech, loud ...)" are loud moments without talking (action, music, explosions). Use them only when nearby speech or a reaction makes the moment understandable.

TRANSCRIPT (format: [start-end] text):
${transcript}`;
  return { system: SYSTEM_PROMPT, user };
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function buildVideoPrompt(o, ws, we) {
  const range = we > ws
    ? `You are watching only the part of the video from ${fmtClock(ws)} to ${fmtClock(we)} (seconds ${Math.round(ws)} to ${Math.round(we)} of the full video).`
    : 'You are watching the whole video.';
  const user = `${pickRules(o)}

${range}
Use BOTH the visuals and the audio (speech, reactions, music, sound effects) to judge what is exciting.
IMPORTANT: start and end must be measured in seconds from the very beginning of the FULL video${we > ws ? `, so they must be between ${Math.round(ws)} and ${Math.round(we)}` : ''}.`;
  return { system: SYSTEM_PROMPT, user };
}

async function handleHighlights(request, env) {
  const body = await readJson(request);
  const lic = await checkLicense(env, body.key, body.deviceId);

  const limit = clampNum(env.HIGHLIGHTS_PER_DAY, 1, 10000, 40);
  const since = new Date(Date.now() - 86400000).toISOString();
  await checkDailyLimit(env, lic, limit, since);

  const transcript = String(body.transcript || '').slice(0, MAX_TRANSCRIPT_CHARS);
  if (transcript.trim().length < 20) throw httpError(400, 'empty_transcript');
  const opts = pickOptions(body.options);

  const { system, user } = buildPrompt(transcript, opts);
  const out = await callLLM(env, system, user);
  const clips = normalizeClips(out.data);

  await env.DB.prepare('INSERT INTO usage_log (license_key, kind, seconds, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(lic.license_key, 'highlights', 0, `${out.model}|${clips.length}`, nowIso()).run();
  return json({ clips, model: out.model });
}

function pickOptions(o = {}) {
  let minSec = clampNum(o.minSec, 5, 170, 30);
  let maxSec = clampNum(o.maxSec, 10, 180, 60);
  if (maxSec <= minSec) maxSec = minSec + 10;
  return {
    count: Math.round(clampNum(o.count, 1, 20, 6)),
    minSec, maxSec,
    lang: ['th', 'en'].includes(o.lang) ? o.lang : 'auto',
    type: ['podcast', 'gaming', 'general'].includes(o.type) ? o.type : 'general',
    topic: String(o.topic || '').replace(/[\r\n]+/g, ' ').slice(0, 120),
    duration: clampNum(o.duration, 1, 86400, 0),
  };
}

function normalizeClips(data) {
  return (Array.isArray(data && data.clips) ? data.clips : []).slice(0, 25).map((c) => ({
    start: Number(c.start), end: Number(c.end),
    title: String(c.title || '').slice(0, 140),
    hook: String(c.hook || '').slice(0, 120),
    caption: String(c.caption || '').slice(0, 600),
    hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 10),
    reason: String(c.reason || '').slice(0, 300),
    score: Math.round(clampNum(c.score, 0, 100, 50)),
  })).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

async function checkDailyLimit(env, lic, limit, since) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_log WHERE license_key = ? AND kind IN ('highlights', 'vision') AND created_at > ?")
    .bind(lic.license_key, since).first();
  if (row && row.n >= limit) throw httpError(429, 'daily_limit', { limit });
}

/* ------------------------------------------------- highlights from a YouTube URL */

function youtubeId(u) {
  try {
    const url = new URL(String(u || '').trim());
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return url.pathname.slice(1, 12);
    if (host === 'youtube.com') {
      const v = url.searchParams.get('v');
      if (v) return v.slice(0, 11);
      const m = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

async function handleHighlightsVideo(request, env) {
  const body = await readJson(request);
  const lic = await checkLicense(env, body.key, body.deviceId);
  if (!env.GEMINI_API_KEY) throw httpError(400, 'vision_not_available');
  const id = youtubeId(body.url);
  if (!id || !/^[\w-]{11}$/.test(id)) throw httpError(400, 'bad_url');
  const ytUrl = `https://www.youtube.com/watch?v=${id}`;

  const opts = pickOptions(body.options);
  const ws = clampNum(body.window && body.window.start, 0, 86400, 0);
  const we = clampNum(body.window && body.window.end, 0, 86400, 0);
  const winLen = we > ws ? we - ws : (opts.duration || 3600);
  const remaining = lic.quota_seconds - lic.used_seconds;
  if (remaining <= 0 || winLen > remaining + 30) throw httpError(402, 'quota_exceeded', { remainingSeconds: Math.max(0, remaining) });

  const limit = clampNum(env.HIGHLIGHTS_PER_DAY, 1, 10000, 40);
  await checkDailyLimit(env, lic, limit, new Date(Date.now() - 86400000).toISOString());

  const { system, user } = buildVideoPrompt(opts, ws, we);
  const models = [env.GEMINI_MODEL || 'gemini-flash-latest', env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest']
    .filter((m, i, a) => m && m !== 'off' && a.indexOf(m) === i);
  const errors = [];
  let data = null;
  let used = '';
  for (const model of models) {
    try {
      data = await callGeminiVideo(env, model, ytUrl, ws, we, system, user);
      used = model;
      break;
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
    }
  }
  if (!data) throw httpError(502, 'vision_failed', { detail: errors.join(' | ').slice(0, 600) });

  let clips = normalizeClips(data);
  if (we > ws && ws > 30 && clips.length) {
    const inside = clips.filter((c) => c.start >= ws - 5 && c.end <= we + 5).length;
    const relative = clips.filter((c) => c.end <= we - ws + 5).length;
    if (!inside && relative) clips = clips.map((c) => ({ ...c, start: c.start + ws, end: c.end + ws }));
  }
  if (we > ws) clips = clips.filter((c) => c.end > ws - 5 && c.start < we + 5);

  const seconds = Math.ceil(winLen);
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE licenses SET used_seconds = used_seconds + ? WHERE license_key = ?').bind(seconds, lic.license_key),
    env.DB.prepare('INSERT INTO usage_log (license_key, kind, seconds, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(lic.license_key, 'vision', seconds, `${used}|${id}|${clips.length}`, t),
  ]);
  return json({ clips, model: used, window: [ws, we], usage: { usedSeconds: lic.used_seconds + seconds, quotaSeconds: lic.quota_seconds } });
}

async function callGeminiVideo(env, model, ytUrl, ws, we, system, user) {
  const base = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };
  const offsets = we > ws ? { startOffset: `${Math.floor(ws)}s`, endOffset: `${Math.ceil(we)}s` } : null;
  const variants = [
    { vm: offsets ? { ...offsets, fps: 0.5 } : { fps: 0.5 }, gen: { responseMimeType: 'application/json', responseJsonSchema: CLIP_SCHEMA, mediaResolution: 'MEDIA_RESOLUTION_LOW', temperature: 0.7 } },
    { vm: offsets, gen: { responseMimeType: 'application/json', mediaResolution: 'MEDIA_RESOLUTION_LOW', temperature: 0.7 } },
    { vm: offsets, gen: { responseMimeType: 'application/json', temperature: 0.7 } },
  ];
  let lastErr = '';
  for (const v of variants) {
    const videoPart = { fileData: { fileUri: ytUrl } };
    if (v.vm) videoPart.videoMetadata = v.vm;
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [videoPart, { text: user }] }],
      generationConfig: v.gen,
    });
    const res = await fetchWithRetry(url, { method: 'POST', headers, body }, 2);
    if (res.status === 400) { lastErr = `HTTP 400 ${(await res.text()).slice(0, 200)}`; continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    if (!text) throw new Error(`empty response (${(data.candidates && data.candidates[0] && data.candidates[0].finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'no candidates'})`);
    return parseJsonLoose(text);
  }
  throw new Error(lastErr || 'request rejected');
}

async function callLLM(env, system, user) {
  const errors = [];
  if (env.GEMINI_API_KEY) {
    const models = [env.GEMINI_MODEL || 'gemini-flash-latest', env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest']
      .filter((m, i, a) => m && m !== 'off' && a.indexOf(m) === i);
    for (const model of models) {
      try {
        return { data: await callGemini(env, model, system, user), model };
      } catch (e) {
        errors.push(`${model}: ${e.message}`);
      }
    }
  }
  const groqModel = env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';
  if (env.GROQ_API_KEY && groqModel !== 'off') {
    try {
      return { data: await callGroqLLM(env, groqModel, system, user), model: groqModel };
    } catch (e) {
      errors.push(`${groqModel}: ${e.message}`);
    }
  }
  if (!errors.length) throw httpError(500, 'llm_key_not_set');
  throw httpError(502, 'llm_failed', { detail: errors.join(' | ').slice(0, 600) });
}

async function callGemini(env, model, system, user) {
  const base = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const makeBody = (withSchema) => JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: withSchema
      ? { responseMimeType: 'application/json', responseJsonSchema: CLIP_SCHEMA, temperature: 0.7 }
      : { responseMimeType: 'application/json', temperature: 0.7 },
  });
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY };
  let res = await fetchWithRetry(url, { method: 'POST', headers, body: makeBody(true) }, 2);
  if (res.status === 400) {
    // Older/newer API versions may reject the schema field: retry with plain JSON mode.
    res = await fetchWithRetry(url, { method: 'POST', headers, body: makeBody(false) }, 2);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text) throw new Error(`empty response (${(data.candidates && data.candidates[0] && data.candidates[0].finishReason) || 'no candidates'})`);
  return parseJsonLoose(text);
}

async function callGroqLLM(env, model, system, user) {
  const base = (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    temperature: 0.6,
    max_completion_tokens: 8192,
  };
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'medium';
  const res = await fetchWithRetry(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify(body),
  }, 2);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('empty response');
  return parseJsonLoose(text);
}

function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch {}
  }
  throw new Error('invalid JSON from model');
}

/* -------------------------------------------------------------------- admin */

async function adminCreateKeys(request, env) {
  const b = await readJson(request);
  const count = Math.round(clampNum(b.count, 1, 50, 1));
  const days = Math.round(clampNum(b.durationDays, 1, 3650, 30));
  const quotaSeconds = Math.round(clampNum(b.quotaHours, 0.05, 100000, 10) * 3600);
  const maxDevices = Math.round(clampNum(b.maxDevices, 1, 20, 2));
  const plan = String(b.plan || 'custom').slice(0, 40);
  const note = String(b.note || '').slice(0, 200);
  const prefix = String(env.KEY_PREFIX || 'KD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'KD';
  const created = [];
  const t = nowIso();
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = randomKey(prefix);
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO licenses (license_key, plan, note, status, duration_days, quota_seconds, used_seconds, max_devices, devices, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?, '[]', ?)`
      ).bind(key, plan, note, days, quotaSeconds, maxDevices, t).run();
      if (r.meta && r.meta.changes) { created.push(key); break; }
    }
  }
  return json({ ok: true, keys: created, plan, durationDays: days, quotaSeconds, maxDevices, note });
}

async function adminListKeys(url, env) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
  const limit = Math.round(clampNum(url.searchParams.get('limit'), 1, 500, 100));
  const offset = Math.round(clampNum(url.searchParams.get('offset'), 0, 1e9, 0));
  let stmt;
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    stmt = env.DB.prepare('SELECT * FROM licenses WHERE license_key LIKE ? OR note LIKE ? OR plan LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(like.toUpperCase(), like, like, limit, offset);
  } else {
    stmt = env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset);
  }
  const { results } = await stmt.all();
  return json({
    keys: (results || []).map((r) => ({ ...publicLicense(r), note: r.note, createdAt: r.created_at, lastUsedAt: r.last_used_at })),
  });
}

async function adminKeyAction(request, env) {
  const b = await readJson(request);
  const key = normalizeKey(b.key);
  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(key).first();
  if (!lic) throw httpError(404, 'invalid_key');
  const action = String(b.action || '');
  const DB = env.DB;
  switch (action) {
    case 'revoke':
      await DB.prepare("UPDATE licenses SET status = 'revoked' WHERE license_key = ?").bind(key).run();
      break;
    case 'activate':
      await DB.prepare("UPDATE licenses SET status = 'active' WHERE license_key = ?").bind(key).run();
      break;
    case 'extend': {
      const days = Math.round(clampNum(b.days, -3650, 3650, 0));
      if (lic.expires_at) {
        // Extending an already-expired key counts from now, otherwise from its current expiry.
        const baseMs = Math.max(new Date(lic.expires_at).getTime(), days > 0 ? Date.now() : 0);
        const exp = new Date(baseMs + days * 86400000).toISOString();
        await DB.prepare('UPDATE licenses SET expires_at = ? WHERE license_key = ?').bind(exp, key).run();
      } else {
        await DB.prepare('UPDATE licenses SET duration_days = MAX(1, duration_days + ?) WHERE license_key = ?').bind(days, key).run();
      }
      break;
    }
    case 'add_hours': {
      const secs = Math.round(clampNum(b.hours, -100000, 100000, 0) * 3600);
      await DB.prepare('UPDATE licenses SET quota_seconds = MAX(0, quota_seconds + ?) WHERE license_key = ?').bind(secs, key).run();
      break;
    }
    case 'reset_usage':
      await DB.prepare('UPDATE licenses SET used_seconds = 0 WHERE license_key = ?').bind(key).run();
      break;
    case 'reset_devices':
      await DB.prepare("UPDATE licenses SET devices = '[]' WHERE license_key = ?").bind(key).run();
      break;
    case 'set_note':
      await DB.prepare('UPDATE licenses SET note = ? WHERE license_key = ?').bind(String(b.note || '').slice(0, 200), key).run();
      break;
    case 'delete':
      await DB.batch([
        DB.prepare('DELETE FROM usage_log WHERE license_key = ?').bind(key),
        DB.prepare('DELETE FROM licenses WHERE license_key = ?').bind(key),
      ]);
      return json({ ok: true, deleted: key });
    default:
      throw httpError(400, 'bad_action');
  }
  const updated = await DB.prepare('SELECT * FROM licenses WHERE license_key = ?').bind(key).first();
  return json({ ok: true, license: { ...publicLicense(updated), note: updated.note, createdAt: updated.created_at, lastUsedAt: updated.last_used_at } });
}

async function adminStats(env) {
  const now = nowIso();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const [total, active, notStarted, expired, usage, highlights] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM licenses'),
    env.DB.prepare("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > ?").bind(now),
    env.DB.prepare("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active' AND activated_at IS NULL"),
    env.DB.prepare('SELECT COUNT(*) AS n FROM licenses WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now),
    env.DB.prepare("SELECT COALESCE(SUM(seconds), 0) AS s FROM usage_log WHERE kind = 'transcribe' AND created_at > ?").bind(since30),
    env.DB.prepare("SELECT COUNT(*) AS n FROM usage_log WHERE kind = 'highlights' AND created_at > ?").bind(since30),
  ]);
  const first = (r, f) => (r.results && r.results[0] ? r.results[0][f] : 0);
  return json({
    totalKeys: first(total, 'n'),
    activeKeys: first(active, 'n'),
    notStartedKeys: first(notStarted, 'n'),
    expiredKeys: first(expired, 'n'),
    transcribedSeconds30d: first(usage, 's'),
    highlightCalls30d: first(highlights, 'n'),
  });
}
