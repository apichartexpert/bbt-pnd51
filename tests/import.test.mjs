// ทดสอบส่งออก/นำเข้า Excel (การหั่น _json), dedupe เลขผู้เสียภาษี+รอบปี, tombstone
import { openApp, makeChecker } from './helper.mjs';

const { browser, page, errors } = await openApp();
const { check, report } = makeChecker();

// 1. Excel round-trip ผ่านการหั่น _json (payload >30,000 ตัวอักษร บังคับหั่นหลายคอลัมน์)
const rt = await page.evaluate(() => {
  const bigHist = Array.from({ length: 800 }, (_, i) => ({ note: 'entry-' + i + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', v: i }));
  const c = {
    id: 'cRT1', name: 'บริษัท ทดสอบ จำกัด', taxId: '0105551234567', year: 2568,
    jobCode: 'J-99', yearEnd: '31/12/2568', entityType: 'general',
    preparer: 'สมชาย', reviewer: 'สมหญิง', approver: 'สมศักดิ์',
    lossCarry: [111, 222, 0, 0, 0], history: bigHist, est: { profit: '1234567' }
  };
  const wb = companiesToWorkbook([c], []);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const data = workbookToData(XLSX.read(buf, { type: 'array' }));
  return { full: JSON.stringify(c).length, back: data.companies[0] };
});
check('roundtrip payload >30k chars (forces chunking)', rt.full > 30000, `len=${rt.full}`);
check('roundtrip name preserved', rt.back.name === 'บริษัท ทดสอบ จำกัด', rt.back.name);
check('roundtrip taxId preserved', rt.back.taxId === '0105551234567', rt.back.taxId);
check('roundtrip lossCarry preserved', JSON.stringify(rt.back.lossCarry) === JSON.stringify([111, 222, 0, 0, 0]), JSON.stringify(rt.back.lossCarry));
check('roundtrip history length preserved', (rt.back.history || []).length === 800, `${(rt.back.history || []).length}`);
check('roundtrip entityType preserved', rt.back.entityType === 'general', rt.back.entityType);

// 2. Dedupe: เลขผู้เสียภาษี+ปีตรงกัน → อัปเดตทับ คงรหัสภายในเดิม
const dd = await page.evaluate(() => {
  db.companies = [{ id: 'orig1', name: 'เดิม', taxId: '0105551234567', year: 2568, entityType: 'sme', lossCarry: [0, 0, 0, 0, 0], history: [] }];
  db.activeId = 'orig1';
  db.deletedIds = db.deletedIds || [];
  const before = db.companies.length;
  applyImportedData({ companies: [{ id: 'newXYZ', name: 'ใหม่', taxId: '0105551234567', year: 2568, entityType: 'general' }] });
  const match = db.companies.find(x => x.taxId === '0105551234567' && String(x.year) === '2568');
  return { before, after: db.companies.length, id: match.id, name: match.name, count: db.companies.filter(x => x.taxId === '0105551234567').length };
});
check('dedupe same taxId+year: no new record', dd.after === dd.before, `before=${dd.before} after=${dd.after}`);
check('dedupe preserves original internal id', dd.id === 'orig1', dd.id);
check('dedupe updates content', dd.name === 'ใหม่', dd.name);
check('dedupe only one record for that taxId', dd.count === 1, `${dd.count}`);

// 3. Dedupe: ปีต่างกัน → แยกรายการ
const dy = await page.evaluate(() => {
  db.companies = [{ id: 'orig1', name: 'ปี2568', taxId: '0105551234567', year: 2568, entityType: 'sme', lossCarry: [0, 0, 0, 0, 0], history: [] }];
  db.activeId = 'orig1';
  applyImportedData({ companies: [{ id: 'other', name: 'ปี2569', taxId: '0105551234567', year: 2569, entityType: 'sme' }] });
  return { count: db.companies.filter(x => x.taxId === '0105551234567').length };
});
check('different year -> separate record (2 total)', dy.count === 2, `${dy.count}`);

// 4. เติม 0 นำหน้าเลขผู้เสียภาษีที่ Excel ตัดทิ้ง
const pad = await page.evaluate(() => excelTaxIdText(105551234567));
check('excelTaxIdText pads to 13 digits', pad === '0105551234567', pad);

// 5. นำเข้าข้อมูลบางส่วน → default sme ไม่ crash
const partial = await page.evaluate(() => {
  db.companies = [db.companies[0]]; db.activeId = db.companies[0].id;
  applyImportedData({ companies: [{ id: 'p1', name: 'บางส่วน', taxId: '999' }] });
  const c = db.companies.find(x => x.id === 'p1');
  return { entityType: c.entityType, lossCarry: Array.isArray(c.lossCarry), history: Array.isArray(c.history) };
});
check('partial import defaults entityType=sme', partial.entityType === 'sme', partial.entityType);
check('partial import initializes lossCarry array', partial.lossCarry === true);
check('partial import initializes history array', partial.history === true);

// 6. นำเข้าบริษัทที่เคยลบ → ยกเลิก tombstone
const tomb = await page.evaluate(() => {
  db.companies = [db.companies[0]]; db.activeId = db.companies[0].id;
  db.deletedIds = ['ghost1'];
  applyImportedData({ companies: [{ id: 'ghost1', name: 'คืนชีพ', taxId: '111', year: 2568 }] });
  return { stillDeleted: db.deletedIds.includes('ghost1'), present: db.companies.some(x => x.id === 'ghost1') };
});
check('re-import lifts tombstone', tomb.stillDeleted === false, `stillDeleted=${tomb.stillDeleted}`);
check('re-imported company present', tomb.present === true);

check('no page errors during import tests', errors.length === 0, errors.join(' | '));

await browser.close();
process.exit(report('import') ? 1 : 0);
