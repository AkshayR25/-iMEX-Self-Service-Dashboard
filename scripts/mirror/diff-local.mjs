// Read-only: compares the local tenant now with the pre-import backup. Everything that existed before must be
// unchanged, except the entities the copy shares on purpose (DBBLLM-CONFIG gets the DBB model defaults + relation).
import { readFileSync } from 'node:fs';
import { targetClient } from './clients.mjs';
const BK = process.argv[2] || `backups/${new Date().toISOString().slice(0, 10)}/local-before-import`;
const B = (n) => JSON.parse(readFileSync(`${BK}/${n}.json`, 'utf8'));
const c = await targetClient();
const norm = (o) => JSON.stringify(o, (k, v) => (['version', 'lastLoginTs', 'additionalInfo'].includes(k) && typeof v !== 'object' ? undefined : v));
let bad = 0;
const cmp = (label, before, now) => { const same = norm(before) === norm(now); if (!same) bad++; console.log(`${same ? 'unchanged' : 'CHANGED  '} ${label}`); };
for (const d of B('dashboards')) cmp(`dashboard ${d.title}`, d.configuration, (await c.api('GET', `/api/dashboard/${d.id.id}`)).configuration);
for (const r of B('rule-chains')) cmp(`rule chain ${r.ruleChain.name}`, r.metadata.nodes.map((n) => n.configuration), (await c.api('GET', `/api/ruleChain/${r.ruleChain.id.id}/metadata`)).metadata?.nodes?.map((n) => n.configuration) ?? (await c.api('GET', `/api/ruleChain/${r.ruleChain.id.id}/metadata`)).nodes.map((n) => n.configuration));
for (const p of B('device-profiles')) cmp(`device profile ${p.name}`, p.profileData, (await c.api('GET', `/api/deviceProfile/${p.id.id}`)).profileData);
for (const p of B('asset-profiles')) { const n = await c.api('GET', `/api/assetProfile/${p.id.id}`); cmp(`asset profile ${p.name}`, [p.defaultRuleChainId, p.description], [n.defaultRuleChainId, n.description]); }
for (const t of B('widget-types')) cmp(`widget type ${t.fqn}`, t.descriptor, (await c.api('GET', `/api/widgetType/${t.id.id}`)).descriptor);
for (const u of B('users')) { const n = await c.api('GET', `/api/user/${u.id.id}`); cmp(`user ${u.email}`, [u.email, u.customerId, u.authority], [n.email, n.customerId, n.authority]); }
for (const a of B('assets')) { const n = await c.api('GET', `/api/asset/${a.id.id}`); cmp(`asset ${a.name}`, [a.name, a.customerId, a.assetProfileId], [n.name, n.customerId, n.assetProfileId]); }
for (const d of B('devices')) { const n = await c.api('GET', `/api/device/${d.id.id}`); cmp(`device ${d.name}`, [d.name, d.customerId, d.deviceProfileId], [n.name, n.customerId, n.deviceProfileId]); }
console.log(bad ? `${bad} CHANGED` : 'all pre-existing entities unchanged');
