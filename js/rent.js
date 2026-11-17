import { CONFIG } from '../config.js';
import { $, el } from './util.js';
import { promptPayPayload } from './promptpay.js';
import qrcode from '../lib/qrcode.mjs';

const plans = CONFIG.PLANS || [];
let current = plans.find((p) => p.popular) || plans[0];

function renderPlans() {
  const box = $('#plans');
  box.replaceChildren(...plans.map((p) => el('div', { class: 'plan' + (p === current ? ' on' : ''), onclick: () => { current = p; renderPlans(); renderPay(); } },
    p.popular ? el('div', { class: 'hot' }, 'ยอดนิยม') : null,
    el('h3', {}, p.name),
    el('div', { class: 'price' }, `฿${p.price.toLocaleString()} `, el('small', {}, `/ ${p.days} วัน`)),
    el('ul', {},
      el('li', {}, `วิเคราะห์วิดีโอได้ ${p.hours} ชั่วโมง`),
      el('li', {}, `ใช้ได้ ${p.devices} เครื่อง`),
      el('li', {}, 'คลิปไม่จำกัด · ไม่มีลายน้ำ'),
      el('li', {}, 'ซับไทย / อังกฤษ + ชื่อคลิป + แฮชแท็ก')),
    el('button', { class: 'btn ' + (p === current ? 'primary' : '') }, p === current ? 'เลือกแล้ว ✓' : 'เลือกแพ็กเกจนี้'))));
}

function renderPay() {
  const line = CONFIG.CONTACT_LINE_URL || '#';
  $('#lineLink').href = line;
  $('#lineLink').textContent = CONFIG.CONTACT_LABEL || 'LINE';
  $('#lineBtn').href = line;
  if (!current) return;
  $('#payTitle').textContent = `${current.name} — ฿${current.price.toLocaleString()}`;
  const qrBox = $('#qr');
  if (!CONFIG.PROMPTPAY_ID) {
    qrBox.replaceChildren(el('div', { style: { padding: '30px 10px' } }, 'ติดต่อแอดมินทาง LINE เพื่อรับเลขบัญชี'));
    $('#ppNote').textContent = '';
    return;
  }
  const qr = qrcode(0, 'M');
  qr.addData(promptPayPayload(CONFIG.PROMPTPAY_ID, current.price));
  qr.make();
  const holder = el('div', { html: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) });
  qrBox.replaceChildren(
    el('div', { class: 'pp' }, 'PromptPay'),
    holder,
    el('div', { style: { fontWeight: '700', fontSize: '18px' } }, `฿${current.price.toLocaleString()}`),
    CONFIG.PROMPTPAY_NAME ? el('div', { class: 'small' }, CONFIG.PROMPTPAY_NAME) : null,
  );
  $('#ppNote').textContent = 'ตรวจชื่อบัญชีในแอปธนาคารก่อนโอนทุกครั้ง';
}

renderPlans();
renderPay();
