// Teardown (build instructions 4.4). Deletes only entities carrying poc=true, and profiles carrying the POC marker.
// Two steps so a caller can show the plan and ask for confirmation (the Node entry asks the user to type
// DELETE): planTeardown (read-only) then executeTeardown.
// Also removes what widgets/deploy/deploy-browser.js creates (D-016): the "iMEX App (POC)" dashboard,
// POC-marked widget bundles and widget types, and POC-marked rule chains (the chat relay). The
// DashboardStore asset/profile are covered by the poc attribute / marker checks.

import { TbClient, Log, fetchAll, EntityId } from './tb';
import { CUSTOMER_TITLE, POC_MARKER } from './model';

/** Entities to delete, by kind. Fields other than devices/assets/customers/profiles may be missing in old plans. */
export interface TeardownPlan {
  devices: { id: string; name: string }[];
  assets: { id: string; name: string }[];
  customers: { id: string; name: string }[];
  deviceProfiles: { id: string; name: string }[];
  assetProfiles: { id: string; name: string }[];
  users: { id: string; name: string }[];
  dashboards: { id: string; name: string }[];
  widgetBundles: { id: string; name: string }[];
  widgetTypes: { id: string; name: string }[];
  ruleChains: { id: string; name: string }[];
}

const eid = (id: string, entityType: string): EntityId => ({ id, entityType });

/**
 * Lists everything teardown would delete. Checks the poc attribute on every candidate.
 * Selection: devices, assets and users (of customer ITHENA) with server attribute poc=true; the customer
 * ITHENA if it has poc=true; device/asset profiles, widget bundles, widget types and rule chains whose
 * description contains POC_MARKER; the dashboard titled "iMEX App (POC)" (by title only).
 * Read-only, but one attribute read per device/asset/user, so slow on a large tenant.
 */
export async function planTeardown(tb: TbClient, log: Log): Promise<TeardownPlan> {
  const plan: TeardownPlan = { devices: [], assets: [], customers: [], deviceProfiles: [], assetProfiles: [], users: [], dashboards: [], widgetBundles: [], widgetTypes: [], ruleChains: [] };

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

  if (customer) {
    for (const u of await fetchAll<any>(tb, `/api/customer/${customer.id.id}/users`))
      if (await tb.isPoc(eid(u.id.id, 'USER'))) plan.users.push({ id: u.id.id, name: u.email });
  }
  for (const d of await fetchAll<any>(tb, '/api/tenant/dashboards'))
    if (d.title === 'iMEX App (POC)') plan.dashboards.push({ id: d.id.id, name: d.title });
  for (const b of await fetchAll<any>(tb, '/api/widgetsBundles?tenantOnly=true'))
    if (String(b.description ?? '').includes(POC_MARKER)) plan.widgetBundles.push({ id: b.id.id, name: b.title });
  for (const fqn of ['imex_dbb_launcher', 'imex_dbb_renderer', 'imex_dbb_listing']) {
    const w = await tb.find<any>(`/api/widgetType?fqn=tenant.${fqn}`);
    if (w && String(w.description ?? '').includes(POC_MARKER)) plan.widgetTypes.push({ id: w.id.id, name: fqn });
  }
  for (const r of await fetchAll<any>(tb, '/api/ruleChains'))
    if (String(r.configuration?.description ?? '').includes(POC_MARKER)) plan.ruleChains.push({ id: r.id.id, name: r.name });
  log(
    `teardown plan: ${plan.devices.length} devices, ${plan.assets.length} assets, ${plan.customers.length} customers, ` +
      `${plan.deviceProfiles.length} device profiles, ${plan.assetProfiles.length} asset profiles`,
  );
  return plan;
}

/**
 * Deletes the planned entities: dashboards, users, widget types, bundles first; then devices, assets and
 * customers, re-checking poc=true right before each delete; then profiles (after the devices/assets that
 * use them) and rule chains. Only device/asset/customer deletes throw on failure; the rest are logged and skipped.
 */
export async function executeTeardown(tb: TbClient, plan: TeardownPlan, log: Log) {
  const quiet = async (what: string, path: string) => {
    try {
      await tb.del(path);
      log(`deleted ${what}`);
    } catch (e) {
      log(`could not delete ${what}: ${(e as Error).message}`);
    }
  };
  for (const d of plan.dashboards ?? []) await quiet(`dashboard ${d.name}`, `/api/dashboard/${d.id}`);
  for (const u of plan.users ?? []) await quiet(`user ${u.name}`, `/api/user/${u.id}`);
  for (const w of plan.widgetTypes ?? []) await quiet(`widget type ${w.name}`, `/api/widgetType/${w.id}`);
  for (const b of plan.widgetBundles ?? []) await quiet(`widget bundle ${b.name}`, `/api/widgetsBundle/${b.id}`);
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
  for (const r of plan.ruleChains ?? []) await quiet(`rule chain ${r.name}`, `/api/ruleChain/${r.id}`);
}
