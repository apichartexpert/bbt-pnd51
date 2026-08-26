// ตัวช่วยกลางของชุดทดสอบ: เปิด Chromium ชี้ไปที่ index.html และตัดเน็ตภายนอก (firebase/gstatic)
// รัน: node tests/run-all.mjs  (ต้องมี playwright — ติดตั้งด้วย: npm i -g playwright && npx playwright install chromium)
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
    try { return require(spec); } catch (e) { /* ลองตัวถัดไป */ }
  }
  throw new Error('ไม่พบ playwright — ติดตั้งด้วย: npm i -g playwright');
}
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    const dir = fs.readdirSync(base).find(d => /^chromium-\d+$/.test(d));
    if (dir) {
      const p = path.join(base, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;   // ให้ playwright หาเอง
}

export const APP_FILE = 'file://' + path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

export async function openApp() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!/net::ERR|Failed to load resource|gstatic|firebase/i.test(t)) errors.push('CONSOLE: ' + t);
  });
  await page.route('**/*', r => r.request().url().startsWith('file://') ? r.continue() : r.abort());
  await page.goto(APP_FILE, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  return { browser, page, errors };
}

export function makeChecker() {
  const results = [];
  const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });
  const report = (suite) => {
    let pass = 0, fail = 0;
    for (const r of results) {
      if (r.pass) pass++;
      else { fail++; console.log(`  ✗ FAIL: ${r.name}  [${r.detail}]`); }
    }
    console.log(`${suite}: ${pass}/${results.length} passed, ${fail} failed`);
    return fail;
  };
  return { check, report };
}

export const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
