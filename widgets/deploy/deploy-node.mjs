// Runs DBB_DEPLOY (deploy-browser.js) from Node instead of a browser console, with the tenant admin from .env.
//   npm run build:widgets
//   node widgets/deploy/deploy-node.mjs          shows the options it would use, deploys nothing
//   node widgets/deploy/deploy-node.mjs --go     deploys
// Options: deploy.local.json (git-ignored), same fields as DBB_DEPLOY's opts. When it has no `profileKeys`, the
// catalogue already stored on the store asset (dbb_profile_keys) is passed back unchanged, because DBB_DEPLOY
// overwrites it and its own default `{}` would wipe it. `userEmails` defaults to [] (home dashboards untouched).
// The JWT is held in memory only (tb-node.mjs); the script prints DBB_DEPLOY's log, never the token.
import { readFileSync, existsSync } from 'node:fs';
import { tbLogin, serverAttrs } from './tb-node.mjs';

const opts = Object.assign(
  { customerTitle: 'ITHENA', storeName: 'DBB-STORE-ITHENA', userEmails: [] },
  existsSync('deploy.local.json') ? JSON.parse(readFileSync('deploy.local.json', 'utf8')) : {},
);
const { base, token, api } = await tbLogin();

if (!opts.profileKeys) {
  const store = await api('GET', `/api/tenant/assets?assetName=${encodeURIComponent(opts.storeName)}`, undefined, true);
  const pk = store ? (await serverAttrs(api, 'ASSET', store.id.id)).dbb_profile_keys : null;
  opts.profileKeys = pk ? (typeof pk === 'string' ? JSON.parse(pk) : pk) : {};
}
const glue = JSON.parse(readFileSync('widgets/dist/glue.json', 'utf8'));
console.log(`target ${base}, build ${glue.version}`);
console.log(`customer ${opts.customerTitle}, store ${opts.storeName}, home dashboards for ${opts.userEmails.length} users`);
console.log(`profileKeys: ${Object.entries(opts.profileKeys).map(([p, ks]) => `${p} (${ks.length})`).join(', ') || 'EMPTY (the store catalogue will be cleared)'}`);
if (!process.argv.includes('--go')) {
  console.log('Dry run. Re-run with --go to deploy.');
  process.exit(0);
}

// deploy-browser.js expects a browser page: window, localStorage.jwt_token and relative /api paths.
globalThis.window = globalThis;
// defineProperty: newer Node versions have their own localStorage global
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (k === 'jwt_token' ? token() : null) }, configurable: true });
const nodeFetch = globalThis.fetch;
globalThis.fetch = (url, init) => nodeFetch(typeof url === 'string' && url.startsWith('/') ? base + url : url, init);
window.__dbbLib = readFileSync('widgets/dist/imex-dbb.js', 'utf8');
window.__dbbGlue = glue;
await import('./deploy-browser.js');
const res = await window.DBB_DEPLOY(opts);
console.log(JSON.stringify({ dashboardId: res.dashboardId, storeId: res.storeId, ruleChainId: res.ruleChainId, bundleId: res.bundleId }, null, 2));
