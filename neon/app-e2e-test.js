// Full Neon path in the real app against real PostgREST — faking only the Stack Auth token.
const { chromium } = require('playwright');
const crypto = require('crypto');
const SECRET = 'reallylongtestsecret_at_least_32_chars_1234567890';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = sub => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ sub, role: 'authenticated', email: sub + '@f.co', iat: 1700000000, exp: 2000000000 }); return `${h}.${p}.` + crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url'); };

const PASS = [], FAIL = [];
const ok = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log((c ? '✓' : '✗ FAIL') + ' ' + n + (!c && d ? ` — ${d}` : '')); };
const APP = 'http://localhost:8088/index.html';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
  page.on('dialog', d => d.accept());

  // inject Neon config + a fake Stack Auth session (fresh token → getAccessToken returns it without calling Stack Auth)
  const asUser = uid => page.addInitScript(({ token }) => {
    localStorage.setItem('pnd51_cloud_config_v1', JSON.stringify({
      dataApiUrl: 'http://localhost:3999', authProjectId: 'testproj', authPublishableKey: 'testkey', authBaseUrl: 'http://localhost:9'
    }));
    localStorage.setItem('neon_auth_tokens_v1', JSON.stringify({ access_token: token, refresh_token: 'dummy', at: Date.now() }));
  }, { token: jwt(uid) });

  // ---------- staff signs in (session restored from token) ----------
  await asUser('fb_staff');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);   // cloudInit → afterSignIn → checkApproval → startSync (real HTTP)

  let st = await page.evaluate(() => ({
    badge: (document.getElementById('cloudBadge') || {}).textContent,
    approved: cloudApproved, role: cloudRole, uid: cloudUser && cloudUser.uid,
    names: db.companies.map(c => c.name)
  }));
  ok('staff: connected + approved badge', /เชื่อมต่อแล้ว/.test(st.badge) && st.approved === true, JSON.stringify(st));
  ok('staff: identity from token', st.uid === 'fb_staff' && st.role === 'staff', JSON.stringify(st));
  ok('staff: pulled server company into local db', st.names.includes('บริษัทจากเซิร์ฟเวอร์'), JSON.stringify(st.names));

  // ---------- create a company locally → it should push to the server ----------
  await page.evaluate(async () => {
    const c = newCompany(); c.name = 'บริษัทจากแอป'; c.taxId = '0105552220002';
    db.companies.push(c); db.activeId = c.id; saveDB();
    await cloudPushNow();
  });
  await page.waitForTimeout(800);
  const onServer = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3999/company?select=id,name,created_by', { headers: { Authorization: 'Bearer ' + await neonAuth.getAccessToken() } });
    return await r.json();
  });
  ok('push: local company reached the server', onServer.some(r => r.name === 'บริษัทจากแอป' && r.created_by === 'fb_staff'), JSON.stringify(onServer));

  // ---------- concurrent edit: server-side workflow change must not be clobbered by a local est edit ----------
  const appco = onServer.find(r => r.name === 'บริษัทจากแอป');
  await page.evaluate(async ({ id }) => {
    // machine B (direct): approve on the server
    await fetch('http://localhost:3999/company?id=eq.' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await neonAuth.getAccessToken() },
      body: JSON.stringify({ workflow: { status: 'approved', log: [{ action: 'approve', by: 'B' }] } })
    });
    // machine A (this app): edit est only, then push
    const c = db.companies.find(x => x.name === 'บริษัทจากแอป');
    c.est = { profit: '123456' }; saveDB();
    await cloudPushNow();
  }, { id: appco.id });
  await page.waitForTimeout(600);
  const merged = await page.evaluate(async ({ id }) => {
    const r = await fetch('http://localhost:3999/company?id=eq.' + id + '&select=est,workflow', { headers: { Authorization: 'Bearer ' + await neonAuth.getAccessToken() } });
    return (await r.json())[0];
  }, { id: appco.id });
  ok("merge: A's est saved", merged.est && merged.est.profit === '123456', JSON.stringify(merged.est));
  ok("merge: B's approval kept", merged.workflow && merged.workflow.status === 'approved', JSON.stringify(merged.workflow));

  // ---------- poll picks up a remote change ----------
  await page.evaluate(async ({ id }) => {
    await fetch('http://localhost:3999/company?id=eq.' + id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await neonAuth.getAccessToken() },
      body: JSON.stringify({ name: 'บริษัทเปลี่ยนชื่อจากเครื่องอื่น' })
    });
    await pullAll(true);
  }, { id: appco.id });
  const pulled = await page.evaluate(() => db.companies.map(c => c.name));
  ok('poll: remote rename reflected locally', pulled.includes('บริษัทเปลี่ยนชื่อจากเครื่องอื่น'), JSON.stringify(pulled));

  // ---------- soft delete propagates ----------
  await page.evaluate(async ({ id }) => {
    markDeleted(id); db.companies = db.companies.filter(c => c.id !== id); saveDB();
    await cloudPushNow();
  }, { id: appco.id });
  const delRow = await page.evaluate(async ({ id }) => {
    const r = await fetch('http://localhost:3999/company?id=eq.' + id + '&select=deleted_at', { headers: { Authorization: 'Bearer ' + await neonAuth.getAccessToken() } });
    return (await r.json())[0];
  }, { id: appco.id });
  ok('delete: soft-deleted on server (deleted_at set)', delRow && delRow.deleted_at, JSON.stringify(delRow));

  await ctx.close();

  // ---------- pending user sees the waiting screen and no data ----------
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => errs.push('PAGEERROR2: ' + e.message));
  page2.on('dialog', d => d.accept());
  await page2.addInitScript(({ token }) => {
    localStorage.setItem('pnd51_cloud_config_v1', JSON.stringify({ dataApiUrl: 'http://localhost:3999', authProjectId: 'p', authPublishableKey: 'k', authBaseUrl: 'http://localhost:9' }));
    localStorage.setItem('neon_auth_tokens_v1', JSON.stringify({ access_token: token, refresh_token: 'dummy', at: Date.now() }));
  }, { token: jwt('fb_pending') });
  await page2.goto(APP, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(2000);
  const pend = await page2.evaluate(() => ({
    badge: (document.getElementById('cloudBadge') || {}).textContent,
    approved: cloudApproved,
    pendingShown: (document.getElementById('cloudPending') || {}).style.display
  }));
  ok('pending: waiting-for-approval screen shown', /รอ partner/.test(pend.badge) && pend.approved === false && pend.pendingShown === 'block', JSON.stringify(pend));
  await ctx2.close();

  // ---------- partner sees the admin panel and can approve ----------
  const ctx3 = await browser.newContext();
  const page3 = await ctx3.newPage();
  page3.on('pageerror', e => errs.push('PAGEERROR3: ' + e.message));
  page3.on('dialog', d => d.accept());
  await page3.addInitScript(({ token }) => {
    localStorage.setItem('pnd51_cloud_config_v1', JSON.stringify({ dataApiUrl: 'http://localhost:3999', authProjectId: 'p', authPublishableKey: 'k', authBaseUrl: 'http://localhost:9' }));
    localStorage.setItem('neon_auth_tokens_v1', JSON.stringify({ access_token: token, refresh_token: 'dummy', at: Date.now() }));
  }, { token: jwt('fb_partner') });
  await page3.goto(APP, { waitUntil: 'domcontentloaded' });
  await page3.waitForTimeout(2500);
  const adm = await page3.evaluate(() => ({
    isAdmin: isCloudAdmin(),
    panelShown: (document.getElementById('cloudAdminPanel') || {}).style.display,
    pendingHtml: (document.getElementById('cloudPendingList') || {}).textContent
  }));
  ok('partner: admin panel visible', adm.isAdmin === true && adm.panelShown === 'block', JSON.stringify({ a: adm.isAdmin, p: adm.panelShown }));
  ok('partner: pending queue lists the pending user', /pending@f\.co|รอ/.test(adm.pendingHtml || ''), (adm.pendingHtml || '').slice(0, 120));
  // approve the pending user via the app
  await page3.evaluate(async () => { await cloudApproveUser('fb_pending'); });
  await page3.waitForTimeout(600);
  const approvedNow = await page3.evaluate(async () => {
    const r = await fetch('http://localhost:3999/app_user?uid=eq.fb_pending&select=approved,role', { headers: { Authorization: 'Bearer ' + await neonAuth.getAccessToken() } });
    return (await r.json())[0];
  });
  ok('partner: approving via the app updates the server', approvedNow && approvedNow.approved === true, JSON.stringify(approvedNow));
  await ctx3.close();

  await browser.close();
  console.log('\nJS ERRORS:', errs.length ? '\n' + errs.join('\n') : 'none');
  console.log('PASS:' + PASS.length + ' FAIL:' + FAIL.length);
  if (FAIL.length || errs.length) process.exit(1);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
