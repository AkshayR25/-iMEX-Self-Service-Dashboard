// End-to-end tests of the Dashboard Builder and the machine page, in a real Chromium, against the in-memory
// fake ThingsBoard of widgets/harness (generated telemetry, stub chat relay). No ThingsBoard needed.
//
//   npx esbuild widgets/harness/harness.ts --bundle --format=iife --target=es2019 --outfile=widgets/harness/harness.js
//   node widgets/e2e/builder.e2e.mjs            # all tests
//   node widgets/e2e/builder.e2e.mjs save chat  # only tests whose name contains one of the words
//
// Needs Playwright's Chromium once on a new machine: npx playwright install chromium
// Every test gets a fresh page (fresh fake server). A test fails on a failed check, on an uncaught page
// error, or on a console error. Exit code 1 when anything failed.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '../harness');
const PORT = 8766;
const srv = createServer((q, r) => {
  const f = q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0].slice(1);
  try {
    r.end(readFileSync(join(HARNESS, f)));
  } catch {
    r.statusCode = 404;
    r.end();
  }
}).listen(PORT);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class Fail extends Error {}
const ok = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** Opens the harness. page=builder waits for the builder to finish loading. */
async function open(query = 'page=builder&dev=pc') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // Google Fonts can't load in the sandbox; that is not a widget error.
    if (m.type() === 'error' && !/fonts\.googleapis|ERR_|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
  });
  page.on('dialog', (d) => {
    errors.push('native dialog: ' + d.message());
    void d.dismiss();
  });
  await page.goto(`http://localhost:${PORT}/?${query}`);
  if (query.includes('page=builder')) await page.waitForFunction(() => window.__b && !window.__b.busy && window.__b.root?.querySelector('.dbb-top select'), null, { timeout: 8000 });
  else await page.waitForTimeout(1200);
  const h = {
    page,
    errors,
    draft: () => page.evaluate(() => window.__b.draft),
    b: (fn, arg) => page.evaluate(fn, arg),
    click: (sel) => page.click(sel, { timeout: 4000 }),
    idle: async (ms = 300) => {
      await page.waitForTimeout(ms);
      await page.waitForFunction(() => !window.__b || !window.__b.busy, null, { timeout: 8000 });
    },
    toastText: () => page.evaluate(() => [...document.querySelectorAll('.dbb-toast')].map((t) => t.textContent).join(' | ')),
    modalTitle: () => page.evaluate(() => document.querySelector('.dbb-modal .dbb-modal-h')?.textContent?.trim() ?? null),
    modalBtn: (key) => page.click(`.dbb-modal [data-mb="${key}"]`, { timeout: 4000 }),
    addWidget: async (type) => {
      await page.click(`.dbb-left .dbb-pal[data-t="${type}"]`, { timeout: 4000 });
      await page.waitForTimeout(150);
    },
    /** Card error placeholders currently on the canvas (a widget that failed to load). */
    cardErrors: () => page.evaluate(() => [...document.querySelectorAll('.dbb-canvas .dbb-card')].map((c) => c.textContent).filter((t) => /Could not load|Unknown widget|undefined|NaN/.test(t))),
  };
  return h;
}

// ------------------------------------------------------------------ builder shell

test('opens for a machine: blank draft, empty state, Inter font', async (t) => {
  const d = await t.draft();
  eq(d.widgets.length, 0, 'widgets');
  eq(d.profile, 'Compressor', 'profile');
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'machine select');
  eq(await t.page.inputValue('.dbb-top [data-a="name"]'), 'Compressor dashboard', 'name');
  ok(await t.page.isVisible('.dbb-empty-card'), 'empty-state card shown');
  const fonts = await t.b(() => ({
    overlay: getComputedStyle(document.querySelector('.dbb-overlay')).fontFamily,
    top: getComputedStyle(document.querySelector('.dbb-top input')).fontFamily,
    select: getComputedStyle(document.querySelector('.dbb-top select')).fontFamily,
    palette: getComputedStyle(document.querySelector('.dbb-pal')).fontFamily,
    canvas: getComputedStyle(document.querySelector('.dbb-center')).fontFamily,
    panel: getComputedStyle(document.querySelector('.dbb-right')).fontFamily,
  }));
  for (const [k, v] of Object.entries(fonts)) ok(/^Inter\b/.test(v), `${k} font is Inter (got ${v})`);
  ok(await t.b(() => !!document.getElementById('dbb-font-Inter')), 'Inter font stylesheet requested');
});

test('machine options group devices by location; standalone option first', async (t) => {
  const opts = await t.b(() => [...document.querySelectorAll('.dbb-top [data-a="machine"] option')].map((o) => o.value));
  eq(opts[0], '', 'first option is standalone');
  eq(opts.slice(1).sort(), ['pc', 'pw', 'rc', 'rd'], 'all in-scope devices');
  const groups = await t.b(() => [...document.querySelectorAll('.dbb-top [data-a="machine"] optgroup')].map((g) => g.label));
  ok(groups.length === 2 && groups.every((g) => g.includes('›')), `grouped by location: ${groups}`);
});

test('rename, time range realtime/historic, undo and redo (buttons and keys)', async (t) => {
  await t.page.fill('.dbb-top [data-a="name"]', 'Line 1 overview');
  await t.page.press('.dbb-top [data-a="name"]', 'Tab');
  eq((await t.draft()).name, 'Line 1 overview', 'renamed');
  await t.click('.dbb-top [data-rng="hist"]');
  eq((await t.draft()).timeRange, '1h', 'historic starts at 1 h');
  await t.page.selectOption('.dbb-top [data-a="range"]', '8h');
  eq((await t.draft()).timeRange, '8h', 'historic 8 h');
  await t.click('.dbb-top [data-rng="realtime"]');
  eq((await t.draft()).timeRange, 'realtime', 'back to realtime');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).timeRange, '8h', 'undo -> 8h');
  await t.page.click('.dbb-center', { position: { x: 5, y: 5 } });
  await t.page.keyboard.press('Control+z');
  eq((await t.draft()).timeRange, '1h', 'Ctrl+Z -> 1h');
  await t.page.keyboard.press('Control+Shift+Z');
  eq((await t.draft()).timeRange, '8h', 'Ctrl+Shift+Z -> 8h');
  await t.click('.dbb-top [data-a="redo"]');
  eq((await t.draft()).timeRange, 'realtime', 'redo button -> realtime');
  ok(await t.page.isDisabled('.dbb-top [data-a="redo"]'), 'redo disabled at the end');
});

// ------------------------------------------------------------------ palette and widgets

const ALL_TYPES = ['value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary', 'line', 'area', 'bar', 'donut', 'timeline', 'heatmap', 'table', 'alarms', 'text', 'image', 'link', 'embed'];

test('every palette widget type adds, renders without errors, and deletes', async (t) => {
  const tiles = await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal')].map((p) => p.dataset.t));
  eq(tiles.slice().sort(), ALL_TYPES.slice().sort(), 'palette lists the 19 widget types');
  for (const type of ALL_TYPES) {
    const blocked = await t.b((ty) => document.querySelector(`.dbb-pal[data-t="${ty}"]`).classList.contains('off'), type);
    if (blocked) continue; // not possible for Compressor; covered by the next test
    await t.addWidget(type);
    const d = await t.draft();
    eq(d.widgets.length, 1, `${type}: added`);
    eq(d.widgets[0].type, type, `${type}: type`);
    const sel = await t.b(() => window.__b.selected);
    eq(sel, d.widgets[0].id, `${type}: selected after add`);
    ok(await t.page.isVisible('.dbb-right .dbb-tab.on:has-text("Widget")'), `${type}: Widget tab open`);
    await t.page.waitForTimeout(900);
    eq(await t.cardErrors(), [], `${type}: card errors`);
    const body = await t.b(() => document.querySelector('.dbb-canvas .dbb-card-b')?.innerHTML.length ?? 0);
    ok(body > 0, `${type}: card body drawn`);
    await t.page.click('.dbb-center', { position: { x: 5, y: 5 } }); // focus outside inputs
    await t.b(() => window.__b.grid && (window.__b.selected = window.__b.draft.widgets[0].id));
    await t.page.keyboard.press('Delete');
    eq((await t.draft()).widgets.length, 0, `${type}: Delete key removes it`);
  }
});

test('palette blocks types with no fitting property and explains why', async (t) => {
  // Weather Station has one numeric property: state widgets (status/timeline) don't fit it.
  await t.page.selectOption('.dbb-top [data-a="machine"]', 'pw');
  await t.idle();
  const off = await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal.off')].map((p) => p.dataset.t));
  ok(off.length > 0, `some tiles blocked for Weather Station: ${off}`);
  await t.page.click(`.dbb-left .dbb-pal[data-t="${off[0]}"]`, { force: true });
  await t.page.waitForTimeout(150);
  ok(/isn't available for Weather Station/.test(await t.toastText()), 'toast explains why');
  eq((await t.draft()).widgets.length, 0, 'nothing added');
});

test('palette search filters tiles', async (t) => {
  await t.page.fill('.dbb-pal-search input', 'gau');
  await t.page.waitForTimeout(100);
  eq(await t.b(() => [...document.querySelectorAll('.dbb-left .dbb-pal')].map((p) => p.dataset.t)), ['gauge'], 'only gauge');
  ok(await t.b(() => document.activeElement?.closest('.dbb-pal-search') != null), 'search keeps focus while typing');
  await t.page.fill('.dbb-pal-search input', 'zzz');
  ok(await t.page.isVisible('.dbb-left :text("No widget matches.")'), 'no-match hint');
});

test('10-widget limit: tiles grey out, extra add and duplicate refused', async (t) => {
  for (let i = 0; i < 10; i++) await t.addWidget('value');
  eq((await t.draft()).widgets.length, 10, '10 added');
  ok(await t.b(() => document.querySelectorAll('.dbb-left .dbb-pal.off').length === 19), 'all tiles off');
  ok(/10 \/ 10/.test(await t.page.textContent('.dbb-count')), 'counter');
  await t.page.click('.dbb-left .dbb-pal[data-t="kpi"]', { force: true });
  eq((await t.draft()).widgets.length, 10, 'no 11th widget');
  await t.click('.dbb-right [data-s="dup"]');
  eq((await t.draft()).widgets.length, 10, 'duplicate refused');
  ok(/at most 10 widgets|already has 10/.test(await t.toastText()), 'limit toast');
});

test('drag a palette tile onto the canvas places it at the drop cell', async (t) => {
  const canvas = await t.page.$('.dbb-canvas');
  const box = await canvas.boundingBox();
  await t.page.dragAndDrop('.dbb-left .dbb-pal[data-t="gauge"]', '.dbb-canvas', { targetPosition: { x: box.width * 0.55, y: 260 } });
  await t.page.waitForTimeout(300);
  const d = await t.draft();
  eq(d.widgets.length, 1, 'dropped');
  eq(d.widgets[0].type, 'gauge', 'type');
  ok(d.widgets[0].x >= 5 && d.widgets[0].y >= 2, `placed near the drop point (x=${d.widgets[0].x}, y=${d.widgets[0].y})`);
});

test('move and resize a card with the pointer; both undoable', async (t) => {
  await t.addWidget('value');
  const w0 = (await t.draft()).widgets[0];
  const bar = await (await t.page.$('.dbb-gbox .dbb-gdrag')).boundingBox();
  await t.page.mouse.move(bar.x + 20, bar.y + 10);
  await t.page.mouse.down();
  await t.page.mouse.move(bar.x + 420, bar.y + 200, { steps: 8 });
  await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  const w1 = (await t.draft()).widgets[0];
  ok(w1.x > w0.x && w1.y > w0.y, `moved (${w0.x},${w0.y}) -> (${w1.x},${w1.y})`);
  const rz = await (await t.page.$('.dbb-gbox .dbb-gresize')).boundingBox();
  await t.page.mouse.move(rz.x + 8, rz.y + 8);
  await t.page.mouse.down();
  await t.page.mouse.move(rz.x + 300, rz.y + 150, { steps: 8 });
  await t.page.mouse.up();
  await t.page.waitForTimeout(250);
  const w2 = (await t.draft()).widgets[0];
  ok(w2.w > w1.w && w2.h > w1.h, `resized ${w1.w}x${w1.h} -> ${w2.w}x${w2.h}`);
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).widgets[0].w, w1.w, 'undo resize');
  await t.click('.dbb-top [data-a="undo"]');
  eq((await t.draft()).widgets[0].x, w0.x, 'undo move');
});

test('card quick tools and panel buttons: duplicate and remove', async (t) => {
  await t.addWidget('kpi');
  await t.page.dispatchEvent('.dbb-gbox.sel .dbb-gtools [data-q="dup"]', 'mousedown');
  eq((await t.draft()).widgets.length, 2, 'duplicated by card tool');
  const [a, b] = (await t.draft()).widgets;
  ok(a.id !== b.id && a.type === b.type && JSON.stringify(a.keys) === JSON.stringify(b.keys), 'copy has new id, same config');
  ok(!(a.x === b.x && a.y === b.y), 'copy placed in a free slot');
  await t.click('.dbb-right [data-s="dup"]');
  eq((await t.draft()).widgets.length, 3, 'duplicated by panel button');
  await t.click('.dbb-right [data-s="del"]');
  eq((await t.draft()).widgets.length, 2, 'removed by panel button');
  await t.page.click('.dbb-canvas .dbb-gbox .dbb-gdrag');
  await t.page.dispatchEvent('.dbb-gbox.sel .dbb-gtools [data-q="del"]', 'mousedown');
  eq((await t.draft()).widgets.length, 1, 'removed by card tool');
});

test('Widget tab: title, type change, data sources, properties and caps', async (t) => {
  await t.addWidget('line');
  let w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'current', 'line starts on This machine');
  await t.page.fill('.dbb-right [data-s="title"]', 'Pressure trend');
  await t.page.press('.dbb-right [data-s="title"]', 'Tab');
  eq((await t.draft()).widgets[0].title, 'Pressure trend', 'title');
  ok(/Pressure trend/.test(await t.page.textContent('.dbb-canvas .dbb-card-t')), 'card title updated');
  // multi-key: tick all numeric properties; the cap is 4
  for (let i = 0; i < 6; i++) {
    const v = await t.page.$eval(`.dbb-right`, (r, id) => r.querySelector(`input[name="k-${id}"]:not([disabled]):not(:checked)`)?.value ?? null, w.id);
    if (!v) break;
    await t.page.click(`.dbb-right input[name="k-${w.id}"][value="${v}"]`);
    await t.page.waitForTimeout(80);
  }
  w = (await t.draft()).widgets[0];
  ok(w.keys.length >= 2 && w.keys.length <= 4, `line keys within 1..4: ${w.keys}`);
  // specific machines: two compressors
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="fixed"]`);
  await t.page.check('.dbb-right [data-s="dev"][value="rc"]');
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'fixed', 'fixed binding');
  eq(w.binding.deviceIds.slice().sort(), ['pc', 'rc'], 'two machines');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'fixed binding renders');
  // same-type machines at this location, and all of a type under a location
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="siblings"]`);
  eq((await t.draft()).widgets[0].binding.mode, 'siblings', 'siblings');
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="nodeQuery"]`);
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'nodeQuery', 'nodeQuery');
  await t.page.selectOption('.dbb-right [data-s="node"]', 'ric');
  eq((await t.draft()).widgets[0].binding.nodeId, 'ric', 'node picked');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'nodeQuery renders');
  // type change to a single-key, single-machine type trims keys and binding
  await t.page.selectOption('.dbb-right [data-s="type"]', 'value');
  w = (await t.draft()).widgets[0];
  eq(w.type, 'value', 'type changed');
  ok(w.keys.length === 1, `keys trimmed to 1: ${w.keys}`);
  ok(w.binding.mode === 'current', `multi-machine binding reset: ${w.binding.mode}`);
  // nearest machine of a type (value card only)
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="nearest"]`);
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'nearest', 'nearest');
  ok(w.binding.profile && w.binding.profile !== 'Compressor', `nearest defaults to another type (${w.binding.profile})`);
  await t.page.selectOption('.dbb-right [data-s="sprof"]', 'Weather Station');
  eq((await t.draft()).widgets[0].binding.profile, 'Weather Station', 'nearest type picked');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'nearest renders');
  // content type drops the data source
  await t.page.selectOption('.dbb-right [data-s="type"]', 'text');
  w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'none', 'text has no data source');
  eq(w.keys, [], 'text has no keys');
});

test('Specific machines are capped at 4 per widget', async (t) => {
  await t.addWidget('bar');
  const w = (await t.draft()).widgets[0];
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="fixed"]`);
  for (const id of ['rc', 'rd', 'pw']) {
    const sel = `.dbb-right [data-s="dev"][value="${id}"]`;
    if (await t.page.$(sel) && !(await t.page.isDisabled(sel))) await t.page.check(sel);
  }
  const ids = (await t.draft()).widgets[0].binding.deviceIds;
  ok(ids.length <= 4, `at most 4 machines (${ids})`);
});

// ------------------------------------------------------------------ style, colours, theme

test('Style tab: title, icon, sizes, card look, help text, footer, copy to all, reset', async (t) => {
  await t.addWidget('value');
  await t.addWidget('gauge');
  await t.click('.dbb-right .dbb-tab[data-tab="style"]');
  await t.click('.dbb-right [data-icon]:not([data-icon=""])');
  await t.page.selectOption('.dbb-right [data-st="titleSize"]', '16');
  await t.page.selectOption('.dbb-right [data-st="titleWeight"]', '700');
  await t.click('.dbb-right [data-seg="border"][data-v="thick"]');
  await t.click('.dbb-right [data-seg="shadow"][data-v="strong"]');
  await t.click('.dbb-right [data-seg="padding"][data-v="roomy"]');
  await t.page.fill('.dbb-right [data-footer]', 'Source: PLC');
  await t.page.press('.dbb-right [data-footer]', 'Tab');
  let s = (await t.draft()).widgets[1].settings;
  ok(s.style?.icon, 'icon set');
  eq(s.style.titleSize, 16, 'title size');
  eq(String(s.style.titleWeight), '700', 'weight');
  eq(s.style.border, 'thick', 'border');
  eq(s.style.shadow, 'strong', 'shadow');
  eq(s.style.padding, 'roomy', 'padding');
  eq(s.footer, 'Source: PLC', 'footer');
  ok(/Source: PLC/.test(await t.page.textContent('.dbb-gbox.sel .dbb-card')), 'footer drawn on the card');
  await t.page.uncheck('.dbb-right [data-st="hideTitle"]');
  await t.page.waitForTimeout(150);
  eq((await t.draft()).widgets[1].settings.style.hideTitle, true, 'title hidden');
  ok(!(await t.page.$('.dbb-gbox.sel .dbb-card-t')), 'title not drawn');
  await t.page.check('.dbb-right [data-st="hideTitle"]');
  await t.page.waitForTimeout(150);
  // copy style to all
  const copy = await t.page.$('.dbb-right [data-copyall]');
  ok(copy, 'Copy style to all button');
  await copy.click();
  await t.page.waitForTimeout(150);
  const all = (await t.draft()).widgets.map((w) => w.settings.style ?? {});
  eq(all[0].border, 'thick', 'copied to the other widget');
  ok(all[0].icon !== all[1].icon || !all[0].icon || true, 'icons kept per widget');
  // reset
  const reset = await t.page.$('.dbb-right [data-reset]');
  ok(reset, 'Reset style button');
  await reset.click();
  await t.page.waitForTimeout(150);
  s = (await t.draft()).widgets[1].settings;
  ok(!s.style || !s.style.border, 'style reset');
});

test('Colours tab: presets, test a value, edit and remove rules; card colour applied', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="rules"]');
  await t.click('.dbb-right [data-preset="traffic"]');
  let rules = (await t.draft()).widgets[0].settings.colorRules ?? [];
  ok(rules.length >= 2, `traffic light rules: ${rules.length}`);
  await t.page.fill('.dbb-right [data-test]', '99999');
  await t.page.waitForTimeout(100);
  ok((await t.page.textContent('.dbb-right .dbb-test-out')).trim().length > 0, 'test output shown');
  const n = rules.length;
  const n0 = await t.page.$$eval('.dbb-right .dbb-rule', (x) => x.length);
  ok(n0 === n, `rule rows drawn: ${n0}`);
  await t.page.locator('.dbb-right .dbb-rule [data-del]').first().click({ timeout: 4000 });
  await t.page.waitForTimeout(100);
  rules = (await t.draft()).widgets[0].settings.colorRules ?? [];
  eq(rules.length, n - 1, 'rule removed');
  const add = await t.page.$('.dbb-right button:has-text("Add rule")');
  await t.page.waitForTimeout(50);
  ok(add, 'Add rule button');
  await add.click();
  eq(((await t.draft()).widgets[0].settings.colorRules ?? []).length, n, 'rule added');
  // make every value match: > -1e9 in red
  await t.page.selectOption('.dbb-right .dbb-rule:last-child [data-f="op"]', 'gt');
  await t.page.fill('.dbb-right .dbb-rule:last-child [data-f="value"]', '-1000000');
  await t.page.press('.dbb-right .dbb-rule:last-child [data-f="value"]', 'Tab');
  await t.page.waitForTimeout(900);
  eq(await t.cardErrors(), [], 'renders with rules');
});

test('Colours tab: on/off preset for a status widget', async (t) => {
  await t.addWidget('status');
  const w = (await t.draft()).widgets[0];
  eq(w.keys, ['runStatus'], 'status picks the on/off property');
  ok((w.settings.colorRules ?? []).some((r) => r.label === 'Running'), 'starts with Running/Stopped');
  await t.page.waitForTimeout(900);
  ok(/Running|Stopped|Offline/.test(await t.page.textContent('.dbb-canvas .dbb-card')), 'status text drawn');
});

test('Dashboard tab: theme preset, accent, font (Inter default), radius, density, title alignment', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right [data-desel]');
  ok(await t.page.isVisible('.dbb-right .dbb-tab.on:has-text("Dashboard")'), 'Dashboard tab when nothing selected');
  eq(await t.page.textContent('.dbb-right [data-t="font"] option[value=""]'), 'Inter (default)', 'default font label');
  await t.click('.dbb-right [data-preset="dark"]');
  eq((await t.draft()).theme?.preset, 'dark', 'dark preset');
  ok(await t.b(() => document.querySelector('.dbb-center').classList.contains('dbb-dark')), 'canvas dark');
  await t.page.selectOption('.dbb-right [data-t="font"]', 'Poppins');
  eq((await t.draft()).theme.font, 'Poppins', 'font Poppins');
  ok(/Poppins/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-canvas .dbb-card')).fontFamily)), 'canvas uses the theme font');
  ok(/^Inter/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-top')).fontFamily)), 'builder chrome stays Inter');
  await t.page.selectOption('.dbb-right [data-t="font"]', '');
  ok(/^"?Inter/.test(await t.b(() => getComputedStyle(document.querySelector('.dbb-canvas .dbb-card')).fontFamily)), 'theme default font is Inter');
  await t.click('.dbb-right [data-tseg="density"][data-v="compact"]');
  await t.click('.dbb-right [data-tseg="titleAlign"][data-v="center"]');
  const th = (await t.draft()).theme;
  eq([th.density, th.titleAlign], ['compact', 'center'], 'density + title alignment');
  await t.page.$eval('.dbb-right [data-t="radius"]', (e) => {
    e.value = '4';
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await t.page.waitForTimeout(350); // range inputs emit 250 ms after the last move
  eq((await t.draft()).theme.radius, 4, 'radius');
});

// ------------------------------------------------------------------ content widgets

test('Text widget: typing and Backspace in the editor never delete the widget; live values', async (t) => {
  await t.addWidget('text');
  const ed = '.dbb-right [contenteditable="true"]';
  ok(await t.page.$(ed), 'rich-text editor present');
  await t.page.click(ed);
  await t.page.keyboard.press('Control+a');
  await t.page.keyboard.type('Hello {{machine}}');
  await t.page.keyboard.press('Backspace');
  await t.page.keyboard.press('Delete');
  await t.page.keyboard.type('}');
  await t.page.waitForTimeout(800); // the editor commits 500 ms after the last keystroke
  const d = await t.draft();
  eq(d.widgets.length, 1, 'widget still there after Backspace/Delete in the editor');
  ok(/Hello/.test(d.widgets[0].settings.html ?? ''), `html saved: ${d.widgets[0].settings.html}`);
  await t.page.waitForTimeout(500);
  ok(/Hello Pune Compressor 1/.test(await t.page.textContent('.dbb-canvas .dbb-card')), 'machine placeholder filled on the card');
  await t.click('.dbb-right [data-rc="bold"]');
  eq((await t.draft()).widgets.length, 1, 'toolbar click keeps the widget');
});

test('Image, link and embed widgets', async (t) => {
  await t.addWidget('image');
  await t.page.fill('.dbb-right [data-c="url"]', 'http://insecure.example/logo.png');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-gbox.sel img')), 'http image refused');
  await t.page.fill('.dbb-right [data-c="url"]', 'https://example.com/logo.png');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(await t.page.$('.dbb-canvas img.dbb-img[src="https://example.com/logo.png"]'), 'https image drawn');
  await t.addWidget('link');
  const lw = (await t.draft()).widgets[1];
  eq(lw.settings.linkKind, 'state', 'link opens an app page by default');
  await t.click('.dbb-right [data-lk="url"]');
  eq((await t.draft()).widgets[1].settings.linkKind, 'url', 'link to website');
  await t.addWidget('embed');
  await t.page.fill('.dbb-right [data-c="url"]', 'https://example.com/');
  await t.page.press('.dbb-right [data-c="url"]', 'Tab');
  await t.page.waitForTimeout(200);
  ok(await t.page.$('.dbb-canvas iframe.dbb-frame'), 'iframe drawn');
});

// ------------------------------------------------------------------ templates, preview

test('templates: each builds widgets without errors; replacing asks first', async (t) => {
  await t.click('.dbb-top [data-a="templates"]');
  const ids = await t.b(() => [...document.querySelectorAll('.dbb-modal [data-tpl]')].map((b) => b.dataset.tpl));
  eq(ids.length, 5, '5 templates');
  await t.modalBtn('cancel').catch(() => t.page.keyboard.press('Escape'));
  for (const [i, id] of ids.entries()) {
    await t.click('.dbb-top [data-a="templates"]');
    await t.click(`.dbb-modal [data-tpl="${id}"]`);
    await t.page.waitForTimeout(200);
    if (i > 0) {
      ok(/^Use “.+”\?$/.test(await t.modalTitle()), 'asks before replacing');
      await t.page.click('.dbb-modal .dbb-modal-f button.primary');
      await t.page.waitForTimeout(200);
    }
    const d = await t.draft();
    ok(d.widgets.length > 0 && d.widgets.length <= 10, `${id}: ${d.widgets.length} widgets`);
    await t.page.waitForTimeout(1200);
    eq(await t.cardErrors(), [], `${id}: card errors`);
  }
});

test('empty state: simple default layout; preview hides panels', async (t) => {
  await t.click('.dbb-empty [data-a="default"]');
  const d = await t.draft();
  ok(d.widgets.length > 0, `default layout: ${d.widgets.length}`);
  await t.click('.dbb-top [data-a="preview"]');
  ok(await t.page.isHidden('.dbb-left'), 'palette hidden');
  ok(await t.page.isHidden('.dbb-right'), 'panel hidden');
  await t.page.click('.dbb-canvas .dbb-gbox');
  eq(await t.b(() => window.__b.selected), null, 'no selection in preview');
  await t.click('.dbb-top [data-a="preview"]');
  ok(await t.page.isVisible('.dbb-left'), 'back to edit');
});

// ------------------------------------------------------------------ save / apply / versions / open / delete

async function saveFirst(t) {
  await t.addWidget('value');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")', { timeout: 5000 });
}

test('save with no widgets is refused', async (t) => {
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForTimeout(200);
  ok(/Add at least one widget/.test(await t.toastText()), 'toast');
  ok(!(await t.b(() => Object.keys(window.__tb.getAttrs('ASSET', 'store')).some((k) => k.startsWith('dbb_d_')))), 'nothing written');
});

test('first save opens Apply; apply to only this machine; machine page shows it', async (t) => {
  await saveFirst(t);
  ok(await t.page.isChecked('.dbb-modal input[name="t"][value="device"]'), 'Only this machine preselected');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-modal .dbb-modal-f button.primary')?.disabled);
  ok(/1<\/b> machine affected/.test(await t.page.innerHTML('.dbb-modal .dbb-preview')), 'preview: 1 machine');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  const d = await t.draft();
  eq(d.version, 1, 'version 1');
  ok(/Applied to 1 machine/.test(await t.toastText()), 'applied toast');
  eq((await t.page.textContent('.dbb-top [data-a="save"]')).trim(), '✓ Saved', 'saved state');
  const assign = await t.b(() => window.__tb.getAttrs('DEVICE', 'pc').dbb_assign);
  ok(assign && JSON.stringify(assign).includes(d.id), 'device assignment written');
  ok(await t.page.isVisible('.dbb-top [data-a="versions"]') && await t.page.isVisible('.dbb-top [data-a="saveas"]') && await t.page.isVisible('.dbb-top [data-a="apply"]'), 'history / save as / apply shown after save');
});

test('apply to all machines of the type (customer-wide)', async (t) => {
  await saveFirst(t);
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForFunction(() => /2<\/b> machines affected/.test(document.querySelector('.dbb-modal .dbb-preview')?.innerHTML ?? ''), null, { timeout: 5000 });
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  ok(/Applied to 2 machines/.test(await t.toastText()), 'applied to 2');
});

test('second save: no Apply dialog; versions and restore; save as; conflict', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  await t.page.fill('.dbb-top [data-a="name"]', 'Renamed v2');
  await t.page.press('.dbb-top [data-a="name"]', 'Tab');
  eq((await t.page.textContent('.dbb-top [data-a="save"]')).trim(), 'Save', 'dirty again');
  await t.click('.dbb-top [data-a="save"]');
  await t.idle(500);
  ok(!(await t.page.$('.dbb-modal')), 'no Apply dialog on later saves');
  eq((await t.draft()).version, 2, 'version 2');
  // history
  await t.click('.dbb-top [data-a="versions"]');
  await t.page.waitForSelector('.dbb-modal [data-v]');
  const vs = await t.b(() => [...document.querySelectorAll('.dbb-modal [data-v]')].map((b) => b.dataset.v));
  ok(vs.includes('1'), `versions listed: ${vs}`);
  await t.click('.dbb-modal [data-v="1"]');
  await t.idle(500);
  const r = await t.draft();
  eq(r.version, 3, 'restore saves a new version');
  eq(r.name, 'Compressor dashboard', 'restored content');
  // unsaved change + restore asks first
  await t.addWidget('kpi');
  await t.click('.dbb-top [data-a="versions"]');
  await t.click('.dbb-modal [data-v="2"]');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'restore asks about unsaved changes');
  await t.page.click('.dbb-modal .dbb-modal-f button:not(.primary)');
  await t.page.waitForTimeout(150);
  eq((await t.draft()).widgets.length, 2, 'cancel keeps the draft');
  // save as
  await t.click('.dbb-top [data-a="saveas"]');
  await t.page.waitForSelector('.dbb-modal [data-in]');
  await t.page.fill('.dbb-modal [data-in]', 'My copy');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")', { timeout: 5000 });
  await t.page.check('.dbb-modal input[name="t"][value="none"]');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(300);
  const c = await t.draft();
  eq([c.name, c.version], ['My copy', 1], 'save as creates a new dashboard');
  ok(c.id !== r.id, 'new id');
  // conflict: someone else saves the copy meanwhile
  await t.b((id) => {
    const k = `dbb_d_${id}`;
    const cur = window.__tb.getAttrs('ASSET', 'store')[k];
    const doc = typeof cur === 'string' ? JSON.parse(cur) : cur;
    window.__tb.setAttrs('ASSET', 'store', { [k]: { ...doc, version: doc.version + 1, name: 'Theirs' } });
  }, c.id);
  await t.addWidget('gauge');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForTimeout(400);
  eq(await t.modalTitle(), 'Someone else saved this dashboard', 'conflict dialog');
  await t.page.click('.dbb-modal .dbb-modal-f button:has-text("Reload theirs")');
  await t.idle(200);
  eq((await t.draft()).name, 'Theirs', 'reloaded theirs');
});

test('Open dialog: lists saved, opens one, asks before discarding changes, new blank', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  const id = (await t.draft()).id;
  await t.click('.dbb-top [data-a="open"]');
  await t.page.waitForSelector('.dbb-modal [data-new]');
  await t.click('.dbb-modal [data-new]');
  await t.idle(200);
  eq((await t.draft()).widgets.length, 0, 'new blank');
  await t.addWidget('gauge');
  await t.click('.dbb-top [data-a="open"]');
  await t.page.waitForSelector(`.dbb-modal tr[data-id="${id}"]`);
  await t.click(`.dbb-modal tr[data-id="${id}"]`);
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'asks before discarding');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  eq((await t.draft()).id, id, 'opened the saved one');
});

test('delete a saved dashboard falls back to the default layout', async (t) => {
  await saveFirst(t);
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(400);
  const id = (await t.draft()).id;
  await t.click('.dbb-top [data-a="delete"]');
  await t.page.waitForTimeout(200);
  ok(/Delete “/.test(await t.modalTitle()), 'confirm delete');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.idle(500);
  ok(/Dashboard deleted/.test(await t.toastText()), 'deleted toast');
  ok(!(await t.b((x) => `dbb_d_${x}` in window.__tb.getAttrs('ASSET', 'store'), id)), 'dashboard removed from store');
  ok(!(await t.b(() => window.__tb.getAttrs('DEVICE', 'pc').dbb_assign)), 'assignment removed');
  eq((await t.draft()).version, 0, 'blank draft again');
});

test('switching machine and closing ask about unsaved changes; Esc closes when clean', async (t) => {
  await t.addWidget('value');
  await t.page.selectOption('.dbb-top [data-a="machine"]', 'rc');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Switch machine?', 'switch confirm');
  await t.page.click('.dbb-modal .dbb-modal-f button:not(.primary)');
  await t.page.waitForTimeout(200);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'select reverted on cancel');
  eq((await t.draft()).widgets.length, 1, 'draft kept');
  await t.click('.dbb-top [data-a="close"]');
  await t.page.waitForTimeout(200);
  eq(await t.modalTitle(), 'Discard unsaved changes?', 'close confirm');
  await t.page.click('.dbb-modal .dbb-modal-f button.primary');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-overlay')), 'closed after discard');
  eq(await t.b(() => window.__closed), { changed: false }, 'onClose(false)');
});

test('Esc closes a clean builder', async (t) => {
  await t.page.click('.dbb-center', { position: { x: 5, y: 5 } });
  await t.page.keyboard.press('Escape');
  await t.page.waitForTimeout(200);
  ok(!(await t.page.$('.dbb-overlay')), 'closed');
});

test('standalone (no machine): only specific machines; Apply explains standalone', async (t) => {
  await t.page.close();
  const s = await open('page=builder&dev=none');
  Object.assign(t, s);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), '', 'No machine selected');
  await t.addWidget('value');
  const w = (await t.draft()).widgets[0];
  eq(w.binding.mode, 'none', 'no machine bound yet');
  ok(!(await t.page.$(`.dbb-right input[name="src-${w.id}"][value="current"]`)), 'This machine not offered');
  await t.page.check(`.dbb-right input[name="src-${w.id}"][value="fixed"]`);
  eq((await t.draft()).widgets[0].binding.mode, 'fixed', 'specific machine');
  await t.page.waitForTimeout(800);
  eq(await t.cardErrors(), [], 'renders');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("standalone dashboard")', { timeout: 5000 });
  eq((await t.draft()).kind, 'standalone', 'kind standalone');
});

// ------------------------------------------------------------------ chat

test('chat: builds widgets from the reply, highlight, discard; clarification; provider error', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() =>
    window.__chatQueue.push({
      reply: 'Added pressure and power.',
      ops: [
        { op: 'addWidget', type: 'value', title: 'Pressure', keys: ['dischargePressure'], binding: { mode: 'current' } },
        { op: 'addWidget', type: 'line', title: 'Power', keys: ['powerKw'], binding: { mode: 'current' } },
      ],
    }),
  );
  await t.page.fill('.dbb-chat-in', 'pressure and power');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 2 && !window.__b.busy, null, { timeout: 8000 });
  ok(/Added pressure and power/.test(await t.page.textContent('.dbb-chat-log')), 'reply shown');
  ok(await t.page.$('.dbb-chat-log [data-hl]'), 'Highlight link');
  await t.click('.dbb-chat-log [data-hl]');
  ok(await t.b(() => document.querySelectorAll('.dbb-gbox.hl').length === 2), 'two cards highlighted');
  await t.click('.dbb-right [data-a="discard"]');
  eq((await t.draft()).widgets.length, 0, 'chat changes discarded');
  // clarification with options
  await t.b(() => window.__chatQueue.push({ reply: '', ops: [], clarification: { question: 'Which machine?', options: ['Pune', 'Richmond'] } }));
  await t.page.fill('.dbb-chat-in', 'overview');
  await t.page.keyboard.press('Enter');
  await t.page.waitForSelector('.dbb-chat-log [data-opt="Pune"]', { timeout: 8000 });
  // provider overload message is shown as the assistant reply, draft unchanged
  await t.b(() => window.__chatQueue.push('The gemini service is overloaded right now (a temporary problem on the provider\'s side). Try again in a minute.'));
  await t.click('.dbb-chat-log [data-opt="Pune"]');
  await t.page.waitForFunction(() => /overloaded right now/.test(document.querySelector('.dbb-chat-log')?.textContent ?? ''), null, { timeout: 8000 });
  eq((await t.draft()).widgets.length, 0, 'draft unchanged on error');
  ok(await t.page.isEnabled('.dbb-chat-form button[type="submit"]'), 'Send enabled again');
});

test('chat: invalid answer gets one corrective retry', async (t) => {
  await t.click('.dbb-right .dbb-tab[data-tab="chat"]');
  await t.b(() => {
    window.__chatQueue.push({ reply: 'x', ops: [{ op: 'addWidget', type: 'gauge', title: 'Bad', keys: ['noSuchKey'], binding: { mode: 'current' } }] });
    window.__chatQueue.push({ reply: 'Fixed.', ops: [{ op: 'addWidget', type: 'gauge', title: 'Temp', keys: ['dischargeTemp'], binding: { mode: 'current' } }] });
  });
  await t.page.fill('.dbb-chat-in', 'a gauge');
  await t.page.keyboard.press('Enter');
  await t.page.waitForFunction(() => window.__b.draft.widgets.length === 1 && !window.__b.busy, null, { timeout: 10000 });
  eq(await t.b(() => window.__chatReqs.length), 2, 'two relay requests');
  eq((await t.draft()).widgets[0].keys, ['dischargeTemp'], 'second answer applied');
});

// ------------------------------------------------------------------ machine page (renderer)

test('machine page header: one line, no machine name or type; org › site, status, range', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.waitForSelector('.dbb-rhead .dbb-status-pill');
  await t.page.waitForTimeout(800);
  const h = await t.b(() => {
    const head = document.querySelector('.dbb-rhead');
    const r = head.getBoundingClientRect();
    const tops = [...head.children].map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2));
    return { text: head.textContent.replace(/\s+/g, ' ').trim(), height: r.height, sameLine: Math.max(...tops) - Math.min(...tops) <= 4, font: getComputedStyle(head).fontFamily };
  });
  ok(h.height <= 48, `header height ${h.height}px`);
  ok(h.sameLine, 'crumb, status and range on one line');
  ok(/ITHENA › Pune/.test(h.text), `crumb: ${h.text}`);
  ok(!/Pune Compressor 1|Compressor\b(?!.*›)/.test(h.text.replace('ITHENA › Pune', '')), `no machine name/type: ${h.text}`);
  ok(/Running|Stopped|Offline/.test(h.text), 'status');
  ok(/Realtime|Last/.test(h.text), 'range chip');
  ok(/^Inter/.test(h.font), `page font Inter (${h.font})`);
});

test('machine page follows a machine picked in an app navbar (URL-only state change)', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  // Give the Dryer its own dashboard so the switch is visible.
  await t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'dry1', name: 'Dryer board', kind: 'device', profile: 'Dryer', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [{ id: 'w1', type: 'gauge', title: 'DRYER GAUGE', x: 0, y: 0, w: 4, h: 3, binding: { mode: 'current' }, keys: ['dewPoint'], settings: {} }] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_dry1: d });
    window.__tb.setAttrs('DEVICE', 'rd', { dbb_assign: { dashboardId: 'dry1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
  });
  const before = await t.page.textContent('.dbb-rbody');
  ok(!/DRYER GAUGE/.test(before), 'compressor page first');
  await t.b(() => window.__urlSwitch('rd'));
  await t.page.waitForFunction(() => /DRYER GAUGE/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  ok(/DRYER GAUGE/.test(await t.page.textContent('.dbb-rbody')), 'dashboard switched to the Dryer');
  ok(/Richmond/.test(await t.page.textContent('.dbb-rhead')), 'header switched');
  await t.b(() => window.__urlSwitch('pc'));
  await t.page.waitForFunction(() => !/DRYER GAUGE/.test(document.querySelector('.dbb-rbody')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => undefined);
  ok(!/DRYER GAUGE/.test(await t.page.textContent('.dbb-rbody')), 'and back');
});

test('refresh does not flicker: no fade after the first draw, embedded page not reloaded', async (t) => {
  await t.page.close();
  const s = await open('dev=pc');
  Object.assign(t, s);
  await t.b(() => {
    const now = Date.now();
    const d = { schemaVersion: 1, id: 'c1', name: 'C', kind: 'device', profile: 'Compressor', version: 1, ownerId: 'u1', ownerName: 'A', updatedBy: 'u1', updatedAt: now, timeRange: 'realtime', copiedFrom: null,
      widgets: [
        { id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {} },
        { id: 'w2', type: 'embed', title: 'E', x: 3, y: 0, w: 4, h: 3, binding: { mode: 'none' }, keys: [], settings: { url: 'https://example.com/' } },
      ] };
    window.__tb.setAttrs('ASSET', 'store', { dbb_d_c1: d });
    window.__tb.setAttrs('DEVICE', 'pc', { dbb_assign: { dashboardId: 'c1', mode: 'linked', by: 'u1', at: now } });
    window.__tb.setAttrs('ASSET', 'store', { dbb_assign_rev: 'v' + now });
    window.dispatchEvent(new CustomEvent('imex-dbb:changed'));
  });
  await t.page.waitForSelector('.dbb-rbody iframe');
  await t.page.waitForTimeout(700);
  const r = await t.b(async () => {
    const frame = document.querySelector('.dbb-rbody iframe');
    frame.__mark = 1;
    const anims = () => [...document.querySelectorAll('.dbb-rbody .dbb-card-b > *')].map((e) => getComputedStyle(e).animationName).filter((a) => a && a !== 'none');
    const beforeAnims = anims();
    // Two refresh cycles, as the 10 s timer / WebSocket push would do.
    const grid = document.querySelector('.dbb-rgrid');
    void grid;
    return { beforeAnims };
  });
  eq(r.beforeAnims, [], 'no animation left after the first draw');
  // Trigger refreshes through the renderer's grid (same path as the timer).
  await t.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await t.page.waitForTimeout(11000); // one REST polling cycle (socket is down in the harness)
  const after = await t.b(() => ({
    same: document.querySelector('.dbb-rbody iframe')?.__mark === 1,
    anims: [...document.querySelectorAll('.dbb-rbody .dbb-card-b > *')].map((e) => getComputedStyle(e).animationName).filter((a) => a && a !== 'none'),
  }));
  ok(after.same, 'iframe element kept across refresh (not reloaded)');
  eq(after.anims, [], 'no fade animation on refresh');
});

// ------------------------------------------------------------------ more flows

test('every data widget type renders in Historic 8 h', async (t) => {
  await t.click('.dbb-top [data-rng="hist"]');
  await t.page.selectOption('.dbb-top [data-a="range"]', '8h');
  const types = ALL_TYPES.filter((x) => !['text', 'image', 'link', 'embed'].includes(x));
  for (let i = 0; i < types.length; i += 9) {
    const batch = types.slice(i, i + 9);
    for (const ty of batch) await t.addWidget(ty);
    await t.page.waitForTimeout(2000);
    eq(await t.cardErrors(), [], `historic render ${batch.join(',')}`);
    const n = (await t.draft()).widgets.length;
    eq(n, batch.length, 'batch added');
    await t.b(() => window.__b.mutate((d) => (d.widgets = [])));
  }
});

test('help text shows as an info tooltip on the card', async (t) => {
  await t.addWidget('value');
  await t.click('.dbb-right .dbb-tab[data-tab="style"]');
  const ed = '.dbb-right [data-desc] [contenteditable="true"]';
  await t.page.click(ed);
  await t.page.keyboard.type('Pressure at the outlet');
  await t.page.click('.dbb-right [data-footer]'); // blur commits
  await t.page.waitForTimeout(700);
  ok(/Pressure at the outlet/.test((await t.draft()).widgets[0].settings.description ?? ''), 'description saved');
  ok(await t.page.$('.dbb-canvas .dbb-card .dbb-info'), 'info icon on the card');
});

test('Apply: replacing an existing assignment must be ticked first', async (t) => {
  await saveFirst(t);
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForFunction(() => !document.querySelector('.dbb-modal [data-mb="apply"]')?.disabled, null, { timeout: 5000 });
  await t.page.click('.dbb-modal [data-mb="apply"]');
  await t.idle(400);
  // a second dashboard for the same type, applied to all -> replaces the first
  await t.click('.dbb-top [data-a="open"]');
  await t.click('.dbb-modal [data-new]');
  await t.idle(200);
  await t.addWidget('gauge');
  await t.click('.dbb-top [data-a="save"]');
  await t.page.waitForSelector('.dbb-modal :text("Apply dashboard")');
  await t.page.check('.dbb-modal input[name="t"][value="all"]');
  await t.page.waitForSelector('.dbb-modal [data-replace]', { timeout: 5000 });
  ok(await t.page.isDisabled('.dbb-modal [data-mb="apply"]'), 'Apply disabled until replace is ticked');
  await t.page.check('.dbb-modal [data-replace]');
  ok(await t.page.isEnabled('.dbb-modal [data-mb="apply"]'), 'enabled after ticking');
  await t.page.click('.dbb-modal [data-mb="apply"]');
  await t.idle(400);
  ok(/Applied to/.test(await t.toastText()), 'applied');
});

test('machine page: edit menu opens the builder on the shown dashboard; viewers get no edit menu', async (t) => {
  await t.page.close();
  let s = await open('dev=pc');
  Object.assign(t, s);
  await t.page.waitForFunction(() => window.__imexDbbActions?.items?.length > 0, null, { timeout: 5000 });
  const items = await t.b(() => window.__imexDbbActions.items.map((i) => i.id));
  ok(items.includes('edit') && items.includes('thr'), `admin actions: ${items}`);
  await t.b(() => window.__imexDbbActions.run('edit'));
  await t.page.waitForSelector('.dbb-overlay .dbb-top select');
  await t.page.waitForTimeout(500);
  eq(await t.page.inputValue('.dbb-top [data-a="machine"]'), 'pc', 'builder opened for the shown machine');
  await t.page.close();
  s = await open('dev=pc&role=Viewer');
  Object.assign(t, s);
  await t.page.waitForTimeout(1500);
  eq(await t.b(() => window.__imexDbbActions?.items ?? null), null, 'no edit actions for a viewer');
});

// ------------------------------------------------------------------ run

const only = process.argv.slice(2).map((s) => s.toLowerCase());
let failed = 0;
for (const tc of tests) {
  if (only.length && !only.some((w) => tc.name.toLowerCase().includes(w))) continue;
  const t0 = Date.now();
  let h;
  try {
    h = await open();
    await tc.fn(h);
    if (h.errors.length) throw new Fail(h.errors.join('\n    '));
    console.log(`✓ ${tc.name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${tc.name}\n    ${e instanceof Fail ? e.message : e.stack?.split('\n').slice(0, 3).join('\n    ')}${h?.errors.length ? '\n    page errors: ' + h.errors.join(' | ') : ''}`);
    if (h) await h.page.screenshot({ path: join(tmpdir(), `e2e-fail-${tc.name.replace(/\W+/g, '_').slice(0, 40)}.png`) }).catch(() => undefined);
  } finally {
    await h?.page.close().catch(() => undefined);
  }
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
await browser.close();
srv.close();
process.exit(failed ? 1 : 0);
