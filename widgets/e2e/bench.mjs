// Worst-case load test of the machine-dashboard widget (D-028), in a real Chromium against the fake ThingsBoard.
//
//   npx esbuild widgets/harness/harness.ts --bundle --format=iife --target=es2019 --outfile=widgets/harness/harness.js
//   node widgets/e2e/bench.mjs [tabs=5] [seconds=60]
//
// Opens the same 10-widget dashboard in N tabs (?bench=1: 40 machines, every widget at its maximum of machines and
// properties, and a fake WebSocket that pushes a new value for every subscribed key of every machine once per
// second). All tabs are visible (headless), which is worse than real browsers, which pause hidden tabs.
// Per tab it reports CPU busy time, script / layout / style time, heap, DOM nodes, long tasks (> 50 ms) and redraws.
// Exit code 1 if any tab exceeds the budgets below.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TABS = Number(process.argv[2] ?? 5);
const SECONDS = Number(process.argv[3] ?? 60);
// Budgets per tab in the steady state (headless Chromium, all tabs on one machine): average main-thread busy
// share, worst single task, heap growth over the run, DOM node growth.
const BUDGET = { busyPct: 25, longestTaskMs: 200, heapGrowthMB: 15, nodeGrowth: 2000 };

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '../harness');
const PORT = 8767;
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
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.addInitScript(() => {
  const w = window;
  w.__long = { n: 0, max: 0, total: 0 };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      w.__long.n++;
      w.__long.total += e.duration;
      w.__long.max = Math.max(w.__long.max, e.duration);
    }
  }).observe({ type: 'longtask', buffered: true });
  // count full redraws of the grid (every card body replaced or updated) via a MutationObserver on the page
  w.__mut = 0;
  addEventListener('DOMContentLoaded', () => new MutationObserver((m) => (w.__mut += m.length)).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }));
});

const pages = [];
const errors = [];
for (let i = 0; i < TABS; i++) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`tab ${i + 1}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.googleapis|ERR_|Failed to load resource/.test(m.text()) && errors.push(`tab ${i + 1}: ${m.text()}`));
  await page.goto(`http://localhost:${PORT}/?bench=1`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  pages.push({ page, cdp });
}
// warm-up: first load (REST history for 40 machines x 4 keys) and the first live pushes
await pages[0].page.waitForTimeout(12000);
const metrics = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const inPage = (page) => page.evaluate(() => ({ calls: window.__tb.calls.length, long: { ...window.__long }, mut: window.__mut, bench: { ...window.__bench }, cards: document.querySelectorAll('.dbb-card').length, errs: document.querySelectorAll('.dbb-card-err, .dbb-err').length }));
const firstLoad = await Promise.all(pages.map((p) => p.page.evaluate(() => Math.round(window.__long.max))));
// from here on, only the steady state counts (the first load of 40 machines' history is reported separately)
await Promise.all(pages.map((p) => p.page.evaluate(() => (window.__long.max = 0))));
const t0 = await Promise.all(pages.map(async (p) => ({ m: await metrics(p.cdp), x: await inPage(p.page) })));
await pages[0].page.waitForTimeout(SECONDS * 1000);
const t1 = await Promise.all(pages.map(async (p) => ({ m: await metrics(p.cdp), x: await inPage(p.page) })));

let fail = false;
const rows = t1.map((b, i) => {
  const a = t0[i];
  const d = (k) => b.m[k] - a.m[k];
  const r = {
    tab: i + 1,
    cards: b.x.cards,
    'busy %': +((d('TaskDuration') / SECONDS) * 100).toFixed(1),
    'script s': +d('ScriptDuration').toFixed(2),
    'layout s': +d('LayoutDuration').toFixed(2),
    'style s': +d('RecalcStyleDuration').toFixed(2),
    'heap MB': +(b.m.JSHeapUsedSize / 1048576).toFixed(1),
    'heap Δ MB': +((b.m.JSHeapUsedSize - a.m.JSHeapUsedSize) / 1048576).toFixed(1),
    nodes: b.m.Nodes,
    'nodes Δ': b.m.Nodes - a.m.Nodes,
    'long tasks': b.x.long.n - a.x.long.n,
    'longest ms': Math.round(b.x.long.max),
    'first load longest ms': firstLoad[i],
    'values pushed': b.x.bench.values - a.x.bench.values,
    'REST calls/min': Math.round(((b.x.calls - a.x.calls) / SECONDS) * 60),
    'DOM mutations/s': Math.round((b.x.mut - a.x.mut) / SECONDS),
  };
  const bad = r['busy %'] > BUDGET.busyPct || r['longest ms'] > BUDGET.longestTaskMs || r['heap Δ MB'] > BUDGET.heapGrowthMB || r['nodes Δ'] > BUDGET.nodeGrowth || b.x.errs > 0;
  if (bad) fail = true;
  return { ...r, ok: bad ? 'OVER BUDGET' : 'ok' };
});
console.log(`\n${TABS} tabs x ${SECONDS} s, 10 widgets, 40 machines, every key pushed every second\n`);
console.table(rows);
if (errors.length) {
  fail = true;
  console.log('Page errors:\n' + errors.slice(0, 10).join('\n'));
}
console.log(fail ? 'FAILED (over budget or errors)' : 'within budget');
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);
