// LOCAL ONLY. Puts a long-lived token of the local tenant admin on the asset "System Configuration" (attribute
// authToken), which the developers' widgets (alerts, user management, listing) read. The server has such a
// token too; it was not copied.
//   node scripts/mirror/local-authtoken.mjs [days]      default 365
// How: as the local system administrator, the token lifetime is raised, the tenant admin logs in once, and the
// lifetime is set back. Nothing is printed except the expiry date. The signing key is not changed, so existing
// logins stay valid.
import 'dotenv/config';

const base = (process.env.TB_URL || '').replace(/\/+$/, '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error(`TB_URL is not a local ThingsBoard (${base}); this script only runs on local.`);
const days = Number(process.argv[2]) || 365;
const ASSET = 'System Configuration';

const login = async (username, password, who) => {
  if (!username || !password) throw new Error(`${who}: user name / password missing in .env`);
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`${who}: login -> ${r.status} (check .env)`);
  return (await r.json()).token;
};
const call = async (token, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'X-Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};

const sys = await login(process.env.TB_SYSADMIN_USERNAME, process.env.TB_SYSADMIN_PASSWORD, 'system administrator');
const before = await call(sys, 'GET', '/api/admin/jwtSettings');
const seconds = days * 86400;
let long;
try {
  await call(sys, 'POST', '/api/admin/jwtSettings', { ...before, tokenExpirationTime: seconds, refreshTokenExpTime: Math.max(before.refreshTokenExpTime, seconds + 86400) });
  long = await login(process.env.TB_TENANT_USERNAME, process.env.TB_TENANT_PASSWORD, 'tenant admin');
} finally {
  // saving the settings returns a new token for the system administrator; the old one keeps working here
  await call(sys, 'POST', '/api/admin/jwtSettings', before).catch(async () => call(await login(process.env.TB_SYSADMIN_USERNAME, process.env.TB_SYSADMIN_PASSWORD, 'system administrator'), 'POST', '/api/admin/jwtSettings', before));
}
const after = await call(await login(process.env.TB_SYSADMIN_USERNAME, process.env.TB_SYSADMIN_PASSWORD, 'system administrator'), 'GET', '/api/admin/jwtSettings');
console.log(`token lifetime setting back to ${after.tokenExpirationTime} s (was ${before.tokenExpirationTime} s)`);

const exp = JSON.parse(Buffer.from(long.split('.')[1], 'base64url').toString()).exp;
const asset = await call(long, 'GET', `/api/tenant/assets?assetName=${encodeURIComponent(ASSET)}`);
await call(long, 'POST', `/api/plugins/telemetry/ASSET/${asset.id.id}/attributes/SERVER_SCOPE`, { authToken: long });
console.log(`authToken set on "${ASSET}" (local tenant admin), valid until ${new Date(exp * 1000).toISOString().slice(0, 10)}`);
