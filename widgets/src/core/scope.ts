// core/scope.ts — the user context: who is logged in, their role, the hierarchy they may see, the
// customer's DashboardStore asset and the property catalogue (DECISIONS D-011, D-018).
//
// Main exports:
//   loadUserContext()   builds a UserContext
//   liveKeys()          merges the machines' live telemetry keys into ctx.profileKeys (the only other network I/O)
//   clearRelCache()     drops the cached scope relations
//   parseSelectedNodes  tolerant parser for the `selectedNodes` user attribute
//   inScope / devicesUnder / allDevices / ancestors / pathLabel / siblings / nearest / nodesContaining
//                       pure queries over the loaded tree (no network)
// Called by: entries/common.ts `userContext()` (which caches ONE context per page for 5 minutes,
// or until forced), then passed to everything in core/store.ts, core/chat.ts, the builder and the
// renderer. This module itself does not cache.
//
// How the context is built:
//   1. GET /api/auth/user, then the user's SERVER_SCOPE attributes.
//   2. Scope = attribute `selectedNodes` (same shape as the production app):
//        [{"ID":"UCA Systems_WM_...","categoryId":"...","name":"Miscellaneous","entityId":"<uuid>"}]
//      `entityId` may also be {id, entityType}; entries without an id are matched by name/label
//      among the customer's assets.
//   3. Role = attribute `Role` (or `role`). 'Admin', 'Customer Admin', 'Administrator' or the
//      attribute `dbbAdmin = true` make the user an admin (may apply to many machines; D-011, D-017).
//   4. Tenant-admin mode (D-018): a TENANT_ADMIN has no customer and no selectedNodes. The widget
//      setting `customerId` picks the customer; its top-level assets (no parent asset, excluding the
//      store) become the scope roots, and the user is an admin.
//   5. Tree = the roots plus everything below them via `Contains` relations (assets and devices): ONE
//      relations query per root for the structure, then ONE Entity Data Query per entity type for names,
//      labels, profiles and the `dbb_assign` attributes (D-022). The number of calls does not grow with the tree.
//   6. Ancestors above each root (ONE relations query per root, direction TO) are kept in `aboveRoot`;
//      `rootsAreTop` = no root has one, i.e. the user sees the whole organisation (required for
//      customer-wide assignments). Their `dbb_assign` is loaded too, because a location assignment above
//      the user's scope still applies (store.resolveForDevice).
//   7. Store = first asset of type `DashboardStore` assigned to the customer; one read of its attributes
//      `dbb_profile_keys` ({ [profile]: KeyMeta[] }, the property catalogue for the builder and chat),
//      `dbb_assign_customer`, `dbb_assign_rev` and `dbb_lib_version`.
//   Calls for a customer user with one scope root: 8, in 4 rounds (auth user; user attributes + store lookup;
//   2 relations queries + store attributes; 2 entity queries). Before D-022 it was about 10 + 1 per asset.
//   Problems are collected in `warnings` (shown by the UI) instead of throwing, where possible.
//   8. Not part of the load: `liveKeys(ctx, types)` adds the keys the machines actually send to `ctx.profileKeys`
//      (the catalogue is only an overlay for names and units, 9 Oct 2026). The builder, the chat and the default
//      machine page await it; it is cached per browser session.
//
// SECURITY: in ThingsBoard CE this scope and the admin flag are enforced by the UI only (D-011,
// D-012). A customer user can read every device of their customer through the REST API.

import * as api from './api';
import type { KeyMeta } from './types';

/** One entity of the user's visible hierarchy (asset = location/site/line, device = machine). */
export interface Node {
  id: string;
  entityType: 'ASSET' | 'DEVICE';
  name: string;
  label: string;
  profile: string; // asset profile or device profile name (TB `type`)
  parentId: string | null;
  children: string[];
}

/**
 * Everything the widgets need to know about the current user. Built by `loadUserContext()`,
 * treated as read-only afterwards (reload to pick up attribute or hierarchy changes).
 */
export interface UserContext {
  /** ThingsBoard user id (key for `dbb_personal` and `dbb_chat_resp_<userId>`). */
  userId: string;
  /** Customer id; for a tenant admin, the widget setting `customerId` ('' when unset). */
  customerId: string;
  email: string;
  displayName: string;
  /** Raw `Role` attribute (tenant admins without one get 'Admin', others 'Viewer'). */
  role: string;
  /** Admin rights in the builder (UI-only, D-012). */
  isAdmin: boolean;
  /** Scope roots (resolved `selectedNodes`). */
  rootIds: string[];
  /** True when every scope root is a top of the real hierarchy (no parent asset): the user sees the whole organisation. */
  rootsAreTop: boolean;
  /** Every node in scope by id: the roots and all their `Contains` descendants. */
  nodes: Map<string, Node>;
  /** The customer's DashboardStore asset; null = saving and chat are unavailable. */
  store: api.EntityRef | null;
  /**
   * Properties per machine type: the catalogue (`catalogue`) plus, once `liveKeys` has run for the type, the keys
   * its machines actually send (9 Oct 2026). Await `liveKeys` first where the full list matters.
   */
  profileKeys: Record<string, KeyMeta[]>;
  /** The store attribute `dbb_profile_keys` as stored: names, units, decimals and limits per machine type. */
  catalogue: Record<string, KeyMeta[]>;
  /** `liveKeys` loads per machine type, in flight or done (each type is merged once per context). */
  liveLoads?: Map<string, Promise<void>>;
  /** Setup problems to show the user (missing store, empty scope, unresolved nodes...). */
  warnings: string[];
  /**
   * Assignment snapshot used by store.resolveForDevice (D-022), so opening a machine page needs no
   * hierarchy walk. Refreshed when the store's `dbb_assign_rev` changes or `stale` is set (every write in
   * core/store.ts does both).
   */
  assign?: AssignSnapshot;
  /** Build of the widget library deployed last (store attribute `dbb_lib_version`, written by DBB_DEPLOY); '' when unknown. */
  deployedVersion?: string;
}

/** See `UserContext.assign`. */
export interface AssignSnapshot {
  /** `dbb_assign` per device/asset id (nodes in scope and the ancestors above the roots); absent = none. */
  byId: Map<string, any>;
  /** Ancestor assets above each scope root, nearest first: id, name, label (also for resolveForDevice labels). */
  aboveRoot: Map<string, { id: string; name: string; label: string }[]>;
  /** The user's `dbb_personal` ({ deviceId: dashboardId }). */
  personal: Record<string, string>;
  /** Store attribute `dbb_assign_customer`. */
  customer: Record<string, any>;
  /** Store attribute `dbb_assign_rev` when the snapshot was taken ('' = never written). */
  rev: string;
  /** When the snapshot was taken (ms). */
  at: number;
  /** Set by writes in core/store.ts: the next resolve reloads the snapshot. */
  stale: boolean;
}

/** How long the scope's relations are kept in sessionStorage (D-037). */
export const REL_CACHE_MS = 10 * 60 * 1000;

/** `Role` values (lower-cased) that grant admin rights (D-011). */
export const ADMIN_ROLES = new Set(['admin', 'customer admin', 'administrator']);

/** One parsed `selectedNodes` entry; `entityId` is null until resolved by name. */
export interface SelectedNode {
  entityId: string | null;
  entityType: string;
  name: string;
}

/**
 * Tolerant parser for the production `selectedNodes` attribute.
 * Accepts a JSON string or value, an array or a single object. Id from `entityId` / `entityID` /
 * `id` (string or `{id, entityType}`); type defaults to ASSET; name from `name`, else `ID`.
 * Non-object entries are skipped. Never throws.
 */
export function parseSelectedNodes(raw: unknown): SelectedNode[] {
  const v = api.parseMaybeJson(raw);
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: SelectedNode[] = [];
  for (const n of arr) {
    if (!n || typeof n !== 'object') continue;
    const e = (n as any).entityId ?? (n as any).entityID ?? (n as any).id;
    let id: string | null = null;
    let type = 'ASSET';
    if (typeof e === 'string') id = e;
    else if (e && typeof e === 'object' && typeof e.id === 'string') {
      id = e.id;
      if (typeof e.entityType === 'string') type = e.entityType;
    }
    if (typeof (n as any).entityType === 'string') type = (n as any).entityType;
    out.push({ entityId: id, entityType: type, name: String((n as any).name ?? (n as any).ID ?? '') });
  }
  return out;
}

/** Options for `loadUserContext`. */
export interface LoadOptions {
  /** Customer to show when a TENANT ADMIN opens the app (widget setting `customerId`). */
  tenantCustomerId?: string | null;
}

/**
 * Builds the UserContext for the logged-in user (see the file header for the steps).
 * Reads: /api/auth/user; user SERVER attributes (`Role`, `selectedNodes`, `dbbAdmin`, names);
 * the customer's assets (only for tenant-admin mode or name resolution); `Contains` relations and
 * the entities below the roots; the DashboardStore asset and its `dbb_profile_keys`. Writes nothing.
 * Cost: one relations call per asset in scope, so large trees take a few seconds on a slow server;
 * callers cache the result (entries/common.ts).
 * @throws when /api/auth/user, the customer asset list (name resolution) or the bulk
 *         asset/device lookup fails; other problems become `warnings` or are skipped.
 */
export async function loadUserContext(opts: LoadOptions = {}): Promise<UserContext> {
  const me = await api.get<any>('/api/auth/user');
  const userRef = { id: me.id.id, entityType: 'USER' };
  // The store (lookup + one attribute read) loads in parallel with the user attributes and the tree.
  const custId: string = me.authority === 'TENANT_ADMIN' ? opts.tenantCustomerId ?? '' : me.customerId?.id ?? '';
  const storeP = (async () => {
    if (!custId) return null;
    const r = await api.get<any>(`/api/customer/${custId}/assets?pageSize=5&page=0&type=DashboardStore`).catch(() => null);
    const a = r?.data?.[0];
    if (!a) return null;
    const ref = { id: a.id.id, entityType: 'ASSET' };
    return { ref, attrs: await api.getAttrs(ref, [...STORE_CTX_KEYS]).catch(() => ({}) as Record<string, any>) };
  })();
  const attrs = await api.getAttrs(userRef).catch(() => ({}) as Record<string, any>);
  // no Role attribute: tenant admins default to Admin, everyone else to Viewer
  const role = String(attrs.Role ?? attrs.role ?? (me.authority === 'TENANT_ADMIN' ? 'Admin' : 'Viewer'));
  const warnings: string[] = [];
  const ctx: UserContext = {
    userId: me.id.id,
    customerId: me.customerId?.id,
    email: me.email,
    displayName: [attrs.firstName ?? me.firstName, attrs.lastName ?? me.lastName].filter(Boolean).join(' ') || me.email,
    role,
    isAdmin: ADMIN_ROLES.has(role.toLowerCase()) || attrs.dbbAdmin === true,
    rootIds: [],
    rootsAreTop: false,
    nodes: new Map(),
    store: null,
    profileKeys: {},
    catalogue: {},
    warnings,
  };

  let selected = parseSelectedNodes(attrs.selectedNodes);
  // A tenant admin has no customer and no selectedNodes: show the configured customer's whole hierarchy.
  if (me.authority === 'TENANT_ADMIN') {
    ctx.isAdmin = true;
    ctx.customerId = opts.tenantCustomerId ?? '';
    if (!ctx.customerId) warnings.push('Opened as tenant admin: set the widget setting "customerId" to choose which customer to show.');
    else if (!selected.length) {
      const assets = await api.get<any>(`/api/customer/${ctx.customerId}/assets?pageSize=1000&page=0`).catch(() => ({ data: [] }));
      // top-level = no parent ASSET via Contains (at most 1000 customer assets are considered)
      const candidates = (assets.data as any[]).filter((a) => a.type !== 'DashboardStore');
      const tops = await Promise.all(
        candidates.map(async (a) => ((await api.parentsOf({ id: a.id.id, entityType: 'ASSET' }).catch(() => [])).some((p) => p.from.entityType === 'ASSET') ? null : a)),
      );
      selected = tops.filter(Boolean).map((a: any) => ({ entityId: a.id.id, entityType: 'ASSET', name: a.name }));
    }
  }
  if (!selected.length && !warnings.length) warnings.push('No nodes are assigned to your user (selectedNodes is empty).');

  // resolve nodes without an entityId by name among the customer's assets
  const unresolved = selected.filter((s) => !s.entityId);
  if (unresolved.length && ctx.customerId) {
    const assets = await api.get<any>(`/api/customer/${ctx.customerId}/assets?pageSize=1000&page=0`);
    for (const s of unresolved) {
      const hit = assets.data.find((a: any) => a.name === s.name || a.label === s.name);
      if (hit) s.entityId = hit.id.id;
      else warnings.push(`Selected node "${s.name}" was not found.`);
    }
  }

  const [, st] = await Promise.all([buildTree(ctx, selected.filter((s) => s.entityId) as (SelectedNode & { entityId: string })[], attrs), storeP]);
  if (st) ctx.store = st.ref;
  else if (ctx.customerId) warnings.push('Dashboard store asset (type DashboardStore) is missing; saving is disabled.');
  const sa = st?.attrs ?? {};
  ctx.catalogue = sa.dbb_profile_keys && typeof sa.dbb_profile_keys === 'object' ? sa.dbb_profile_keys : {};
  // a copy per type: liveKeys adds to these lists, the catalogue stays as stored
  ctx.profileKeys = Object.fromEntries(Object.entries(ctx.catalogue).map(([p, ks]) => [p, Array.isArray(ks) ? [...ks] : []]));
  ctx.deployedVersion = String(sa.dbb_lib_version ?? '');
  if (ctx.assign) {
    ctx.assign.customer = sa.dbb_assign_customer ?? {};
    ctx.assign.rev = String(sa.dbb_assign_rev ?? '');
  }
  return ctx;
}

/** Store attributes read with the user context (one call). */
export const STORE_CTX_KEYS = ['dbb_profile_keys', 'dbb_assign_customer', 'dbb_assign_rev', 'dbb_lib_version'] as const;

/**
 * (Re)loads `dbb_assign` of the given devices/assets in one Entity Data Query per entity type.
 * @returns id -> dbb_assign (ids without one are absent) plus the entity rows (names, labels, profiles).
 */
export async function loadAssignments(assetIds: string[], deviceIds: string[]) {
  const [assets, devices] = await Promise.all([
    assetIds.length ? api.entityData('ASSET', assetIds, { attrs: ['dbb_assign'] }) : Promise.resolve([] as api.EntityRow[]),
    deviceIds.length ? api.entityData('DEVICE', deviceIds, { attrs: ['dbb_assign'] }) : Promise.resolve([] as api.EntityRow[]),
  ]);
  const byId = new Map<string, any>();
  for (const r of [...assets, ...devices]) if (r.attrs.dbb_assign != null && r.attrs.dbb_assign !== '') byId.set(r.id, r.attrs.dbb_assign);
  return { byId, assets, devices };
}

/**
 * Loads the hierarchy below `roots` into `ctx.nodes` / `ctx.rootIds`, the ancestors above the roots and the
 * assignment snapshot `ctx.assign` (D-022).
 * Structure: one POST /api/relations per root in each direction (all levels at once). The tree is then
 * walked breadth-first from the roots; `seen` guards against cycles and nodes reachable twice (first
 * parent wins). Devices are leaves; relations to other entity types are ignored.
 * Entities: one Entity Data Query for all assets and one for all devices (names, labels, profiles,
 * `dbb_assign`). Children that could not be loaded are dropped at the end.
 * @param userAttrs the user's SERVER attributes (for `dbb_personal`).
 */
async function buildTree(ctx: UserContext, roots: { entityId: string; entityType: string }[], userAttrs: Record<string, any>) {
  const refs = roots.map((r) => ({ id: r.entityId, entityType: r.entityType === 'DEVICE' ? 'DEVICE' : 'ASSET' }));
  ctx.rootIds = refs.map((r) => r.id);
  // D-037: the relations (2 calls per root) are kept for the browser session, 10 minutes, per user and root set.
  // Every page of the app loads the library again (the headless launcher is on each state), so without this a
  // user with 50 locations paid 100 relation calls on every page change. A failed call is never cached.
  const cacheKey = `imex-dbb-rel:${ctx.userId}:${refs.map((r) => r.id).join(',')}`;
  let cached: { at: number; down: api.Rel[][]; up: api.Rel[][] } | null = null;
  try {
    const hit = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (hit && Date.now() - hit.at < REL_CACHE_MS && Array.isArray(hit.down) && Array.isArray(hit.up)) cached = hit;
  } catch {
    /* no session storage, or not JSON */
  }
  let failed = false;
  const miss = (): api.Rel[] => {
    failed = true;
    return [];
  };
  const [down, up] = cached
    ? [cached.down, cached.up]
    : await Promise.all([
        Promise.all(refs.map((r) => (r.entityType === 'ASSET' ? api.relationsTree(r, 'FROM', ['ASSET', 'DEVICE']).catch(miss) : Promise.resolve([] as api.Rel[])))),
        Promise.all(refs.map((r) => api.relationsTree(r, 'TO', ['ASSET']).catch(miss))),
      ]);
  if (!cached && !failed) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), down, up }));
    } catch {
      /* storage full or unavailable: the next page asks again */
    }
  }

  // children per asset, in the order ThingsBoard returned them
  const kids = new Map<string, api.EntityRef[]>();
  for (const rel of down.flat()) {
    if (rel.type !== 'Contains' || rel.from.entityType !== 'ASSET' || (rel.to.entityType !== 'ASSET' && rel.to.entityType !== 'DEVICE')) continue;
    const l = kids.get(rel.from.id) ?? [];
    if (!l.some((x) => x.id === rel.to.id)) l.push(rel.to);
    kids.set(rel.from.id, l);
  }
  const assetIds = new Set<string>();
  const deviceIds = new Set<string>();
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const seen = new Set<string>();
  let level: { id: string; entityType: string; parentId: string | null }[] = refs.map((r) => ({ id: r.id, entityType: r.entityType, parentId: null }));
  while (level.length) {
    const next: typeof level = [];
    for (const n of level) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      parent.set(n.id, n.parentId);
      if (n.entityType === 'DEVICE') {
        deviceIds.add(n.id);
        continue;
      }
      assetIds.add(n.id);
      const ks = kids.get(n.id) ?? [];
      children.set(
        n.id,
        ks.map((k) => k.id),
      );
      for (const k of ks) next.push({ id: k.id, entityType: k.entityType, parentId: n.id });
    }
    level = next;
  }

  // ancestors above each root, nearest first (first ASSET parent at each level, cycle-safe)
  const aboveIds = new Map<string, string[]>();
  refs.forEach((r, i) => {
    const parentOf = new Map<string, string>();
    for (const rel of up[i]) if (rel.from.entityType === 'ASSET' && !parentOf.has(rel.to.id)) parentOf.set(rel.to.id, rel.from.id);
    const chain: string[] = [];
    let cur = parentOf.get(r.id);
    while (cur && !chain.includes(cur) && cur !== r.id) {
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    aboveIds.set(r.id, chain);
  });
  const extIds = [...new Set([...aboveIds.values()].flat())].filter((id) => !assetIds.has(id));

  const { byId, assets, devices } = await loadAssignments([...assetIds, ...extIds], [...deviceIds]);
  const names = new Map<string, { name: string; label: string }>();
  for (const a of assets) {
    names.set(a.id, { name: a.fields.name, label: a.fields.label || a.fields.name });
    if (!assetIds.has(a.id)) continue;
    ctx.nodes.set(a.id, {
      id: a.id,
      entityType: 'ASSET',
      name: a.fields.name,
      label: a.fields.label || a.fields.name,
      profile: a.fields.type,
      parentId: parent.get(a.id) ?? null,
      children: (children.get(a.id) ?? []).filter((c) => seen.has(c)),
    });
  }
  for (const d of devices)
    ctx.nodes.set(d.id, {
      id: d.id,
      entityType: 'DEVICE',
      name: d.fields.name,
      label: d.fields.label || d.fields.name,
      profile: d.fields.type,
      parentId: parent.get(d.id) ?? null,
      children: [],
    });
  // drop children that could not be loaded (e.g. other entity types)
  for (const n of ctx.nodes.values()) n.children = n.children.filter((c) => ctx.nodes.has(c));

  const aboveRoot = new Map<string, { id: string; name: string; label: string }[]>();
  for (const [r, chain] of aboveIds) aboveRoot.set(r, chain.map((id) => ({ id, ...(names.get(id) ?? { name: id, label: id }) })));
  ctx.rootsAreTop = ctx.rootIds.length > 0 && [...aboveIds.values()].every((c) => c.length === 0);
  const personal = api.parseMaybeJson(userAttrs.dbb_personal);
  ctx.assign = { byId, aboveRoot, personal: personal && typeof personal === 'object' ? personal : {}, customer: {}, rev: '', at: Date.now(), stale: false };
}

/**
 * Drops the cached scope relations (D-037) of `userId` (every user when omitted), so the next loadUserContext
 * asks ThingsBoard again. Used when a machine is opened that the cached tree does not have yet (a machine
 * added after the cache was filled would otherwise be refused for up to REL_CACHE_MS).
 */
export function clearRelCache(userId?: string) {
  const prefix = `imex-dbb-rel:${userId ? `${userId}:` : ''}`;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(prefix)) sessionStorage.removeItem(k);
    }
  } catch {
    /* no session storage */
  }
}

// ---------- live property keys (9 Oct 2026) ----------
// The catalogue `dbb_profile_keys` is written by DBB_DEPLOY and goes stale: a key a machine starts sending, or a
// machine type nobody catalogued, was missing from the property picker, the default machine page and the chat.
// The catalogue is now an overlay: the properties of a type are the keys its machines send (up to
// LIVE_KEYS_MAX_DEVICES of them in scope), with the catalogue's names, units, decimals and limits where it has them.

/** Machines of one type whose keys are listed (in parallel); the first ones in scope. */
export const LIVE_KEYS_MAX_DEVICES = 20;
/** How long the listed keys of a type are kept in sessionStorage. */
export const LIVE_KEYS_CACHE_MS = 5 * 60 * 1000;
/** Keys that are not properties: AI Insights outputs and the pre-aggregated copies of a value. */
export const NOT_A_PROPERTY = /^aiml_|_(2min|5min|30min|2hrs|6hrs|1day)$/;

/** Readable name for a key without a catalogue entry: "dischargePressure" / "discharge_pressure" -> "Discharge Pressure" / "Discharge pressure". */
export function readableKey(key: string): string {
  const s = key
    .replace(/[_\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** Unit suffixes of snake_case keys ("discharge_pressure_bar"), longest first. One-letter ones need 3+ parts ("motor_current_a", not "phase_a"). */
const KEY_UNITS: [string, string][] = [
  ['kw_m3min', 'kW/(m³/min)'],
  ['m3min', 'm³/min'],
  ['mm_s', 'mm/s'],
  ['kwh', 'kWh'],
  ['kw', 'kW'],
  ['mbar', 'mbar'],
  ['bar', 'bar'],
  ['pct', '%'],
  ['rpm', 'rpm'],
  ['hz', 'Hz'],
  ['lpm', 'L/min'],
  ['c', '°C'],
  ['f', '°F'],
  ['v', 'V'],
  ['a', 'A'],
];

/** Name and unit for a key nobody has named: "discharge_pressure_bar" -> {name: "Discharge pressure", unit: "bar"}. */
export function guessKey(key: string): { name: string; unit: string } {
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(key)) {
    const parts = key.split('_').length;
    for (const [suf, unit] of KEY_UNITS) {
      if (!key.endsWith(`_${suf}`) || (suf.length === 1 && parts < 3)) continue;
      return { name: readableKey(key.slice(0, -suf.length - 1)), unit };
    }
  }
  return { name: readableKey(key), unit: '' };
}

/** Name and unit from a machine's `telemetryKeys` entry label, e.g. "Airflow Rate (CFM)" -> {label: "Airflow Rate", unit: "CFM"}. */
function splitLabel(text: string): { label: string; unit: string } {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(text);
  return m ? { label: m[1], unit: m[2] } : { label: text, unit: '' };
}

/**
 * Properties of one machine type: the catalogue entries first (as stored, also keys no machine sends yet, so
 * saved widgets keep theirs), then every other live key except NOT_A_PROPERTY. Those get the name and unit of
 * the machines' `telemetryKeys` list when it has them (in that list's order), else a readable name and the unit
 * of a snake_case suffix (guessKey); decimals 1,
 * range 0-100 like `keyMeta` gives unknown keys. Pure.
 * @param named key -> name/unit from the machines' `telemetryKeys` attribute (insertion order = list order).
 */
export function mergeKeys(catalogue: KeyMeta[], live: string[], named: Map<string, { label: string; unit: string }> = new Map()): KeyMeta[] {
  const have = new Set(catalogue.map((k) => k.key));
  const extra = [...new Set(live)].filter((k) => !have.has(k) && !NOT_A_PROPERTY.test(k));
  const order = [...named.keys()];
  const rank = (k: string) => (named.has(k) ? order.indexOf(k) : order.length);
  extra.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [
    ...catalogue,
    ...extra.map((key) => {
      const n = named.get(key);
      const g = guessKey(key);
      return { key, displayName: n?.label || g.name, unit: n?.unit || g.unit, decimals: 1, min: 0, max: 100 };
    }),
  ];
}

/** sessionStorage entry of one type's live keys. */
interface LiveEntry {
  at: number;
  keys: string[];
  named: [string, string, string][]; // key, name, unit
}

/**
 * Merges the live keys of the given machine types (default: every type in scope) into `ctx.profileKeys`.
 * Per type: GET /api/plugins/telemetry/DEVICE/{id}/keys/timeseries for up to LIVE_KEYS_MAX_DEVICES of its machines
 * in scope, plus ONE entity query (all types together) for their `telemetryKeys` attribute; kept in sessionStorage
 * for LIVE_KEYS_CACHE_MS per user and type. Each type is loaded once per context (concurrent callers share the
 * load). Never rejects: a failed read leaves the type's catalogue as it is (and is not cached).
 */
export function liveKeys(ctx: UserContext, profiles?: string[]): Promise<void> {
  const loads = (ctx.liveLoads ??= new Map());
  const want = [...new Set(profiles ?? allDevices(ctx).map((d) => d.profile))].filter((p) => p && !loads.has(p));
  if (want.length) {
    const job = loadLive(ctx, want).catch(() => undefined);
    for (const p of want) loads.set(p, job);
  }
  const all = [...new Set(profiles ?? [...loads.keys()])].map((p) => loads.get(p));
  return Promise.all(all).then(() => undefined);
}

async function loadLive(ctx: UserContext, profiles: string[]) {
  const cacheKey = (p: string) => `imex-dbb-keys:${ctx.userId}:${p}`;
  const fresh = new Map<string, LiveEntry>();
  const todo: string[] = [];
  for (const p of profiles) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(cacheKey(p)) || 'null') as LiveEntry | null;
      if (hit && Date.now() - hit.at < LIVE_KEYS_CACHE_MS && Array.isArray(hit.keys) && Array.isArray(hit.named)) {
        fresh.set(p, hit);
        continue;
      }
    } catch {
      /* no session storage, or not JSON */
    }
    todo.push(p);
  }
  const devs = new Map(todo.map((p) => [p, allDevices(ctx, p).slice(0, LIVE_KEYS_MAX_DEVICES).map((d) => d.id)]));
  const ids = [...devs.values()].flat();
  if (ids.length) {
    let failed = 0;
    const [lists, rows] = await Promise.all([
      Promise.all(
        ids.map((id) =>
          api.timeseriesKeys(id).catch(() => {
            failed++;
            return [] as string[];
          }),
        ),
      ),
      api.entityData('DEVICE', ids, { fields: [], attrs: ['telemetryKeys'] }).catch(() => {
        failed++;
        return [] as api.EntityRow[];
      }),
    ]);
    const keysOf = new Map(ids.map((id, i) => [id, lists[i]]));
    const tkOf = new Map(rows.map((r) => [r.id, r.attrs.telemetryKeys]));
    for (const [p, dids] of devs) {
      const keys = [...new Set(dids.flatMap((id) => keysOf.get(id) ?? []))];
      const named = new Map<string, [string, string, string]>();
      for (const id of dids) {
        const list = api.parseMaybeJson(tkOf.get(id));
        for (const v of Array.isArray(list) ? list : []) {
          if (!v || typeof v.kpi !== 'string' || !v.label || named.has(v.kpi)) continue;
          const { label, unit } = splitLabel(String(v.label));
          named.set(v.kpi, [v.kpi, label, unit]);
        }
      }
      const e: LiveEntry = { at: Date.now(), keys, named: [...named.values()] };
      fresh.set(p, e);
      if (!failed)
        try {
          sessionStorage.setItem(cacheKey(p), JSON.stringify(e));
        } catch {
          /* storage full or unavailable */
        }
    }
  }
  for (const [p, e] of fresh) {
    const named = new Map(e.named.map(([k, label, unit]) => [k, { label, unit }]));
    ctx.profileKeys[p] = mergeKeys(ctx.catalogue?.[p] ?? ctx.profileKeys[p] ?? [], e.keys, named);
  }
}

// ---------- tree queries (pure) ----------
// All work on the already-loaded `ctx.nodes` only, i.e. within the user's scope.

/** True when the entity is in the user's scope (UI-level check only, D-012). */
export function inScope(ctx: Pick<UserContext, 'nodes'>, id: string) {
  return ctx.nodes.has(id);
}

/** Devices at or below `nodeId` (a device id returns itself), optionally only of `profile`. */
export function devicesUnder(ctx: Pick<UserContext, 'nodes'>, nodeId: string, profile?: string): Node[] {
  const out: Node[] = [];
  const walk = (id: string) => {
    const n = ctx.nodes.get(id);
    if (!n) return;
    if (n.entityType === 'DEVICE') {
      if (!profile || n.profile === profile) out.push(n);
      return;
    }
    n.children.forEach(walk);
  };
  walk(nodeId);
  return out;
}

/** Every device in scope, optionally only of `profile`. */
export function allDevices(ctx: Pick<UserContext, 'nodes'>, profile?: string): Node[] {
  return [...ctx.nodes.values()].filter((n) => n.entityType === 'DEVICE' && (!profile || n.profile === profile));
}

/** Parents of a node within scope, nearest first (stops at the scope root; cycle-safe). */
export function ancestors(ctx: Pick<UserContext, 'nodes'>, id: string): Node[] {
  const out: Node[] = [];
  let cur = ctx.nodes.get(id)?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const n = ctx.nodes.get(cur);
    if (!n) break;
    out.push(n);
    cur = n.parentId;
  }
  return out;
}

/** Breadcrumb label "Root › Site › Machine" within scope; '' for unknown ids. */
export function pathLabel(ctx: Pick<UserContext, 'nodes'>, id: string): string {
  const n = ctx.nodes.get(id);
  if (!n) return '';
  return [...ancestors(ctx, id).reverse().map((a) => a.label), n.label].join(' › ');
}

/** Devices of `profile` with the same parent as `deviceId` (includes the device itself when it matches); [] for a root. */
export function siblings(ctx: Pick<UserContext, 'nodes'>, deviceId: string, profile: string): Node[] {
  const p = ctx.nodes.get(deviceId)?.parentId;
  if (!p) return [];
  return (ctx.nodes.get(p)?.children ?? [])
    .map((c) => ctx.nodes.get(c)!)
    .filter((n) => n && n.entityType === 'DEVICE' && n.profile === profile);
}

/**
 * Closest other device of `profile` walking up from the device (checking each ancestor's subtree,
 * nearest first), e.g. the site weather station. Excludes the device itself; null when none in scope.
 */
export function nearest(ctx: Pick<UserContext, 'nodes'>, deviceId: string, profile: string): Node | null {
  for (const a of ancestors(ctx, deviceId)) {
    const hits = devicesUnder(ctx, a.id, profile).filter((d) => d.id !== deviceId);
    if (hits.length) return hits[0];
  }
  return null;
}

/** Asset nodes in scope that contain at least one device of the profile (for "apply to node" options). */
export function nodesContaining(ctx: Pick<UserContext, 'nodes'>, profile: string): Node[] {
  return [...ctx.nodes.values()].filter((n) => n.entityType === 'ASSET' && devicesUnder(ctx, n.id, profile).length > 0);
}
