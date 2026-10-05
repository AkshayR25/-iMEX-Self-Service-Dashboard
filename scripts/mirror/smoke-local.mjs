// Opens every state of the copied app on LOCAL as a customer user in headless Chromium; saves a screenshot per
// state to mirror-data/screens/ and prints the console errors and failed requests. Password: LOCAL_USER_PASSWORD.
//   node scripts/mirror/smoke-local.mjs [email]
import 'dotenv/config';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const base = process.env.TB_URL.replace(/\/+$/, '');
const email = process.argv[2] || 'akshayr+imex@ithena.ai';
const idmap = JSON.parse(readFileSync('mirror-data/idmap.json', 'utf8'));
const src = JSON.parse(readFileSync('mirror-data/source/dashboards.json', 'utf8')).find((d) => d.title === 'Self Service Dashboard');
const dashId = idmap[src.id.id];
const firstDevice = JSON.parse(readFileSync('mirror-data/source/devices.json', 'utf8')).find((d) => d.name === 'Compressor 1');
mkdirSync('mirror-data/screens', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
let log = [];
// tokens in URLs (legacy WebSocket) or messages are never printed
const mask = (s) => s.replace(/(token=)[^&\s'"]+/g, '$1<masked>').replace(/eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*){0,2}/g, '<jwt>');
page.on('console', (m) => { if (m.type() === 'error') log.push('console: ' + mask(m.text()).slice(0, 220)); });
page.on('pageerror', (e) => log.push('pageerror: ' + e.message.slice(0, 220)));
page.on('response', (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url().replace(base, '').slice(0, 140)}`); });
await page.goto(base + '/login');
await page.fill('input#username-input', email);
await page.fill('input#password-input', process.env.LOCAL_USER_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
const stateParam = (id, params = {}) => Buffer.from(JSON.stringify([{ id, params }])).toString('base64');
for (const sid of Object.keys(src.configuration.states)) {
  log = [];
  const params = sid === 'machine' ? { entityId: { entityType: 'DEVICE', id: idmap[firstDevice.id.id] }, entityName: 'Compressor 1' } : {};
  await page.goto(`${base}/dashboard/${dashId}?state=${encodeURIComponent(stateParam(sid, params))}`);
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `mirror-data/screens/${sid}.png` });
  const uniq = [...new Set(log)];
  console.log(`== ${sid}: ${uniq.length ? uniq.length + ' problems' : 'no errors'}`);
  for (const l of uniq.slice(0, 8)) console.log('   ' + l);
}
await browser.close();
