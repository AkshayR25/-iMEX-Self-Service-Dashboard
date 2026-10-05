// Read-only check of the Dashboard Builder footprint on a ThingsBoard tenant (.env), and optional backup.
//   node widgets/deploy/check-tb.mjs            prints what is deployed (build ids, dashboard states, relay, store)
//   node widgets/deploy/check-tb.mjs --backup   also saves JSON of everything DBB_DEPLOY overwrites to backups/<date>/
// Names come from deploy.local.json (git-ignored; same file as deploy-node.mjs), else the DBB_DEPLOY defaults.
// Never prints the JWT or the LLM key (only "set" / "empty"); the LLM config asset's attributes are not backed up.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tbLogin, serverAttrs } from './tb-node.mjs';

const opts = Object.assign(
  { customerTitle: 'ITHENA', storeName: 'DBB-STORE-ITHENA', appTitle: 'iMEX App (POC)', bundleTitle: 'iMEX Self-Service (POC)', llmConfigName: 'DBB-LLM-CONFIG' },
  existsSync('deploy.local.json') ? JSON.parse(readFileSync('deploy.local.json', 'utf8')) : {},
);
const backup = process.argv.includes('--backup');
const dir = `backups/${new Date().toISOString().slice(0, 10)}`;
const save = (name, data) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, JSON.stringify(data, null, 2));
};
// A key pasted into a REST node header (pre-D-021 "Call LLM") must not land in a backup file.
const redactHeaders = (meta) => {
  for (const n of meta.nodes || []) {
    const h = n.configuration && n.configuration.headers;
    if (h) for (const k of Object.keys(h)) if (/key|authorization/i.test(k) && !String(h[k]).includes('${')) h[k] = '<redacted>';
  }
  return meta;
};

const { base, api, all } = await tbLogin();
const out = (s) => console.log(s);
out(`ThingsBoard: ${base}`);
const localBuild = JSON.parse(readFileSync('widgets/dist/glue.json', 'utf8')).version;
out(`local build (widgets/dist): ${localBuild}`);

const customer = await api('GET', `/api/tenant/customers?customerTitle=${encodeURIComponent(opts.customerTitle)}`, undefined, true);
out(`customer "${opts.customerTitle}": ${customer ? customer.id.id : 'NOT FOUND'}`);

// --- app dashboard
const dash = (await all(`/api/tenant/dashboards?textSearch=${encodeURIComponent(opts.appTitle)}`)).find((d) => d.title === opts.appTitle);
if (dash) {
  const full = await api('GET', `/api/dashboard/${dash.id.id}`);
  const cfg = full.configuration || {};
  const assigned = (full.assignedCustomers || []).map((c) => c.title).join(', ');
  out(`dashboard "${opts.appTitle}": ${dash.id.id}, assigned to: ${assigned || '-'}`);
  const foreign = new Set();
  for (const [sid, st] of Object.entries(cfg.states || {})) {
    const fq = [];
    for (const l of Object.values(st.layouts || {})) for (const wid of Object.keys(l.widgets || {})) fq.push((cfg.widgets[wid] || {}).typeFullFqn || '?');
    fq.filter((f) => !f.startsWith('tenant.imex_dbb_')).forEach((f) => foreign.add(f));
    out(`  state ${sid} ("${st.name}"): ${fq.join(', ')}`);
  }
  out(foreign.size ? `  NOT OURS: ${[...foreign].join(', ')}  -> do not let DBB_DEPLOY overwrite this dashboard` : '  only tenant.imex_dbb_* widgets (safe to overwrite)');
  if (backup) save('dashboard-app.json', full);
} else out(`dashboard "${opts.appTitle}": not found`);

// --- widget bundle + types
const bundle = (await all('/api/widgetsBundles?tenantOnly=true')).find((b) => b.title === opts.bundleTitle);
out(`bundle "${opts.bundleTitle}": ${bundle ? bundle.id.id : 'not found'}`);
if (bundle) {
  const fqns = await api('GET', `/api/widgetsBundle/${bundle.id.id}/widgetTypeFqns`, undefined, true);
  out(`  widget types in bundle: ${(fqns || []).join(', ')}`);
  if (backup) save('widgets-bundle.json', { bundle, fqns });
}
for (const k of ['launcher', 'renderer', 'listing']) {
  const ref = await api('GET', `/api/widgetType?fqn=tenant.imex_dbb_${k}`, undefined, true);
  if (!ref) { out(`  imex_dbb_${k}: not found`); continue; }
  const wt = await api('GET', `/api/widgetType/${ref.id.id}`);
  const built = (String(wt.description || '').match(/built (\S+)/) || [])[1] || '?';
  out(`  imex_dbb_${k}: built ${built}${built === localBuild ? ' (= local)' : ''}`);
  if (backup) save(`widget-type-${k}.json`, wt);
}

// --- relay rule chain + profile
const rcName = 'DBB Chat relay (POC)';
const rc = (await all(`/api/ruleChains?textSearch=${encodeURIComponent(rcName)}`)).find((x) => x.name === rcName);
if (rc) {
  const meta = await api('GET', `/api/ruleChain/${rc.id.id}/metadata`);
  const build = (meta.nodes || []).find((n) => n.name === 'Build LLM request');
  const script = (build && build.configuration && build.configuration.tbelScript) || '';
  const debug = (meta.nodes || []).filter((n) => n.debugMode || (n.debugSettings && (n.debugSettings.failuresEnabled || n.debugSettings.allEnabled))).map((n) => n.name);
  out(`relay "${rcName}": ${rc.id.id}, ${meta.nodes.length} nodes; D-028 checks (USER_MISMATCH/TOO_BIG/BAD_TOOL): ${['USER_MISMATCH', 'TOO_BIG', 'BAD_TOOL'].every((s) => script.includes(s)) ? 'yes' : 'NO (pre-D-028)'}; debug on: ${debug.join(', ') || 'none'}`);
  if (backup) save('rulechain-relay.json', { ruleChain: await api('GET', `/api/ruleChain/${rc.id.id}`), metadata: redactHeaders(meta) });
} else out(`relay "${rcName}": not found`);
const ap = (await all('/api/assetProfiles?textSearch=DashboardStore')).find((x) => x.name === 'DashboardStore');
if (ap) {
  const full = await api('GET', `/api/assetProfile/${ap.id.id}`);
  out(`asset profile DashboardStore: marker ${String(full.description || '').includes('[poc=true]') ? 'yes' : 'NO'}, default rule chain = relay: ${rc && full.defaultRuleChainId && full.defaultRuleChainId.id === rc.id.id ? 'yes' : 'no'}`);
  if (backup) save('asset-profile-dashboardstore.json', full);
}

// --- store asset
const store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(opts.storeName)}`, undefined, true);
if (store) {
  const a = await serverAttrs(api, 'ASSET', store.id.id);
  const pk = a.dbb_profile_keys ? (typeof a.dbb_profile_keys === 'string' ? JSON.parse(a.dbb_profile_keys) : a.dbb_profile_keys) : {};
  out(`store "${opts.storeName}": ${store.id.id}, customer ${store.customerId && customer && store.customerId.id === customer.id.id ? 'ok' : 'MISMATCH'}`);
  out(`  dbb_lib_version: ${a.dbb_lib_version || '-'}${a.dbb_lib_version === localBuild ? ' (= local)' : ''}`);
  out(`  dbb_profile_keys: ${Object.entries(pk).map(([p, ks]) => `${p} (${ks.length})`).join(', ') || 'EMPTY'}`);
  out(`  dashboards (dbb_d_*): ${Object.keys(a).filter((k) => k.startsWith('dbb_d_')).length}`);
  if (backup) save('store-attributes.json', a);
} else out(`store "${opts.storeName}": not found`);

// --- LLM config asset (key status only)
const cfgAsset = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(opts.llmConfigName)}`, undefined, true);
if (cfgAsset) {
  const a = await serverAttrs(api, 'ASSET', cfgAsset.id.id);
  const owned = !cfgAsset.customerId || cfgAsset.customerId.id === '13814000-1dd2-11b2-8080-808080808080';
  out(`${opts.llmConfigName}: ${cfgAsset.id.id}, tenant-owned: ${owned ? 'yes' : 'NO (customer-assigned!)'}, key: ${a.dbb_llm_api_key ? 'set' : 'empty'}, models: ${['anthropic', 'openai', 'gemini'].map((p) => `${p}=${a['dbb_llm_model_' + p] || '-'}`).join(' ')}`);
} else out(`${opts.llmConfigName}: not found`);

if (backup) out(`backup written to ${dir}/`);
