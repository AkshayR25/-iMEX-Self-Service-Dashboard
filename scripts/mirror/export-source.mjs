// Stage 1 of the copy: read-only export of the server's configuration and entity structure (no telemetry
// history) to mirror-data/source/ (git-ignored: it holds customer data, user emails and widget code).
//   node scripts/mirror/export-source.mjs
// Every call goes through the read-only SOURCE client (clients.mjs). Device credentials are never read.
import { mkdirSync, writeFileSync } from 'node:fs';
import { sourceClient } from './clients.mjs';
import { redactAttrs } from './redact.mjs';

const OUT = 'mirror-data/source';
mkdirSync(OUT, { recursive: true });
const save = (name, data) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 1));
const c = await sourceClient();
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const NULL_TENANT = '13814000-1dd2-11b2-8080-808080808080';
// Attributes per scope (tagged with .scope), secrets masked (redact.mjs). CLIENT_SCOPE exists only on devices.
const attrs = async (type, id) => {
  const out = [];
  for (const scope of type === 'DEVICE' ? ['SERVER_SCOPE', 'SHARED_SCOPE', 'CLIENT_SCOPE'] : ['SERVER_SCOPE']) {
    for (const a of (await c.api('GET', `/api/plugins/telemetry/${type}/${id}/values/attributes/${scope}`, undefined, { allow404: true })) || []) out.push({ ...a, scope });
  }
  return redactAttrs(out);
};

const me = await c.api('GET', '/api/auth/user');
const tenantId = me.tenantId.id;
save('me', { authority: me.authority, tenantId, email: me.email });
save('tenant-attributes', await attrs('TENANT', tenantId));

// --- dashboards (full JSON)
const dashInfos = await c.all('/api/tenant/dashboards');
const dashboards = [];
for (const d of dashInfos) dashboards.push(await c.api('GET', `/api/dashboard/${d.id.id}`));
// Google Maps browser keys in widget settings are masked too; the local copy gets its own key.
save('dashboards', JSON.parse(JSON.stringify(dashboards).replace(/("gmApiKey":")AIza[0-9A-Za-z_-]{30,}"/g, '$1<redacted>"')));
say(`dashboards: ${dashboards.length}`);

// --- widget bundles and tenant widget types (full descriptors)
const bundles = await c.all('/api/widgetsBundles?tenantOnly=true');
const bundleTypes = {};
for (const b of bundles) bundleTypes[b.id.id] = (await c.api('GET', `/api/widgetTypesDetails?widgetsBundleId=${b.id.id}&includeResources=false`, undefined, { allow404: true })) || [];
save('widget-bundles', bundles.map((b) => ({ bundle: b, fqns: bundleTypes[b.id.id].map((t) => t.fqn) })));
const typeInfos = await c.all('/api/widgetTypes?tenantOnly=true');
const widgetTypes = [];
for (const t of typeInfos) widgetTypes.push(await c.api('GET', `/api/widgetType/${t.id.id}`));
save('widget-types', widgetTypes);
say(`widget bundles: ${bundles.length}, tenant widget types: ${widgetTypes.length}`);

// --- resources (JS modules etc.) and images owned by the tenant
const resources = (await c.all('/api/resource')).filter((r) => r.tenantId && r.tenantId.id !== NULL_TENANT);
mkdirSync(`${OUT}/resources`, { recursive: true });
for (const r of resources) {
  const buf = await c.api('GET', `/api/resource/${r.id.id}/download`, undefined, { raw: true, allow404: true }).catch((e) => (say('resource ' + r.title + ': ' + e.message), null));
  if (buf) writeFileSync(`${OUT}/resources/${r.id.id}`, buf);
}
save('resources', resources);
const images = await c.all('/api/images?includeSystemImages=false');
const imageExports = [];
for (const im of images) imageExports.push(await c.api('GET', `/api/images/${im.public ? 'tenant' : 'tenant'}/${encodeURIComponent(im.resourceKey)}/export`, undefined, { allow404: true }).catch((e) => ({ error: e.message, key: im.resourceKey })));
save('images', imageExports);
say(`resources: ${resources.length}, images: ${images.length}`);

// --- rule chains (with metadata), profiles, notification setup
const ruleChains = [];
for (const rc of await c.all('/api/ruleChains')) ruleChains.push({ ruleChain: rc, metadata: await c.api('GET', `/api/ruleChain/${rc.id.id}/metadata`) });
save('rule-chains', ruleChains);
const deviceProfiles = [];
for (const p of await c.all('/api/deviceProfiles')) deviceProfiles.push(await c.api('GET', `/api/deviceProfile/${p.id.id}`));
save('device-profiles', deviceProfiles);
const assetProfiles = [];
for (const p of await c.all('/api/assetProfiles')) assetProfiles.push(await c.api('GET', `/api/assetProfile/${p.id.id}`));
save('asset-profiles', assetProfiles);
const cf = {};
for (const p of [...deviceProfiles.map((x) => ['DEVICE_PROFILE', x.id.id]), ...assetProfiles.map((x) => ['ASSET_PROFILE', x.id.id])]) {
  const list = await c.all(`/api/${p[0]}/${p[1]}/calculatedFields`).catch(() => []);
  if (list.length) cf[p[1]] = list;
}
save('calculated-fields-profiles', cf);
for (const k of ['rules', 'templates', 'targets']) save(`notification-${k}`, await c.all(`/api/notification/${k}`).catch((e) => ({ error: e.message })));
say(`rule chains: ${ruleChains.length}, device profiles: ${deviceProfiles.length}, asset profiles: ${assetProfiles.length}`);

// --- customers, users, assets, devices, entity views (with attributes and timeseries key names)
const customers = await c.all('/api/customers');
for (const cu of customers) cu._attributes = await attrs('CUSTOMER', cu.id.id);
save('customers', customers);
const users = await c.all('/api/users');
for (const u of users) u._attributes = await attrs('USER', u.id.id);
save('users', users);
say(`customers: ${customers.length}, users: ${users.length}`);
const assets = await c.all('/api/tenant/assetInfos').catch(() => c.all('/api/tenant/assets'));
const devices = await c.all('/api/tenant/deviceInfos').catch(() => c.all('/api/tenant/devices'));
const entityViews = await c.all('/api/tenant/entityViews').catch(() => []);
say(`assets: ${assets.length}, devices: ${devices.length}, entity views: ${entityViews.length}; reading attributes and relations...`);
let n = 0;
for (const [type, list] of [['ASSET', assets], ['DEVICE', devices], ['ENTITY_VIEW', entityViews]])
  for (const e of list) {
    e._attributes = await attrs(type, e.id.id);
    e._tsKeys = (await c.api('GET', `/api/plugins/telemetry/${type}/${e.id.id}/keys/timeseries`, undefined, { allow404: true })) || [];
    // latest value of every timeseries key ({key: [{ts, value}]})
    e._latest = e._tsKeys.length ? await c.api('GET', `/api/plugins/telemetry/${type}/${e.id.id}/values/timeseries?keys=${e._tsKeys.map(encodeURIComponent).join(',')}&useStrictDataTypes=true`, undefined, { allow404: true }) : {};
    e._relationsFrom = (await c.api('GET', `/api/relations?fromId=${e.id.id}&fromType=${type}`, undefined, { allow404: true })) || [];
    if (++n % 50 === 0) say(`  ${n} entities read`);
  }
save('assets', assets);
save('devices', devices);
save('entity-views', entityViews);
say('done -> ' + OUT);
