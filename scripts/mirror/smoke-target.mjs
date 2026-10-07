// Browser check of the migrated app on the NEW tenant: signs in as a migrated user, opens every page (state) of
// "Self Service Dashboard", and lists script errors and failed requests per page -> mirror-data/target-shots/.
//   node scripts/mirror/smoke-target.mjs [email]        default ar@imex.com (password TGT_USER_PASSWORD)
// Opening pages only reads; the one exception is ThingsBoard's own "last visited dashboard" note.
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { newTenantClient, targetClient } from './clients.mjs';

// --local: the same check on the local copy (TB_URL, LOCAL_USER_PASSWORD), to tell server issues from existing ones
const LOCAL = process.argv.includes('--local');
const email = process.argv.slice(2).find((a) => !a.startsWith('--')) || (LOCAL ? 'akshayr+imex@ithena.ai' : 'ar@imex.com');
const base = (LOCAL ? process.env.TB_URL : process.env.TGT_TB_URL).replace(/\/+$/, '');
const OUT = 'mirror-data/target-shots';
mkdirSync(OUT, { recursive: true });
const T = LOCAL ? await targetClient() : await newTenantClient();
const dash = (await T.all('/api/tenant/dashboards')).find((d) => d.title === 'Self Service Dashboard');
const states = Object.keys((await T.api('GET', `/api/dashboard/${dash.id.id}`)).configuration.states);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let errs = [], fails = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 140)); });
page.on('response', (r) => { const u = new URL(r.url()); if (r.status() >= 400 && u.origin === base) fails.push(`${r.status()} ${r.request().method()} ${u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}`); });
await page.goto(base + '/login');
await page.fill('input#username-input', email);
await page.fill('input#password-input', LOCAL ? process.env.LOCAL_USER_PASSWORD : process.env.TGT_USER_PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 30000 });
await page.waitForTimeout(6000);
console.log(`${email}: landed on ${new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, '<id>')}; pages: ${states.length}`);
const tag = (LOCAL ? 'local-' : '') + email.split('@')[0];
for (const s of states) {
  errs = []; fails = [];
  const st = encodeURIComponent(Buffer.from(JSON.stringify([{ id: s, params: {} }])).toString('base64'));
  await page.goto(`${base}/dashboard/${dash.id.id}?state=${st}`);
  await page.waitForTimeout(9000);
  const info = await page.evaluate(() => ({
    menu: !!document.querySelector('.imx-menu, .imx-sm, [class*="imx-menu"]'),
    widgetErrors: [...document.querySelectorAll('.tb-widget-error, .tb-widget-error-container')].map((e) => e.textContent.trim().slice(0, 80)),
    noData: [...document.querySelectorAll('.tb-widget-no-data')].length,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 0)
  }));
  await page.screenshot({ path: `${OUT}/${tag}-${s}.png` });
  const f = [...new Set(fails)];
  console.log(`${errs.length || f.length || info.widgetErrors.length ? 'CHECK' : 'ok   '} ${s.padEnd(20)} menu ${info.menu ? 'yes' : 'NO '} | widget errors ${info.widgetErrors.length}${info.widgetErrors.length ? ' (' + info.widgetErrors.join(' | ') + ')' : ''} | script errors ${errs.length}${errs.length ? ' (' + [...new Set(errs)].slice(0, 3).join(' | ') + ')' : ''} | failed requests ${f.length}${f.length ? ' (' + f.slice(0, 4).join(', ') + ')' : ''}`);
}
await browser.close();
