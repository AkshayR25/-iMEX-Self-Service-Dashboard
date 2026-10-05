// READ-ONLY look at the app on the SERVER (source): opens states of "Self Service Dashboard" in headless Chromium
// and saves a screenshot per state to mirror-data/source-screens/. Nothing can be changed on the server: every
// request that is not a GET is aborted in the browser, except the login / token refresh and the query POSTs that
// only read. GETs with a side effect (dashboard-visit tracking, user tokens) are aborted too.
//   node scripts/mirror/shots-source.mjs [state ...]        default: the alert, analyzer and user pages
import 'dotenv/config';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.SRC_TB_URL.replace(/\/+$/, '');
const READ_POST = [/^\/api\/auth\/login$/, /^\/api\/auth\/token$/, /^\/api\/entitiesQuery\/(find|count)$/, /^\/api\/alarmsQuery\/(find|count)$/, /^\/api\/relations\/info$/, /^\/api\/relations$/, /^\/api\/edqs\//];
const SIDE_EFFECT_GET = [/^\/api\/user\/lastVisitedDashboard\//, /^\/api\/user\/[^/]+\/token$/, /activationLink/, /^\/api\/noauth\//, /^\/api\/v1\//, /^\/api\/user\/dashboards\/[^/]+\/(star|unstar)$/];
const src = JSON.parse(readFileSync('mirror-data/source/dashboards.json', 'utf8')).find((d) => d.title === 'Self Service Dashboard');
const device = JSON.parse(readFileSync('mirror-data/source/devices.json', 'utf8')).find((d) => d.name === 'Compressor 1');
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['user_management', 'active_alerts', 'alert_history', 'alert_management', 'custom_alert', 'analytics', 'in_app_alert'];
mkdirSync('mirror-data/source-screens', { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const blocked = [];
await ctx.route('**/*', (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.origin !== new URL(base).origin) return route.continue();
  const m = req.method();
  const ok = m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? !SIDE_EFFECT_GET.some((r) => r.test(u.pathname)) : m === 'POST' && READ_POST.some((r) => r.test(u.pathname));
  if (ok) return route.continue();
  blocked.push(`${m} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}`);
  return route.abort();
});
const page = await ctx.newPage();
await page.goto(base + '/login');
await page.fill('input#username-input', process.env.SRC_TB_USERNAME);
await page.fill('input#password-input', process.env.SRC_TB_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 30000 });
const stateParam = (id, params = {}) => Buffer.from(JSON.stringify([{ id, params }])).toString('base64');
for (const sid of want) {
  const params = { entityId: { entityType: 'DEVICE', id: device.id.id }, entityName: 'Compressor 1', entityLabel: 'Compressor 1' };
  await page.goto(`${base}/dashboard/${src.id.id}?state=${encodeURIComponent(stateParam(sid, params))}`);
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `mirror-data/source-screens/${sid}.png` });
  console.log(`${sid}: saved`);
}
console.log(blocked.length ? 'blocked (not sent): ' + [...new Set(blocked)].join(' | ') : 'no write request was attempted');
await browser.close();
