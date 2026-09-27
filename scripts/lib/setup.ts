// Phase 1 setup (build instructions 4.1). Idempotent: every entity is looked up by name first.
// Only reuses entities that carry the POC marker; refuses to touch anything else.
// Creates or updates: asset profiles, device profiles (alarm rules re-applied every run, D-003), customer
// ITHENA, assets and devices (assigned to the customer, poc=true, default thresholds only where missing,
// D-007), and `Contains` relations. Throws NotPocError on a same-named non-POC entity (D-005, D-006).
// The result (IDs only, D-008) is saved by the caller as scripts/output/setup-result.json.

import { TbClient, EntityId, Log, fetchAll } from './tb';
import {
  ASSETS,
  ASSET_PROFILES,
  CUSTOMER_TITLE,
  DEVICES,
  DEVICE_PROFILES,
  POC_MARKER,
  RELATION_TYPE,
  APP_USERS,
  AlarmSpec,
  KeyMeta,
  defaultThresholds,
} from './model';

/** IDs and metadata of everything setup ensured; read later by backfill and the simulator. */
export interface SetupResult {
  tbUrl: string;
  tbVersion: string | null;
  createdAt: string;
  customer: { id: string; title: string };
  assetProfiles: Record<string, string>;
  deviceProfiles: Record<string, string>;
  assets: Record<string, { id: string; label: string; profile: string; parent: string | null }>;
  devices: Record<string, { id: string; label: string; profile: string; parent: string }>;
  relations: { from: string; to: string; type: string }[];
  profileKeys: Record<string, KeyMeta[]>;
  appUsers: typeof APP_USERS;
  summary: { created: string[]; reused: string[] };
}

/** A same-named entity exists without the POC marker; setup refuses to adopt it. */
class NotPocError extends Error {}

const eid = (id: string, entityType: string): EntityId => ({ id, entityType });

// Numeric predicate whose threshold is the device's server attribute, with the spec default as fallback.
function predicate(a: AlarmSpec, op: string) {
  return {
    type: 'NUMERIC',
    operation: op,
    value: {
      defaultValue: a.defaultValue,
      userValue: null,
      dynamicValue: { sourceType: 'CURRENT_DEVICE', sourceAttribute: a.thresholdAttr, inherit: false },
    },
  };
}

function condition(a: AlarmSpec, op: string) {
  return {
    condition: {
      condition: [
        { key: { type: 'TIME_SERIES', key: a.key }, valueType: 'NUMERIC', value: null, predicate: predicate(a, op) },
      ],
      spec: { type: 'SIMPLE' },
    },
    schedule: null,
    alarmDetails: null,
    dashboardId: null,
  };
}

/** Profile alarm with a dynamic threshold read from the device's server attribute (default when missing). */
export function buildAlarm(a: AlarmSpec) {
  const clearOp = a.operator === 'GREATER' ? 'LESS_OR_EQUAL' : 'GREATER_OR_EQUAL';
  return {
    id: a.id,
    alarmType: a.alarmType,
    propagate: true, // lets site-level queries find device alarms via relations
    propagateToOwner: false,
    propagateToTenant: false,
    propagateRelationTypes: [RELATION_TYPE],
    createRules: { [a.severity]: condition(a, a.operator) },
    clearRule: condition(a, clearOp),
  };
}

// Body for POST /api/deviceProfile (new profile).
function deviceProfileBody(name: string, alarms: AlarmSpec[]) {
  return {
    name,
    description: `${POC_MARKER} iMEX self-service POC profile`,
    type: 'DEFAULT',
    transportType: 'DEFAULT',
    provisionType: 'DISABLED',
    profileData: {
      configuration: { type: 'DEFAULT' },
      transportConfiguration: { type: 'DEFAULT' },
      provisionConfiguration: { type: 'DISABLED', provisionDeviceSecret: null },
      alarms: alarms.map(buildAlarm),
    },
  };
}

// Exact-name match (textSearch is a prefix/contains search).
async function findProfileByName(tb: TbClient, kind: 'assetProfiles' | 'deviceProfiles', name: string) {
  const all = await fetchAll<any>(tb, `/api/${kind}?textSearch=${encodeURIComponent(name)}`);
  return all.find((p) => p.name === name) ?? null;
}

/**
 * Runs Phase-1 setup. Idempotent; safe to re-run. About 25 s on the demo server (one call per attribute write).
 * REST: /api/assetProfile, /api/deviceProfile, /api/customer, /api/asset, /api/device,
 * /api/customer/{id}/asset|device/{id} (assign), .../attributes/SERVER_SCOPE, /api/relation (upsert).
 * @returns SetupResult (no credentials).
 * @throws NotPocError when a non-POC entity with a POC name exists; TbHttpError on REST failures.
 */
export async function runSetup(tb: TbClient, log: Log): Promise<SetupResult> {
  const created: string[] = [];
  const reused: string[] = [];
  const note = (isNew: boolean, what: string) => {
    (isNew ? created : reused).push(what);
    log(`${isNew ? 'created' : 'reused '}  ${what}`);
  };

  let tbVersion: string | null = null;
  try {
    const info = await tb.get<any>('/api/system/info');
    tbVersion = `${info.type} ${info.version}`;
    log(`ThingsBoard ${tbVersion} at ${tb.baseUrl}`);
  } catch {
    log('could not read /api/system/info');
  }

  // 1. Asset profiles
  const assetProfiles: Record<string, string> = {};
  for (const name of ASSET_PROFILES) {
    let p = await findProfileByName(tb, 'assetProfiles', name);
    if (p && !String(p.description ?? '').includes(POC_MARKER))
      throw new NotPocError(`Asset profile "${name}" exists but is not a POC profile; refusing to reuse it.`);
    const isNew = !p;
    if (!p) p = await tb.post('/api/assetProfile', { name, description: `${POC_MARKER} iMEX self-service POC profile` });
    assetProfiles[name] = p.id.id;
    note(isNew, `asset profile ${name}`);
  }

  // 2. Device profiles (alarm rules are re-applied on every run so rule changes in code take effect)
  const deviceProfiles: Record<string, string> = {};
  for (const spec of DEVICE_PROFILES) {
    let p = await findProfileByName(tb, 'deviceProfiles', spec.name);
    if (p && !String(p.description ?? '').includes(POC_MARKER))
      throw new NotPocError(`Device profile "${spec.name}" exists but is not a POC profile; refusing to reuse it.`);
    const isNew = !p;
    const body = deviceProfileBody(spec.name, spec.alarms);
    if (p) {
      const full = await tb.get<any>(`/api/deviceProfile/${p.id.id}`);
      p = await tb.post('/api/deviceProfile', { ...full, description: body.description, profileData: { ...full.profileData, alarms: body.profileData.alarms } });
    } else {
      p = await tb.post('/api/deviceProfile', body);
    }
    deviceProfiles[spec.name] = p.id.id;
    note(isNew, `device profile ${spec.name} (${spec.alarms.length} alarm rule)`);
  }

  // 3. Customer
  let customer = await tb.find<any>(`/api/tenant/customers?customerTitle=${encodeURIComponent(CUSTOMER_TITLE)}`);
  if (customer) {
    if (!(await tb.isPoc(eid(customer.id.id, 'CUSTOMER'))))
      throw new NotPocError(`Customer "${CUSTOMER_TITLE}" exists but has no poc attribute; refusing to reuse it.`);
    note(false, `customer ${CUSTOMER_TITLE}`);
  } else {
    customer = await tb.post('/api/customer', { title: CUSTOMER_TITLE });
    await tb.saveServerAttributes(eid(customer.id.id, 'CUSTOMER'), { poc: true });
    note(true, `customer ${CUSTOMER_TITLE}`);
  }
  const customerId: string = customer.id.id;

  // 4. Assets (create, assign, attributes)
  const assets: SetupResult['assets'] = {};
  for (const a of ASSETS) {
    let asset = await tb.find<any>(`/api/tenant/assets?assetName=${encodeURIComponent(a.name)}`);
    const isNew = !asset;
    if (asset) {
      if (!(await tb.isPoc(eid(asset.id.id, 'ASSET'))))
        throw new NotPocError(`Asset "${a.name}" exists but has no poc attribute; refusing to reuse it.`);
    } else {
      asset = await tb.post('/api/asset', {
        name: a.name,
        label: a.label,
        assetProfileId: eid(assetProfiles[a.profile], 'ASSET_PROFILE'),
      });
      // mark immediately so a failure later still leaves it teardown-able
      await tb.saveServerAttributes(eid(asset.id.id, 'ASSET'), { poc: true });
    }
    if (asset.customerId?.id !== customerId) await tb.post(`/api/customer/${customerId}/asset/${asset.id.id}`);
    await tb.saveServerAttributes(eid(asset.id.id, 'ASSET'), a.attributes);
    assets[a.name] = { id: asset.id.id, label: a.label, profile: a.profile, parent: a.parent };
    note(isNew, `asset ${a.name} (${a.label})`);
  }

  // 6. Devices (before relations to them)
  const devices: SetupResult['devices'] = {};
  for (const d of DEVICES) {
    let dev = await tb.find<any>(`/api/tenant/devices?deviceName=${encodeURIComponent(d.name)}`);
    const isNew = !dev;
    if (dev) {
      if (!(await tb.isPoc(eid(dev.id.id, 'DEVICE'))))
        throw new NotPocError(`Device "${d.name}" exists but has no poc attribute; refusing to reuse it.`);
    } else {
      dev = await tb.post('/api/device', {
        name: d.name,
        label: d.label,
        deviceProfileId: eid(deviceProfiles[d.profile], 'DEVICE_PROFILE'),
      });
      await tb.saveServerAttributes(eid(dev.id.id, 'DEVICE'), { poc: true });
    }
    if (dev.customerId?.id !== customerId) await tb.post(`/api/customer/${customerId}/device/${dev.id.id}`);
    // set default thresholds only where missing, so customer-edited thresholds survive reruns
    const existing = await tb.getServerAttributes(eid(dev.id.id, 'DEVICE'));
    const defaults = defaultThresholds(d.profile);
    const missing = Object.fromEntries(Object.entries(defaults).filter(([k]) => existing[k] === undefined));
    await tb.saveServerAttributes(eid(dev.id.id, 'DEVICE'), { poc: true, ...missing });
    devices[d.name] = { id: dev.id.id, label: d.label, profile: d.profile, parent: d.parent };
    note(isNew, `device ${d.name} (${d.label})`);
  }

  // 5. Relations: parent Contains child (POST /api/relation is an upsert in TB)
  const relations: SetupResult['relations'] = [];
  const relate = async (from: EntityId, to: EntityId, fromName: string, toName: string) => {
    await tb.post('/api/relation', { from, to, type: RELATION_TYPE, typeGroup: 'COMMON' });
    relations.push({ from: fromName, to: toName, type: RELATION_TYPE });
  };
  for (const a of ASSETS) {
    if (a.parent) await relate(eid(assets[a.parent].id, 'ASSET'), eid(assets[a.name].id, 'ASSET'), a.parent, a.name);
  }
  for (const d of DEVICES) {
    await relate(eid(assets[d.parent].id, 'ASSET'), eid(devices[d.name].id, 'DEVICE'), d.parent, d.name);
  }
  log(`relations ensured: ${relations.length} x ${RELATION_TYPE}`);

  // 7. Users: intentionally not created in ThingsBoard (DECISIONS.md D-002).
  // D-002 is superseded by D-010 (app users are ThingsBoard customer users), but this script still
  // creates none; the sample customer users are not made here.
  log(`app users (${APP_USERS.length}) will be seeded into the service DB in Phase 2; no ThingsBoard users created`);

  return {
    tbUrl: tb.baseUrl,
    tbVersion,
    createdAt: new Date().toISOString(),
    customer: { id: customerId, title: CUSTOMER_TITLE },
    assetProfiles,
    deviceProfiles,
    assets,
    devices,
    relations,
    profileKeys: Object.fromEntries(DEVICE_PROFILES.map((p) => [p.name, p.keys])),
    appUsers: APP_USERS,
    summary: { created, reused },
  };
}
