// One field on the NEW tenant's dashboard: the Sites page widget's title "Sites" -> "Fleet overview" (the page was
// renamed, 9 Oct 2026). Everything else of the dashboard (edited on the server by hand) stays as it is. Backs up first.
//   node scripts/mirror/set-sites-title.mjs [--go]
import { mkdirSync, writeFileSync } from 'node:fs';
import { newTenantClient } from './clients.mjs';
const GO = process.argv.includes('--go');
const T = await newTenantClient();
const r = await T.api('GET', '/api/tenant/dashboards?pageSize=50&page=0&textSearch=Self%20Service%20Dashboard');
const d = await T.api('GET', '/api/dashboard/' + r.data.find((x) => x.title === 'Self Service Dashboard').id.id);
const ws = Object.values(d.configuration.widgets).filter((w) => w.typeFullFqn === 'tenant.imex_sites_page' && w.config && w.config.settings && w.config.settings.title === 'Sites');
console.log(`${ws.length} Sites page widget(s) titled "Sites"`);
if (!ws.length || !GO) process.exit(0);
const day = new Date().toISOString().slice(0, 10);
mkdirSync(`backups/${day}`, { recursive: true });
writeFileSync(`backups/${day}/server-dashboard-${Date.now()}.json`, JSON.stringify(d));
ws.forEach((w) => { w.config.settings.title = 'Fleet overview'; });
const saved = await T.api('POST', '/api/dashboard', d);
console.log('saved; title now:', Object.values(saved.configuration.widgets).filter((w) => w.typeFullFqn === 'tenant.imex_sites_page').map((w) => w.config.settings.title).join(', '));
