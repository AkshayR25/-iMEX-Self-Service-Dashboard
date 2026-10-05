// REST clients for copying the iMEX demo app from the server (SOURCE) to the local ThingsBoard (TARGET).
// SOURCE is strictly read-only (user rule: never change anything on iserv-demov2): every call is checked
// against READ_ONLY_POST before it is sent; anything else that is not a GET throws without a request.
// Credentials come from .env (SRC_TB_* and TB_*); tokens stay in memory and are never printed.
import 'dotenv/config';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST endpoints that only read (queries); login/refresh are allowed separately.
const READ_ONLY_POST = [/^\/api\/entitiesQuery\/find$/, /^\/api\/entitiesQuery\/count$/, /^\/api\/alarmsQuery\/find$/];
// GETs that change state or hand out credentials (star/unstar a dashboard, user tokens, activation links,
// the device API, OAuth flows, device credentials): refused on the source as well.
const SIDE_EFFECT_GET = [/^\/api\/user\/[^/]+\/token$/, /activationLink/, /^\/api\/user\/dashboards\/[^/]+\/[^/]+$/, /^\/api\/noauth\//, /^\/api\/v1\//, /oauth2\/(authorize|code)/, /\/credentials/];

async function makeClient({ base, username, password, refreshToken, minDelayMs, readOnly, label }) {
  base = (base || '').replace(/\/+$/, '');
  if (!base || !((username && password) || refreshToken)) throw new Error(`${label}: URL and credentials missing in .env`);
  let token = null;
  const login = async () => {
    const r = username && password
      ? await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
      : await fetch(`${base}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
    if (!r.ok) throw new Error(`${label}: login -> ${r.status} (check .env)`);
    const j = await r.json();
    token = j.token;
    if (j.refreshToken) refreshToken = j.refreshToken;
  };
  await login();
  let last = 0;
  const api = async (method, path, body, { allow404 = false, raw = false } = {}) => {
    const p = path.split('?')[0];
    if (readOnly && ((method !== 'GET' && !(method === 'POST' && READ_ONLY_POST.some((re) => re.test(p)))) || (method === 'GET' && SIDE_EFFECT_GET.some((re) => re.test(p)))))
      throw new Error(`${label} is read-only: refused ${method} ${path}`);
    for (let attempt = 0; ; attempt++) {
      const wait = last + minDelayMs - Date.now();
      if (wait > 0) await sleep(wait);
      let res;
      try {
        res = await fetch(base + path, { method, headers: { 'X-Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', Accept: raw ? '*/*' : 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        last = Date.now();
        if (attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
        throw e;
      }
      last = Date.now();
      if (res.status === 401 && attempt === 0) { await login(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
      if (res.status === 404 && allow404) return null;
      if (raw) {
        if (!res.ok) throw new Error(`${label} ${method} ${path} -> ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      }
      const t = await res.text();
      if (!res.ok) throw new Error(`${label} ${method} ${path} -> ${res.status}: ${t.slice(0, 300)}`);
      return t ? JSON.parse(t) : null;
    }
  };
  const all = async (path) => {
    const out = [];
    for (let p = 0; ; p++) {
      const pg = await api('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${p}`);
      out.push(...pg.data);
      if (!pg.hasNext) return out;
    }
  };
  return { base, label, api, all, token: () => token };
}

/** The server (iserv-demov2): read-only. */
export const sourceClient = () =>
  makeClient({ label: 'SOURCE', readOnly: true, base: process.env.SRC_TB_URL, username: process.env.SRC_TB_USERNAME, password: process.env.SRC_TB_PASSWORD, refreshToken: process.env.SRC_TB_REFRESH_TOKEN, minDelayMs: Number(process.env.SRC_TB_MIN_DELAY_MS ?? 150) });

/** The local ThingsBoard (shared with Self-Service Reports). */
export const targetClient = () =>
  makeClient({ label: 'LOCAL', readOnly: false, base: process.env.TB_URL, username: process.env.TB_TENANT_USERNAME, password: process.env.TB_TENANT_PASSWORD, minDelayMs: Number(process.env.TB_MIN_DELAY_MS ?? 0) });
