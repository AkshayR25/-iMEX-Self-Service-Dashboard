// core/scope.ts — the user context: who is logged in, their role, the hierarchy they may see, the
// customer's DashboardStore asset and the property catalogue (DECISIONS D-011, D-018).
//
// Main exports:
//   loadUserContext()   builds a UserContext (all network I/O of this module happens here)
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
  /** Property catalogue per machine type, from the store attribute `dbb_profile_keys`. */
  profileKeys: Record<string, KeyMeta[]>;
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
  ctx.profileKeys = sa.dbb_profile_keys ?? {};
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
  const [down, up] = await Promise.all([
    Promise.all(refs.map((r) => (r.entityType === 'ASSET' ? api.relationsTree(r, 'FROM', ['ASSET', 'DEVICE']).catch(() => [] as api.Rel[]) : Promise.resolve([] as api.Rel[])))),
    Promise.all(refs.map((r) => api.relationsTree(r, 'TO', ['ASSET']).catch(() => [] as api.Rel[]))),
  ]);

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
