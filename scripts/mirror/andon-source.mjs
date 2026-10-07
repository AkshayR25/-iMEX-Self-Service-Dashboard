// READ-ONLY look at the Andon board on the SERVER (source), as the app user (SRC_APP_USERNAME / SRC_APP_PASSWORD):
// sign in, choose the "PM (Manufacturer)" tile, open the Andon icon of the top navbar, start the board if it asks,
// and save what is seen to mirror-data/andon/: a screenshot per step, the dashboard and state it runs on, the widgets
// it uses (their definitions, read with GET), and the data requests the page makes. Nothing can be changed on the
// server: every request that is not a GET is aborted in the browser, except the login / token refresh and the query
// POSTs that only read (same rules as shots-source.mjs); the aborted ones are listed at the end.
//   node scripts/mirror/andon-source.mjs
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.SRC_TB_URL.replace(/\/+$/, '');
const READ_POST = [/^\/api\/auth\/login$/, /^\/api\/auth\/token$/, /^\/api\/entitiesQuery\/(find|count)$/, /^\/api\/alarmsQuery\/(find|count)$/, /^\/api\/relations\/info$/, /^\/api\/relations$/, /^\/api\/edqs\//];
const SIDE_EFFECT_GET = [/^\/api\/user\/lastVisitedDashboard\//, /^\/api\/user\/[^/]+\/token$/, /activationLink/, /^\/api\/noauth\//, /^\/api\/v1\//, /^\/api\/user\/dashboards\/[^/]+\/(star|unstar)$/];
const OUT = 'mirror-data/andon';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const blocked = [];
const reads = [];
await ctx.route('**/*', (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.origin !== new URL(base).origin) return route.continue();
  const m = req.method();
  const ok = m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? !SIDE_EFFECT_GET.some((r) => r.test(u.pathname)) : m === 'POST' && READ_POST.some((r) => r.test(u.pathname));
  const p = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>');
  if (ok) {
    if (u.pathname.startsWith('/api/')) reads.push(`${m} ${p}${m === 'POST' ? '' : u.search ? '?' + [...u.searchParams.keys()].join('&') : ''}`);
    return route.continue();
  }
  blocked.push(`${m} ${p}`);
  return route.abort();
});
let page = await ctx.newPage();
const sockets = [];
const wsCmds = [];
page.on('websocket', (s) => {
  sockets.push(new URL(s.url()).pathname);
  s.on('framesent', (f) => { try { const c = JSON.parse(String(f.payload)); (c.cmds || []).forEach((x) => wsCmds.push(x)); } catch {} });
});
let n = 0;
const shot = async (name) => { const f = `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: f }); console.log('screenshot', f); };
const state = () => page.evaluate(() => { try { const u = new URL(location.href); const s = u.searchParams.get('state'); return { path: u.pathname, state: s ? JSON.parse(atob(decodeURIComponent(s))) : null }; } catch (e) { return { path: location.pathname, state: null }; } });
try {
  await page.goto(base + '/login');
  await page.fill('input#username-input', process.env.SRC_APP_USERNAME);
  await page.fill('input#password-input', process.env.SRC_APP_PASSWORD);
  await page.click('button[type=submit]');
  try { await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 30000 }); } catch (e) { await shot('sign-in-failed'); console.log('still on', page.url().split('?')[0], '| page says:', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)))); throw new Error('sign-in did not complete'); }
  await page.waitForTimeout(10000);
  await shot('after-sign-in');
  console.log('after sign-in:', JSON.stringify(await state()));

  // the "PM (Manufacturer)" tile
  const tile = page.getByText(/PM\s*\(Manufacturer\)/i).first();
  if (!(await tile.count())) {
    console.log('no "PM (Manufacturer)" tile found; visible texts:', (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 600))));
  } else {
    // how the tile links: an anchor around it, or a click handler that may open a new tab
    console.log('tile link:', JSON.stringify(await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /PMs*(Manufacturer)/i.test(e.textContent));
      const card = el && (el.closest('a, [onclick], [ng-click], [data-url], [data-href]') || el.parentElement && el.parentElement.parentElement);
      const a = card && (card.closest('a') || card.querySelector('a'));
      return { tag: card && card.tagName, href: a && a.getAttribute('href'), target: a && a.getAttribute('target'), onclick: card && (card.getAttribute('onclick') || '').slice(0, 160), html: card && card.outerHTML.slice(0, 300) };
    })));
    const popupP = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    const img = page.locator('img').filter({ has: page.locator('xpath=..') }).first();
    await tile.click();
    const popup = await popupP;
    if (popup) {
      console.log('the tile opened a new tab:', popup.url().split('?')[0]);
      page = popup;
      page.on('websocket', (sk) => { sockets.push(new URL(sk.url()).pathname); sk.on('framesent', (fr) => { try { const c = JSON.parse(String(fr.payload)); (c.cmds || []).forEach((x) => wsCmds.push(x)); } catch {} }); });
    }
    await page.waitForTimeout(12000);
    await shot('pm-manufacturer');
    console.log('after the tile:', JSON.stringify(await state()));
  }

  // the navbar icons: their titles / tooltips / labels, to find the Andon one
  const icons = await page.evaluate(() => [...document.querySelectorAll('button, a, [role=button], mat-icon, i, img, svg')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.top < 140 && r.width > 8 && r.width < 80 && r.height > 8; })
    .map((e) => ({ tag: e.tagName, text: (e.innerText || '').trim().slice(0, 30), title: e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('mattooltip') || e.getAttribute('ng-reflect-message') || '', cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className).slice(0, 50), x: Math.round(e.getBoundingClientRect().left) })));
  console.log('navbar candidates:', JSON.stringify(icons.filter((i) => i.title || i.text).slice(0, 40)));
  let andon = page.locator('[title*="ndon" i], [aria-label*="ndon" i], [mattooltip*="ndon" i], [ng-reflect-message*="ndon" i]').first();
  // the navbar's icons carry a hidden tooltip span ("Andon Dashboard"): click the icon it belongs to
  if (!(await andon.count())) andon = page.locator('span.tooltip', { hasText: /andon/i }).first().locator('xpath=..');
  if (!(await andon.count())) andon = page.getByText(/andon/i).first();
  if (await andon.count()) {
    await andon.click();
    await page.waitForTimeout(12000);
    await shot('andon');
    console.log('Andon page:', JSON.stringify(await state()));
    // the "Andon Parameters" pop-up: equipment (several) and delay, then "Start now" (a form in the browser)
    const pop = page.locator('.dx-popup-normal:visible, .dx-overlay-content:visible').filter({ hasText: /Andon Parameters/ }).first();
    if (await pop.count()) {
      const eq = pop.locator('.dx-tagbox, .dx-selectbox, .dx-dropdowneditor').first();
      await eq.click();
      await page.waitForTimeout(1500);
      const opts = page.locator('.dx-overlay-wrapper .dx-list-item:visible');
      const names = await opts.allInnerTexts();
      console.log('equipment offered:', names.length, '|', names.slice(0, 20).join(' | '));
      await shot('andon-equipment-list');
      for (let k = 0; k < Math.min(4, names.length); k++) { await opts.nth(k).click(); await page.waitForTimeout(250); }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const delay = pop.locator('.dx-selectbox, .dx-dropdowneditor').nth(1);
      await delay.locator('.dx-dropdowneditor-button').click().catch(() => delay.click());
      await page.waitForTimeout(1000);
      const dl = await page.locator('.dx-overlay-wrapper .dx-list-item:visible').allInnerTexts();
      console.log('delay offered:', dl.join(' | '));
      await page.locator('.dx-overlay-wrapper .dx-list-item:visible').first().click();
      await page.waitForTimeout(500);
      await shot('andon-parameters-filled');
      await pop.getByText(/Start now/i).click();
      await page.waitForTimeout(10000);
      await shot('andon-started');
      console.log('after Start:', JSON.stringify(await state()));
      for (let k = 1; k <= 3; k++) { await page.waitForTimeout(15000); await shot('andon-' + (15 * k) + 's'); console.log('after ' + (15 * k) + ' s:', JSON.stringify(await state())); }
    }
  } else {
    console.log('no Andon icon found among the navbar candidates above');
  }

  // what the page is made of: the dashboard, the current state's widgets and their definitions (GET only)
  const st = await state();
  const dashId = (/\/dashboards?\/([0-9a-f-]{36})/.exec(st.path) || [])[1];
  if (dashId) {
    const info = await page.evaluate(async (id) => {
      const h = { headers: { 'X-Authorization': 'Bearer ' + localStorage.getItem('jwt_token') } };
      const d = await fetch('/api/dashboard/' + id, h).then((x) => x.json());
      const cur = (new URLSearchParams(location.search).get('state'));
      let sid = null;
      try { const a = JSON.parse(atob(decodeURIComponent(cur))); sid = a[a.length - 1].id; } catch (e) { sid = Object.keys(d.configuration.states).find((k) => d.configuration.states[k].root); }
      const pick = ['andon_carousel', sid];
      const layout = Object.assign({}, ...pick.map((k) => d.configuration.states[k]?.layouts?.main?.widgets || {}));
      sid = pick.join(' + ');
      const ws = Object.keys(layout).map((wid) => d.configuration.widgets[wid]).filter(Boolean);
      const types = {};
      for (const w of ws) {
        if (types[w.typeFullFqn]) continue;
        types[w.typeFullFqn] = await fetch('/api/widgetType?fqn=' + encodeURIComponent(w.typeFullFqn), h).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      }
      return { title: d.title, stateId: sid, states: Object.keys(d.configuration.states), aliases: d.configuration.entityAliases, widgets: ws, types };
    }, dashId);
    writeFileSync(`${OUT}/dashboard-state.json`, JSON.stringify(info, null, 1));
    console.log(`dashboard "${info.title}", state ${info.stateId}; widgets: ${info.widgets.map((w) => w.typeFullFqn + ' (' + (w.config?.title || '') + ')').join(', ')}`);
    console.log('states of that dashboard:', info.states.join(', '));
  }
} finally {
  writeFileSync(`${OUT}/requests.json`, JSON.stringify({ reads: [...new Set(reads)], sockets, wsCmds: wsCmds.slice(0, 50), blocked: [...new Set(blocked)] }, null, 1));
  console.log('data requests made:', [...new Set(reads)].length, '| websocket connections:', sockets.length, '| ws commands:', [...new Set(wsCmds.map((c) => c.type))].join(', '));
  console.log(blocked.length ? 'blocked (not sent): ' + [...new Set(blocked)].join(' | ') : 'no write request was attempted');
  await browser.close();
}
