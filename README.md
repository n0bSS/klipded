# 🎬 คลิปเด็ด (KlipDed) — AI ตัดคลิปสั้นจากวิดีโอยาว

วางลิงก์ YouTube หรือลากไฟล์วิดีโอยาว (เป็นชั่วโมงก็ได้) → AI หาช่วงที่น่าจะเรียกยอดวิว → ตัดเป็นคลิปแนวตั้ง 9:16 ใส่ซับไทย/อังกฤษ ตั้งชื่อคลิป + แคปชัน + แฮชแท็กให้ → ได้ไฟล์ MP4 พร้อมลง TikTok / YouTube Shorts / Instagram Reels

พร้อมระบบ **เช่าคีย์** — ลูกค้าไม่ต้องสมัคร API เอง ใส่คีย์ที่ซื้อจากเราแล้วใช้ได้เลย

---

## ทำอะไรได้บ้าง

* **วางลิงก์ YouTube** (ผ่านโปรแกรมช่วยโหลดบน PC) หรือ **ลากไฟล์** MP4 / MOV / WebM / MKV
* **AI 2 โหมด**
  * 🗣️ **เสียงพูด** — ถอดเสียงทั้งคลิป (Whisper) แล้วให้ AI อ่านหาช่วงเด็ด เหมาะกับพอดแคสต์ / สตรีมที่มีคนพูด
  * 👀 **ดูภาพ + เสียง** — ส่งลิงก์ YouTube ให้ Gemini ดูวิดีโอจริง เหมาะกับคลิปเกม (เช่น GTA 6) ที่พูดน้อย
* **ให้คะแนนความไวรัล** + เหตุผลที่เลือก (ภาษาไทย)
* **จัดภาพแนวตั้งอัตโนมัติ** (หาใบหน้าด้วย AI)
  * ตามหน้าคนพูด · แบ่งจอบน-ล่าง 2 คน · **เกม + เฟซแคม** · ย่อพอดีจอ + เบลอพื้นหลัง · ครอปเอง (ลากกรอบ)
* **ซับคาราโอเกะ** ตัวใหญ่ ไฮไลต์คำที่กำลังพูด (ฟอนต์ Kanit รองรับไทย) 5 สไตล์ แก้คำผิดได้
* **Hook** ตัวใหญ่ช่วงต้นคลิป · ลายน้ำชื่อช่อง · แถบความคืบหน้า · 30/60 fps
* **เรนเดอร์ในเบราว์เซอร์** (WebCodecs) ได้ MP4 1080×1920 — ไม่มีค่าเซิร์ฟเวอร์เรนเดอร์
* เก็บผลวิเคราะห์ไว้ในเครื่อง เปิดวิดีโอเดิมซ้ำ **ไม่เสียโควตาซ้ำ**
* หน้า **เช่าคีย์** (QR พร้อมเพย์ใส่ยอดเงินให้) และหน้า **แอดมิน** ออกคีย์ / ต่ออายุ / เพิ่มชั่วโมง / รีเซ็ตเครื่อง / ระงับ

## ภาพรวมระบบ

```
 เว็บ (GitHub Pages)  ── คีย์ + ไฟล์เสียง ──▶  หลังบ้าน (Cloudflare Worker + D1)
   │  ตัดต่อ/เรนเดอร์ในเบราว์เซอร์                ├─ ตรวจคีย์ / โควตา / จำนวนเครื่อง
   │                                              ├─ Groq Whisper  → ถอดเสียง
   │                                              └─ Gemini        → คัดคลิป, ดูวิดีโอ YouTube
   │
   └─ http://127.0.0.1:7788 ──▶ KlipDed Helper บน PC (yt-dlp) ──▶ YouTube
```

API key ของ AI อยู่ที่หลังบ้านเท่านั้น ลูกค้าเห็นแค่คีย์ที่เช่า

---

## ติดตั้ง (ครั้งเดียว ประมาณ 30 นาที)

### 1) สมัคร API key (มีแบบฟรี)

| ใช้ทำอะไร | สมัครที่ |
|---|---|
| ถอดเสียง (Whisper) | Groq — https://console.groq.com/keys |
| AI คัดคลิป + ดูวิดีโอ YouTube | Google Gemini — https://aistudio.google.com/apikey |

### 2) Deploy หลังบ้าน (Cloudflare Worker + D1)

ต้องมี [Node.js](https://nodejs.org) และบัญชี [Cloudflare](https://dash.cloudflare.com) (ฟรี) — เปิด PowerShell:

```powershell
cd worker
npm install
npx wrangler login
npx wrangler d1 create klipded
```

คัดลอก `database_id` ที่ได้ ไปใส่แทน `REPLACE_WITH_YOUR_D1_DATABASE_ID` ใน `worker/wrangler.toml` แล้วรันต่อ:

```powershell
npx wrangler d1 execute klipded --remote --file=schema.sql
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

* `ADMIN_TOKEN` = รหัสแอดมินที่ตั้งเอง (ยาวๆ เดายาก อย่างน้อย 12 ตัว) ใช้เข้าหน้า `admin.html`
* จะได้ URL เช่น `https://klipded-api.<ชื่อคุณ>.workers.dev` — ลองเปิด `/api/health` ต้องเห็น `"ok":true`

### 3) ตั้งค่าเว็บ — แก้ไฟล์ `config.js` ไฟล์เดียว

* `API_BASE` = URL จากข้อ 2
* `CONTACT_LINE_URL`, `CONTACT_LABEL` = LINE สำหรับส่งสลิป
* `PROMPTPAY_ID` (เบอร์มือถือหรือเลขบัตร 13 หลัก), `PROMPTPAY_NAME`
* `PLANS` = ราคา / จำนวนวัน / ชั่วโมงวิดีโอ / จำนวนเครื่อง ของแต่ละแพ็กเกจ

### 4) เปิดเว็บด้วย GitHub Pages

repo นี้ → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main` / `(root)` → **Save**
รอ 1–2 นาที เว็บจะอยู่ที่ **https://n0bss.github.io/klipded/**

จากนั้นล็อกให้เฉพาะเว็บเราเรียก API ได้: แก้ `ALLOWED_ORIGINS = "https://n0bss.github.io"` ใน `worker/wrangler.toml` แล้ว `npx wrangler deploy` อีกครั้ง

### 5) ออกคีย์ให้ตัวเอง

เปิด `https://n0bss.github.io/klipded/admin.html` → ใส่ `ADMIN_TOKEN` → เลือก “กำหนดเอง” เช่น 3650 วัน / 1000 ชม. → สร้างคีย์ → เอาไปใส่ที่ปุ่ม **ใส่คีย์** ในหน้าเว็บ

### 6) (ถ้าจะวางลิงก์ YouTube) ติดตั้งโปรแกรมช่วยโหลดบน PC

1. ติดตั้ง [Python 3](https://www.python.org/downloads/) — ติ๊ก **Add python.exe to PATH**
2. PowerShell:
   ```powershell
   winget install --id DenoLand.Deno -e
   winget install --id Gyan.FFmpeg -e
   ```
3. ดับเบิลคลิก `helper/start-helper.bat` (ครั้งแรกจะติดตั้ง yt-dlp ให้) แล้ว **เปิดหน้าต่างทิ้งไว้**
4. ครั้งแรกที่วางลิงก์ Chrome อาจถามขอสิทธิ์เข้าถึงอุปกรณ์/แอปในเครื่อง → กด **อนุญาต**
5. วันไหน YouTube โหลดไม่ได้ ให้ดับเบิลคลิก `helper/update-ytdlp.bat` (YouTube เปลี่ยนระบบบ่อย ต้องอัปเดต yt-dlp)

วิดีโอที่โหลดจะเก็บไว้ที่ `โฟลเดอร์ผู้ใช้\Videos\KlipDed`

---

## วิธีใช้

1. กด **ใส่คีย์** มุมขวาบน
2. วางลิงก์ YouTube → **ดึงวิดีโอ** (หรือลากไฟล์วิดีโอมาวาง)
3. เลือกประเภท (เกม / พอดแคสต์ / ทั่วไป), ภาษา, ความยาวคลิป, จำนวนคลิป, โหมด AI และใส่หัวข้อ เช่น `GTA 6`
4. กด **🚀 ให้ AI หาคลิปเด็ด** (วิดีโอ 1 ชม. ใช้เวลาประมาณ 2–5 นาที)
5. กด **แก้ไข / พรีวิว** เพื่อปรับช่วงเวลา, ลากกรอบจัดภาพ, แก้คำผิดในซับ, แก้ชื่อคลิป
6. กด **เรนเดอร์** → ได้ MP4 + ปุ่มคัดลอกแคปชันสำหรับ TikTok / Shorts / Reels

> เรนเดอร์หลายคลิป: กด **📁 โฟลเดอร์บันทึก** ก่อน ไฟล์จะถูกเซฟลงโฟลเดอร์เลยโดยไม่ต้องกดยืนยันทีละไฟล์
> ใช้ Chrome หรือ Edge บนคอมพิวเตอร์ (ต้องรองรับ WebCodecs)

---

## ขายคีย์ (ระบบเช่าคีย์)

* `rent.html` แสดงแพ็กเกจ + QR พร้อมเพย์ที่ใส่ยอดเงินให้อัตโนมัติ
* ลูกค้าโอน → ส่งสลิปทาง LINE → เข้า `admin.html` สร้างคีย์ → กด **คัดลอกข้อความส่งลูกค้า** แล้วส่งให้ลูกค้า
* คีย์**เริ่มนับวันเมื่อลูกค้าใส่ครั้งแรก**, มี**โควตาชั่วโมงวิดีโอ**, **จำกัดจำนวนเครื่อง**
* หน้าแอดมิน: +7/+30 วัน, +5 ชม., รีเซ็ตเครื่อง, ระงับ/ปลดระงับ, ลบ, สถิติการใช้งาน 30 วัน
* ดูข้อมูลดิบได้ใน Cloudflare → D1 → `klipded` (ตาราง `licenses`, `usage_log`)

---

## ค่าใช้จ่ายและลิมิตแบบฟรี (ข้อมูล พ.ย. 2026 — เช็กหน้าราคาของแต่ละเจ้าอีกครั้ง)

| บริการ | แบบฟรี | ถ้าจ่ายเงิน |
|---|---|---|
| Cloudflare Workers + D1 | 100,000 requests/วัน, CPU 10ms/request | Workers Paid $5/เดือน (แนะนำเมื่อมีลูกค้าจริง) |
| Groq Whisper | ประมาณ 2 ชม.เสียงต่อชั่วโมง / 8 ชม.ต่อวัน (รวมทุกลูกค้า) | whisper-large-v3 $0.111 ต่อชม.เสียง |
| Gemini | มีลิมิตจำนวนครั้งต่อวัน, ลิงก์ YouTube ได้ไม่เกิน 8 ชม.วิดีโอ/วัน | คิดตามจำนวน token |

* ต้นทุนเมื่อจ่ายจริง (ประมาณ): โหมดเสียงพูด ~5 บาทต่อวิดีโอ 1 ชม. · โหมดดูภาพ ~5–15 บาทต่อวิดีโอ 1 ชม.
* ข้อมูลที่ส่งเข้า Gemini แบบฟรีอาจถูก Google ใช้ปรับปรุงบริการ — มีลูกค้าจริงแล้วควรเปิด billing
* เปลี่ยนรุ่นโมเดลได้ใน `worker/wrangler.toml` (`GEMINI_MODEL`, `GROQ_STT_MODEL`, ...)

---

## ⚠️ ลิขสิทธิ์

* ตัดคลิปจากวิดีโอของคนอื่นแล้วโพสต์ลงช่องเรา **ต้องได้รับอนุญาต** (เช่น ช่องที่เปิดแคมเปญจ้างคนตัดคลิป) ไม่อย่างนั้นอาจโดนเคลม/สไตรก์ และ YouTube อาจไม่ให้สร้างรายได้ (นโยบาย reused content)
* การโหลดวิดีโอจาก YouTube ด้วย yt-dlp ขัดกับเงื่อนไขการใช้งานของ YouTube — ใช้กับวิดีโอที่คุณมีสิทธิ์เท่านั้น
* ทางที่ปลอดภัย: วิดีโอ/เกมเพลย์ของตัวเอง, ช่องที่อนุญาต, และใส่ความเห็น/หัวข้อของเราเพิ่มเข้าไป

---

## โครงสร้างไฟล์

```
index.html        หน้าตัดคลิป
rent.html         หน้าเช่าคีย์ (QR พร้อมเพย์)
admin.html        หน้าแอดมินออกคีย์
config.js         ตั้งค่าเว็บ (แก้ไฟล์นี้)
css/app.css
js/               app.js (หน้าหลัก), media.js (WebCodecs), transcript.js, highlights.js,
                  facetrack.js (หาใบหน้า), layout.js, captions.js, render.js (เรนเดอร์ MP4),
                  helper.js, api.js, license.js, store.js, rent.js, admin.js, promptpay.js
lib/              mediabunny (MPL-2.0), qrcode-generator (MIT)
fonts/            Kanit (SIL OFL)
worker/           Cloudflare Worker: src/worker.js, schema.sql, wrangler.toml
helper/           KlipDed Helper: klipded_helper.py, start-helper.bat, update-ytdlp.bat
```

## ทดสอบในเครื่อง (สำหรับแก้โค้ด)

```powershell
# หลังบ้าน
cd worker
# สร้างไฟล์ .dev.vars ใส่: GROQ_API_KEY=...  GEMINI_API_KEY=...  ADMIN_TOKEN=...
npx wrangler d1 execute klipded --local --file=schema.sql
npx wrangler dev
# หน้าเว็บ (อีกหน้าต่าง ที่โฟลเดอร์หลัก) แล้วตั้ง API_BASE = http://127.0.0.1:8787 ชั่วคราว
python -m http.server 8080
```

## ไอเดียทำต่อ

* ตรวจสลิปอัตโนมัติ (เช่น SlipOK / EasySlip) → ลูกค้าได้คีย์ทันที 24 ชม. ไม่ต้องรอแอดมิน
* คีย์ทดลองฟรี 30 นาที
* โพสต์ขึ้น TikTok / YouTube อัตโนมัติ
* ใส่อีโมจิ / B-roll / เสียงเอฟเฟกต์อัตโนมัติ
