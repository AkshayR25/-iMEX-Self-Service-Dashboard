// core/store.ts — dashboard storage, assignments and resolution (DECISIONS D-013, D-015, D-017).
//
// Everything lives in ThingsBoard SERVER_SCOPE attributes, written as the logged-in customer user
// (no tenant credentials, D-010). Customers can't write customer attributes (D-012), so dashboards
// live on one DashboardStore asset per customer (`ctx.store`, found by core/scope.ts).
//
// Store asset (type DashboardStore, one per TB customer):
//   dbb_d_<id>            Dashboard JSON (core/schema.ts format)
//   dbb_h_<id>            last 10 previous versions [{version, savedAt, savedBy, doc}], newest first
//   dbb_vis_<id>          'private' | 'shared' (missing = shared; private = listed for the owner only)
//   dbb_assign_customer   { [profile]: Assignment }        customer-wide per machine type
// Asset (site/plant/line/org):
//   dbb_assign            { [profile]: Assignment }        all machines of a type under this node
// Device:
//   dbb_assign            DeviceAssignment                 this machine only / copy / customised
// User:
//   dbb_personal          { [deviceId]: dashboardId }      personal override (only this user;
//                                                         still resolved, no longer created by the UI, D-017)
//
// Resolution (`resolveForDevice`): first match of
//   personal > device > nearest ancestor location (walking the REAL hierarchy up) > customer-wide
//   > built-in default layout (dashboard null).
// All matches are returned as `candidates` for the "Show dashboard" switcher.
//
// Saving: `saveDashboard` validates (Zod + checkDashboard incl. property kinds), then uses
// optimistic concurrency on `version` and keeps history. Two attribute writes are not atomic in
// ThingsBoard, so two users saving at the same moment can still both succeed (last write wins).
//
// Apply / customise / reset: `apply` writes assignments; `customise` makes a per-machine copy;
// `resetDevice` removes the device assignment (and its copy). Callers (builder, renderer entry)
// write the audit entry (core/audit.ts) after each of these.
//
// SECURITY (D-012): every permission check here (`canApply`, owner/admin on delete, scope checks)
// runs in the browser only. A customer user can write any of these attributes directly via REST.

import * as api from './api';
import { Dashboard, checkDashboard, newId } from './schema';
import { metaLookup } from './compat';
import type { UserContext } from './scope';
import * as scope from './scope';

/** A dashboard assigned at node or customer level: which dashboard, who assigned it (display name), when (ms). */
export interface Assignment {
  dashboardId: string;
  by: string;
  at: number;
}
/**
 * Device-level assignment. `linked` = follows the shared dashboard; `copy` = an independent copy
 * made by a copy-mode apply; `customised` = copy made by "Customise for this machine".
 */
export interface DeviceAssignment extends Assignment {
  mode: 'linked' | 'copy' | 'customised';
}

/** Where the dashboard shown on a machine comes from; 'node' = an ancestor location. */
export type SourceLevel = 'personal' | 'device' | 'node' | 'customer' | 'default';
/** Result of `resolveForDevice`. */
export interface Resolved {
  dashboard: Dashboard | null; // null => default auto layout
  level: SourceLevel;
  sourceLabel: string;
  sourceNodeId?: string;
  deviceAssignment?: DeviceAssignment | null;
  /** Every dashboard that applies to this device, most specific first (for the switcher). */
  candidates: { dashboard: Dashboard; level: SourceLevel; sourceLabel: string }[];
}

// attribute key builders and entity refs
const D = (id: string) => `dbb_d_${id}`;
const H = (id: string) => `dbb_h_${id}`;
const VIS = (id: string) => `dbb_vis_${id}`;
const dev = (id: string): api.EntityRef => ({ id, entityType: 'DEVICE' });
const asset = (id: string): api.EntityRef => ({ id, entityType: 'ASSET' });

/** Thrown by `saveDashboard` when the stored version differs from the one being saved; carries the stored copy. */
export class ConflictError extends Error {
  constructor(public current: Dashboard) {
    super(`This dashboard was changed by ${current.updatedBy} (version ${current.version}).`);
  }
}

/** The customer's store asset, or throws when the customer has none (saving disabled). */
function requireStore(ctx: UserContext): api.EntityRef {
  if (!ctx.store) throw new Error('Dashboard store is not set up for this customer.');
  return ctx.store;
}

// ---------- dashboards ----------

/**
 * All dashboards on the store asset, newest first, with their visibility.
 * Reads the store's SERVER attribute key list, then every `dbb_d_*` / `dbb_vis_*` value (so it grows
 * with the number of dashboards). Documents that fail the schema are skipped silently; private
 * dashboards of other users are hidden (UI-only, D-012).
 */
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

/** One dashboard from `dbb_d_<id>`, or null when missing or not a valid dashboard. */
export async function getDashboard(ctx: UserContext, id: string): Promise<Dashboard | null> {
  const a = await api.getAttrs(requireStore(ctx), [D(id)]);
  const p = Dashboard.safeParse(a[D(id)]);
  return p.success ? p.data : null;
}

/**
 * Saves a dashboard to the store asset with optimistic concurrency.
 * Steps: Zod parse -> `checkDashboard` with property kinds (throws all problems as one message) ->
 * read `dbb_d_<id>` and `dbb_h_<id>` -> version check -> write the new document (version + 1,
 * updatedAt/updatedBy = now/this user) and the history (previous document prepended, max 10) in
 * one attribute POST. Visibility `dbb_vis_<id>` is written when given, or 'shared' for a new dashboard.
 * @param doc        the draft; `doc.version` must equal the stored version (0 for a new dashboard).
 * @param visibility optional new visibility.
 * @returns the saved document (with the new version).
 * @throws ConflictError when someone else saved in between (the UI offers reload / save as copy);
 *         Error when a non-zero version no longer exists, or the store is missing.
 * Permission to overwrite a shared dashboard (D-015) is decided by the builder, not here.
 */
export async function saveDashboard(
  ctx: UserContext,
  doc: Dashboard,
  visibility?: 'private' | 'shared',
): Promise<Dashboard> {
  const store = requireStore(ctx);
  const parsed = Dashboard.parse(doc);
  const problems = checkDashboard(parsed, metaLookup(ctx, parsed));
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

/** Previous versions of a dashboard from `dbb_h_<id>` (newest first, at most 10); [] when none. */
export async function versions(ctx: UserContext, id: string): Promise<{ version: number; savedAt: number; savedBy: string; doc: Dashboard }[]> {
  const a = await api.getAttrs(requireStore(ctx), [H(id)]);
  return Array.isArray(a[H(id)]) ? a[H(id)] : [];
}

/**
 * Restores an older version by saving its document as a NEW version on top of the current one
 * (so the restore itself is in the history). Goes through `saveDashboard`, so the old version must
 * pass the current limits; throws when it does not, or when the version is not found.
 */
export async function restoreVersion(ctx: UserContext, id: string, version: number): Promise<Dashboard> {
  const [cur, hist] = await Promise.all([getDashboard(ctx, id), versions(ctx, id)]);
  const v = hist.find((h) => h.version === version);
  if (!cur || !v) throw new Error('Version not found.');
  return saveDashboard(ctx, { ...v.doc, version: cur.version });
}

/** New empty dashboard owned by the user (version 0, realtime); 'device' kind when a profile is given. Not saved. */
export function blankDashboard(ctx: UserContext, name: string, profile: string | null): Dashboard {
  return {
    schemaVersion: 1,
    id: newId('d'),
    name,
    kind: profile ? 'device' : 'standalone',
    profile,
    timeRange: 'realtime',
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

/** `dbb_assign` of a device or asset, or null (read errors are treated as "no assignment"). */
async function readAssign(e: api.EntityRef): Promise<any> {
  const a = await api.getAttrs(e, ['dbb_assign']).catch(() => ({}) as any);
  return a.dbb_assign ?? null;
}

/**
 * Walks up Contains relations through the real hierarchy (not limited to the user's scope), nearest
 * first, following the first ASSET parent at each level; at most 12 levels, cycle-safe.
 * Using the real hierarchy means a location assignment above the user's scope root still applies.
 * One REST call per level.
 */
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

/**
 * Which dashboard a machine shows for this user (D-013): first match of personal (user
 * `dbb_personal`) > device (`dbb_assign` on the device) > nearest ancestor location (`dbb_assign[profile]`
 * on each real ancestor, nearest first) > customer-wide (store `dbb_assign_customer[profile]`)
 * > default layout (`dashboard: null`, level 'default').
 * Assignments whose dashboard is missing or invalid are skipped, so the next level wins.
 * Read-only; about 3 + 2 x (hierarchy depth) calls.
 * @param profile the machine's device profile (assignments above device level are per profile).
 */
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
  // node id of the winning candidate, when it came from a location assignment
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

/**
 * Where to apply a saved dashboard: the user's personal view of one machine, specific machines
 * (linked, or one independent copy each), all machines of a type under a location, all machines of
 * a type of the customer, or nowhere.
 */
export type ApplyTarget =
  | { type: 'personal'; deviceId: string }
  | { type: 'devices'; deviceIds: string[]; mode: 'linked' | 'copy' }
  | { type: 'node'; nodeId: string; profile: string }
  | { type: 'customer'; profile: string }
  | { type: 'none' };

/** What an apply would do, shown before the admin confirms (`previewApply`). */
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

/**
 * Permission check for an apply target (D-011, D-017). Returns a user-facing reason, or null if allowed.
 * - personal / none: always allowed.
 * - devices: all must be in scope; more than one needs an admin.
 * - node / customer: admin only; node must be in scope; customer-wide needs `ctx.rootsAreTop`.
 * SECURITY: UI-only (D-012); nothing on the server enforces this.
 */
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

/** Telemetry keys of a device; empty set on error. */
async function keysOf(ctx: UserContext, deviceId: string): Promise<Set<string>> {
  return new Set(await api.timeseriesKeys(deviceId).catch(() => []));
}

/**
 * Dry run of `apply` for the confirmation dialog. Read-only.
 * Fills: affected machines (in scope), machines that would switch from another dashboard,
 * machines keeping their own device-level dashboard (node/customer targets never override those),
 * a same-level assignment that would be replaced, keys used by 'current' widgets that some machines
 * have never reported, and the `canApply` error if any.
 * Cost: a full `resolveForDevice` plus a key listing per affected machine (slow on the demo server).
 */
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

/**
 * Applies a saved dashboard to a target (checks `canApply` first, throws its reason).
 * Writes:
 * - personal: user attribute `dbb_personal[deviceId]`.
 * - devices:  device `dbb_assign` = DeviceAssignment; in copy mode first saves one independent
 *             dashboard per machine (`copiedFrom` = doc.id) and assigns that.
 * - node:     asset `dbb_assign[profile]` (merged with other profiles' entries).
 * - customer: store `dbb_assign_customer[profile]` (merged).
 * Read-modify-write without locking: concurrent applies on the same entity can lose one update.
 * Device-level assignments are not touched by node/customer applies (they keep winning).
 * @returns ids of the machines in scope that the assignment covers (for the audit/summary).
 */
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

/**
 * "Customise for this machine": saves a copy of `template` (new id, version 0, `copiedFrom`) and
 * assigns it to the device with mode 'customised', so the machine stops following the template.
 * Writes: store `dbb_d_/dbb_h_/dbb_vis_<copy>`, device `dbb_assign`. Scope check is UI-only (D-012).
 */
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

/**
 * "Reset to shared dashboard": deletes the device's `dbb_assign`, so the machine falls back to the
 * location / customer-wide / default dashboard. When that assignment was a 'customised' or 'copy'
 * dashboard, its `dbb_d_/dbb_h_/dbb_vis_` attributes are deleted too (best effort).
 * No permission check here; callers restrict it to admins (UI-only, D-012).
 */
export async function resetDevice(ctx: UserContext, deviceId: string): Promise<void> {
  const a: DeviceAssignment | null = await readAssign(dev(deviceId));
  await api.deleteAttrs(dev(deviceId), ['dbb_assign']);
  if (a && (a.mode === 'customised' || a.mode === 'copy') && ctx.store) {
    await api.deleteAttrs(ctx.store, [D(a.dashboardId), H(a.dashboardId), VIS(a.dashboardId)]).catch(() => undefined);
  }
}

/** Removes the user's personal view for one machine (user attribute `dbb_personal`). */
export async function clearPersonal(ctx: UserContext, deviceId: string) {
  const u = { id: ctx.userId, entityType: 'USER' };
  const cur = (await api.getAttrs(u, ['dbb_personal'])).dbb_personal ?? {};
  delete cur[deviceId];
  await api.saveAttrs(u, { dbb_personal: cur });
}

/**
 * Where a dashboard is used (machines in scope of its profile whose non-personal resolution is it),
 * and which machines have customised copies of it. Returns machine labels. Runs `resolveForDevice`
 * for every machine of the profile, so it is slow on large scopes.
 */
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

/**
 * Deletes a dashboard and every assignment in the user's scope that points at it: device
 * `dbb_assign`, entries in asset `dbb_assign`, entries in store `dbb_assign_customer`; then the
 * store's `dbb_d_/dbb_h_/dbb_vis_<id>`. Assignments outside the user's scope are left dangling
 * (resolution skips them because the dashboard no longer loads). Per-machine copies are kept.
 * Only the owner or an admin (UI-only, D-012). Sequential calls: one read per node in scope.
 * @returns labels of what was unassigned, for the confirmation/audit.
 */
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
