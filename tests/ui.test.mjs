// UI smoke: เดินครบ 7 ขั้นตอน + Dashboard, render ทุกส่วนหลัก, สร้างเอกสารพิมพ์ — ต้องไม่มี JS error
import { openApp, makeChecker } from './helper.mjs';

const { browser, page, errors } = await openApp();
const { check, report } = makeChecker();

// เตรียมบริษัทข้อมูลครบ เพื่อให้ทุก render path มีข้อมูลจริง
await page.evaluate(() => {
  const c = activeCompany();
  c.name = 'บริษัท สโมค เทสต์ จำกัด'; c.taxId = '0105551234567'; c.year = 2568;
  c.yearEnd = '31/12/2568'; c.jobCode = 'JOB-1'; c.entityType = 'sme';
  c.preparer = 'ผู้จัดทำ ก'; c.reviewer = 'ผู้ตรวจ ข'; c.approver = 'ผู้อนุมัติ ค';
  c.lossCarry = [100000, 50000, 0, 0, 0];
  db.employees = [
    { name: 'ผู้จัดทำ ก', role: '', rtype: 'Staff' },
    { name: 'ผู้ตรวจ ข', role: '', rtype: 'Manager' },
    { name: 'ผู้อนุมัติ ค', role: '', rtype: 'Partner' }];
  saveDB();
  loadCompanyToForm();   // โหลดฟอร์มก่อนกรอกตัวเลข (loadCompanyToForm ล้างช่องตาม c.est)
  document.getElementById('inRevenue').value = '10000000';
  document.getElementById('inExpense').value = '7000000';
  document.getElementById('inProfit').value = '3000000';
  document.getElementById('inLastYearProfit').value = '2800000';
  document.getElementById('inWht').value = '50000';
  calculate();
});
check('after seed+calculate: no errors', errors.length === 0, errors.join(' | '));

for (let n = 1; n <= 7; n++) {
  const before = errors.length;
  await page.evaluate((s) => goToStep(s), n);
  await page.waitForTimeout(60);
  check(`goToStep(${n}) no error`, errors.length === before, errors.slice(before).join(' | '));
}

{
  const before = errors.length;
  await page.evaluate(() => setView('dash'));
  await page.waitForTimeout(60);
  check('setView(dash) no error', errors.length === before, errors.slice(before).join(' | '));
}

for (const fn of ['renderWorkflow', 'renderFilingStep', 'renderHistory', 'renderCompare', 'renderPriorYearTax', 'renderDetail', 'renderLossTable', 'renderJobsDashboard']) {
  const before = errors.length;
  const ok = await page.evaluate((f) => {
    try { if (typeof window[f] === 'function') { window[f](); return 'ok'; } return 'missing'; }
    catch (e) { return 'THREW: ' + e.message; }
  }, fn);
  check(`${fn}() runs clean`, ok === 'ok' && errors.length === before, `${ok} ${errors.slice(before).join('|')}`);
}

{
  const html = await page.evaluate(() => {
    try { buildPrintReport(); return document.getElementById('printReport').innerHTML; }
    catch (e) { return 'THREW:' + e.message; }
  });
  check('buildPrintReport fills #printReport', typeof html === 'string' && html.length > 200 && !html.startsWith('THREW'), (html || '').slice(0, 80));
  check('print report contains company name', typeof html === 'string' && html.includes('สโมค เทสต์'), '');
}

// ชื่อบริษัทมีอักขระ HTML ต้องถูก escape ในเอกสารพิมพ์ (ไม่กลายเป็น tag จริง)
{
  const out = await page.evaluate(() => {
    const nameBox = document.getElementById('coName');
    const keep = nameBox.value;
    nameBox.value = 'บจ. <b>ทดสอบ</b> & จำกัด';   // calculate → saveCompanyFromForm อ่านชื่อจากช่องนี้
    calculate();
    buildPrintReport();
    const html = document.getElementById('printReport').innerHTML;
    nameBox.value = keep; calculate(); buildPrintReport();
    return { escaped: html.includes('&lt;b&gt;ทดสอบ&lt;/b&gt;'), injected: /<b>ทดสอบ<\/b>/.test(html) };
  });
  check('print report escapes < > in company name', out.escaped && !out.injected, JSON.stringify(out));
}

check('no page errors overall', errors.length === 0, errors.join(' | '));

await browser.close();
process.exit(report('ui') ? 1 : 0);
