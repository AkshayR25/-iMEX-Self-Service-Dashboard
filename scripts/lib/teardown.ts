// Teardown (build instructions 4.4). Deletes only entities carrying poc=true, and profiles carrying the POC marker.

import { TbClient, Log, fetchAll, EntityId } from './tb';
import { CUSTOMER_TITLE, POC_MARKER } from './model';

export interface TeardownPlan {
  devices: { id: string; name: string }[];
  assets: { id: string; name: string }[];
  customers: { id: string; name: string }[];
  deviceProfiles: { id: string; name: string }[];
  assetProfiles: { id: string; name: string }[];
}

const eid = (id: string, entityType: string): EntityId => ({ id, entityType });

/** Lists everything teardown would delete. Checks the poc attribute on every candidate. */
export async function planTeardown(tb: TbClient, log: Log): Promise<TeardownPlan> {
  const plan: TeardownPlan = { devices: [], assets: [], customers: [], deviceProfiles: [], assetProfiles: [] };

  const devices = await fetchAll<any>(tb, '/api/tenant/devices');
  for (const d of devices) if (await tb.isPoc(eid(d.id.id, 'DEVICE'))) plan.devices.push({ id: d.id.id, name: d.name });

  const assets = await fetchAll<any>(tb, '/api/tenant/assets');
  for (const a of assets) if (await tb.isPoc(eid(a.id.id, 'ASSET'))) plan.assets.push({ id: a.id.id, name: a.name });

  const customer = await tb.find<any>(`/api/tenant/customers?customerTitle=${encodeURIComponent(CUSTOMER_TITLE)}`);
  if (customer && (await tb.isPoc(eid(customer.id.id, 'CUSTOMER'))))
    plan.customers.push({ id: customer.id.id, name: customer.title });

  for (const p of await fetchAll<any>(tb, '/api/deviceProfiles'))
    if (String(p.description ?? '').includes(POC_MARKER)) plan.deviceProfiles.push({ id: p.id.id, name: p.name });
  for (const p of await fetchAll<any>(tb, '/api/assetProfiles'))
    if (String(p.description ?? '').includes(POC_MARKER)) plan.assetProfiles.push({ id: p.id.id, name: p.name });

  log(
    `teardown plan: ${plan.devices.length} devices, ${plan.assets.length} assets, ${plan.customers.length} customers, ` +
      `${plan.deviceProfiles.length} device profiles, ${plan.assetProfiles.length} asset profiles`,
  );
  return plan;
}

export async function executeTeardown(tb: TbClient, plan: TeardownPlan, log: Log) {
  // re-check the marker right before each delete
  for (const d of plan.devices) {
    if (!(await tb.isPoc(eid(d.id, 'DEVICE')))) { log(`skip device ${d.name}: poc missing`); continue; }
    await tb.del(`/api/device/${d.id}`);
    log(`deleted device ${d.name}`);
  }
  for (const a of plan.assets) {
    if (!(await tb.isPoc(eid(a.id, 'ASSET')))) { log(`skip asset ${a.name}: poc missing`); continue; }
    await tb.del(`/api/asset/${a.id}`);
    log(`deleted asset ${a.name}`);
  }
  for (const c of plan.customers) {
    if (!(await tb.isPoc(eid(c.id, 'CUSTOMER')))) { log(`skip customer ${c.name}: poc missing`); continue; }
    await tb.del(`/api/customer/${c.id}`);
    log(`deleted customer ${c.name}`);
  }
  for (const p of plan.deviceProfiles) {
    try { await tb.del(`/api/deviceProfile/${p.id}`); log(`deleted device profile ${p.name}`); }
    catch (e) { log(`could not delete device profile ${p.name}: ${(e as Error).message}`); }
  }
  for (const p of plan.assetProfiles) {
    try { await tb.del(`/api/assetProfile/${p.id}`); log(`deleted asset profile ${p.name}`); }
    catch (e) { log(`could not delete asset profile ${p.name}: ${(e as Error).message}`); }
  }
}
