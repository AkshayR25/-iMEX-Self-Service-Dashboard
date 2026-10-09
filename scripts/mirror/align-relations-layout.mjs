// One layout on the NEW tenant's dashboard: the Relationships page widget gets the same row and height as the Anomalies
// page widget (the server's layout of that state was edited by hand and sat 13 px lower; Akshay agreed, 9 Oct 2026).
// Everything else of the dashboard stays as it is. Backs up first.
//   node scripts/mirror/align-relations-layout.mjs [--go]
import { mkdirSync, writeFileSync } from 'node:fs';
import { newTenantClient } from './clients.mjs';
const GO = process.argv.includes('--go');
const T = await newTenantClient();
const r = await T.api('GET', '/api/tenant/dashboards?pageSize=50&page=0&textSearch=Self%20Service%20Dashboard');
const d = await T.api('GET', '/api/dashboard/' + r.data.find((x) => x.title === 'Self Service Dashboard').id.id);
const W = d.configuration.widgets, S = d.configuration.states;
const cell = (state, fqn) => {
  const m = S[state] && S[state].layouts.main.widgets;
  const id = Object.keys(m || {}).find((k) => W[k] && W[k].typeFullFqn === fqn);
  return id ? m[id] : null;
};
const ref = cell('aiml_anomalies', 'tenant.aiml_anomalies');
const rel = cell('aiml_relations', 'tenant.aiml_relations');
if (!ref || !rel) { console.log('widget cell not found', !!ref, !!rel); process.exit(1); }
const pick = (c) => ({ row: c.row, col: c.col, sizeX: c.sizeX, sizeY: c.sizeY, mobileHeight: c.mobileHeight });
console.log('anomalies    ', JSON.stringify(pick(ref)));
console.log('relationships', JSON.stringify(pick(rel)));
const gs = (st) => JSON.stringify(S[st].layouts.main.gridSettings);
console.log('grid settings same:', gs('aiml_anomalies') === gs('aiml_relations'));
if (ref.row === rel.row && ref.sizeY === rel.sizeY && ref.mobileHeight === rel.mobileHeight) { console.log('already aligned'); process.exit(0); }
if (!GO) { console.log('Dry run. Re-run with --go to align.'); process.exit(0); }
const day = new Date().toISOString().slice(0, 10);
mkdirSync(`backups/${day}`, { recursive: true });
writeFileSync(`backups/${day}/server-dashboard-${Date.now()}.json`, JSON.stringify(d));
Object.assign(rel, { row: ref.row, sizeY: ref.sizeY, mobileHeight: ref.mobileHeight });
await T.api('POST', '/api/dashboard', d);
console.log('saved: relationships now', JSON.stringify(pick(rel)));
