# HANDOFF — โปรแกรมคำนวณประมาณการ ภ.ง.ด.51

เอกสารส่งมอบงาน สรุปสถานะ สถาปัตยกรรม สิ่งที่เหลือ และวิธีทดสอบ

---

## 1. แอปนี้คืออะไร

เครื่องมือคำนวณประมาณการภาษีเงินได้นิติบุคคลครึ่งปี (ภ.ง.ด.51) แบบ **ไฟล์เดียว** (`index.html`)
ทำงานในเบราว์เซอร์ทั้งหมด ไม่ต้อง build — เปิดจากไฟล์ตรงๆ / GitHub Pages / Artifact ได้

- Wizard 7 ขั้น: เลือกบริษัท → นำเข้างบทดลอง → ประมาณการ+ปรับปรุงภาษี → คำนวณ+สรุปแบบ → Review/Sign-off → ประวัติ → ยื่น/ชำระ
- SME (ขั้นบันได) และบริษัททั่วไป 20% · ประเมินความเสี่ยง ม.67 ตรี · ขาดทุนสะสม 5 รอบ
- นำเข้างบทดลอง Excel 3 งวด + เปรียบเทียบ · Export/Import ข้อมูลทั้งหมดเป็น Excel
- เอกสารแนบเก็บใน IndexedDB (ไม่ซิงค์)
- **ระบบกลาง** ใช้ข้อมูลร่วมหลายเครื่อง (ล็อกอิน + อนุมัติผู้ใช้ + ซิงค์)

## 2. สถานะปัจจุบัน

| ส่วน | สถานะ |
|---|---|
| แกนหลัก (คำนวณ/wizard/Excel) ออฟไลน์ | ✅ พร้อมใช้ · ทดสอบ 31 E2E + 32 regression |
| ความปลอดภัย/data-loss/XSS (รอบตรวจ 2 ระบบ) | ✅ แก้ครบ · ทดสอบแล้ว |
| ระบบกลาง — **ย้ายจาก Firebase → Neon แล้ว** | ✅ โค้ดเสร็จ ทดสอบในเบราว์เซอร์จริง 12/12 |
| เชื่อม Neon จริง (ใส่ค่า + ทดสอบ auth จริง) | ⏳ **เหลือขั้นนี้ — ต้องมีบัญชี Neon (ดูข้อ 4)** |

Branch: `claude/pnd51-estimator-webapp-0h0z6p` · PR #1

## 3. สถาปัตยกรรมระบบกลาง (Neon)

```
เบราว์เซอร์ (index.html)
   │  ล็อกอิน → Neon Auth (Stack Auth) → ได้ JWT
   ▼
Neon Data API (PostgREST) — REST + แนบ JWT
   │  ทุก request คุมสิทธิ์ด้วย ...
   ▼
Postgres + Row-Level Security (RLS)  ← ด่านความปลอดภัย "จริง" เพียงด่านเดียว
```

**หลักการสำคัญ:** โค้ดทั้งหมดอยู่ในเบราว์เซอร์ผู้ใช้ การเช็คสิทธิ์ในหน้าเว็บ (ซ่อนปุ่ม) เป็นแค่ UX
ตัวกันจริงคือ **RLS ใน `neon/schema.sql`** — ใครเปิด console เรียก Data API ตรงๆ ก็ยังโดน RLS กัน

จุดเด่นที่ได้จากการย้ายมา Postgres:
- **server timestamp** (`updated_at`) ตัดสินการชนกัน → ไม่มีปัญหานาฬิกาเครื่องเพี้ยน
- **soft delete** (`deleted_at`/`undeleted_at`) แทน tombstone hack
- แก้คนละคอลัมน์พร้อมกันไม่ทับกัน (PATCH เฉพาะช่องที่เปลี่ยน)
- server ประทับ `created_by/updated_by` เอง client ปลอมไม่ได้

## 4. ⏳ สิ่งที่เหลือ — เชื่อม Neon จริง (ต้องทำในบัญชี Neon ของคุณ)

> ทำในเบราว์เซอร์ที่ล็อกอิน Neon ของคุณเอง — Claude ทำแทนไม่ได้ (ไม่มีสิทธิ์เข้าบัญชี)

1. **สร้างโปรเจกต์** ที่ https://console.neon.tech (region: Singapore)
2. **โหลด schema** — Neon Console → SQL Editor → วางทั้งไฟล์ `neon/schema.sql` → Run
   ตรวจว่าได้ตาราง `app_user`, `company`:
   ```sql
   select table_name from information_schema.tables where table_schema='public';
   ```
3. **เปิด Data API** → ก๊อบ **Data API URL**
4. **เปิด Neon Auth** → ก๊อบ **Project ID** และ **Publishable Client Key**
5. **ใส่ค่าในแอป** — เปิดแอป → การ์ด "☁ ระบบกลาง" → วาง JSON:
   ```json
   { "dataApiUrl": "https://...", "authProjectId": "...", "authPublishableKey": "..." }
   ```
   (หรือฝังถาวรใน `index.html` ที่ตัวแปร `NEON_DEFAULT_CONFIG` เพื่อให้ทุกเครื่องเชื่อมอัตโนมัติ)
6. **สมัคร/ล็อกอินในแอปครั้งแรก** แล้ว **ตั้ง partner คนแรก** (bootstrap) ใน SQL Editor:
   ```sql
   update app_user set approved=true, role='partner' where email='<อีเมลคุณ>';
   ```

> **ต้องเช็ค:** Neon Data API ต้อง map JWT ของ Neon Auth → role `authenticated` และอ่าน claim `sub`
> เป็น user id (schema ใช้ `auth.uid()` = `sub`). ปกติเปิด Auth+Data API บนโปรเจกต์เดียวกันจะตั้งให้อัตโนมัติ
> ถ้าชื่อ role ที่ Data API ใช้ไม่ใช่ `authenticated`/`anon` ให้ปรับ grant ท้ายไฟล์ `neon/schema.sql`

## 5. โครงไฟล์

```
index.html              แอปทั้งหมด (มี neon-client.js ฝังอยู่ข้างใน + layer ระบบกลางบน Neon)
README.md               ภาพรวม + การตั้งค่าความปลอดภัย
HANDOFF.md              ไฟล์นี้
neon/
  schema.sql            ตาราง + RLS + trigger (server timestamp, soft delete)  ← ต้องโหลดเข้า Neon
  SETUP.md              คู่มือตั้งค่า Neon แบบละเอียด
  neon-client.js        ชั้นเชื่อมต่อ (mapping + data + auth) — ต้นฉบับของที่ฝังใน index.html
  rls-test.sql          ทดสอบ RLS 15 เคส (psql)
  api-contract-test.mjs ทดสอบ REST+RLS+JWT ผ่าน PostgREST (14/14)
  client-test.mjs       ทดสอบ client layer + concurrent-merge (14/14)
  app-e2e-test.js       ทดสอบแอปทั้งตัวบน Neon ในเบราว์เซอร์ (12/12)
firestore.rules,        ** ของเดิม Firebase — เลิกใช้แล้ว เก็บไว้เป็นประวัติ **
firebase.json, .firebaserc
```

> ⚠️ ถ้าแก้ตรรกะใน `neon/neon-client.js` ต้อง **re-inline ลง `index.html`** ด้วย (สำเนาฝังอยู่ในนั้น)
> แอปโหลดจากสำเนาที่ฝัง ไม่ได้โหลดไฟล์แยก

## 6. วิธีทดสอบ (ในเครื่องพัฒนา)

**ชุด offline (ไม่ต้องมี Neon)** — ใช้ Playwright + Chromium:
```
node <scratch>/e2e.js        # 31 เคส: สูตรภาษี, wizard, Excel round-trip
node <scratch>/regress.js    # 32 เคส: quota, XSS, import merge, cloud guards
```

**ชุด Neon** — ต้องมี Postgres + PostgREST ในเครื่อง:
```
psql "$DB" -f neon/schema.sql
psql "$DB" -f neon/rls-test.sql          # RLS 15 เคส
node neon/api-contract-test.mjs          # REST contract 14 เคส (ตั้ง PostgREST + jwt-secret)
node neon/client-test.mjs                # client layer 14 เคส
node neon/app-e2e-test.js                # แอปทั้งตัวบน Neon 12 เคส (เสิร์ฟ index.html + PostgREST + mint JWT)
```
(รายละเอียดการตั้ง PostgREST + การ mint JWT อยู่หัวไฟล์ทดสอบแต่ละอัน)

## 7. รายการที่ทดสอบผ่านแล้ว (รวม ~120 เคส)

- แกนหลัก: SME ขั้นบันได / 20% / ขาดทุนสะสม / ม.67 ตรี / กำหนดยื่น / Excel round-trip
- data-loss: localStorage เต็ม (เตือน+ไม่หายเงียบ), import merge/atomic, TB import race, alert leak
- XSS: หน้าพิมพ์, id/year ที่ import มา, escapeHtml รวม `'`
- Neon: RLS ครบทุกบทบาท, server-stamp กันปลอม, concurrent-merge, soft-delete/undelete,
  polling, pending/admin flow — ทดสอบในเบราว์เซอร์จริงกับ PostgREST

## 8. รายการที่ยังไม่ทำ / ข้อควรรู้

- **auth จริงกับ Neon Auth** ยังไม่ได้ทดสอบ (dev ปลอม token ได้เท่านั้น) — ทดสอบตอนเชื่อมจริง (ข้อ 4)
- realtime ของเดิม (Firestore onSnapshot) → เปลี่ยนเป็น **poll ทุก 10 วินาที** (Data API ไม่มี push)
- ไฟล์แนบยังอยู่ในเครื่อง (IndexedDB) ไม่ซิงค์ — ตามดีไซน์เดิม
- ไฟล์ Firebase เดิมยังอยู่ใน repo (เลิกใช้แล้ว) — จะลบทิ้งเมื่อยืนยันว่า Neon ใช้งานได้จริงก็ได้

---

_อัปเดตล่าสุด: หลังย้ายระบบกลางจาก Firebase มา Neon เสร็จและทดสอบในเบราว์เซอร์จริง_
