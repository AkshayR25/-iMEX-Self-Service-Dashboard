// Stage 2 of the copy: imports the server export (mirror-data/source, from export-source.mjs) into the LOCAL
// ThingsBoard tenant (.env TB_*), which is shared with Self-Service Reports.
//   node scripts/mirror/import-local.mjs           backs up the local tenant config, then imports
// Idempotent: everything is found by name / fqn / email first and updated in place; source -> local ids are kept
// in mirror-data/idmap.json and every copied JSON (dashboards, rule chains, attributes, Builder documents) has its
// server ids rewritten to local ids.
// Agreed with Akshay (5 Oct 2026): same tenant as Reports; generators every 10 s instead of 1 s; latest telemetry
// only; new device access tokens (ThingsBoard creates them); no activation emails; secrets are not copied
// (redacted in the export); outbound URLs in the copied widgets point at local services.
// Not touched: Reports' POC entities, the local root rule chain, the imex_rpt_* widget types (local build is newer),
// DBBLLM-CONFIG (exists locally; its key stays as it is). The imex_dbb_* widget types come from this repo's build
// (deploy-node.mjs), not from the server.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { targetClient } from './clients.mjs';
import { swapAssets } from './cdn-map.mjs';

const SRC = 'mirror-data/source';
const L = (n) => JSON.parse(readFileSync(`${SRC}/${n}.json`, 'utf8'));
const IDMAP = 'mirror-data/idmap.json';
const idmap = existsSync(IDMAP) ? JSON.parse(readFileSync(IDMAP, 'utf8')) : {};
const saveMap = () => writeFileSync(IDMAP, JSON.stringify(idmap, null, 1));
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const c = await targetClient();
const { api, all } = c;

const APP_TITLE = 'Self Service Dashboard';
const GENERATOR_MIN_PERIOD_S = 10;
const LOCAL_REPORTS_URL = 'http://localhost:8090';
const SKIP_RULE_CHAINS = ['Root Rule Chain', 'DBB Chat relay (POC)']; // root: use the local one; relay: DBB deploy
const SKIP_WIDGET_FQNS = /^imex_(dbb|rpt)_/; // DBB from the repo build, Reports' local build is newer
const SKIP_ASSETS = ['DBBLLM-CONFIG']; // exists locally (tenant-owned); mapped, not copied
const SYSTEM_ATTRS = new Set(['active', 'lastActivityTime', 'lastConnectTime', 'lastDisconnectTime', 'inactivityAlarmTime']);
// chat request/response attributes would re-trigger the chat relay or are per-user transients
const SKIP_ATTR = (k) => SYSTEM_ATTRS.has(k) || k === 'dbb_chat_req' || k.startsWith('dbb_chat_resp_');
// Akshay's own login for the copy (akshayr@ithena.ai exists in POC Customer Alpha; emails are unique)
// user additionalInfo fields worth copying (not login history, lockout counters or password history)
const USER_INFO_KEYS = ['description', 'defaultDashboardId', 'defaultDashboardFullscreen', 'homeDashboardId', 'homeDashboardHideToolbar'];
const NEW_ADMIN = { email: 'akshayr+imex@ithena.ai', firstName: 'Akshay', lastName: 'R' };

// --- id rewriting
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const remap = (v) => JSON.parse(JSON.stringify(v).replace(UUID, (u) => idmap[u] || u));
const ref = (type, id) => ({ entityType: type, id });
const strip = (o, ...keys) => { const r = { ...o }; for (const k of ['id', 'createdTime', 'tenantId', 'version', 'externalId', ...keys]) delete r[k]; return r; };
const findByName = (list, name, key = 'name') => list.find((x) => x[key] === name);

// --- 0. backup of the local tenant configuration (before anything is written)
const day = new Date().toISOString().slice(0, 10);
const BK = `backups/${day}/local-before-import`;
if (!existsSync(BK)) {
  mkdirSync(BK, { recursive: true });
  const bk = (n, d) => writeFileSync(`${BK}/${n}.json`, JSON.stringify(d, null, 1));
  const dashes = [];
  for (const d of await all('/api/tenant/dashboards')) dashes.push(await api('GET', `/api/dashboard/${d.id.id}`));
  bk('dashboards', dashes);
  const rcs = [];
  for (const r of await all('/api/ruleChains')) rcs.push({ ruleChain: r, metadata: await api('GET', `/api/ruleChain/${r.id.id}/metadata`) });
  bk('rule-chains', rcs);
  const dps = [];
  for (const p of await all('/api/deviceProfiles')) dps.push(await api('GET', `/api/deviceProfile/${p.id.id}`));
  bk('device-profiles', dps);
  const aps = [];
  for (const p of await all('/api/assetProfiles')) aps.push(await api('GET', `/api/assetProfile/${p.id.id}`));
  bk('asset-profiles', aps);
  const wts = [];
  for (const t of await all('/api/widgetTypes?tenantOnly=true')) wts.push(await api('GET', `/api/widgetType/${t.id.id}`));
  bk('widget-types', wts);
  bk('customers', await all('/api/customers'));
  bk('users', await all('/api/users'));
  bk('assets', await all('/api/tenant/assetInfos'));
  bk('devices', await all('/api/tenant/deviceInfos'));
  say(`local backup -> ${BK}`);
} else say(`local backup already in ${BK} (kept)`);

// --- 1. fixed mappings: tenant, root rule chain, LLM config asset
const me = L('me');
const localUser = await api('GET', '/api/auth/user');
idmap[me.tenantId] = localUser.tenantId.id;
const srcRCs = L('rule-chains');
const localRCs = await all('/api/ruleChains');
idmap[srcRCs.find((r) => r.ruleChain.root).ruleChain.id.id] = localRCs.find((r) => r.root).id.id;
for (const name of SKIP_ASSETS) {
  const s = findByName(L('assets'), name);
  const l = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(name)}`, undefined, { allow404: true });
  if (s && l) idmap[s.id.id] = l.id.id;
}

// --- 2. customer
const customerId = {};
for (const cu of L('customers')) {
  let l = await api('GET', `/api/tenant/customers?customerTitle=${encodeURIComponent(cu.title)}`, undefined, { allow404: true });
  if (!l) l = await api('POST', '/api/customer', strip(cu, '_attributes', 'name', 'ownerId'));
  idmap[cu.id.id] = l.id.id;
  customerId[cu.id.id] = l.id.id;
  say(`customer ${cu.title}`);
}
saveMap();

// --- 3. rule chain shells (metadata later, after the devices exist)
for (const { ruleChain: r } of srcRCs) {
  if (SKIP_RULE_CHAINS.includes(r.name)) continue;
  let l = findByName(localRCs, r.name);
  if (!l) l = await api('POST', '/api/ruleChain', { name: r.name, type: r.type, debugMode: false, configuration: r.configuration, additionalInfo: r.additionalInfo });
  idmap[r.id.id] = l.id.id;
}
saveMap();

// --- 4. images (widgets and profiles refer to them by resource key)
for (const im of L('images')) {
  if (im.error) { say('image skipped: ' + im.error); continue; }
  const exists = await api('GET', `/api/images/tenant/${encodeURIComponent(im.resourceKey)}/info`, undefined, { allow404: true });
  if (!exists) await api('PUT', '/api/image/import', im);
}
say(`images: ${L('images').length}`);

// --- 5. profiles
const localDPs = await all('/api/deviceProfiles');
for (const p of L('device-profiles')) {
  if (p.default) { idmap[p.id.id] = localDPs.find((x) => x.default).id.id; continue; }
  const body = remap(strip(p, 'provisionDeviceKey', 'firmwareId', 'softwareId', 'defaultEdgeRuleChainId', 'defaultDashboardId'));
  body.default = false;
  // provisioning keys are unique per server and secret-like: provisioning stays off on the copy
  if (body.profileData) body.profileData.provisionConfiguration = { type: 'DISABLED', provisionDeviceSecret: null };
  const l = findByName(localDPs, p.name);
  if (l) Object.assign(body, { id: l.id, version: (await api('GET', `/api/deviceProfile/${l.id.id}`)).version });
  const saved = await api('POST', '/api/deviceProfile', body);
  idmap[p.id.id] = saved.id.id;
}
const localAPs = await all('/api/assetProfiles');
for (const p of L('asset-profiles')) {
  if (p.default) { idmap[p.id.id] = localAPs.find((x) => x.default).id.id; continue; }
  const body = remap(strip(p, 'defaultEdgeRuleChainId', 'defaultDashboardId'));
  body.default = false;
  // DBB_DEPLOY refuses to reuse a DashboardStore profile without the POC marker (D-005)
  if (p.name === 'DashboardStore' && !String(body.description || '').includes('[poc=true]')) body.description = `[poc=true] ${body.description || 'Dashboard Builder store'}`.trim();
  // the relay rule chain is created by the DBB deploy, which then sets itself as this profile's default chain
  if (p.name === 'DashboardStore') delete body.defaultRuleChainId;
  const l = findByName(localAPs, p.name);
  if (l) {
    const cur = await api('GET', `/api/assetProfile/${l.id.id}`);
    Object.assign(body, { id: l.id, version: cur.version });
    if (p.name === 'DashboardStore') body.defaultRuleChainId = cur.defaultRuleChainId;
  }
  const saved = await api('POST', '/api/assetProfile', body);
  idmap[p.id.id] = saved.id.id;
}
saveMap();
say('profiles: device ' + L('device-profiles').length + ', asset ' + L('asset-profiles').length);

// --- 6. assets and devices (entities first, so attributes and relations can refer to each other)
const entities = [...L('assets').map((e) => ['ASSET', e]), ...L('devices').map((e) => ['DEVICE', e])];
for (const [type, e] of entities) {
  if (type === 'ASSET' && SKIP_ASSETS.includes(e.name)) continue;
  const path = type === 'ASSET' ? 'asset' : 'device';
  let l = await api('GET', `/api/tenant/${path}s?${path}Name=${encodeURIComponent(e.name)}`, undefined, { allow404: true });
  if (!l) {
    const body = { name: e.name, label: e.label, additionalInfo: e.additionalInfo };
    if (type === 'ASSET') body.assetProfileId = ref('ASSET_PROFILE', idmap[e.assetProfileId.id]);
    else body.deviceProfileId = ref('DEVICE_PROFILE', idmap[e.deviceProfileId.id]);
    l = await api('POST', `/api/${path}`, body); // a new device gets a new access token from ThingsBoard
  }
  idmap[e.id.id] = l.id.id;
  const cid = e.customerId && customerId[e.customerId.id];
  if (cid && (!l.customerId || l.customerId.id !== cid)) await api('POST', `/api/customer/${cid}/${path}/${l.id.id}`);
}
saveMap();
say(`entities: ${entities.length}`);

for (const [type, e] of entities) {
  const id = idmap[e.id.id];
  if (!id || (type === 'ASSET' && SKIP_ASSETS.includes(e.name))) continue;
  // attributes (server and shared scope; ids inside values rewritten; secrets were redacted in the export)
  for (const scope of ['SERVER_SCOPE', 'SHARED_SCOPE']) {
    const vals = {};
    for (const a of e._attributes.filter((x) => x.scope === scope && !SKIP_ATTR(x.key) && x.value !== '<redacted>')) vals[a.key] = remap(a.value);
    if (Object.keys(vals).length) await api('POST', `/api/plugins/telemetry/${type}/${id}/attributes/${scope}`, vals);
  }
  // latest telemetry, grouped by timestamp
  const byTs = {};
  for (const [k, pts] of Object.entries(e._latest || {})) for (const p of pts || []) (byTs[p.ts] ||= {})[k] = p.value;
  const batch = Object.entries(byTs).map(([ts, values]) => ({ ts: Number(ts), values }));
  if (batch.length) await api('POST', `/api/plugins/telemetry/${type}/${id}/timeseries/ANY`, batch);
  // relations from this entity
  for (const r of e._relationsFrom) {
    if (!idmap[r.to.id]) continue;
    await api('POST', '/api/v2/relation', { from: ref(type, id), to: ref(r.to.entityType, idmap[r.to.id]), type: r.type, typeGroup: r.typeGroup || 'COMMON', additionalInfo: r.additionalInfo });
  }
}
say('attributes, latest values and relations written');

// --- 7. rule chain metadata: ids rewritten, generators slowed to >= 10 s, debug off
for (const { ruleChain: r, metadata: m } of srcRCs) {
  if (SKIP_RULE_CHAINS.includes(r.name)) continue;
  const id = idmap[r.id.id];
  const cur = await api('GET', `/api/ruleChain/${id}/metadata`);
  const nodes = remap(m.nodes).map((n) => {
    const node = strip(n, 'ruleChainId', 'debugMode', 'debugSettings');
    node.debugSettings = { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 };
    if (n.type.endsWith('TbMsgGeneratorNode')) node.configuration = { ...node.configuration, periodInSeconds: Math.max(GENERATOR_MIN_PERIOD_S, Number(node.configuration.periodInSeconds) || 0) };
    // The server's clamp() fails in TBEL with "argument type mismatch" when v is an integer (Math.max(0.0, 1) has no
    // matching overload), so 5 generators (Dryer 2/3/4, Weather Station 3/4) produce nothing there either (stopped
    // 2026-10-05 12:32 UTC). Fixed on the local copy only: everything converted to double.
    if (n.type.endsWith('TbMsgGeneratorNode') && node.configuration.tbelScript)
      node.configuration.tbelScript = node.configuration.tbelScript.replace(/function clamp\(v, lo, hi\) \{[^}]*\}/,'function clamp(v, lo, hi) { return Math.min(hi * 1.0, Math.max(lo * 1.0, v * 1.0)); }');
    return node;
  });
  await api('POST', '/api/ruleChain/metadata', { ruleChainId: ref('RULE_CHAIN', id), version: cur.version, firstNodeIndex: m.firstNodeIndex, nodes, connections: m.connections, ruleChainConnections: m.ruleChainConnections });
  say(`rule chain ${r.name}: ${nodes.length} nodes`);
}

// --- 8. widget types (developer widgets; server-hosted libraries -> CDN; hard-coded server URLs -> local)
for (const t of L('widget-types')) {
  if (SKIP_WIDGET_FQNS.test(t.fqn)) continue;
  // active_alarm_ called a fixed foreign server over plain HTTP with the stored token: same-origin locally
  const descriptor = JSON.parse(swapAssets(JSON.stringify(t.descriptor)).replace(/http:\/\/3\.110\.150\.117:8080/g, ''));
  const body = { fqn: t.fqn, name: t.name, descriptor, description: t.description, image: t.image, tags: t.tags, deprecated: t.deprecated, scada: t.scada };
  const ex = await api('GET', `/api/widgetType?fqn=tenant.${t.fqn}`, undefined, { allow404: true });
  if (ex) Object.assign(body, { id: ex.id, version: (await api('GET', `/api/widgetType/${ex.id.id}`)).version });
  const saved = await api('POST', '/api/widgetType', body);
  idmap[t.id.id] = saved.id.id;
}
saveMap();
say('widget types copied');

// --- 9. the app dashboard
const src = L('dashboards').find((d) => d.title === APP_TITLE);
const conf = remap(src.configuration);
for (const w of Object.values(conf.widgets || {})) {
  const s = w.config && w.config.settings;
  if (!s) continue;
  if (w.typeFullFqn === 'tenant.imex_rpt_app') s.serviceUrl = LOCAL_REPORTS_URL;
  if (s.gmApiKey === '<redacted>') s.gmApiKey = ''; // a Google Maps key for local is set in the map widget's settings
}
let dash = (await all(`/api/tenant/dashboards?textSearch=${encodeURIComponent(APP_TITLE)}`)).find((d) => d.title === APP_TITLE);
const dashBody = { title: src.title, image: src.image, mobileHide: src.mobileHide, mobileOrder: src.mobileOrder, configuration: conf };
if (dash) {
  const full = await api('GET', `/api/dashboard/${dash.id.id}`);
  dash = await api('POST', '/api/dashboard', Object.assign(full, dashBody));
} else dash = await api('POST', '/api/dashboard', dashBody);
idmap[src.id.id] = dash.id.id;
for (const cu of src.assignedCustomers || []) await api('POST', `/api/customer/${customerId[cu.customerId.id]}/dashboard/${dash.id.id}`);
saveMap();
say(`dashboard "${APP_TITLE}": ${dash.id.id}`);

// --- 10. users (customer users from the server + Akshay's admin login), password from LOCAL_USER_PASSWORD
const password = process.env.LOCAL_USER_PASSWORD;
const localUsers = await all('/api/users');
const srcUsers = L('users').filter((u) => u.authority === 'CUSTOMER_USER');
const template = srcUsers.find((u) => u._attributes.some((a) => a.key === 'Role' && a.value === 'Admin')) || srcUsers[0];
const wanted = [...srcUsers.map((u) => ({ src: u, email: u.email, firstName: u.firstName, lastName: u.lastName })), { src: template, ...NEW_ADMIN }];
for (const w of wanted) {
  let l = localUsers.find((u) => u.email === w.email);
  if (!l) {
    l = await api('POST', '/api/user?sendActivationMail=false', {
      email: w.email, firstName: w.firstName, lastName: w.lastName, authority: 'CUSTOMER_USER',
      customerId: ref('CUSTOMER', customerId[w.src.customerId.id]),
      additionalInfo: remap(Object.fromEntries(Object.entries(w.src.additionalInfo || {}).filter(([k]) => USER_INFO_KEYS.includes(k)))),
    });
    if (password) {
      const link = await api('GET', `/api/user/${l.id.id}/activationLink`, undefined, { raw: true });
      const token = new URL(link.toString()).searchParams.get('activateToken');
      await api('POST', '/api/noauth/activate?sendActivationMail=false', { activateToken: token, password });
    }
    say(`user ${w.email} created${password ? ' and activated' : ' (not activated: LOCAL_USER_PASSWORD not set)'}`);
  }
  if (w.src.id) idmap[w.src.id.id] ||= l.id.id;
  // iMEX user attributes (Role, selectedNodes, profile fields); for the new admin, the template's values with its own name/email
  const vals = {};
  for (const a of w.src._attributes.filter((x) => x.scope === 'SERVER_SCOPE' && !SKIP_ATTR(x.key))) vals[a.key] = remap(a.value);
  if (w.email !== w.src.email) Object.assign(vals, { email: w.email, firstName: w.firstName, lastName: w.lastName });
  if (Object.keys(vals).length) await api('POST', `/api/plugins/telemetry/USER/${l.id.id}/attributes/SERVER_SCOPE`, vals);
}
saveMap();
say('done. Next: deploy the Dashboard Builder (widgets/deploy/deploy-node.mjs).');
