// Dashboard storage, assignments and resolution — all in ThingsBoard server attributes,
// written as the logged-in customer user (no tenant credentials).
//
// Store asset (type DashboardStore, one per TB customer):
//   dbb_d_<id>            Dashboard JSON
//   dbb_h_<id>            last 10 versions [{version, savedAt, savedBy, doc}]
//   dbb_vis_<id>          'private' | 'shared'
//   dbb_assign_customer   { [profile]: Assignment }        customer-wide per machine type
// Asset (site/plant/line/org):
//   dbb_assign            { [profile]: Assignment }        all machines of a type under this node
// Device:
//   dbb_assign            DeviceAssignment                 this machine only / copy / customised
// User:
//   dbb_personal          { [deviceId]: dashboardId }      personal override (only this user)

import * as api from './api';
import { Dashboard, checkDashboard, newId } from './schema';
import type { UserContext } from './scope';
import * as scope from './scope';

export interface Assignment {
  dashboardId: string;
  by: string;
  at: number;
}
export interface DeviceAssignment extends Assignment {
  mode: 'linked' | 'copy' | 'customised';
}

export type SourceLevel = 'personal' | 'device' | 'node' | 'customer' | 'default';
export interface Resolved {
  dashboard: Dashboard | null; // null => default auto layout
  level: SourceLevel;
  sourceLabel: string;
  sourceNodeId?: string;
  deviceAssignment?: DeviceAssignment | null;
  /** Every dashboard that applies to this device, most specific first (for the switcher). */
  candidates: { dashboard: Dashboard; level: SourceLevel; sourceLabel: string }[];
}

const D = (id: string) => `dbb_d_${id}`;
const H = (id: string) => `dbb_h_${id}`;
const VIS = (id: string) => `dbb_vis_${id}`;
const dev = (id: string): api.EntityRef => ({ id, entityType: 'DEVICE' });
const asset = (id: string): api.EntityRef => ({ id, entityType: 'ASSET' });

export class ConflictError extends Error {
  constructor(public current: Dashboard) {
    super(`This dashboard was changed by ${current.updatedBy} (version ${current.version}).`);
  }
}

function requireStore(ctx: UserContext): api.EntityRef {
  if (!ctx.store) throw new Error('Dashboard store is not set up for this customer.');
  return ctx.store;
}

// ---------- dashboards ----------

export async function listDashboards(ctx: UserContext): Promise<(Dashboard & { visibility: string })[]> {
  const store = requireStore(ctx);
  const keys = await api.get<string[]>(`/api/plugins/telemetry/ASSET/${store.id}/keys/attributes/SERVER_SCOPE`);
  const want = keys.filter((k) => k.startsWith('dbb_d_') || k.startsWith('dbb_vis_'));
  if (!want.length) return [];
  const attrs = await api.getAttrs(store, want);
  const out: (Dashboard & { visibility: string })[] = [];
  for (const k of Object.keys(attrs)) {
    if (!k.startsWith('dbb_d_')) continue;
    const p = Dashboard.safeParse(attrs[k]);
    if (!p.success) continue;
    const vis = attrs[VIS(p.data.id)] ?? 'shared';
    if (vis === 'private' && p.data.ownerId !== ctx.userId) continue;
    out.push({ ...p.data, visibility: vis });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDashboard(ctx: UserContext, id: string): Promise<Dashboard | null> {
  const a = await api.getAttrs(requireStore(ctx), [D(id)]);
  const p = Dashboard.safeParse(a[D(id)]);
  return p.success ? p.data : null;
}

/**
 * Saves with optimistic concurrency: `doc.version` must equal the stored version (0 for new).
 * Keeps the previous 10 versions.
 */
export async function saveDashboard(
  ctx: UserContext,
  doc: Dashboard,
  visibility?: 'private' | 'shared',
): Promise<Dashboard> {
  const store = requireStore(ctx);
  const parsed = Dashboard.parse(doc);
  const problems = checkDashboard(parsed);
  if (problems.length) throw new Error(problems.join(' '));
  const cur = await api.getAttrs(store, [D(doc.id), H(doc.id)]);
  const existing = Dashboard.safeParse(cur[D(doc.id)]);
  if (existing.success && existing.data.version !== doc.version) throw new ConflictError(existing.data);
  if (!existing.success && doc.version !== 0) throw new Error('Dashboard no longer exists; use Save as.');
  const next: Dashboard = { ...parsed, version: doc.version + 1, updatedAt: Date.now(), updatedBy: ctx.displayName };
  const hist: any[] = Array.isArray(cur[H(doc.id)]) ? cur[H(doc.id)] : [];
  if (existing.success) hist.unshift({ version: existing.data.version, savedAt: existing.data.updatedAt, savedBy: existing.data.updatedBy, doc: existing.data });
  const attrs: Record<string, unknown> = { [D(doc.id)]: next, [H(doc.id)]: hist.slice(0, 10) };
  if (visibility) attrs[VIS(doc.id)] = visibility;
  else if (!existing.success) attrs[VIS(doc.id)] = 'shared';
  await api.saveAttrs(store, attrs);
  return next;
}

export async function versions(ctx: UserContext, id: string): Promise<{ version: number; savedAt: number; savedBy: string; doc: Dashboard }[]> {
  const a = await api.getAttrs(requireStore(ctx), [H(id)]);
  return Array.isArray(a[H(id)]) ? a[H(id)] : [];
}

export async function restoreVersion(ctx: UserContext, id: string, version: number): Promise<Dashboard> {
  const [cur, hist] = await Promise.all([getDashboard(ctx, id), versions(ctx, id)]);
  const v = hist.find((h) => h.version === version);
  if (!cur || !v) throw new Error('Version not found.');
  return saveDashboard(ctx, { ...v.doc, version: cur.version });
}

export function blankDashboard(ctx: UserContext, name: string, profile: string | null): Dashboard {
  return {
    schemaVersion: 1,
    id: newId('d'),
    name,
    kind: profile ? 'device' : 'standalone',
    profile,
    timeRange: '24h',
    widgets: [],
    ownerId: ctx.userId,
    ownerName: ctx.displayName,
    version: 0,
    updatedAt: Date.now(),
    updatedBy: ctx.displayName,
    copiedFrom: null,
  };
}

// ---------- assignments ----------

async function readAssign(e: api.EntityRef): Promise<any> {
  const a = await api.getAttrs(e, ['dbb_assign']).catch(() => ({}) as any);
  return a.dbb_assign ?? null;
}

/** Walks up Contains relations through the real hierarchy (not limited to the user's scope). */
export async function realAncestors(deviceId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let cur: api.EntityRef = dev(deviceId);
  const guard = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const ps = await api.parentsOf(cur);
    const p = ps.find((r) => r.from.entityType === 'ASSET');
    if (!p || guard.has(p.from.id)) break;
    guard.add(p.from.id);
    out.push({ id: p.from.id, name: p.fromName ?? p.from.id });
    cur = p.from;
  }
  return out;
}

export async function resolveForDevice(ctx: UserContext, deviceId: string, profile: string): Promise<Resolved> {
  const store = ctx.store;
  const [userAttrs, devAssign, anc, storeAttrs] = await Promise.all([
    api.getAttrs({ id: ctx.userId, entityType: 'USER' }, ['dbb_personal']).catch(() => ({}) as any),
    readAssign(dev(deviceId)),
    realAncestors(deviceId),
    store ? api.getAttrs(store, ['dbb_assign_customer']).catch(() => ({}) as any) : Promise.resolve({} as any),
  ]);
  const cands: { id: string; level: SourceLevel; sourceLabel: string; nodeId?: string }[] = [];
  const personal = userAttrs.dbb_personal?.[deviceId];
  if (personal) cands.push({ id: personal, level: 'personal', sourceLabel: 'Your personal view' });
  if (devAssign?.dashboardId)
    cands.push({
      id: devAssign.dashboardId,
      level: 'device',
      sourceLabel: devAssign.mode === 'customised' ? 'Customised for this machine' : 'Assigned to this machine',
    });
  const ancAssigns = await Promise.all(anc.map((a) => readAssign(asset(a.id))));
  anc.forEach((a, i) => {
    const as = ancAssigns[i]?.[profile];
    if (as?.dashboardId) {
      const label = ctx.nodes.get(a.id)?.label ?? a.name;
      cands.push({ id: as.dashboardId, level: 'node', sourceLabel: `All ${profile} machines in ${label}`, nodeId: a.id });
    }
  });
  const cw = storeAttrs.dbb_assign_customer?.[profile];
  if (cw?.dashboardId) cands.push({ id: cw.dashboardId, level: 'customer', sourceLabel: `All ${profile} machines` });

  // load the dashboards (dedupe)
  const ids = [...new Set(cands.map((c) => c.id))];
  const docs = ids.length && store ? await api.getAttrs(store, ids.map(D)) : {};
  const candidates: Resolved['candidates'] = [];
  for (const c of cands) {
    const p = Dashboard.safeParse((docs as any)[D(c.id)]);
    if (p.success) candidates.push({ dashboard: p.data, level: c.level, sourceLabel: c.sourceLabel });
  }
  const first = candidates[0];
  const nodeC = cands.find((c) => first && c.id === first.dashboard.id && c.level === first.level);
  return {
    dashboard: first?.dashboard ?? null,
    level: first?.level ?? 'default',
    sourceLabel: first?.sourceLabel ?? 'Default layout',
    sourceNodeId: nodeC?.nodeId,
    deviceAssignment: devAssign,
    candidates,
  };
}

export type ApplyTarget =
  | { type: 'personal'; deviceId: string }
  | { type: 'devices'; deviceIds: string[]; mode: 'linked' | 'copy' }
  | { type: 'node'; nodeId: string; profile: string }
  | { type: 'customer'; profile: string }
  | { type: 'none' };

export interface ApplyPreview {
  affected: { id: string; label: string }[];
  /** Devices that currently show a different assigned dashboard and would switch. */
  replaced: { id: string; label: string; from: string }[];
  /** Devices with their own (device-level) dashboard, which a node/customer assignment will NOT override. */
  keepOwn: { id: string; label: string }[];
  /** Same-level assignment that will be replaced (asks "Replace existing?"). */
  replacesAssignment: { dashboardId: string; name: string } | null;
  missingKeys: { key: string; devices: string[] }[];
  errors: string[];
}

export function canApply(ctx: UserContext, t: ApplyTarget): string | null {
  if (t.type === 'none' || t.type === 'personal') return null;
  if (t.type === 'devices') {
    if (t.deviceIds.length > 1 && !ctx.isAdmin) return 'Only admins can apply a dashboard to more than one machine.';
    const out = t.deviceIds.filter((d) => !scope.inScope(ctx, d));
    return out.length ? 'Some machines are outside your access.' : null;
  }
  if (!ctx.isAdmin) return 'Only admins can apply a dashboard to all machines of a type.';
  if (t.type === 'node' && !scope.inScope(ctx, t.nodeId)) return 'That node is outside your access.';
  if (t.type === 'customer') {
    // customer-wide requires the user's scope to cover the whole organisation (scope roots have no parent)
    if (!ctx.rootsAreTop) return 'Customer-wide assignment requires access to the whole organisation.';
  }
  return null;
}

async function keysOf(ctx: UserContext, deviceId: string): Promise<Set<string>> {
  return new Set(await api.timeseriesKeys(deviceId).catch(() => []));
}

export async function previewApply(ctx: UserContext, doc: Dashboard, t: ApplyTarget): Promise<ApplyPreview> {
  const pv: ApplyPreview = { affected: [], replaced: [], keepOwn: [], replacesAssignment: null, missingKeys: [], errors: [] };
  const deny = canApply(ctx, t);
  if (deny) pv.errors.push(deny);
  if (t.type === 'none') return pv;
  let devices: scope.Node[] = [];
  if (t.type === 'personal') devices = [ctx.nodes.get(t.deviceId)!].filter(Boolean);
  if (t.type === 'devices') devices = t.deviceIds.map((d) => ctx.nodes.get(d)!).filter(Boolean);
  if (t.type === 'node') devices = scope.devicesUnder(ctx, t.nodeId, t.profile);
  if (t.type === 'customer') devices = scope.allDevices(ctx, t.profile);
  pv.affected = devices.map((d) => ({ id: d.id, label: d.label }));

  if (t.type === 'node') {
    const cur = (await readAssign(asset(t.nodeId)))?.[t.profile];
    if (cur?.dashboardId && cur.dashboardId !== doc.id) {
      const other = await getDashboard(ctx, cur.dashboardId);
      pv.replacesAssignment = { dashboardId: cur.dashboardId, name: other?.name ?? cur.dashboardId };
    }
  }
  if (t.type === 'customer' && ctx.store) {
    const cur = (await api.getAttrs(ctx.store, ['dbb_assign_customer'])).dbb_assign_customer?.[t.profile];
    if (cur?.dashboardId && cur.dashboardId !== doc.id) {
      const other = await getDashboard(ctx, cur.dashboardId);
      pv.replacesAssignment = { dashboardId: cur.dashboardId, name: other?.name ?? cur.dashboardId };
    }
  }

  // per-device: current resolution + key availability
  const usedKeys = [...new Set(doc.widgets.filter((w) => w.binding.mode === 'current').flatMap((w) => w.keys))];
  const missing = new Map<string, string[]>();
  await Promise.all(
    devices.map(async (d) => {
      const [res, keys] = await Promise.all([resolveForDevice(ctx, d.id, d.profile), keysOf(ctx, d.id)]);
      if ((t.type === 'node' || t.type === 'customer') && res.deviceAssignment?.dashboardId) pv.keepOwn.push({ id: d.id, label: d.label });
      else if (res.dashboard && res.dashboard.id !== doc.id && res.level !== 'personal')
        pv.replaced.push({ id: d.id, label: d.label, from: res.dashboard.name });
      for (const k of usedKeys) if (!keys.has(k)) missing.set(k, [...(missing.get(k) ?? []), d.label]);
    }),
  );
  pv.missingKeys = [...missing.entries()].map(([key, devs]) => ({ key, devices: devs }));
  return pv;
}

/** Applies a saved dashboard. Copy mode creates one independent dashboard per machine. */
export async function apply(ctx: UserContext, doc: Dashboard, t: ApplyTarget): Promise<string[]> {
  const deny = canApply(ctx, t);
  if (deny) throw new Error(deny);
  const now = Date.now();
  const done: string[] = [];
  if (t.type === 'none') return done;
  if (t.type === 'personal') {
    const cur = (await api.getAttrs({ id: ctx.userId, entityType: 'USER' }, ['dbb_personal'])).dbb_personal ?? {};
    await api.saveAttrs({ id: ctx.userId, entityType: 'USER' }, { dbb_personal: { ...cur, [t.deviceId]: doc.id } });
    return [t.deviceId];
  }
  if (t.type === 'devices') {
    for (const id of t.deviceIds) {
      let dashId = doc.id;
      if (t.mode === 'copy') {
        const label = ctx.nodes.get(id)?.label ?? id;
        const copy = await saveDashboard(ctx, { ...doc, id: newId('d'), name: `${doc.name} — ${label}`, version: 0, copiedFrom: doc.id, ownerId: ctx.userId, ownerName: ctx.displayName });
        dashId = copy.id;
      }
      const a: DeviceAssignment = { dashboardId: dashId, mode: t.mode, by: ctx.displayName, at: now };
      await api.saveAttrs(dev(id), { dbb_assign: a });
      done.push(id);
    }
    return done;
  }
  const a: Assignment = { dashboardId: doc.id, by: ctx.displayName, at: now };
  if (t.type === 'node') {
    const cur = (await readAssign(asset(t.nodeId))) ?? {};
    await api.saveAttrs(asset(t.nodeId), { dbb_assign: { ...cur, [t.profile]: a } });
    return scope.devicesUnder(ctx, t.nodeId, t.profile).map((d) => d.id);
  }
  const store = requireStore(ctx);
  const cur = (await api.getAttrs(store, ['dbb_assign_customer'])).dbb_assign_customer ?? {};
  await api.saveAttrs(store, { dbb_assign_customer: { ...cur, [t.profile]: a } });
  return scope.allDevices(ctx, t.profile).map((d) => d.id);
}

/** "Customise for this machine": device-level copy that stops following the template. */
export async function customise(ctx: UserContext, deviceId: string, template: Dashboard): Promise<Dashboard> {
  if (!ctx.isAdmin && !scope.inScope(ctx, deviceId)) throw new Error('Machine is outside your access.');
  const label = ctx.nodes.get(deviceId)?.label ?? deviceId;
  const copy = await saveDashboard(ctx, {
    ...template,
    id: newId('d'),
    name: `${template.name} (customised: ${label})`,
    version: 0,
    copiedFrom: template.id,
    ownerId: ctx.userId,
    ownerName: ctx.displayName,
  });
  await api.saveAttrs(dev(deviceId), { dbb_assign: { dashboardId: copy.id, mode: 'customised', by: ctx.displayName, at: Date.now() } });
  return copy;
}

/** "Reset to template": removes the device-level assignment (and its customised copy). */
export async function resetDevice(ctx: UserContext, deviceId: string): Promise<void> {
  const a: DeviceAssignment | null = await readAssign(dev(deviceId));
  await api.deleteAttrs(dev(deviceId), ['dbb_assign']);
  if (a && (a.mode === 'customised' || a.mode === 'copy') && ctx.store) {
    await api.deleteAttrs(ctx.store, [D(a.dashboardId), H(a.dashboardId), VIS(a.dashboardId)]).catch(() => undefined);
  }
}

export async function clearPersonal(ctx: UserContext, deviceId: string) {
  const u = { id: ctx.userId, entityType: 'USER' };
  const cur = (await api.getAttrs(u, ['dbb_personal'])).dbb_personal ?? {};
  delete cur[deviceId];
  await api.saveAttrs(u, { dbb_personal: cur });
}

/** Where a dashboard is used, and which machines have customised copies of it. */
export async function usage(ctx: UserContext, doc: Dashboard): Promise<{ devices: string[]; customised: string[] }> {
  if (!doc.profile) return { devices: [], customised: [] };
  const devices: string[] = [];
  const customised: string[] = [];
  await Promise.all(
    scope.allDevices(ctx, doc.profile).map(async (d) => {
      const r = await resolveForDevice(ctx, d.id, d.profile);
      const nonPersonal = r.candidates.find((c) => c.level !== 'personal');
      if (nonPersonal?.dashboard.id === doc.id) devices.push(d.label);
      else if (nonPersonal?.dashboard.copiedFrom === doc.id && r.deviceAssignment?.mode === 'customised') customised.push(d.label);
    }),
  );
  return { devices, customised };
}

/** Deletes a dashboard and every assignment in the user's scope that points at it. */
export async function deleteDashboard(ctx: UserContext, doc: Dashboard): Promise<string[]> {
  if (doc.ownerId !== ctx.userId && !ctx.isAdmin) throw new Error('Only the owner or an admin can delete this dashboard.');
  const store = requireStore(ctx);
  const affected: string[] = [];
  for (const n of ctx.nodes.values()) {
    const a = await readAssign(n.entityType === 'DEVICE' ? dev(n.id) : asset(n.id));
    if (!a) continue;
    if (n.entityType === 'DEVICE' && a.dashboardId === doc.id) {
      await api.deleteAttrs(dev(n.id), ['dbb_assign']);
      affected.push(n.label);
    } else if (n.entityType === 'ASSET') {
      const keep = Object.fromEntries(Object.entries(a).filter(([, v]: any) => v?.dashboardId !== doc.id));
      if (Object.keys(keep).length !== Object.keys(a).length) {
        await api.saveAttrs(asset(n.id), { dbb_assign: keep });
        affected.push(`${n.label} (all ${doc.profile})`);
      }
    }
  }
  const cw = (await api.getAttrs(store, ['dbb_assign_customer'])).dbb_assign_customer ?? {};
  const keep = Object.fromEntries(Object.entries(cw).filter(([, v]: any) => v?.dashboardId !== doc.id));
  if (Object.keys(keep).length !== Object.keys(cw).length) {
    await api.saveAttrs(store, { dbb_assign_customer: keep });
    affected.push(`All ${doc.profile} machines`);
  }
  await api.deleteAttrs(store, [D(doc.id), H(doc.id), VIS(doc.id)]);
  return affected;
}
