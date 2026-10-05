// Read-only check of the copy on LOCAL: leftover server ids, generator data arriving, rule-chain errors.
import { readFileSync } from 'node:fs';
import { targetClient } from './clients.mjs';
const idmap = JSON.parse(readFileSync('mirror-data/idmap.json', 'utf8'));
const L = (n) => JSON.parse(readFileSync(`mirror-data/source/${n}.json`, 'utf8'));
const srcIds = new Set();
for (const n of ['assets', 'devices', 'customers', 'users', 'dashboards', 'device-profiles', 'asset-profiles', 'widget-types']) for (const e of L(n)) srcIds.add(e.id.id);
for (const r of L('rule-chains')) srcIds.add(r.ruleChain.id.id);
srcIds.add(L('me').tenantId);
const c = await targetClient();
const leftovers = (label, obj) => {
  const hits = [...new Set((JSON.stringify(obj).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).filter((u) => srcIds.has(u)))];
  console.log(`${hits.length ? 'LEFTOVER' : 'ok      '} ${label}${hits.length ? ': ' + hits.join(', ') : ''}`);
};
const dash = await c.api('GET', `/api/dashboard/${idmap[L('dashboards').find((d) => d.title === 'Self Service Dashboard').id.id]}`);
leftovers('dashboard Self Service Dashboard', dash.configuration);
for (const r of L('rule-chains')) if (idmap[r.ruleChain.id.id] && !r.ruleChain.root) leftovers(`rule chain ${r.ruleChain.name}`, (await c.api('GET', `/api/ruleChain/${idmap[r.ruleChain.id.id]}/metadata`)).nodes);
for (const e of [...L('assets'), ...L('devices')]) if (idmap[e.id.id]) leftovers(`attributes ${e.name}`, await c.api('GET', `/api/plugins/telemetry/${e.id.entityType}/${idmap[e.id.id]}/values/attributes/SERVER_SCOPE`));
for (const u of (await c.all('/api/users')).filter((u) => /ithena/.test(u.email))) leftovers(`user ${u.email}`, [u.additionalInfo, await c.api('GET', `/api/plugins/telemetry/USER/${u.id.id}/values/attributes/SERVER_SCOPE`)]);
// generators: newest telemetry timestamp per device
const now = Date.now();
for (const d of L('devices')) {
  const id = idmap[d.id.id];
  const keys = (await c.api('GET', `/api/plugins/telemetry/DEVICE/${id}/keys/timeseries`)).slice(0, 40);
  const latest = await c.api('GET', `/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=${keys.map(encodeURIComponent).join(',')}`);
  const newest = Math.max(0, ...Object.values(latest).flat().map((p) => p.ts));
  console.log(`${d.name.padEnd(18)} newest value ${newest ? Math.round((now - newest) / 1000) + ' s ago' : 'none'}`);
}
