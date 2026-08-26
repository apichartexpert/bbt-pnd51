import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const NeonSync = require('/home/user/bbt-pnd51/neon/neon-client.js');

const SECRET='reallylongtestsecret_at_least_32_chars_1234567890';
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=sub=>{const h=b64({alg:'HS256',typ:'JWT'});const p=b64({sub,role:'authenticated',email:sub+'@f.co',iat:1700000000,exp:2000000000});return `${h}.${p}.`+crypto.createHmac('sha256',SECRET).update(h+'.'+p).digest('base64url');};

const PASS=[],FAIL=[];
const ok=(n,c,d)=>{(c?PASS:FAIL).push(n);console.log((c?'✓':'✗ FAIL')+' '+n+(!c&&d?` — ${d}`:''));};
const dataFor=uid=>NeonSync.makeData({dataApiUrl:'http://localhost:3999',getToken:async()=>uid?jwt(uid):null});

// ---- mapping round-trip ----
const appco={id:'m1',name:'บ.แมพ',taxId:'0105551234567',year:2568,jobCode:'J1',yearEnd:'31/12/2568',
  entityType:'sme',preparer:'ก',reviewer:'ข',approver:'ค',
  est:{profit:'1000000',wht:'25000'},tb:{B:{net:1}},history:[{tax:5}],
  lossCarry:[100,200,0,0,0],priorYearTax:{cit:8},workflow:{status:'approved',log:[{action:'approve'}]}};
const row=NeonSync.companyToRow(appco);
const back=NeonSync.rowToCompany(Object.assign({updated_at:'2026-01-01T00:00:00Z'},row));
ok('mapping: core fields survive round-trip',
  back.name===appco.name&&back.taxId===appco.taxId&&String(back.year)==='2568'&&back.entityType==='sme'&&
  JSON.stringify(back.est)===JSON.stringify(appco.est)&&
  JSON.stringify(back.workflow)===JSON.stringify(appco.workflow)&&
  JSON.stringify(back.lossCarry)===JSON.stringify(appco.lossCarry), JSON.stringify(back).slice(0,160));
ok('mapping: row uses snake_case + status from workflow', row.tax_id==='0105551234567'&&row.status==='approved'&&row.fiscal_year===2568);

const staff=dataFor('fb_staff');

// ---- create + list ----
const created=await staff.saveCompany({id:'capi1',name:'บ.สร้าง',taxId:'0105559999999',year:2568,entityType:'sme',
  workflow:{status:'draft'},est:{profit:'500000'}}, null);
ok('data: create returns row with server stamp', created&&created.id==='capi1'&&created.created_by==='fb_staff', JSON.stringify(created).slice(0,140));

const list=await staff.listCompanies();
const found=list.find(x=>x.company.id==='capi1');
ok('data: listCompanies maps back to app object', !!found && found.company.name==='บ.สร้าง' && found.company.workflow.status==='draft', JSON.stringify(found&&found.company).slice(0,140));
ok('data: _syncAt is server time (nonzero)', found && found.company._syncAt>0);

// ---- CONCURRENT EDIT: column-level merge prevents clobber ----
// machine B changes ONLY workflow directly on server
const partnerApi=dataFor('fb_partner')._api;
await partnerApi('PATCH','/company?id=eq.capi1',{body:{workflow:{status:'approved',log:[{action:'approve',by:'B'}]}}});
// machine A holds the STALE row (created, workflow=draft) and edits ONLY est
const stale=created;                            // prevRow before B's change
const aEdit={id:'capi1',name:'บ.สร้าง',taxId:'0105559999999',year:2568,entityType:'sme',
  workflow:{status:'draft'},                    // A still thinks draft (stale) but A didn't touch workflow vs its own baseline
  est:{profit:'999999'}};                       // A changed est
await staff.saveCompany(aEdit, stale);
const after=(await staff.listCompanies()).find(x=>x.company.id==='capi1').company;
ok("merge: A's est change applied", after.est.profit==='999999', JSON.stringify(after.est));
ok("merge: B's workflow approval NOT clobbered", after.workflow.status==='approved' && (after.workflow.log||[]).some(l=>l.by==='B'), JSON.stringify(after.workflow).slice(0,140));

// ---- changedColumns sends nothing when unchanged ----
const noChange=NeonSync.changedColumns(NeonSync.companyToRow(aEdit), NeonSync.companyToRow(aEdit));
ok('merge: identical rows → no patch', noChange===null);

// ---- soft delete / undelete ----
await staff.softDelete('capi1');
let l2=await staff.listCompanies(); let e2=l2.find(x=>x.company.id==='capi1');
ok('soft delete: flagged deleted in list', e2 && e2.deleted===true, JSON.stringify(e2&&{del:e2.deleted}));
await staff.undelete('capi1');
let l3=await staff.listCompanies(); let e3=l3.find(x=>x.company.id==='capi1');
ok('undelete: flag cleared', e3 && e3.deleted===false);

// ---- users / approval via client ----
const stranger=dataFor('fb_new');
await stranger.createOwnProfile('fb_new','new@f.co','คนใหม่');
const mine=await stranger.getMyProfile('fb_new');
ok('user: stranger created pending profile (approved=false, staff)', mine && mine.approved===false && mine.role==='staff', JSON.stringify(mine));
// stranger tries to self-approve → RLS blocks (setUserRole PATCH by self is filtered)
let selfPromoteBlocked=true;
try{ await stranger.setUserRole('fb_new','partner'); const m2=await stranger.getMyProfile('fb_new'); selfPromoteBlocked = m2.role!=='partner'; }catch(e){ selfPromoteBlocked=true; }
ok('user: self-promote blocked', selfPromoteBlocked);
// partner approves the stranger
const partner=dataFor('fb_partner');
await partner.approveUser('fb_new','manager','partner@f.co');
const m3=await stranger.getMyProfile('fb_new');
ok('user: partner approved stranger → manager', m3 && m3.approved===true && m3.role==='manager', JSON.stringify(m3));
const approved=await partner.listApprovedUsers();
ok('user: listApprovedUsers returns the roster', Array.isArray(approved) && approved.some(u=>u.uid==='fb_new'), 'n='+(approved&&approved.length));

console.log('\nPASS:'+PASS.length+' FAIL:'+FAIL.length);
if(FAIL.length){FAIL.forEach(f=>console.log(' - '+f));process.exit(1);}
