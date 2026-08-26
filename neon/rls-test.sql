-- RLS enforcement tests. Run as a NON-superuser role so RLS applies
-- (superuser and table owner bypass RLS unless FORCE — we FORCE, but also test via 'authenticated').
\set ON_ERROR_STOP 0
\pset pager off

-- helper: become the authenticated API role with a given JWT
create or replace function test_as(uid text, email text) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'email', email)::text, false);
end $$;

create or replace function test_anon() returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
end $$;

-- seed: a partner (approved), a staff (approved), a pending user — inserted as superuser bypassing RLS
insert into app_user(uid,email,name,role,approved,rejected) values
  ('U_PARTNER','partner@f.co','พาร์ทเนอร์','partner',true,false),
  ('U_STAFF','staff@f.co','สตาฟ','staff',true,false),
  ('U_PENDING','pending@f.co','รออนุมัติ','staff',false,false)
on conflict (uid) do nothing;

insert into company(id,name,tax_id,fiscal_year) values ('c_seed','บริษัทเมล็ด','0105551234567',2568)
on conflict (id) do nothing;

-- run all checks as the API role 'authenticated' so RLS is enforced
set role authenticated;

\echo '=== T1: anonymous cannot read companies (expect 0 rows) ==='
select test_anon();
select count(*) as anon_company_rows from company;

\echo '=== T2: pending user cannot read companies (expect 0) ==='
select test_as('U_PENDING','pending@f.co');
select count(*) as pending_company_rows from company;

\echo '=== T3: pending user cannot INSERT a company (expect ERROR) ==='
select test_as('U_PENDING','pending@f.co');
insert into company(id,name) values ('c_bad','ห้ามเข้า');

\echo '=== T4: approved staff CAN read companies (expect >=1) ==='
select test_as('U_STAFF','staff@f.co');
select count(*) as staff_company_rows from company;

\echo '=== T5: approved staff CAN insert a company (expect success) ==='
select test_as('U_STAFF','staff@f.co');
insert into company(id,name,tax_id) values ('c_staff','บริษัทสตาฟสร้าง','0105559999999');
select id, created_by, updated_by, (created_at is not null) as has_ts from company where id='c_staff';

\echo '=== T6: server stamps updated_at/updated_by, ignores client-supplied values ==='
select test_as('U_STAFF','staff@f.co');
update company set name='แก้ชื่อ', updated_by='HACKER', created_by='HACKER' where id='c_staff';
select updated_by='U_STAFF' as updated_by_is_real, created_by='U_STAFF' as created_by_untampered from company where id='c_staff';

\echo '=== T7: pending user cannot self-approve (insert own row approved=true) (expect ERROR) ==='
select test_as('U_NEW','new@f.co');
insert into app_user(uid,email,approved,role) values ('U_NEW','new@f.co',true,'partner');

\echo '=== T8: a stranger CAN create own pending request (approved=false, staff) (expect success) ==='
select test_as('U_NEW','new@f.co');
insert into app_user(uid,email,name,approved,rejected,role) values ('U_NEW','new@f.co','คนใหม่',false,false,'staff');
select uid, approved, role from app_user where uid='U_NEW';

\echo '=== T9: user cannot promote SELF to partner via update (expect blocked: role stays staff) ==='
select test_as('U_NEW','new@f.co');
update app_user set role='partner', approved=true where uid='U_NEW';
-- read back as partner to see the truth
set role postgres; select uid, role, approved from app_user where uid='U_NEW'; set role authenticated;

\echo '=== T10: staff cannot approve someone else (expect blocked) ==='
select test_as('U_STAFF','staff@f.co');
update app_user set approved=true, role='manager' where uid='U_PENDING';
set role postgres; select uid, approved, role from app_user where uid='U_PENDING'; set role authenticated;

\echo '=== T11: partner CAN approve a pending user (expect approved=true, manager) ==='
select test_as('U_PARTNER','partner@f.co');
update app_user set approved=true, role='manager', approved_by='U_PARTNER', approved_at=now() where uid='U_PENDING';
set role postgres; select uid, approved, role from app_user where uid='U_PENDING'; set role authenticated;

\echo '=== T12: staff cannot HARD delete a company (expect blocked: row remains) ==='
select test_as('U_STAFF','staff@f.co');
delete from company where id='c_staff';
select exists(select 1 from company where id='c_staff') as still_exists;

\echo '=== T13: soft delete via update works for approved user; is_deleted true ==='
select test_as('U_STAFF','staff@f.co');
update company set deleted_at=now() where id='c_staff';
set role postgres; select company_is_deleted(c) as deleted from company c where id='c_staff'; set role authenticated;

\echo '=== T14: undelete (undeleted_at newer) flips is_deleted back to false ==='
select test_as('U_STAFF','staff@f.co');
update company set undeleted_at=now() where id='c_staff';
set role postgres; select company_is_deleted(c) as deleted_after_undelete from company c where id='c_staff'; set role authenticated;

\echo '=== T15: manager (was U_PENDING, now approved manager) CAN hard delete ==='
select test_as('U_PENDING','pending@f.co');
delete from company where id='c_seed';
select exists(select 1 from company where id='c_seed') as seed_still_exists;

reset role;
