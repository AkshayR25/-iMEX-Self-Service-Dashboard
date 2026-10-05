// Read-only: who each .env login is (authority, tenant) and the ThingsBoard version. Prints no secrets.
import { sourceClient, targetClient } from './clients.mjs';
for (const mk of [sourceClient, targetClient]) {
  try {
    const c = await mk();
    const u = await c.api('GET', '/api/auth/user');
    const ver = await c.api('GET', '/api/system/info', undefined, { allow404: true }).catch((e) => ({ err: e.message.slice(0, 80) }));
    console.log(`${c.label} ${c.base}: ${u.authority}, tenant ${u.tenantId.id}, version ${ver?.version ?? JSON.stringify(ver)}`);
  } catch (e) {
    console.log(e.message);
  }
}
