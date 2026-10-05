// Node helper for the deploy and check scripts: loads .env, logs in as the tenant admin and returns a tiny
// REST client. The JWT stays in this module's memory; it is never printed or written to disk.
// .env (git-ignored, filled by the user): TB_URL, TB_TENANT_USERNAME, TB_TENANT_PASSWORD.
import 'dotenv/config';

/** Logs in and returns {base, token(), api(method, path, body, allow404), all(path)}. Exits when .env is incomplete. */
export async function tbLogin() {
  const base = (process.env.TB_URL || '').replace(/\/+$/, '');
  const username = process.env.TB_TENANT_USERNAME;
  const password = process.env.TB_TENANT_PASSWORD;
  if (!base || !username || !password) {
    console.error('Missing TB_URL / TB_TENANT_USERNAME / TB_TENANT_PASSWORD in .env (copy .env.example).');
    process.exit(1);
  }
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error(`login -> ${r.status} (check the credentials in .env)`);
  const { token } = await r.json();
  const headers = () => ({ 'X-Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' });
  // Same contract as the api() helper in deploy-browser.js: JSON in/out, null for 404 when allow404.
  const api = async (method, path, body, allow404) => {
    const res = await fetch(base + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await res.text();
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  };
  const all = async (path) => {
    const out = [];
    for (let p = 0; ; p++) {
      const pg = await api('GET', `${path}${path.includes('?') ? '&' : '?'}pageSize=100&page=${p}`);
      out.push(...pg.data);
      if (!pg.hasNext) return out;
    }
  };
  return { base, token: () => token, api, all };
}

/** SERVER_SCOPE attributes of an entity as {key: value}. */
export async function serverAttrs(api, type, id) {
  const o = {};
  for (const a of (await api('GET', `/api/plugins/telemetry/${type}/${id}/values/attributes/SERVER_SCOPE`)) || []) o[a.key] = a.value;
  return o;
}
