import { CONFIG } from '../config.js';
import { $, el, toast, fmtHours, copyText, debounce } from './util.js';
import { api, errorText } from './api.js';

let token = sessionStorage.getItem('kd.admin') || '';
const SITE = location.href.replace(/admin\.html.*$/, '');

const fmtDate = (s) => (s ? new Date(s).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function status(k) {
  if (k.status !== 'active') return ['ระงับ', 'rev'];
  if (!k.activatedAt) return ['ยังไม่เริ่มใช้', 'new'];
  if (k.expiresAt && new Date(k.expiresAt) <= new Date()) return ['หมดอายุ', 'exp'];
  return ['ใช้งานอยู่', 'ok'];
}

function customerMessage(key, d) {
  return `🎬 คีย์ ${CONFIG.APP_NAME_TH} (${CONFIG.APP_NAME}) ของคุณ
คีย์: ${key}
แพ็กเกจ: ${d.days} วัน · วิเคราะห์วิดีโอได้ ${d.hours} ชม. · ใช้ได้ ${d.devices} เครื่อง
(เริ่มนับวันเมื่อใส่คีย์ครั้งแรก)

เข้าใช้งาน: ${SITE}
แนะนำ Chrome หรือ Edge บนคอมพิวเตอร์ แล้วกดปุ่ม "ใส่คีย์" มุมขวาบน`;
}

async function login() {
  token = $('#token').value.trim() || token;
  if (!token) return;
  try {
    await loadStats();
    sessionStorage.setItem('kd.admin', token);
    $('#login').classList.add('hidden');
    $('#panel').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    await loadKeys();
  } catch (e) {
    $('#loginMsg').textContent = errorText(e);
    sessionStorage.removeItem('kd.admin');
  }
}

async function loadStats() {
  const s = await api.admin.stats(token);
  const stat = (n, label) => el('div', { class: 'stat' }, el('b', {}, String(n)), el('span', { class: 'small muted' }, label));
  $('#stats').replaceChildren(
    stat(s.totalKeys, 'คีย์ทั้งหมด'),
    stat(s.activeKeys, 'ใช้งานอยู่'),
    stat(s.notStartedKeys, 'ยังไม่เริ่มใช้'),
    stat(s.expiredKeys, 'หมดอายุ'),
    stat(fmtHours(s.transcribedSeconds30d), 'วิดีโอที่วิเคราะห์ (30 วัน)'),
    stat(s.highlightCalls30d, 'ครั้งที่ AI คัดคลิป (30 วัน)'),
  );
}

async function loadKeys() {
  const { keys } = await api.admin.list(token, $('#q').value.trim());
  $('#rows').replaceChildren(...keys.map(row));
  if (!keys.length) $('#rows').append(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'ยังไม่มีคีย์')));
}

function row(k) {
  const [label, cls] = status(k);
  const act = (text, body, confirmMsg, kind = '') => el('button', {
    class: `btn sm ${kind}`,
    onclick: async () => {
      if (confirmMsg && !confirm(confirmMsg)) return;
      try { await api.admin.action(token, { key: k.key, ...body }); toast('บันทึกแล้ว', 'ok'); await loadKeys(); loadStats(); } catch (e) { toast(errorText(e), 'err'); }
    },
  }, text);
  return el('tr', {},
    el('td', {}, el('span', { class: 'mono' }, k.key), el('br'), el('button', { class: 'btn sm ghost', onclick: () => copyText(k.key) }, 'คัดลอก')),
    el('td', {}, k.note || '—', el('div', { class: 'tiny' }, `${k.plan} · สร้าง ${fmtDate(k.createdAt)}`)),
    el('td', {}, el('span', { class: `st ${cls}` }, label)),
    el('td', {}, k.expiresAt ? fmtDate(k.expiresAt) : `${k.durationDays} วันหลังเริ่มใช้`),
    el('td', {}, `${fmtHours(k.usedSeconds)} / ${fmtHours(k.quotaSeconds)}`),
    el('td', {}, `${k.deviceCount}/${k.maxDevices}`),
    el('td', {},
      act('+7 วัน', { action: 'extend', days: 7 }),
      act('+30 วัน', { action: 'extend', days: 30 }),
      act('+5 ชม.', { action: 'add_hours', hours: 5 }),
      act('รีเซ็ตเครื่อง', { action: 'reset_devices' }),
      k.status === 'active'
        ? act('ระงับ', { action: 'revoke' }, `ระงับคีย์ ${k.key}?`, 'danger')
        : act('ปลดระงับ', { action: 'activate' }, null, 'good'),
      act('ลบ', { action: 'delete' }, `ลบคีย์ ${k.key} ถาวร?`, 'danger')),
  );
}

async function create() {
  const d = {
    days: Number($('#days').value) || 30,
    hours: Number($('#hours').value) || 10,
    devices: Number($('#devices').value) || 1,
  };
  const body = {
    count: Number($('#count').value) || 1,
    durationDays: d.days,
    quotaHours: d.hours,
    maxDevices: d.devices,
    plan: $('#plan').value || 'custom',
    note: $('#note').value.trim(),
  };
  const btn = $('#btnCreate');
  btn.disabled = true;
  try {
    const res = await api.admin.create(token, body);
    const box = $('#created');
    box.replaceChildren(...res.keys.map((key) => {
      const msg = customerMessage(key, d);
      return el('div', { class: 'copy-box', style: { marginBottom: '10px' } },
        el('div', { class: 'row' }, el('b', { class: 'mono' }, key), el('div', { class: 'spacer' }),
          el('button', { class: 'btn sm', onclick: () => copyText(key) }, 'คัดลอกคีย์'),
          el('button', { class: 'btn sm primary', onclick: () => copyText(msg) }, 'คัดลอกข้อความส่งลูกค้า')),
        el('div', { class: 'tiny', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, msg));
    }));
    toast(`สร้าง ${res.keys.length} คีย์แล้ว`, 'ok');
    await loadKeys();
    loadStats();
  } catch (e) {
    toast(errorText(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

const OWNER = { id: 'owner', name: '👑 คีย์แอดมิน (ใช้เอง)', days: 9999, hours: 99999, devices: 5 };

function initPlans() {
  const sel = $('#plan');
  const plans = [...(CONFIG.PLANS || []), OWNER];
  sel.replaceChildren(
    ...plans.map((p) => el('option', { value: p.id }, p.price ? `${p.name} (฿${p.price})` : `${p.name} · ${p.days} วัน`)),
    el('option', { value: 'custom' }, 'กำหนดเอง'),
  );
  const apply = () => {
    const p = plans.find((x) => x.id === sel.value);
    if (!p) return;
    $('#days').value = p.days;
    $('#hours').value = p.hours;
    $('#devices').value = p.devices;
  };
  sel.addEventListener('change', apply);
  const pop = plans.find((p) => p.popular);
  if (pop) sel.value = pop.id;
  apply();
}

$('#btnLogin').addEventListener('click', login);
$('#token').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('#logout').addEventListener('click', () => { sessionStorage.removeItem('kd.admin'); location.reload(); });
$('#btnCreate').addEventListener('click', create);
$('#btnReload').addEventListener('click', () => { loadKeys(); loadStats(); });
$('#q').addEventListener('input', debounce(loadKeys, 300));
initPlans();
if (token) login();
