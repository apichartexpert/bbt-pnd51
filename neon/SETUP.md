# ย้ายระบบกลางไป Neon — คู่มือตั้งค่า

สถาปัตยกรรม: เบราว์เซอร์ → **Neon Auth** (ล็อกอิน ออก JWT) → **Neon Data API** (REST บน PostgREST)
→ **Postgres + RLS** (ด่านความปลอดภัยจริง) ไม่มี backend server ต้องโฮสต์เอง

สถานะ: schema + RLS + REST contract + client layer **เขียนและทดสอบผ่านหมดแล้ว** (บน Postgres/PostgREST จริงในเครื่องพัฒนา)
เหลือ 3 ขั้นที่ต้องทำในบัญชี Neon ของคุณ แล้วผมจะต่อ index.html + ทดสอบจริงให้

---

## ขั้น 1 — เปิด Neon Auth + Data API และโหลด schema

1. Neon Console → โปรเจกต์ของคุณ → เปิด **Auth** (Neon Auth) และ **Data API**
2. โหลด schema เข้าฐานข้อมูล (จาก connection string ของโปรเจกต์):
   ```bash
   psql "postgresql://<user>:<pass>@<host>/<db>?sslmode=require" -f neon/schema.sql
   ```
   > หมายเหตุ role: สคริปต์สร้าง/ใช้ role `authenticated` และ `anon` ตามแบบ PostgREST
   > ถ้า Neon Data API ใช้ชื่อ role ต่างออกไป บอกผมได้ เดี๋ยวปรับ grant ให้

## ขั้น 2 — ผูก Data API ให้เชื่อ JWT ของ Neon Auth

ปกติเมื่อเปิดทั้ง Auth และ Data API บนโปรเจกต์เดียวกัน Neon จะตั้งให้ Data API เชื่อ
JWT ของ Neon Auth อัตโนมัติ และ map โทเคนที่ถูกต้อง → role `authenticated`
(claim `sub` = user id ซึ่ง RLS ใช้ผ่าน `auth.uid()`)

ตรวจว่า RLS อ่าน `sub` ได้ถูก: หลังโหลด schema แล้ว ลองยิง Data API ด้วยโทเคนจริง
ควรเห็นพฤติกรรมตาม `neon/api-contract-test.mjs` (anon/รออนุมัติเห็น 0 แถว, อนุมัติแล้วเห็นข้อมูล)

## ขั้น 3 — ส่งค่า 3 ตัวนี้ให้ผม เพื่อต่อ index.html

หาได้จาก Neon Console:

| ค่า | อยู่ที่ | หน้าตา |
|---|---|---|
| **Data API URL** | โปรเจกต์ → Data API | `https://<...>.apirest.<region>.aws.neon.tech` (หรือ URL ที่ Neon แสดง) |
| **Neon Auth — Project ID** | โปรเจกต์ → Auth → Configuration | รหัสโปรเจกต์ Auth |
| **Neon Auth — Publishable Client Key** | โปรเจกต์ → Auth → Configuration | คีย์ฝั่ง client (เปิดเผยได้ ไม่ใช่ secret) |

> **ห้ามส่ง** connection string ที่มีรหัสผ่าน หรือ secret key ฝั่งเซิร์ฟเวอร์ — ใช้แค่ 3 ค่าข้างบน
> (เป็นค่าฝั่ง client เปิดเผยได้ ความปลอดภัยคุมด้วย RLS)

---

## สิ่งที่ผมจะทำต่อเมื่อได้ค่า 3 ตัว

1. ฝังค่าลง index.html (แทน firebaseConfig เดิม) + โหลด `neon/neon-client.js`
2. เปลี่ยน `cloudInit / startSync / cloudPushNow / โค้ด onSnapshot / แผงอนุมัติ` จาก Firebase → Neon
   - realtime ของเดิม (onSnapshot) → เปลี่ยนเป็น **polling** ทุก ~10 วินาที (Data API ไม่มี push)
3. เปลี่ยนล็อกอิน/สมัคร/logout จาก Firebase Auth → Neon Auth
4. ทดสอบจริง 2 เครื่อง แล้วรายงาน

## ไฟล์ในโฟลเดอร์นี้

- `schema.sql` — ตาราง + RLS + trigger (ประทับเวลาเซิร์ฟเวอร์, soft delete)
- `rls-test.sql` — ชุดทดสอบ RLS 15 เคส (รันด้วย psql)
- `api-contract-test.mjs` — ทดสอบ REST+RLS+JWT ผ่าน PostgREST (14/14 ผ่าน)
- `neon-client.js` — ชั้นเชื่อมต่อ (mapping + data + auth) ใช้ในแอปและเทสได้
- `client-test.mjs` — ทดสอบ client layer + การ merge แก้พร้อมกัน (14/14 ผ่าน)
