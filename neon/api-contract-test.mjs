// ทดสอบ contract REST + RLS + JWT ที่เบราว์เซอร์จะใช้คุยกับ Neon Data API (PostgREST)
// วิธีรันในเครื่อง (จำลอง Neon ด้วย Postgres + PostgREST):
//   1) โหลด schema:  psql "$DB" -f neon/schema.sql
//   2) สร้าง role authenticator (login, noinherit) + grant anon, authenticated
//   3) รัน PostgREST ชี้มาที่ DB โดยตั้ง jwt-secret ให้ตรงกับ SECRET ด้านล่าง
//   4) node neon/api-contract-test.mjs
// บน Neon จริง: Data API ใช้ RS256 JWKS ของ Firebase แทน HS256 — พฤติกรรม RLS เหมือนกัน
// (โทเคน Firebase มี claim sub = uid, ตั้ง role=authenticated ผ่าน Neon Auth/Data API mapping)

import crypto from 'crypto';
const SECRET = 'reallylongtestsecret_at_least_32_chars_1234567890';
const B = 'http://localhost:3999';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub){ // mint an HS256 token like Firebase would (RS256 in prod; same claims)
  const h=b64({alg:'HS256',typ:'JWT'});
  const p=b64({sub, role:'authenticated', email:sub+'@f.co', iat:1700000000, exp:2000000000});
  const s=crypto.createHmac('sha256',SECRET).update(h+'.'+p).digest('base64url');
  return `${h}.${p}.${s}`;
}
const PASS=[],FAIL=[];
const ok=(n,c,d)=>{(c?PASS:FAIL).push(n);console.log((c?'✓':'✗ FAIL')+' '+n+(!c&&d?` — ${d}`:''));};
async function req(method,path,{token,body,prefer}={}){
  const h={'Content-Type':'application/json'};
  if(token)h.Authorization='Bearer '+token;
  if(prefer)h.Prefer=prefer;
  const r=await fetch(B+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  let j=null; const t=await r.text(); try{j=t?JSON.parse(t):null}catch{ j=t; }
  return {status:r.status, body:j};
}

// anon (no token) — RLS should hide everything
let r=await req('GET','/company');
ok('anon GET /company → blocked (401 or empty)', r.status===401 || (Array.isArray(r.body)&&r.body.length===0), JSON.stringify(r).slice(0,120));

// pending user — sees nothing, cannot insert
r=await req('GET','/company',{token:jwt('fb_pending')});
ok('pending GET /company → 0 rows', Array.isArray(r.body)&&r.body.length===0, JSON.stringify(r));
r=await req('POST','/company',{token:jwt('fb_pending'),body:{id:'cbad',name:'x'}});
ok('pending POST /company → blocked (401/403)', r.status===401||r.status===403, JSON.stringify(r).slice(0,160));

// approved staff — reads, inserts; server stamps identity
r=await req('GET','/company',{token:jwt('fb_staff')});
ok('staff GET /company → sees seed', Array.isArray(r.body)&&r.body.length>=1, JSON.stringify(r).slice(0,120));
r=await req('POST','/company',{token:jwt('fb_staff'),body:{id:'capi',name:'บริษัทจาก API',tax_id:'0105559999999',data:{est:{profit:'1000000'}}},prefer:'return=representation'});
ok('staff POST /company → created', r.status===201, JSON.stringify(r).slice(0,160));
const created = Array.isArray(r.body)?r.body[0]:r.body;
ok('staff POST → server stamped created_by=fb_staff', created&&created.created_by==='fb_staff', JSON.stringify(created).slice(0,160));

// tamper attempt: staff tries to set created_by via API — trigger must overwrite
r=await req('PATCH','/company?id=eq.capi',{token:jwt('fb_staff'),body:{name:'แก้ชื่อ',created_by:'HACKER',updated_by:'HACKER'},prefer:'return=representation'});
const patched=Array.isArray(r.body)?r.body[0]:r.body;
ok('staff PATCH → updated_by forced to fb_staff (tamper ignored)', patched&&patched.updated_by==='fb_staff'&&patched.created_by==='fb_staff', JSON.stringify(patched).slice(0,160));

// self-approve attempt via API
r=await req('POST','/app_user',{token:jwt('fb_x'),body:{uid:'fb_x',email:'x@f.co',approved:true,role:'partner'}});
ok('stranger self-approve POST → blocked', r.status===401||r.status===403, JSON.stringify(r).slice(0,160));
r=await req('POST','/app_user',{token:jwt('fb_x'),body:{uid:'fb_x',email:'x@f.co',approved:false,role:'staff'},prefer:'return=representation'});
ok('stranger pending request POST → allowed', r.status===201, JSON.stringify(r).slice(0,160));
r=await req('PATCH','/app_user?uid=eq.fb_x',{token:jwt('fb_x'),body:{role:'partner',approved:true},prefer:'return=representation'});
const selfp=Array.isArray(r.body)?r.body[0]:r.body;
ok('self-promote PATCH → role stays staff/approved false', !selfp||(selfp.role!=='partner'&&selfp.approved!==true), JSON.stringify(selfp).slice(0,160));

// staff cannot approve others; partner can
r=await req('PATCH','/app_user?uid=eq.fb_pending',{token:jwt('fb_staff'),body:{approved:true,role:'manager'}});
r=await req('GET','/app_user?uid=eq.fb_pending&select=approved,role',{token:jwt('fb_partner')});
let row=Array.isArray(r.body)?r.body[0]:r.body;
ok('staff could NOT approve pending', row&&row.approved===false, JSON.stringify(row));
r=await req('PATCH','/app_user?uid=eq.fb_pending',{token:jwt('fb_partner'),body:{approved:true,role:'manager'},prefer:'return=representation'});
row=Array.isArray(r.body)?r.body[0]:r.body;
ok('partner CAN approve pending → manager', row&&row.approved===true&&row.role==='manager', JSON.stringify(row).slice(0,160));

// staff hard-delete blocked; soft-delete allowed
r=await req('DELETE','/company?id=eq.capi',{token:jwt('fb_staff')});
let g=await req('GET','/company?id=eq.capi&select=id',{token:jwt('fb_staff')});
ok('staff hard DELETE blocked (row remains)', Array.isArray(g.body)&&g.body.length===1, JSON.stringify({del:r.status,g:g.body}));
r=await req('PATCH','/company?id=eq.capi',{token:jwt('fb_staff'),body:{deleted_at:new Date(2000,0,1).toISOString()}});
ok('staff soft-delete via PATCH allowed', r.status===204||r.status===200, 'status='+r.status);

console.log('\nPASS:'+PASS.length+' FAIL:'+FAIL.length);
if(FAIL.length){FAIL.forEach(f=>console.log(' - '+f));process.exit(1);}
