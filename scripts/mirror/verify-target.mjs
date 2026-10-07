// Read-only check of the migration on the NEW tenant (migrate-target.mjs): local ids left in anything copied,
// widget libraries, bundles, the simulators producing data, users and the dashboard's service addresses.
//   node scripts/mirror/verify-target.mjs
import { targetClient, newTenantClient } from './clients.mjs';
import { CDN_MAP } from './cdn-map.mjs';

const L = await targetClient();
const T = await newTenantClient();
let bad = 0;
const ok = (cond, label, detail) => { if (!cond) bad++; console.log(`${cond ? 'ok      ' : 'PROBLEM '} ${label}${detail ? '  (' + detail + ')' : ''}`); };

// every local id (including what was deliberately not copied: POC entities, the AI route)
const localIds = new Set([(await L.api('GET', '/api/auth/user')).tenantId.id]);
for (const p of ['/api/tenant/devices', '/api/tenant/assets', '/api/customers', '/api/users', '/api/tenant/dashboards', '/api/ruleChains', '/api/deviceProfiles', '/api/assetProfiles', '/api/widgetTypes?tenantOnly=true']) for (const e of await L.all(p)) localIds.add(e.id.id);
const leftovers = (obj) => [...new Set((JSON.stringify(obj).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []).filter((u) => localIds.has(u)))];

const dash = (await T.all('/api/tenant/dashboards')).find((d) => d.title === 'Self Service Dashboard');
const full = await T.api('GET', `/api/dashboard/${dash.id.id}`);
ok(!leftovers(full.configuration).length, 'dashboard: no local ids', leftovers(full.configuration).join(', '));
ok((full.assignedCustomers || []).some((c) => c.title === 'ITHENA'), 'dashboard assigned to ITHENA');
const urls = [...new Set(Object.values(full.configuration.widgets).filter((w) => w.config?.settings?.serviceUrl).map((w) => w.typeFullFqn.replace('tenant.', '') + '=' + w.config.settings.serviceUrl))];
ok(urls.every((u) => /=\/(reports|aiml)-api$/.test(u)), 'service addresses through the server domain', urls.join(', '));
const missingTypes = [];
for (const f of [...new Set(Object.values(full.configuration.widgets).map((w) => w.typeFullFqn))]) if (!(await T.api('GET', `/api/widgetType?fqn=${f}`, undefined, { allow404: true }))) missingTypes.push(f);
ok(!missingTypes.length, 'every widget type of the dashboard exists', missingTypes.join(', '));

for (const r of await T.all('/api/ruleChains')) {
  const m = await T.api('GET', `/api/ruleChain/${r.id.id}/metadata`);
  ok(!leftovers(m).length, `rule chain ${r.name}: no local ids`, leftovers(m).join(', '));
}
for (const a of await T.all('/api/tenant/assets')) {
  const at = await T.api('GET', `/api/plugins/telemetry/ASSET/${a.id.id}/values/attributes/SERVER_SCOPE`);
  const lo = leftovers(at.filter((x) => x.key !== 'authToken'));
  if (lo.length || /^(DashboardStore|System Configuration|CATALOGUE_STORE_ASSET|DBBLLM-CONFIG)$/.test(a.name)) ok(!lo.length, `asset ${a.name}: ${at.length} attributes, no local ids`, lo.join(', '));
  if (a.name === 'DBBLLM-CONFIG') ok(!at.some((x) => x.key === 'dbb_llm_api_key'), 'DBBLLM-CONFIG has no API key (to be entered on the server)');
}
const users = (await T.all('/api/users')).filter((u) => /@imex\.com$/.test(u.email) && u.authority === 'CUSTOMER_USER');
for (const u of users) {
  const at = Object.fromEntries((await T.api('GET', `/api/plugins/telemetry/USER/${u.id.id}/values/attributes/SERVER_SCOPE`)).map((x) => [x.key, x.value]));
  const nodes = typeof at.selectedNodes === 'string' ? JSON.parse(at.selectedNodes) : at.selectedNodes || [];
  ok(at.Role && nodes.length === 5 && !leftovers(at).length && u.additionalInfo?.homeDashboardId === dash.id.id, `user ${u.email}: ${at.Role}, ${nodes.length} sites, home dashboard`);
}

const wts = await T.all('/api/widgetTypes?tenantOnly=true');
let cdn = 0;
for (const t of wts) { const s = JSON.stringify((await T.api('GET', `/api/widgetType/${t.id.id}`)).descriptor); if (Object.values(CDN_MAP).some((u) => s.includes(u))) cdn++; }
ok(!cdn, `widget types (${wts.length}) load their libraries from the server folder`, cdn ? cdn + ' still on a CDN' : '');
for (const b of await T.all('/api/widgetsBundles?tenantOnly=true')) {
  const n = await T.api('GET', `/api/widgetTypesInfos?widgetsBundleId=${b.id.id}&pageSize=100&page=0`).then((r) => r.totalElements).catch(() => '?');
  ok(n > 0, `bundle ${b.title}: ${n} widgets`);
}

// the simulators: new values on the machines within the last minutes
const devs = await T.all('/api/tenant/devices');
const fresh = [];
for (const d of devs) {
  const keys = await T.api('GET', `/api/plugins/telemetry/DEVICE/${d.id.id}/keys/timeseries`);
  const v = await T.api('GET', `/api/plugins/telemetry/DEVICE/${d.id.id}/values/timeseries?keys=${encodeURIComponent(keys.join(','))}`);
  const newest = Math.max(...Object.values(v).map((p) => Number(p[0]?.ts) || 0));
  fresh.push([d.name, Math.round((Date.now() - newest) / 1000)]);
}
ok(fresh.every(([, s]) => s < 120), `simulators: newest value per machine`, fresh.map(([n, s]) => `${n} ${s}s`).join(', '));
console.log(bad ? `${bad} problem(s)` : 'all checks ok');
