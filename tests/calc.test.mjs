// ทดสอบสูตรภาษี ภ.ง.ด.51: ขั้นบันได SME, waterfall ทางภาษี, ขาดทุนสะสม, อัตราทั่วไป 20%
import { openApp, makeChecker, approx } from './helper.mjs';

const { browser, page, errors } = await openApp();
const { check, report } = makeChecker();

check('page loaded, no pageerror', errors.length === 0, errors.join(' | '));

// ---- smeTax ขั้นบันได: ยกเว้น 300k / 15% ช่วง 300k–3M / 20% เกิน 3M ----
const sme = await page.evaluate(() => {
  const cases = [0, 150000, 300000, 300001, 1000000, 3000000, 3000001, 5000000];
  return cases.map(b => ({ b, t: smeTax(b).tax }));
});
const expected = {
  0: 0, 150000: 0, 300000: 0, 300001: 0.15,
  1000000: 700000 * 0.15,
  3000000: 2700000 * 0.15,
  3000001: 2700000 * 0.15 + 1 * 0.20,
  5000000: 2700000 * 0.15 + 2000000 * 0.20,
};
for (const { b, t } of sme) check(`smeTax(${b}) = ${expected[b]}`, approx(t, expected[b]), `got ${t}`);

// ---- calculate() ผ่านฟอร์มจริง ----
async function runCalc(fields) {
  return await page.evaluate((f) => {
    const c = activeCompany();
    c.entityType = 'sme';
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('inRevenue', f.revenue ?? ''); set('inExpense', f.expense ?? '');
    set('inProfit', f.profit ?? ''); set('inAddBack', f.addBack ?? '');
    set('inExempt', f.exempt ?? ''); set('inLastYearProfit', f.lastYear ?? '');
    set('inWht', f.wht ?? ''); set('inLossUsed', f.lossUsed ?? '');
    c.lossCarry = f.lossCarry || [0, 0, 0, 0, 0];   // ล้างตารางขาดทุนทุกครั้ง กัน state รั่วข้ามเคส
    calculate();
    return JSON.parse(JSON.stringify(lastResult));
  }, fields);
}

// A: กำไร 4M SME → ฐานครึ่งปี 2M → ภาษี (2M−300k)×15% = 255,000
{
  const r = await runCalc({ profit: '4000000' });
  check('A taxableProfit=4,000,000', approx(r.taxableProfit, 4000000), `${r.taxableProfit}`);
  check('A half=2,000,000', approx(r.half, 2000000), `${r.half}`);
  check('A tax=255,000', approx(r.tax, 255000), `${r.tax}`);
  check('A netPay=255,000 (no wht)', approx(r.netPay, 255000), `${r.netPay}`);
}

// B: บวกกลับ + ยกเว้น + WHT
{
  const r = await runCalc({ profit: '1000000', addBack: '200000', exempt: '100000', wht: '10000' });
  check('B taxableBeforeLoss=1,100,000', approx(r.taxableBeforeLoss, 1100000), `${r.taxableBeforeLoss}`);
  check('B half=550,000', approx(r.half, 550000), `${r.half}`);
  check('B tax=37,500', approx(r.tax, 37500), `${r.tax}`);
  check('B netPay=27,500', approx(r.netPay, 27500), `${r.netPay}`);
}

// C: เว้นช่องขาดทุนว่าง → หักอัตโนมัติจากตาราง
{
  const r = await runCalc({ profit: '500000', lossCarry: [200000, 0, 0, 0, 0], lossUsed: '' });
  check('C lossUsed auto=200,000', approx(r.lossUsed, 200000), `${r.lossUsed}`);
  check('C lossAuto flag true', r.lossAuto === true, `${r.lossAuto}`);
  check('C taxableProfit=300,000', approx(r.taxableProfit, 300000), `${r.taxableProfit}`);
  check('C half=150,000', approx(r.half, 150000), `${r.half}`);
  check('C tax=0 (ต่ำกว่า 300k ยกเว้น)', approx(r.tax, 0), `${r.tax}`);
}

// D: หักอัตโนมัติไม่เกินกำไรที่เป็นบวก
{
  const r = await runCalc({ profit: '100000', lossCarry: [500000, 0, 0, 0, 0], lossUsed: '' });
  check('D lossUsed capped at profit=100,000', approx(r.lossUsed, 100000), `${r.lossUsed}`);
  check('D taxableProfit=0', approx(r.taxableProfit, 0), `${r.taxableProfit}`);
}

// E: ปีขาดทุน → ภาษี 0
{
  const r = await runCalc({ profit: '-200000' });
  check('E taxableProfit=-200,000', approx(r.taxableProfit, -200000), `${r.taxableProfit}`);
  check('E half=0', approx(r.half, 0), `${r.half}`);
  check('E tax=0', approx(r.tax, 0), `${r.tax}`);
}

// F: บริษัททั่วไป 20% flat (calculate อ่านประเภทจากปุ่ม radio)
{
  const r = await page.evaluate(() => {
    const c = activeCompany(); c.lossCarry = [0, 0, 0, 0, 0];
    document.querySelector('input[name="entityType"][value="general"]').checked = true;
    document.getElementById('inProfit').value = '4000000';
    ['inRevenue','inExpense','inAddBack','inExempt','inLastYearProfit','inWht','inLossUsed'].forEach(id => document.getElementById(id).value = '');
    calculate();
    const out = JSON.parse(JSON.stringify(lastResult));
    document.querySelector('input[name="entityType"][value="sme"]').checked = true;
    return out;
  });
  check('F general tax=400,000 (20% of half)', approx(r.tax, 400000), `${r.tax}`);
}

// G: พิมพ์จำนวนขาดทุนเอง → หักตามนั้นเสมอ แม้ปีขาดทุน (กติกาที่ผู้ใช้ยืนยัน)
{
  const r = await runCalc({ profit: '-100000', lossCarry: [300000, 0, 0, 0, 0], lossUsed: '50000' });
  check('G typed lossUsed=50,000 honored in loss year', approx(r.lossUsed, 50000), `${r.lossUsed}`);
  check('G taxableProfit=-150,000', approx(r.taxableProfit, -150000), `${r.taxableProfit}`);
}

check('no console errors', errors.length === 0, errors.join(' | '));

await browser.close();
process.exit(report('calc') ? 1 : 0);
