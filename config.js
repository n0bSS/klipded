// ===== ตั้งค่าเว็บ (แก้ไฟล์นี้ไฟล์เดียวพอ) =====
export const CONFIG = {
  APP_NAME: 'KlipDed',
  APP_NAME_TH: 'คลิปเด็ด',
  TAGLINE: 'ตัดคลิปสั้นจากวิดีโอยาวด้วย AI ลง TikTok / Shorts / Reels ได้ทันที',

  // URL ของหลังบ้าน (Cloudflare Worker) ที่ได้หลังจาก deploy เช่น https://klipded-api.yourname.workers.dev
  API_BASE: 'https://klipded-api.YOUR-SUBDOMAIN.workers.dev',

  // ช่องทางติดต่อ / ส่งสลิป
  CONTACT_LINE_URL: 'https://line.me/ti/p/~YOUR_LINE_ID',
  CONTACT_LABEL: 'LINE: YOUR_LINE_ID',

  // พร้อมเพย์สำหรับหน้าเช่าคีย์ (เบอร์มือถือ หรือเลขบัตรประชาชน 13 หลัก) เว้นว่างไว้ = ไม่แสดง QR
  PROMPTPAY_ID: '',
  PROMPTPAY_NAME: '',

  // แพ็กเกจเช่าคีย์ (hours = ความยาววิดีโอรวมที่ให้ AI ถอดเสียงได้)
  PLANS: [
    { id: 'week', name: 'ทดลอง 7 วัน', price: 99, days: 7, hours: 3, devices: 1 },
    { id: 'month', name: 'รายเดือน 30 วัน', price: 299, days: 30, hours: 15, devices: 2, popular: true },
    { id: 'quarter', name: '3 เดือน 90 วัน', price: 790, days: 90, hours: 50, devices: 2 },
  ],
};
