// Read only. For widget types edited on the NEW tenant by hand: every saved version from the tenant's audit log (who,
// when), the version on the server now and the new local version (with the server's library paths), written as files
// to backups/<today>/widget-history/<fqn>/ so they can be compared and merged (git merge-file).
//   node scripts/mirror/widget-history.mjs imex_machine_cards imex_org_hierarchy imex_user_management
import { mkdirSync, writeFileSync } from 'node:fs';
import { newTenantClient, targetClient } from './clients.mjs';
import { CDN_MAP } from './cdn-map.mjs';

const toServerLibs = (s) => { for (const [path, url] of Object.entries(CDN_MAP)) s = s.split(url).join(path); return s; };
const fqns = process.argv.slice(2);
const T = await newTenantClient();
const L = await targetClient(); // LOCAL (named target in clients.mjs): read only here
const day = new Date().toISOString().slice(0, 10);
const PARTS = ['controllerScript', 'templateHtml', 'templateCss', 'settingsSchema', 'dataKeySettingsSchema', 'defaultConfig'];
function dump(dir, d) {
  mkdirSync(dir, { recursive: true });
  for (const p of PARTS) if (d[p] !== undefined) writeFileSync(`${dir}/${p}.txt`, typeof d[p] === 'string' ? d[p] : JSON.stringify(d[p], null, 2));
  writeFileSync(`${dir}/resources.json`, JSON.stringify(d.resources || [], null, 2));
}
for (const fqn of fqns) {
  const base = `backups/${day}/widget-history/${fqn}`;
  const cur = await T.api('GET', `/api/widgetType?fqn=tenant.${fqn}`);
  dump(`${base}/server-now`, cur.descriptor);
  const loc = await L.api('GET', `/api/widgetType?fqn=tenant.${fqn}`);
  dump(`${base}/local-new`, JSON.parse(toServerLibs(JSON.stringify(loc.descriptor))));
  const log = await T.api('GET', `/api/audit/logs/entity/WIDGET_TYPE/${cur.id.id}?pageSize=200&page=0&sortProperty=createdTime&sortOrder=ASC`);
  console.log(`== ${fqn}  (${log.data.length} audit entries)`);
  for (const a of log.data) {
    const t = new Date(a.createdTime).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const who = String(a.userName || '').replace(/@.*/, '');
    const ent = a.actionData && a.actionData.entity;
    console.log(`  ${new Date(a.createdTime).toISOString().slice(0, 19)}Z  ${a.actionType.padEnd(8)} ${who}${ent ? '' : '  (no entity saved)'}`);
    if (ent && ent.descriptor) dump(`${base}/${t}-${who}`, ent.descriptor);
  }
}
