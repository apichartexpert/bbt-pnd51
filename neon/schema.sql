-- ============================================================================
--  ระบบกลาง ภ.ง.ด.51 บน Neon (Postgres) — schema + Row-Level Security
--
--  แนวคิด: เบราว์เซอร์คุยกับ Neon Data API (PostgREST) ผ่าน HTTPS โดยตรง
--  ความปลอดภัย "ทั้งหมด" อยู่ที่ RLS ในไฟล์นี้ (เทียบเท่า firestore.rules เดิม)
--  ตัวตนผู้ใช้มาจาก Neon Auth ในรูป JWT → PostgREST เซ็ต request.jwt.claims ให้
--
--  ตัวช่วยอ่าน uid จาก JWT: เราสร้าง auth.uid() เองด้านล่าง (อ่าน claim "sub")
--  เพื่อไม่ผูกกับสคีมาเฉพาะของผู้ให้บริการ — ถ้าใช้ Neon Auth ที่มี auth.user_id()
--  อยู่แล้ว จะ map มาที่ auth.uid() ให้ในตอนท้าย
--
--  ติดตั้ง:  psql "$DATABASE_URL" -f neon/schema.sql
-- ============================================================================

begin;

-- ---------- ตัวช่วยอ่านตัวตนจาก JWT ----------
create schema if not exists auth;

-- อ่าน claim ตัวใดตัวหนึ่งจาก JWT ที่ PostgREST ใส่ไว้ใน request.jwt.claims
create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb)
$$;

-- uid = subject ของ token (ผู้ใช้ที่ล็อกอิน) · null เมื่อไม่ได้ล็อกอิน
create or replace function auth.uid() returns text
  language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

create or replace function auth.email() returns text
  language sql stable as $$
  select nullif(auth.jwt() ->> 'email', '')
$$;

-- ---------- โปรไฟล์ผู้ใช้ + สถานะอนุมัติ (เทียบ users collection เดิม) ----------
create table if not exists app_user (
  uid        text primary key,                 -- = auth.uid() (sub ของ JWT)
  email      text not null,
  name       text not null default '',
  role       text not null default 'staff'
             check (role in ('staff','manager','partner')),
  approved   boolean not null default false,
  rejected   boolean not null default false,
  requested_at timestamptz not null default now(),
  approved_by  text,
  approved_at  timestamptz
);

-- ตัวช่วยเช็คสิทธิ์ (อ่านจากแถวของผู้ล็อกอินเอง)
-- security definer + search_path ล็อก เพื่อให้ฟังก์ชันข้าม RLS อ่าน app_user ได้
-- โดยไม่เปิดช่องให้ผู้ใช้ทั่วไปอ่านทั้งตาราง
create or replace function auth.me() returns app_user
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from app_user where uid = auth.uid()
$$;

create or replace function auth.is_approved() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from app_user
    where uid = auth.uid() and approved = true and rejected = false)
$$;

create or replace function auth.has_role(want text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from app_user
    where uid = auth.uid() and approved = true and rejected = false and role = want)
$$;

create or replace function auth.is_partner() returns boolean
  language sql stable as $$ select auth.has_role('partner') $$;

-- ผู้ตรวจได้ (manager ขึ้นไป) / ผู้ลบบริษัทได้ (manager ขึ้นไป)
create or replace function auth.is_reviewer() returns boolean
  language sql stable as $$ select auth.has_role('manager') or auth.has_role('partner') $$;

-- ---------- บริษัท / งานลูกค้า (เทียบ companies collection เดิม) ----------
-- คอลัมน์ที่ค้นบ่อยแยกออกมา ส่วนที่ยืดหยุ่น (est/tb/history/workflow/...) เก็บใน data (JSONB)
-- updated_at เป็น "นาฬิกาเซิร์ฟเวอร์" — แก้ปัญหานาฬิกาเครื่องเพี้ยนที่เคยตัดสินการชนกันผิด
-- deleted_at / undeleted_at = soft delete แทน tombstone hack เดิม (สถานะลบอยู่ = deleted_at ใหม่กว่า undeleted_at)
create table if not exists company (
  id           text primary key,
  name         text not null default '',
  tax_id       text not null default '',
  fiscal_year  int,
  job_code     text not null default '',
  year_end     text not null default '',
  entity_type  text not null default 'sme'
               check (entity_type in ('sme','general')),
  status       text not null default 'draft',
  data         jsonb not null default '{}'::jsonb,   -- est, tb, lossCarry, priorYearTax, history, workflow
  created_by   text,
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  undeleted_at timestamptz
);

create index if not exists company_taxid_year_idx on company (tax_id, fiscal_year);
create index if not exists company_updated_idx on company (updated_at);

-- สถานะ "ถูกลบอยู่ตอนนี้"
create or replace function company_is_deleted(c company) returns boolean
  language sql immutable as $$
  select c.deleted_at is not null
     and (c.undeleted_at is null or c.deleted_at > c.undeleted_at)
$$;

-- แตะแถวเมื่อไร ประทับเวลาเซิร์ฟเวอร์ + ผู้แก้ล่าสุดให้อัตโนมัติ (ห้ามเชื่อค่าจาก client)
create or replace function company_touch() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;   -- กันแก้ย้อนหลัง
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

drop trigger if exists company_touch_trg on company;
create trigger company_touch_trg before insert or update on company
  for each row execute function company_touch();

-- ============================================================================
--  Row-Level Security — ด่านความปลอดภัยจริงเพียงด่านเดียว
-- ============================================================================
alter table app_user enable row level security;
alter table company  enable row level security;
-- บังคับ RLS กับเจ้าของตารางด้วย (กันพลาดตอนต่อด้วย role ที่เป็น owner)
alter table app_user force row level security;
alter table company  force row level security;

-- ---------- app_user ----------
-- อ่าน: แถวของตัวเอง หรือ (ผู้อนุมัติแล้วอ่านได้ทุกคน เพื่อเลือกผู้จัดทำ/ผู้ตรวจ/ผู้อนุมัติ)
drop policy if exists app_user_select on app_user;
create policy app_user_select on app_user for select
  using (uid = auth.uid() or auth.is_approved());

-- สร้างคำขอของตัวเองได้ครั้งเดียว และ "ต้อง" เป็นสถานะรออนุมัติเสมอ
-- จุดที่อันตรายสุด: ถ้าปล่อยให้ตั้ง approved/role เองได้ ใครสมัครก็ตั้งตัวเป็น partner แล้วเห็นข้อมูลลูกค้าทั้งหมด
drop policy if exists app_user_insert_self on app_user;
create policy app_user_insert_self on app_user for insert
  with check (
    uid = auth.uid()
    and approved = false
    and rejected = false
    and role = 'staff');

-- เจ้าของแก้ได้เฉพาะชื่อ/อีเมลตัวเอง — ห้ามแตะ approved/role/rejected
drop policy if exists app_user_update_self on app_user;
create policy app_user_update_self on app_user for update
  using (uid = auth.uid())
  with check (
    uid = auth.uid()
    and approved = (select approved from app_user u where u.uid = auth.uid())
    and role     = (select role     from app_user u where u.uid = auth.uid())
    and rejected = (select rejected from app_user u where u.uid = auth.uid()));

-- partner: อนุมัติ/เปลี่ยนบทบาท/ปฏิเสธ/ลบบัญชีได้ทุกแถว
drop policy if exists app_user_admin on app_user;
create policy app_user_admin on app_user for all
  using (auth.is_partner())
  with check (auth.is_partner());

-- ---------- company ----------
-- อ่าน/สร้าง/แก้: ผู้อนุมัติแล้วเท่านั้น (ไม่แบ่งเจ้าของรายเอกสาร ตามรูปแบบสำนักงานเดียว)
drop policy if exists company_select on company;
create policy company_select on company for select
  using (auth.is_approved());

drop policy if exists company_insert on company;
create policy company_insert on company for insert
  with check (auth.is_approved());

drop policy if exists company_update on company;
create policy company_update on company for update
  using (auth.is_approved())
  with check (auth.is_approved());

-- ลบจริง (hard delete) จำกัดที่ manager ขึ้นไป — แต่แนะนำให้ใช้ soft delete (ตั้ง deleted_at) ผ่าน update ปกติ
drop policy if exists company_delete on company;
create policy company_delete on company for delete
  using (auth.is_reviewer());

commit;

-- ============================================================================
--  บทบาทฐานข้อมูลสำหรับ Data API (PostgREST)
--  - anon_role: ผู้ที่ยังไม่ล็อกอิน — ไม่ควรเห็นอะไรเลย (RLS กันอยู่แล้ว แต่ไม่ให้สิทธิ์ตารางไว้ก่อน)
--  - auth_role: ผู้ล็อกอินแล้ว — ให้สิทธิ์ระดับตาราง ส่วนการเห็นแถวไหนคุมด้วย RLS
--  บน Neon ชื่อ role อาจต่างออกไป (เช่น authenticated) — ปรับให้ตรงกับที่ Neon Data API ใช้
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema public, auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
-- ผู้ล็อกอินแล้วมีสิทธิ์ระดับตาราง (แถวไหนเห็น/แก้ได้จริง คุมด้วย RLS ข้างบน)
grant select, insert, update, delete on company  to authenticated;
grant select, insert, update, delete on app_user to authenticated;
-- ผู้ยังไม่ล็อกอิน: ไม่ให้สิทธิ์ตารางใด ๆ (RLS กันซ้ำอีกชั้น)
