// User context: who is logged in, their role, and the hierarchy they may see.
// Scope comes from the user's server attribute `selectedNodes` (same shape as the production app):
//   [{"ID":"UCA Systems_WM_...","categoryId":"...","name":"Miscellaneous","entityId":"<uuid>"}]
// entityId may also be {id, entityType}. Role comes from the `Role` attribute ("Admin" => admin).
//
// NOTE: in ThingsBoard CE this scope is enforced by the UI only (see DECISIONS.md D-011).

import * as api from './api';
import type { KeyMeta } from './types';

export interface Node {
  id: string;
  entityType: 'ASSET' | 'DEVICE';
  name: string;
  label: string;
  profile: string; // asset profile or device profile name (TB `type`)
  parentId: string | null;
  children: string[];
}

export interface UserContext {
  userId: string;
  customerId: string;
  email: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  rootIds: string[];
  /** True when every scope root is a top of the real hierarchy (no parent asset): the user sees the whole organisation. */
  rootsAreTop: boolean;
  nodes: Map<string, Node>;
  store: api.EntityRef | null;
  profileKeys: Record<string, KeyMeta[]>;
  warnings: string[];
}

export const ADMIN_ROLES = new Set(['admin', 'customer admin', 'administrator']);

export interface SelectedNode {
  entityId: string | null;
  entityType: string;
  name: string;
}

/** Tolerant parser for the production `selectedNodes` attribute. */
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

export async function loadUserContext(): Promise<UserContext> {
  const me = await api.get<any>('/api/auth/user');
  const userRef = { id: me.id.id, entityType: 'USER' };
  const attrs = await api.getAttrs(userRef).catch(() => ({}) as Record<string, any>);
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

  const selected = parseSelectedNodes(attrs.selectedNodes);
  if (!selected.length) warnings.push('No nodes are assigned to your user (selectedNodes is empty).');

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

  await buildTree(ctx, selected.filter((s) => s.entityId) as (SelectedNode & { entityId: string })[]);
  const parents = await Promise.all(ctx.rootIds.map((r) => api.parentsOf({ id: r, entityType: ctx.nodes.get(r)?.entityType ?? 'ASSET' }).catch(() => [])));
  ctx.rootsAreTop = ctx.rootIds.length > 0 && parents.every((ps) => !ps.some((p) => p.from.entityType === 'ASSET'));

  // dashboard store asset (customer-scoped)
  if (ctx.customerId) {
    const r = await api.get<any>(`/api/customer/${ctx.customerId}/assets?pageSize=5&page=0&type=DashboardStore`).catch(() => null);
    const a = r?.data?.[0];
    if (a) {
      ctx.store = { id: a.id.id, entityType: 'ASSET' };
      const s = await api.getAttrs(ctx.store, ['dbb_profile_keys']).catch(() => ({}) as any);
      ctx.profileKeys = s.dbb_profile_keys ?? {};
    } else warnings.push('Dashboard store asset (type DashboardStore) is missing; saving is disabled.');
  }
  return ctx;
}

async function buildTree(ctx: UserContext, roots: { entityId: string; entityType: string }[]) {
  const queue: { id: string; entityType: string; parentId: string | null }[] = roots.map((r) => ({
    id: r.entityId,
    entityType: r.entityType === 'DEVICE' ? 'DEVICE' : 'ASSET',
    parentId: null,
  }));
  const assetIds = new Set<string>();
  const deviceIds = new Set<string>();
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const seen = new Set<string>();
  ctx.rootIds = roots.map((r) => r.entityId);

  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    await Promise.all(
      batch.map(async (n) => {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        parent.set(n.id, n.parentId);
        if (n.entityType === 'DEVICE') {
          deviceIds.add(n.id);
          return;
        }
        assetIds.add(n.id);
        const rels = await api.childrenOf({ id: n.id, entityType: 'ASSET' }).catch(() => []);
        children.set(
          n.id,
          rels.map((r) => r.to.id),
        );
        for (const r of rels) if (r.to.entityType === 'ASSET' || r.to.entityType === 'DEVICE') queue.push({ id: r.to.id, entityType: r.to.entityType, parentId: n.id });
      }),
    );
  }

  const [assets, devices] = await Promise.all([api.assetsByIds([...assetIds]), api.devicesByIds([...deviceIds])]);
  for (const a of assets)
    ctx.nodes.set(a.id.id, {
      id: a.id.id,
      entityType: 'ASSET',
      name: a.name,
      label: a.label || a.name,
      profile: a.type,
      parentId: parent.get(a.id.id) ?? null,
      children: (children.get(a.id.id) ?? []).filter((c) => seen.has(c)),
    });
  for (const d of devices)
    ctx.nodes.set(d.id.id, {
      id: d.id.id,
      entityType: 'DEVICE',
      name: d.name,
      label: d.label || d.name,
      profile: d.type,
      parentId: parent.get(d.id.id) ?? null,
      children: [],
    });
  // drop children that could not be loaded (e.g. other entity types)
  for (const n of ctx.nodes.values()) n.children = n.children.filter((c) => ctx.nodes.has(c));
}

// ---------- tree queries (pure) ----------

export function inScope(ctx: Pick<UserContext, 'nodes'>, id: string) {
  return ctx.nodes.has(id);
}

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

export function allDevices(ctx: Pick<UserContext, 'nodes'>, profile?: string): Node[] {
  return [...ctx.nodes.values()].filter((n) => n.entityType === 'DEVICE' && (!profile || n.profile === profile));
}

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

export function pathLabel(ctx: Pick<UserContext, 'nodes'>, id: string): string {
  const n = ctx.nodes.get(id);
  if (!n) return '';
  return [...ancestors(ctx, id).reverse().map((a) => a.label), n.label].join(' › ');
}

export function siblings(ctx: Pick<UserContext, 'nodes'>, deviceId: string, profile: string): Node[] {
  const p = ctx.nodes.get(deviceId)?.parentId;
  if (!p) return [];
  return (ctx.nodes.get(p)?.children ?? [])
    .map((c) => ctx.nodes.get(c)!)
    .filter((n) => n && n.entityType === 'DEVICE' && n.profile === profile);
}

/** Closest device of `profile` walking up from the device (checking each ancestor's subtree, nearest first). */
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
