// Puts back the versions of rule chains and widget types that were saved on the NEW tenant by hand and then
// overwritten by migrate-target.mjs (8 Oct 2026, run at 07:52:40 UTC). The versions come from the tenant's audit log,
// saved in backups/2026-10-08/audit/manual-edits.json. An item that was edited again on the server after that run is
// skipped (its newer version is kept). Device profiles and the dashboard are not touched.
//   node scripts/mirror/restore-from-audit.mjs          dry run
//   node scripts/mirror/restore-from-audit.mjs --go     restore
import { readFileSync } from 'node:fs';
import { newTenantClient } from './clients.mjs';

const GO = process.argv.includes('--go');
const RUN_START = Date.UTC(2026, 9, 8, 7, 52, 30);
const RUN_END = Date.UTC(2026, 9, 8, 7, 53, 40);
const ITEMS = [['Ithena Telemetry Simulation', 'RULE_CHAIN'], ['Weather Station', 'RULE_CHAIN'], ['Dryer', 'RULE_CHAIN'], ['[UCA] Shift Detection RC', 'RULE_CHAIN'], ['iMEX v4.3 User management', 'WIDGET_TYPE']];
// saves made by migrate-target.mjs itself are not hand edits (8 Oct, UTC): 05:10-05:13 and 07:52-07:54
const MINE = [[Date.UTC(2026, 9, 8, 5, 10), Date.UTC(2026, 9, 8, 5, 13)], [Date.UTC(2026, 9, 8, 7, 52), Date.UTC(2026, 9, 8, 7, 54)]];
const byMe = (t) => MINE.some(([a, b]) => t >= a && t <= b);
const T = await newTenantClient();
const manual = JSON.parse(readFileSync('backups/2026-10-08/audit/manual-edits.json', 'utf8'));

// audit entries since the run: anything saved after it on these items means someone worked on them again
const since = [];
for (let p = 0; p < 10; p++) {
  const r = await T.api('GET', `/api/audit/logs?pageSize=1000&page=${p}&startTime=${RUN_END}&endTime=${Date.now()}&sortProperty=createdTime&sortOrder=DESC`);
  since.push(...r.data);
  if (!r.hasNext) break;
}
for (const [name, type] of ITEMS) {
  const saved = manual.filter((a) => a.entityName === name && a.entityId.entityType === type && a.createdTime < RUN_START && !byMe(a.createdTime)).sort((a, b) => b.createdTime - a.createdTime)[0];
  if (!saved) { console.log(`${name}: no hand edit before the run (only saves by the migration), nothing to restore`); continue; }
  const later = since.filter((a) => a.entityId.id === saved.entityId.id && a.actionType === 'UPDATED');
  if (later.length) { console.log(`${name}: edited again on the server after the run (${later.length}x), kept as it is`); continue; }
  const when = new Date(saved.createdTime).toISOString().slice(11, 19) + ' UTC';
  if (saved.entityId.entityType === 'RULE_CHAIN') {
    const md = saved.actionData.metadata;
    const cur = await T.api('GET', `/api/ruleChain/${saved.entityId.id}/metadata`);
    console.log(`${name}: restore the version of ${when} (${md.nodes.length} nodes, ${md.connections.length} links; now ${cur.nodes.length} / ${cur.connections.length})`);
    if (!GO) continue;
    // node ids from that save no longer exist (the run re-created the nodes): saved as new nodes in the same order
    const nodes = md.nodes.map((n) => { const x = { ...n }; delete x.id; delete x.ruleChainId; delete x.createdTime; return x; });
    await T.api('POST', '/api/ruleChain/metadata', { ruleChainId: { entityType: 'RULE_CHAIN', id: saved.entityId.id }, version: cur.version, firstNodeIndex: md.firstNodeIndex, nodes, connections: md.connections, ruleChainConnections: md.ruleChainConnections });
    const back = await T.api('GET', `/api/ruleChain/${saved.entityId.id}/metadata`);
    const same = JSON.stringify(back.nodes.map((n) => [n.name, n.type, n.configuration])) === JSON.stringify(md.nodes.map((n) => [n.name, n.type, n.configuration])) && back.connections.length === md.connections.length;
    console.log(`   restored: ${back.nodes.length} nodes, ${back.connections.length} links, identical to the saved version: ${same}`);
  }
  if (saved.entityId.entityType === 'WIDGET_TYPE') {
    const ent = saved.actionData.entity;
    const cur = await T.api('GET', `/api/widgetType/${saved.entityId.id}`);
    console.log(`${name}: restore the version of ${when}`);
    if (!GO) continue;
    const body = { ...ent, id: cur.id, version: cur.version };
    delete body.createdTime;
    await T.api('POST', '/api/widgetType', body);
    const back = await T.api('GET', `/api/widgetType/${saved.entityId.id}`);
    console.log(`   restored: controller identical to the saved version: ${back.descriptor.controllerScript === ent.descriptor.controllerScript}`);
  }
}
console.log(GO ? 'done' : 'Dry run. Re-run with --go to restore.');
