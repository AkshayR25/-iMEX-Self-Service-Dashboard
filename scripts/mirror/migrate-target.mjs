// Moves the iMEX app as it runs on LOCAL (TB_*) into the NEW tenant on the server (TGT_TB_*, "iMEX - AI Features").
// The existing server tenant (SRC_TB_*) is never written: newTenantClient() refuses to run against it.
//   node scripts/mirror/migrate-target.mjs          dry run: what would be created, nothing is written
//   node scripts/mirror/migrate-target.mjs --go     backs up the new tenant, then migrates
// Idempotent: everything is found by name / fqn / email and updated in place; local -> server ids are kept in
// mirror-data/target-idmap.json and every copied JSON (dashboard, rule chains, attributes, Builder documents) has its
// local ids rewritten to server ids.
//
// Agreed with Akshay (7 Oct 2026):
// - customer "ITHENA" (local "Ithena Technology"); users ar@ / pc@ / vp@ / tl@imex.com (Role Admin) and demo@imex.com
//   (Role Viewer), all sites; password TGT_USER_PASSWORD; no activation e-mails
// - ITHENA only: the Reports POC customers, machines and users stay on local
// - secrets are not copied: the LLM key (DBBLLM-CONFIG dbb_llm_api_key) is entered on the server by Akshay; the stored
//   tenant token (System Configuration authToken) is a new login of the new tenant's admin
// - the AI route ("AIML Claude" model, "AIML Anomaly explain" chain, asset "AIML Insights") is installed afterwards
//   by the AIML repo's install-native-ai.mjs, once the key is on the server (the model needs it)
// - 90 days of history for the 11 simulated machines are written afterwards by the AIML backfill (same model as the
//   live generators); here only the latest values are copied
// - services through the server's own domain: Reports at /reports-api, AI Insights at /aiml-api (nginx, same origin)
// - widget libraries from the server's own folder (assets/ithena/...) instead of the public CDNs used on local
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { targetClient, newTenantClient } from './clients.mjs';
import { CDN_MAP } from './cdn-map.mjs';

const GO = process.argv.includes('--go');
const IDMAP = 'mirror-data/target-idmap.json';
mkdirSync('mirror-data', { recursive: true });
const idmap = existsSync(IDMAP) ? JSON.parse(readFileSync(IDMAP, 'utf8')) : {};
const saveMap = () => GO && writeFileSync(IDMAP, JSON.stringify(idmap, null, 1));
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const APP_TITLE = 'Self Service Dashboard';
const CUSTOMER = { local: 'Ithena Technology', server: 'ITHENA' };
const REPORTS_URL = '/reports-api';
const AIML_URL = '/aiml-api';
const USERS = [
  { email: 'ar@imex.com', role: 'Admin' }, { email: 'pc@imex.com', role: 'Admin' }, { email: 'vp@imex.com', role: 'Admin' },
  { email: 'tl@imex.com', role: 'Admin' }, { email: 'demo@imex.com', role: 'Viewer' },
];
const TEMPLATE_USER = 'akshayr+imex@ithena.ai'; // local admin whose iMEX attributes (all sites, preferences) are the model
const IS_POC = (name) => /^POC /.test(name);
// local-only entities: the AI route (installed later), the AI model, the root chain (the server has its own)
const SKIP_ASSETS = new Set(['AIML Insights']);
const SKIP_ASSET_PROFILES = new Set(); // the AIML profile comes without its rule chain; install-native-ai sets it
const SKIP_RULE_CHAINS = new Set(['AIML Anomaly explain']);
// our widgets only; the developers' originals are not used by the converted dashboard
const OUR_WIDGET = /^(imex_|aiml_)/;
const BUNDLES = [
  { alias: 'imex_app_ui', title: 'iMEX v4.3', test: (f) => /^imex_/.test(f) && !/^imex_(dbb|rpt)_/.test(f) },
  { alias: 'aiml', title: 'AIML', test: (f) => /^aiml_/.test(f) },
  { alias: 'imex_dbb', title: 'iMEX Self-Service (POC)', test: (f) => /^imex_dbb_/.test(f) },
  { alias: 'imex_reports', title: 'iMEX Reports', test: (f) => /^imex_rpt_/.test(f) },
];
const SECRET = /^(dbb_llm_api_key|authToken|.*(api_?key|secret|password).*)$/i;
const SYSTEM_ATTRS = new Set(['active', 'lastActivityTime', 'lastConnectTime', 'lastDisconnectTime', 'inactivityAlarmTime']);
const SKIP_ATTR = (k) => SECRET.test(k) || SYSTEM_ATTRS.has(k) || k === 'dbb_chat_req' || k.startsWith('dbb_chat_resp_');
const USER_INFO_KEYS = ['description', 'defaultDashboardFullscreen', 'homeDashboardHideToolbar'];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const remap = (v) => JSON.parse(JSON.stringify(v).replace(UUID, (u) => idmap[u] || u));
const ref = (type, id) => ({ entityType: type, id });
const strip = (o, ...keys) => { const r = { ...o }; for (const k of ['id', 'createdTime', 'tenantId', 'version', 'externalId', ...keys]) delete r[k]; return r; };
// the CDN copies used on local -> the server's own library folder
const toServerLibs = (s) => { for (const [path, url] of Object.entries(CDN_MAP)) s = s.split(url).join(path); return s; };

const L = await targetClient(); // LOCAL: read only here
const T = await newTenantClient(); // the new tenant
say(`local ${L.base} -> new tenant ${T.base} (${(await T.api('GET', `/api/tenant/${T.tenantId}`)).title})${GO ? '' : '   DRY RUN: nothing is written'}`);
const w = async (method, path, body, opts) => (GO ? T.api(method, path, body, opts) : null);

// ------------------------------------------------------------------ read local
const lUser = await L.api('GET', '/api/auth/user');
idmap[lUser.tenantId.id] = T.tenantId;
const lCustomers = await L.all('/api/customers');
const lCust = lCustomers.find((c) => c.title === CUSTOMER.local);
const lDevices = (await L.all('/api/tenant/deviceInfos')).filter((d) => !IS_POC(d.name));
const lAssets = (await L.all('/api/tenant/assetInfos')).filter((a) => !IS_POC(a.name) && !SKIP_ASSETS.has(a.name));
const usedDP = new Set(lDevices.map((d) => d.deviceProfileId.id));
const usedAP = new Set(lAssets.map((a) => a.assetProfileId.id));
const lDP = []; for (const p of await L.all('/api/deviceProfiles')) if (usedDP.has(p.id.id) || p.default) lDP.push(await L.api('GET', `/api/deviceProfile/${p.id.id}`));
const lAP = []; for (const p of await L.all('/api/assetProfiles')) if ((usedAP.has(p.id.id) || p.default) && !SKIP_ASSET_PROFILES.has(p.name)) lAP.push(await L.api('GET', `/api/assetProfile/${p.id.id}`));
const lRC = []; for (const r of await L.all('/api/ruleChains')) if (!SKIP_RULE_CHAINS.has(r.name)) lRC.push({ ruleChain: r, metadata: await L.api('GET', `/api/ruleChain/${r.id.id}/metadata`) });
const lWT = []; for (const t of await L.all('/api/widgetTypes?tenantOnly=true')) if (OUR_WIDGET.test(t.fqn)) lWT.push(await L.api('GET', `/api/widgetType/${t.id.id}`));
const lDash = await L.api('GET', `/api/dashboard/${(await L.all('/api/tenant/dashboards')).find((d) => d.title === APP_TITLE).id.id}`);
const lImages = (await L.api('GET', '/api/images?pageSize=100&page=0&includeSystemImages=false')).data;
const tmplUser = (await L.all('/api/users')).find((u) => u.email === TEMPLATE_USER);
const tmplAttrs = await L.api('GET', `/api/plugins/telemetry/USER/${tmplUser.id.id}/values/attributes/SERVER_SCOPE`);
say(`local: ${lDevices.length} machines, ${lAssets.length} assets, ${lDP.length} device profiles, ${lAP.length} asset profiles, ${lRC.length} rule chains, ${lWT.length} widget types, ${lImages.length} images, dashboard "${APP_TITLE}" (${Object.keys(lDash.configuration.states).length} states)`);
if (!GO) {
  say(`would create: customer ${CUSTOMER.server}; users ${USERS.map((u) => u.email + ' (' + u.role + ')').join(', ')}`);
  say(`machines: ${lDevices.map((d) => d.name).sort().join(', ')}`);
  say(`assets: ${lAssets.map((a) => a.name).sort().join(', ')}`);
  say(`rule chains: ${lRC.map((r) => r.ruleChain.name + (r.ruleChain.root ? ' (-> the server root chain)' : '')).join(', ')}`);
  say(`widget types: ${lWT.map((t) => t.fqn).sort().join(', ')}`);
  say('Dry run only. Re-run with --go to migrate.');
  process.exit(0);
}

// ------------------------------------------------------------------ 0. backup of the new tenant
const day = new Date().toISOString().slice(0, 10);
const BK = `backups/${day}/new-tenant-before-migration`;
if (!existsSync(BK)) {
  mkdirSync(BK, { recursive: true });
  const bk = (n, d) => writeFileSync(`${BK}/${n}.json`, JSON.stringify(d, null, 1));
  bk('dashboards', await T.all('/api/tenant/dashboards'));
  const rcs = []; for (const r of await T.all('/api/ruleChains')) rcs.push({ ruleChain: r, metadata: await T.api('GET', `/api/ruleChain/${r.id.id}/metadata`) });
  bk('rule-chains', rcs);
  for (const [n, p] of [['device-profiles', '/api/deviceProfiles'], ['asset-profiles', '/api/assetProfiles'], ['customers', '/api/customers'], ['users', '/api/users'], ['assets', '/api/tenant/assets'], ['devices', '/api/tenant/devices'], ['widget-types', '/api/widgetTypes?tenantOnly=true']]) bk(n, await T.all(p));
  say(`backup of the new tenant -> ${BK}`);
} else say(`backup already in ${BK} (kept)`);

// ------------------------------------------------------------------ 1. customer, root chain
let tCust = await T.api('GET', `/api/tenant/customers?customerTitle=${encodeURIComponent(CUSTOMER.server)}`, undefined, { allow404: true });
if (!tCust) tCust = await w('POST', '/api/customer', { title: CUSTOMER.server, email: lCust.email, country: lCust.country, city: lCust.city, additionalInfo: lCust.additionalInfo });
idmap[lCust.id.id] = tCust.id.id;
const tRCs = await T.all('/api/ruleChains');
idmap[lRC.find((r) => r.ruleChain.root).ruleChain.id.id] = tRCs.find((r) => r.root).id.id;
saveMap();
say(`customer ${CUSTOMER.server}: ${tCust.id.id}`);

// ------------------------------------------------------------------ 2. rule chain shells (content after the machines exist)
for (const { ruleChain: r } of lRC) {
  if (r.root) continue;
  let t = tRCs.find((x) => x.name === r.name);
  if (!t) t = await w('POST', '/api/ruleChain', { name: r.name, type: r.type, debugMode: false, configuration: r.configuration, additionalInfo: r.additionalInfo });
  idmap[r.id.id] = t.id.id;
}
saveMap();

// ------------------------------------------------------------------ 3. images (logos, Builder pictures)
for (const im of lImages) {
  const exists = await T.api('GET', `/api/images/tenant/${encodeURIComponent(im.resourceKey)}/info`, undefined, { allow404: true });
  if (exists) continue;
  const data = await L.api('GET', `/api/images/tenant/${encodeURIComponent(im.resourceKey)}/export`);
  await w('PUT', '/api/image/import', data);
}
say(`images: ${lImages.length}`);

// ------------------------------------------------------------------ 4. profiles
const tDPs = await T.all('/api/deviceProfiles');
for (const p of lDP) {
  if (p.default) { idmap[p.id.id] = tDPs.find((x) => x.default).id.id; continue; }
  const body = remap(strip(p, 'provisionDeviceKey', 'firmwareId', 'softwareId', 'defaultEdgeRuleChainId', 'defaultDashboardId', 'defaultQueueName'));
  body.default = false;
  if (body.profileData) body.profileData.provisionConfiguration = { type: 'DISABLED', provisionDeviceSecret: null };
  const t = tDPs.find((x) => x.name === p.name);
  if (t) Object.assign(body, { id: t.id, version: (await T.api('GET', `/api/deviceProfile/${t.id.id}`)).version });
  idmap[p.id.id] = (await w('POST', '/api/deviceProfile', body)).id.id;
}
const tAPs = await T.all('/api/assetProfiles');
for (const p of lAP) {
  if (p.default) { idmap[p.id.id] = tAPs.find((x) => x.default).id.id; continue; }
  const body = remap(strip(p, 'defaultEdgeRuleChainId', 'defaultDashboardId', 'defaultQueueName'));
  body.default = false;
  // a default rule chain that is not on the server (yet) is left out
  if (p.defaultRuleChainId && !idmap[p.defaultRuleChainId.id]) delete body.defaultRuleChainId;
  const t = tAPs.find((x) => x.name === p.name);
  if (t) Object.assign(body, { id: t.id, version: (await T.api('GET', `/api/assetProfile/${t.id.id}`)).version });
  idmap[p.id.id] = (await w('POST', '/api/assetProfile', body)).id.id;
}
saveMap();
say(`profiles: device ${lDP.length}, asset ${lAP.length}`);

// ------------------------------------------------------------------ 5. assets and machines, owned as on local
const ents = [...lAssets.map((e) => ['ASSET', e]), ...lDevices.map((e) => ['DEVICE', e])];
for (const [type, e] of ents) {
  const path = type === 'ASSET' ? 'asset' : 'device';
  let t = await T.api('GET', `/api/tenant/${path}s?${path}Name=${encodeURIComponent(e.name)}`, undefined, { allow404: true });
  if (!t) {
    const body = { name: e.name, label: e.label, additionalInfo: e.additionalInfo };
    if (type === 'ASSET') body.assetProfileId = ref('ASSET_PROFILE', idmap[e.assetProfileId.id]);
    else body.deviceProfileId = ref('DEVICE_PROFILE', idmap[e.deviceProfileId.id]);
    t = await w('POST', `/api/${path}`, body); // a new machine gets a new access token from ThingsBoard
  }
  idmap[e.id.id] = t.id.id;
  const owned = e.customerId && e.customerId.id === lCust.id.id;
  if (owned && (!t.customerId || t.customerId.id !== tCust.id.id)) await w('POST', `/api/customer/${tCust.id.id}/${path}/${t.id.id}`);
}
saveMap();
say(`assets ${lAssets.length}, machines ${lDevices.length}`);

// attributes (secrets left out), latest values, relations
let nAttr = 0, nRel = 0, nTs = 0;
for (const [type, e] of ents) {
  const id = idmap[e.id.id];
  for (const scope of type === 'DEVICE' ? ['SERVER_SCOPE', 'SHARED_SCOPE'] : ['SERVER_SCOPE']) {
    const list = (await L.api('GET', `/api/plugins/telemetry/${type}/${e.id.id}/values/attributes/${scope}`, undefined, { allow404: true })) || [];
    const vals = {};
    for (const a of list) if (!SKIP_ATTR(a.key)) vals[a.key] = remap(a.value);
    if (Object.keys(vals).length) { await w('POST', `/api/plugins/telemetry/${type}/${id}/attributes/${scope}`, vals); nAttr += Object.keys(vals).length; }
  }
  const keys = (await L.api('GET', `/api/plugins/telemetry/${type}/${e.id.id}/keys/timeseries`, undefined, { allow404: true })) || [];
  if (keys.length) {
    const latest = await L.api('GET', `/api/plugins/telemetry/${type}/${e.id.id}/values/timeseries?keys=${keys.map(encodeURIComponent).join(',')}&useStrictDataTypes=true`);
    const byTs = {};
    for (const [k, pts] of Object.entries(latest || {})) for (const p of pts || []) (byTs[p.ts] ||= {})[k] = p.value;
    const batch = Object.entries(byTs).map(([ts, values]) => ({ ts: Number(ts), values }));
    if (batch.length) { await w('POST', `/api/plugins/telemetry/${type}/${id}/timeseries/ANY`, batch); nTs += keys.length; }
  }
  for (const r of (await L.api('GET', `/api/relations?fromId=${e.id.id}&fromType=${type}`, undefined, { allow404: true })) || []) {
    if (!idmap[r.to.id]) continue;
    await w('POST', '/api/relation', { from: ref(type, id), to: ref(r.to.entityType, idmap[r.to.id]), type: r.type, typeGroup: r.typeGroup || 'COMMON', additionalInfo: r.additionalInfo });
    nRel++;
  }
}
say(`attributes ${nAttr}, latest values of ${nTs} keys, relations ${nRel}`);

// ------------------------------------------------------------------ 6. rule chain content (machines are known now)
for (const { ruleChain: r, metadata: m } of lRC) {
  if (r.root) continue;
  const id = idmap[r.id.id];
  const cur = await T.api('GET', `/api/ruleChain/${id}/metadata`);
  const nodes = remap(m.nodes).map((n) => {
    const node = strip(n, 'ruleChainId', 'debugMode', 'debugSettings');
    node.debugSettings = { failuresEnabled: false, allEnabled: false, allEnabledUntil: 0 };
    return node;
  });
  await w('POST', '/api/ruleChain/metadata', { ruleChainId: ref('RULE_CHAIN', id), version: cur.version, firstNodeIndex: m.firstNodeIndex, nodes, connections: m.connections, ruleChainConnections: m.ruleChainConnections });
  say(`rule chain ${r.name}: ${nodes.length} nodes`);
}
// asset / device profiles that point at rule chains are saved again now that the chains have server ids
for (const p of lAP.filter((x) => x.defaultRuleChainId && !x.default && idmap[x.defaultRuleChainId.id])) {
  const cur = await T.api('GET', `/api/assetProfile/${idmap[p.id.id]}`);
  if (!cur.defaultRuleChainId || cur.defaultRuleChainId.id !== idmap[p.defaultRuleChainId.id]) await w('POST', '/api/assetProfile', { ...cur, defaultRuleChainId: ref('RULE_CHAIN', idmap[p.defaultRuleChainId.id]) });
}

// ------------------------------------------------------------------ 7. widget types and bundles
const tBundles = await T.all('/api/widgetsBundles?tenantOnly=true');
for (const t of lWT) {
  const descriptor = JSON.parse(toServerLibs(JSON.stringify(t.descriptor)));
  const body = { fqn: t.fqn, name: t.name, descriptor, description: t.description, image: t.image, tags: t.tags, deprecated: t.deprecated, scada: t.scada };
  const ex = await T.api('GET', `/api/widgetType?fqn=tenant.${t.fqn}`, undefined, { allow404: true });
  if (ex) Object.assign(body, { id: ex.id, version: ex.version });
  idmap[t.id.id] = (await w('POST', '/api/widgetType', body)).id.id;
}
for (const b of BUNDLES) {
  let tb = tBundles.find((x) => x.alias === b.alias);
  if (!tb) tb = await w('POST', '/api/widgetsBundle', { alias: b.alias, title: b.title, description: b.title });
  const fqns = lWT.map((t) => t.fqn).filter(b.test);
  await w('POST', `/api/widgetsBundle/${tb.id.id}/widgetTypeFqns`, fqns).catch((e) => say(`bundle ${b.title}: ${e.message.slice(0, 120)}`));
}
saveMap();
say(`widget types ${lWT.length} in ${BUNDLES.length} bundles`);

// ------------------------------------------------------------------ 8. the app dashboard
const conf = remap(lDash.configuration);
for (const wg of Object.values(conf.widgets || {})) {
  const s = wg.config && wg.config.settings;
  if (!s) continue;
  if (wg.typeFullFqn === 'tenant.imex_rpt_app') s.serviceUrl = REPORTS_URL;
  if (/^tenant\.aiml_/.test(wg.typeFullFqn)) s.serviceUrl = AIML_URL;
}
let tDash = (await T.all(`/api/tenant/dashboards?textSearch=${encodeURIComponent(APP_TITLE)}`)).find((d) => d.title === APP_TITLE);
const dashBody = { title: lDash.title, image: lDash.image, mobileHide: lDash.mobileHide, mobileOrder: lDash.mobileOrder, configuration: conf };
if (tDash) tDash = await w('POST', '/api/dashboard', Object.assign(await T.api('GET', `/api/dashboard/${tDash.id.id}`), dashBody));
else tDash = await w('POST', '/api/dashboard', dashBody);
idmap[lDash.id.id] = tDash.id.id;
if (!(tDash.assignedCustomers || []).some((c) => c.customerId.id === tCust.id.id)) await w('POST', `/api/customer/${tCust.id.id}/dashboard/${tDash.id.id}`);
saveMap();
say(`dashboard "${APP_TITLE}": ${tDash.id.id}`);

// ------------------------------------------------------------------ 9. users
const password = process.env.TGT_USER_PASSWORD;
if (!password) throw new Error('TGT_USER_PASSWORD is empty in .env');
const tUsers = await T.all('/api/users');
const tmpl = Object.fromEntries(tmplAttrs.map((a) => [a.key, a.value]));
for (const u of USERS) {
  const first = u.email.split('@')[0].toUpperCase();
  let t = tUsers.find((x) => x.email === u.email);
  const info = { ...Object.fromEntries(Object.entries(tmplUser.additionalInfo || {}).filter(([k]) => USER_INFO_KEYS.includes(k))), homeDashboardId: tDash.id.id, defaultDashboardId: tDash.id.id };
  if (!t) {
    t = await w('POST', '/api/user?sendActivationMail=false', { email: u.email, firstName: first, lastName: '', authority: 'CUSTOMER_USER', customerId: ref('CUSTOMER', tCust.id.id), additionalInfo: info });
    const link = await T.api('GET', `/api/user/${t.id.id}/activationLink`, undefined, { raw: true });
    const token = new URL(link.toString().trim().replace(/^"|"$/g, '')).searchParams.get('activateToken');
    await T.api('POST', '/api/noauth/activate?sendActivationMail=false', { activateToken: token, password });
    say(`user ${u.email} created and activated`);
  }
  const vals = { ...remap(tmpl), Role: u.role, firstName: first, lastName: '', email: u.email, department: '', phone: '' };
  delete vals.authToken;
  await w('POST', `/api/plugins/telemetry/USER/${t.id.id}/attributes/SERVER_SCOPE`, vals);
}
say(`users: ${USERS.length}`);

// Builder documents name their author by user id: local ITHENA users (not migrated) become the first admin, and the
// asset attributes that mention them are written again
const firstAdmin = (await T.all('/api/users')).find((x) => x.email === USERS[0].email);
for (const u of await L.all(`/api/customer/${lCust.id.id}/users`)) idmap[u.id.id] ||= firstAdmin.id.id;
saveMap();
for (const a of lAssets) {
  const list = (await L.api('GET', `/api/plugins/telemetry/ASSET/${a.id.id}/values/attributes/SERVER_SCOPE`)) || [];
  const vals = {};
  for (const x of list) if (!SKIP_ATTR(x.key) && /[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(x.value))) vals[x.key] = remap(x.value);
  if (Object.keys(vals).length) await w('POST', `/api/plugins/telemetry/ASSET/${idmap[a.id.id]}/attributes/SERVER_SCOPE`, vals);
}
say('Builder documents: authors mapped to ' + USERS[0].email);

// ------------------------------------------------------------------ 10. the stored tenant token the alert and user pages use
// (System Configuration authToken, as on the existing server tenant; a login token there lasts about 2.8 years)
const sys = lAssets.find((a) => a.name === 'System Configuration');
await w('POST', `/api/plugins/telemetry/ASSET/${idmap[sys.id.id]}/attributes/SERVER_SCOPE`, { authToken: T.token() });
const exp = JSON.parse(Buffer.from(T.token().split('.')[1], 'base64url').toString()).exp;
say(`authToken set on "System Configuration", valid until ${new Date(exp * 1000).toISOString().slice(0, 10)}`);
say('done. Next: AIML backfill (90 days) and, once the LLM key is on DBBLLM-CONFIG, install-native-ai.');
