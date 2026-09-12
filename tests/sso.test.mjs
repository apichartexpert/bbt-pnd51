// ทดสอบบ้าน pnd51 กับ mock บ้านกลาง ตามเกณฑ์ตรวจรับฝั่งบ้าน (spec ก้อน C หัวข้อ 5)
// รันเอง: node tests/sso.test.mjs — ต้องมี python3 + fastapi/uvicorn/sqlalchemy/httpx (pip install -r webapp/requirements.txt)
// หมายเหตุ: เทสกับ mock ในเครื่องเท่านั้น — ห้ามยิงเคสผิดปกติ (ตั๋วซ้ำ/ตั๋วปลอม) ใส่บ้านกลางจริง (เหตุร้ายแรง)
import { openApp, makeChecker } from './helper.mjs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = path.join(ROOT, 'webapp');
const CENTRAL = 'http://localhost:8761';
const HOUSE = 'http://localhost:8760';
const KEY = 'devkey-pnd51';
const CHECK_AGE = 4;     // วินาที — ย่อจาก 15 นาทีเพื่อเทสจังหวะตรวจ/ล็อกจอ
const FULL_WIN = 8;      // วินาที — ย่อ window ของ re-SSO ระดับ full

const { check, report } = makeChecker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitLogged(page, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate(() => typeof ssoUser !== 'undefined' && !!ssoUser && typeof db !== 'undefined' && !!db.companies)
      .catch(() => false);
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

function spawnPy(args, env) {
  const p = spawn('python3', ['-m', 'uvicorn', ...args], {
    cwd: WEBAPP, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', d => { if (process.env.SSO_TEST_VERBOSE) process.stderr.write(d); });
  return p;
}
async function waitHealth(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (e) {}
    await sleep(500);
  }
  return false;
}
async function getTicket() {
  // ประตู mock ตอบ 302 พร้อม #ticket= — อ่านจาก Location โดยไม่ตาม redirect
  const r = await fetch(CENTRAL + '/api/sso/pnd51', { redirect: 'manual' });
  const loc = r.headers.get('location') || '';
  const m = /#ticket=([^&]+)/.exec(loc);
  return m ? decodeURIComponent(m[1]) : '';
}

const tmpdb = path.join(os.tmpdir(), 'pnd51-sso-test-' + Date.now() + '.db');
const central = spawnPy(['mock_central:app', '--port', '8761'], {
  MOCK_HOUSE_KEY: KEY, MOCK_HOUSE_URL: HOUSE, MOCK_HOUSE_SLUG: 'pnd51',
});
const house = spawnPy(['main:app', '--port', '8760'], {
  SSO_ENABLED: '1', BBT_URL: CENTRAL, HOUSE_KEY: KEY, HOUSE_SLUG: 'pnd51',
  DATABASE_URL: 'sqlite:///' + tmpdb,
  CHECK_MAX_AGE_SEC: String(CHECK_AGE), FULL_SSO_WINDOW_SEC: String(FULL_WIN),
});
// เครื่องที่สองไว้พิสูจน์ C9: ตั้ง ACCESS_CODE คู่กับ SSO → ต้องถูกปิดอัตโนมัติ
const house2 = spawnPy(['main:app', '--port', '8762'], {
  SSO_ENABLED: '1', BBT_URL: CENTRAL, HOUSE_KEY: KEY, HOUSE_SLUG: 'pnd51',
  DATABASE_URL: 'sqlite:///' + tmpdb + '2', ACCESS_CODE: 'oldcode',
});

let browser = null;
try {
  const okC = await waitHealth(CENTRAL + '/test/events');
  const okH = await waitHealth(HOUSE + '/api/health');
  const okH2 = await waitHealth('http://localhost:8762/api/health');
  check('mock central + house webapp start', okC && okH && okH2, `central=${okC} house=${okH} house2=${okH2}`);
  if (!(okC && okH)) throw new Error('servers failed to start');

  // ---- C9: SSO เปิด → ACCESS_CODE ถูกปิด (เกณฑ์ข้อ 8) ----
  const h2 = await (await fetch('http://localhost:8762/api/health')).json();
  check('C9: SSO on disables ACCESS_CODE', h2.sso === true && h2.access_code === false, JSON.stringify(h2));
  const oldGate = await fetch('http://localhost:8762/gate?code=oldcode', { redirect: 'manual' });
  check('C9: old ACCESS_CODE no longer passes', oldGate.status === 401, `status=${oldGate.status}`);

  // ---- เกณฑ์ข้อ 2: แลกตั๋วใบเดิมซ้ำ = 401 + เป็นเหตุร้ายแรงฝั่งบ้านกลาง (เทสกับ mock เท่านั้น) ----
  {
    const t = await getTicket();
    const r1 = await fetch(HOUSE + '/api/sso/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) });
    const r2 = await fetch(HOUSE + '/api/sso/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: t }) });
    check('exchange first use ok', r1.status === 200, `status=${r1.status}`);
    check('replayed ticket rejected 401 (house never retries)', r2.status === 401, `status=${r2.status}`);
    const ev = await (await fetch(CENTRAL + '/test/events')).json();
    check('central logged severe reuse event', ev.events.some(e => /ซ้ำ/.test(e)), JSON.stringify(ev.events));
  }

  // ---- เปิดผ่านเบราว์เซอร์จริง: ผ่านประตู → เข้าบ้าน → ไม่มี #ticket ค้าง (เกณฑ์ข้อ 1) ----
  await fetch(CENTRAL + '/test/set_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'full' }) });
  const app = await openApp({ url: HOUSE + '/', allowHosts: ['localhost'] });
  browser = app.browser;
  const page = app.page;
  const errors = app.errors;
  check('login completes after gate redirects', await waitLogged(page), 'ssoUser not set in time');
  const st1 = await page.evaluate(() => ({
    hash: location.hash, user: ssoUser && ssoUser.display_name, role: ssoRole,
    badge: document.getElementById('cloudBadge').textContent,
    cookies: document.cookie,
  }));
  check('gate flow lands in app with user', st1.user === 'สมชาย ทดสอบ' && st1.role === 'full', JSON.stringify(st1));
  check('no #ticket left in URL', !/ticket=/.test(st1.hash), st1.hash);
  check('house badge shows central identity', /สมชาย ทดสอบ/.test(st1.badge), st1.badge);
  // เกณฑ์ข้อ 7: บัตร/กุญแจไม่ปรากฏฝั่ง browser — cookie เป็น httpOnly (document.cookie ว่าง) และไม่มี ab_/กุญแจในหน้า
  const leak = await page.evaluate(() => (document.documentElement.outerHTML.includes('devkey') ? 'key' : '')
    + (/ab_[A-Za-z0-9_-]{10,}/.test(document.documentElement.outerHTML) ? 'badge' : ''));
  check('badge/house key never reach browser DOM', leak === '' && !/bbt_session/.test(st1.cookies), `leak=${leak} cookies=${st1.cookies}`);

  // ---- ทำงานจริง: กรอก → คำนวณ → ส่งตรวจ → ตรวจผ่าน → ส่งอนุมัติ (editor path ทำโดย full ได้) ----
  await page.evaluate(() => {
    loadCompanyToForm();
    $('coName').value = 'บริษัท เทสบ้าน จำกัด'; $('coTaxId').value = '0105551234567';
    $('coYearEnd').value = '31/12/2569';
    saveCompanyFromForm();
    $('inProfit').value = '1000000'; calculate();
    $('wfSendTo').value = ssoUser.display_name;   // เลือกผู้ตรวจที่จะส่งให้ (ตัวเองใน mock)
    wfDo('submit');
  });
  await sleep(300);
  await page.evaluate(() => { $('wfActor').value = ssoUser.display_name; wfDo('review-pass'); });
  await sleep(200);
  await page.evaluate(() => { $('wfSendTo').value = ssoUser.display_name; wfDo('send-approve'); });
  await sleep(1800);   // ให้ housePushNow (debounce 1.2s) ส่งขึ้น server
  const wf1 = await page.evaluate(() => ensureWorkflow(activeCompany()).status);
  check('workflow reaches reviewed', wf1 === 'reviewed', wf1);

  // ---- เกณฑ์ข้อ 5: อนุมัติ (ระดับ full) เมื่อพ้น window ต้องถูกบังคับ re-SSO ----
  await sleep(FULL_WIN * 1000 + 1000);          // ให้ sso_at พ้น window
  await page.evaluate(() => { wfDo('approve'); });   // confirm ถูก dismiss อัตโนมัติ = ไม่ไปประตู
  const wf2 = await page.evaluate(() => ensureWorkflow(activeCompany()).status);
  check('approve blocked without fresh re-SSO', wf2 === 'reviewed', wf2);
  // server ก็ต้องปฏิเสธเช่นกัน แม้ browser พยายามยัดตรง
  const forced = await page.evaluate(async () => {
    const c = JSON.parse(JSON.stringify(activeCompany()));
    c.workflow.status = 'approved';
    try { await apiReq('PUT', '/api/companies/' + c.id, c); return 'accepted'; }
    catch (e) { return e.code || String(e.status); }
  });
  check('server rejects stale-SSO approve (need_resso)', forced === 'need_resso', forced);

  // ผ่านประตูใหม่ (re-SSO) แล้วอนุมัติได้ — และ server ประทับชื่อผู้อนุมัติจากบัญชีจริง
  await page.goto(CENTRAL + '/api/sso/pnd51?path=' + encodeURIComponent('/'));
  check('re-SSO gate returns to app', await waitLogged(page), 'not logged after re-gate');
  await page.evaluate(() => { wfDo('approve'); });
  await sleep(1800);
  const approved = await page.evaluate(async () => {
    const wf = ensureWorkflow(activeCompany());
    const remote = await apiReq('GET', '/api/data');
    const rc = (remote.companies || []).find(x => x.name === 'บริษัท เทสบ้าน จำกัด');
    const ap = rc && rc.workflow && rc.workflow.current && rc.workflow.current.approver;
    return { local: wf.status, remote: rc && rc.workflow.status, signer: ap && ap.name, by: ap && ap.by && ap.by.uid };
  });
  check('approve after fresh re-SSO succeeds', approved.local === 'approved' && approved.remote === 'approved', JSON.stringify(approved));
  check('server stamps approver identity from session', approved.signer === 'สมชาย ทดสอบ' && approved.by === 'u-001', JSON.stringify(approved));

  // ---- เกณฑ์ข้อ 4: นั่งเฉย → จอล็อกเอง + ไม่มี traffic อัตโนมัติ · ปลดล็อกด้วยการตรวจใหม่ ----
  let idleReq = 0;
  const countReq = r => { if (r.url().includes('/api/')) idleReq++; };
  page.on('request', countReq);
  await sleep((CHECK_AGE + 7) * 1000);          // เกินอายุผลตรวจ + รอบ tick 5 วิ
  page.off('request', countReq);
  const locked = await page.evaluate(() => document.getElementById('ssoLock').style.display);
  check('idle screen locks itself', locked === 'flex', `display=${locked}`);
  check('no automatic traffic while idle (no heartbeat)', idleReq === 0, `requests=${idleReq}`);
  await page.evaluate(() => ssoUnlock());
  await sleep(700);
  const unlocked = await page.evaluate(() => document.getElementById('ssoLock').style.display);
  check('unlock via fresh check works', unlocked === 'none', `display=${unlocked}`);

  // ---- เกณฑ์ข้อ 3: ถูกปิดสิทธิ์ที่บ้านกลาง → การกระทำถัดไปหลังผลตรวจหมดอายุถูกตัดทันที ----
  await fetch(CENTRAL + '/test/disable', { method: 'POST' });
  await sleep((CHECK_AGE + 1) * 1000);
  const cut = await page.evaluate(async () => { try { await apiReq('GET', '/api/data'); return 'ok'; } catch (e) { return e.code; } });
  check('disabled user is cut off on next action', cut === 'disabled', cut);
  await fetch(CENTRAL + '/test/enable', { method: 'POST' });

  // ---- viewer: server ปฏิเสธการเขียนทุกอย่าง ----
  await fetch(CENTRAL + '/test/set_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) });
  const pv = await browser.newPage();
  await pv.goto(CENTRAL + '/api/sso/pnd51?path=' + encodeURIComponent('/'));
  check('viewer page logs in', await waitLogged(pv), 'viewer not logged');
  const vw = await pv.evaluate(async () => {
    const out = { role: ssoRole, canSubmit: wfActionAllowed('submit') };
    try { await apiReq('PUT', '/api/companies/vwx', { id: 'vwx', name: 'x' }); out.write = 'accepted'; }
    catch (e) { out.write = e.code; }
    return out;
  });
  check('viewer: UI blocks actions', vw.role === 'viewer' && vw.canSubmit === false, JSON.stringify(vw));
  check('viewer: server rejects writes', vw.write === 'role_viewer', vw.write);
  await pv.close();
  await fetch(CENTRAL + '/test/set_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'full' }) });

  // ---- เกณฑ์ข้อ 6: บ้านกลางขัดข้อง → ไม่เปิดข้อมูลใหม่/ไม่รับเขียน · หน้าจอเดิมดูต่อได้ ----
  // session หน้าหลักถูกตัดไปตอนเทส "ถูกปิดสิทธิ์" (ตามดีไซน์) — ผ่านประตูใหม่ก่อน แล้วค่อยดับบ้านกลาง
  await page.goto(CENTRAL + '/api/sso/pnd51?path=' + encodeURIComponent('/'));
  check('re-login before central-down test', await waitLogged(page), 'not logged before down test');
  central.kill('SIGKILL');
  await sleep((CHECK_AGE + 1) * 1000);
  const down = await page.evaluate(async () => {
    const out = { screenVisible: !!document.querySelector('.wrap') };
    try { await apiReq('GET', '/api/data'); out.read = 'ok'; } catch (e) { out.read = e.code; }
    try { await apiReq('PUT', '/api/companies/zzz', { id: 'zzz', name: 'z' }); out.write = 'ok'; } catch (e) { out.write = e.code; }
    return out;
  });
  check('central down: reads/writes blocked (C5)', down.read === 'central_down' && down.write === 'central_down', JSON.stringify(down));
  check('central down: open screen still viewable', down.screenVisible === true, JSON.stringify(down));

  check('no page errors throughout', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('suite crashed', false, String(e && e.stack || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of [central, house, house2]) { try { p.kill('SIGKILL'); } catch (e) {} }
  try { fs.unlinkSync(tmpdb); } catch (e) {}
  try { fs.unlinkSync(tmpdb + '2'); } catch (e) {}
}
process.exit(report('sso') ? 1 : 0);
