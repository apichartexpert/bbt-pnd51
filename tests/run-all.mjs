// รันทุกชุดทดสอบตามลำดับ: node tests/run-all.mjs
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const suites = ['calc.test.mjs', 'import.test.mjs', 'ui.test.mjs'];
// ชุด SSO (โหมดบ้าน) ต้องมี python3 + fastapi/uvicorn — ไม่มีก็ข้าม (ชุดอื่นยังคุมสูตรภาษี/หน้าจอครบ)
const py = spawnSync('python3', ['-c', 'import fastapi, uvicorn, sqlalchemy, httpx'], { stdio: 'ignore' });
if (py.status === 0) suites.push('sso.test.mjs');
else console.log('(ข้าม sso.test.mjs — ติดตั้งด้วย: pip install -r webapp/requirements.txt)');

let failed = 0;
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n✗ ${failed} suite(s) failed` : '\n✓ all suites passed');
process.exit(failed ? 1 : 0);
