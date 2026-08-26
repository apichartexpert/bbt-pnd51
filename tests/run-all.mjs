// รันทุกชุดทดสอบตามลำดับ: node tests/run-all.mjs
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ['calc.test.mjs', 'import.test.mjs', 'ui.test.mjs']) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n✗ ${failed} suite(s) failed` : '\n✓ all suites passed');
process.exit(failed ? 1 : 0);
