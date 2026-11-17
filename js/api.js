import { CONFIG } from '../config.js';

const base = () => String(CONFIG.API_BASE || '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(code, status, data = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

async function handle(res) {
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(data.error || `http_${res.status}`, res.status, data);
  return data;
}

async function send(path, init) {
  let res;
  try {
    res = await fetch(base() + path, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('network', 0, { detail: String(e.message || e) });
  }
  return handle(res);
}

const postJSON = (path, body, headers = {}, signal) =>
  send(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });

export const api = {
  activate: (key, deviceId) => postJSON('/api/license/activate', { key, deviceId }),

  transcribe: (key, deviceId, blob, { lang = '', prompt = '', seconds = 0, signal } = {}) =>
    send('/api/transcribe', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': blob.type || 'audio/ogg',
        'X-License-Key': key,
        'X-Device-Id': deviceId,
        'X-Lang': lang,
        'X-Prompt': encodeURIComponent(prompt || ''),
        'X-Chunk-Seconds': String(Math.ceil(seconds)),
      },
      body: blob,
    }),

  highlights: (payload, signal) => postJSON('/api/highlights', payload, {}, signal),
  highlightsVideo: (payload, signal) => postJSON('/api/highlights-video', payload, {}, signal),

  admin: {
    headers: (token) => ({ Authorization: `Bearer ${token}` }),
    list: (token, q = '') => send(`/api/admin/keys?limit=300&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } }),
    stats: (token) => send('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } }),
    create: (token, body) => postJSON('/api/admin/keys', body, { Authorization: `Bearer ${token}` }),
    action: (token, body) => postJSON('/api/admin/key-action', body, { Authorization: `Bearer ${token}` }),
  },
};

const MESSAGES = {
  missing_key: 'กรุณาใส่คีย์ก่อนใช้งาน',
  invalid_key: 'คีย์ไม่ถูกต้อง ตรวจสอบตัวอักษรอีกครั้ง',
  revoked: 'คีย์นี้ถูกระงับการใช้งาน ติดต่อแอดมิน',
  expired: 'คีย์หมดอายุแล้ว เช่าคีย์ใหม่หรือต่ออายุได้ที่หน้าเช่าคีย์',
  device_limit: 'คีย์นี้ใช้ครบจำนวนเครื่องแล้ว ติดต่อแอดมินเพื่อรีเซ็ตเครื่อง',
  quota_exceeded: 'โควตาชั่วโมงวิดีโอของคีย์นี้หมดแล้ว',
  daily_limit: 'วันนี้ใช้ AI คัดคลิปครบจำนวนแล้ว ลองใหม่พรุ่งนี้',
  stt_busy: 'ระบบถอดเสียงคิวเต็มชั่วคราว รอสักครู่แล้วลองใหม่',
  stt_failed: 'ถอดเสียงไม่สำเร็จ ลองใหม่อีกครั้ง',
  llm_failed: 'AI คัดคลิปไม่สำเร็จ ลองใหม่อีกครั้ง',
  empty_transcript: 'ไม่พบเสียงพูดในวิดีโอ',
  empty_audio: 'ไฟล์เสียงว่าง',
  file_too_large: 'ไฟล์เสียงใหญ่เกินไป',
  network: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ต (หรือยังไม่ได้ตั้งค่า API_BASE)',
  unauthorized: 'รหัสแอดมินไม่ถูกต้อง',
  admin_token_not_set: 'ยังไม่ได้ตั้ง ADMIN_TOKEN ในหลังบ้าน',
  groq_key_not_set: 'หลังบ้านยังไม่ได้ตั้ง GROQ_API_KEY',
  llm_key_not_set: 'หลังบ้านยังไม่ได้ตั้งคีย์ AI (GEMINI_API_KEY / GROQ_API_KEY)',
  upstream_unreachable: 'ติดต่อผู้ให้บริการ AI ไม่ได้ ลองใหม่อีกครั้ง',
  vision_not_available: 'หลังบ้านยังไม่ได้ตั้ง GEMINI_API_KEY จึงใช้โหมดดูภาพไม่ได้',
  vision_failed: 'AI ดูวิดีโอไม่สำเร็จ (คลิปต้องเป็นสาธารณะ)',
  bad_url: 'ลิงก์ไม่ถูกต้อง',
  helper_offline: 'ยังไม่ได้เปิดโปรแกรมช่วยโหลด (KlipDed Helper) บนคอมเครื่องนี้',
  download_failed: 'โหลดวิดีโอจากลิงก์ไม่สำเร็จ',
  info_failed: 'อ่านข้อมูลจากลิงก์ไม่ได้ (ลิงก์ผิด หรือคลิปเป็นแบบส่วนตัว)',
  origin_not_allowed: 'โปรแกรมช่วยโหลดไม่อนุญาตเว็บนี้ (ใส่ --origin ตามคู่มือ)',
  no_audio: 'วิดีโอนี้ไม่มีเสียง',
  audio_not_decodable: 'เบราว์เซอร์อ่านเสียงของไฟล์นี้ไม่ได้ ลองแปลงเป็น MP4 ก่อน',
  no_video: 'ไฟล์นี้ไม่มีภาพวิดีโอ',
  no_video_encoder: 'เบราว์เซอร์นี้สร้างไฟล์วิดีโอไม่ได้ ใช้ Chrome หรือ Edge เวอร์ชันล่าสุด',
};

export function errorText(err) {
  if (!err) return 'เกิดข้อผิดพลาด';
  if (err.name === 'AbortError' || err.code === 'aborted') return 'ยกเลิกแล้ว';
  const code = err.code || err.message;
  let msg = MESSAGES[code] || `เกิดข้อผิดพลาด (${code || err})`;
  if (code === 'device_limit' && err.data?.maxDevices) msg += ` (สูงสุด ${err.data.maxDevices} เครื่อง)`;
  return msg;
}
