import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const srv = createServer((q, r) => { const f = q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0].slice(1); try { r.end(readFileSync('widgets/harness/' + f)); } catch { r.statusCode = 404; r.end(); } }).listen(8765);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
const steps = JSON.parse(process.argv[2] || '[]');
await page.goto('http://localhost:8765/' + (process.argv[3] || ''));
await page.waitForTimeout(1200);
let n = 0;
for (const s of steps) {
  if (s.click) await page.click(s.click, { timeout: 4000 }).catch((e) => errs.push('click ' + s.click + ': ' + e.message.split('\n')[0]));
  if (s.fill) await page.fill(s.fill[0], s.fill[1]).catch((e) => errs.push('fill: ' + e.message.split('\n')[0]));
  if (s.select) await page.selectOption(s.select[0], s.select[1]).catch((e) => errs.push('select: ' + e.message.split('\n')[0]));
  if (s.drag) await page.dragAndDrop(s.drag[0], s.drag[1], { targetPosition: s.drag[2] }).catch((e) => errs.push('drag: ' + e.message.split('\n')[0]));
  if (s.eval) console.log('eval:', String(JSON.stringify(await page.evaluate(s.eval))).slice(0, 1500));
  await page.waitForTimeout(s.wait ?? 600);
  if (s.shot) await page.screenshot({ path: `/tmp/claude-0/shot-${s.shot}.png` });
}
console.log(errs.length ? errs.join('\n') : 'no errors');
await browser.close(); srv.close();
