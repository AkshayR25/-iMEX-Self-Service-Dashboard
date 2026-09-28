// core/api.ts — thin browser-side REST client for the ThingsBoard CE API.
//
// Purpose: every ThingsBoard call made by the widgets (builder, renderer, listing, launcher) goes
// through here. There is no backend of our own (DECISIONS D-010): calls run as the LOGGED-IN user
// with the JWT the ThingsBoard UI keeps in `localStorage.jwt_token`. No tenant credentials exist in
// the widgets, so every call is limited to what that user may do in CE (see D-012 for what a
// customer user can and cannot write).
//
// Token refresh: the ThingsBoard UI refreshes its token lazily. `bindWidgetContext(ctx)` (called by
// entries/common.ts for every widget) stores a hook that makes one call through the TB UI's own
// Angular HttpClient (`ctx.http`), which refreshes `jwt_token` as a side effect. `request()` uses it
// once per call on a 401 and then retries with the new token.
//
// Retries: 429 and 5xx are retried up to 3 times with exponential back-off (0.8 s, 1.6 s, 3.2 s).
//
// Main exports:
//   request / get / post          low-level call; JSON in, JSON out; throws ApiError on non-2xx
//   getAttrs / saveAttrs / deleteAttrs   attributes (SERVER_SCOPE by default) of any entity
//   latest / series               device timeseries (latest values, windowed history). Both read the
//                                 WebSocket live cache (core/live.ts, D-021) first and use REST only until
//                                 the subscription is ready or while the socket is down.
//   getCached                     GET with a time-to-live while the socket is live (window aggregates)
//   alarms                        alarm list of an entity (/api/v2/alarm); 15 s cache while live
//   childrenOf / parentsOf        relations (default type `Contains`, the hierarchy relation)
//   devicesByIds / assetsByIds    bulk entity lookup (chunks of 100 ids)
//   relationsTree                 every Contains relation below / above an entity in ONE call (D-022)
//   entityData                    names, labels, profiles, SERVER attributes and latest telemetry of many
//                                 entities in ONE call (Entity Data Query, D-022)
//   latestMany                    latest values of many devices: live cache, else one entityData call (D-022)
//   activeAlarmCounts             active alarm count per device in ONE call (Alarm Data Query, D-022)
//   timeseriesKeys                telemetry keys a device has ever reported
//
// ThingsBoard endpoints used:
//   GET  /api/plugins/telemetry/{type}/{id}/values/attributes/{scope}?keys=
//   POST /api/plugins/telemetry/{type}/{id}/attributes/{scope}           (upsert; one call per write)
//   DELETE /api/plugins/telemetry/{type}/{id}/{scope}?keys=
//   GET  /api/plugins/telemetry/DEVICE/{id}/values/timeseries            (latest, or windowed with startTs/endTs)
//   GET  /api/plugins/telemetry/DEVICE/{id}/keys/timeseries
//   GET  /api/v2/alarm/{type}/{id}
//   GET  /api/relations/info?fromId=|toId=&relationTypeGroup=COMMON
//   GET  /api/devices?deviceIds=, /api/assets?assetIds=
//   POST /api/relations                                                 (EntityRelationsQuery, whole subtree)
//   POST /api/entitiesQuery/find                                        (Entity Data Query)
//   POST /api/alarmsQuery/find                                          (Alarm Data Query)
//   GET  /api/auth/user (refresh hook; also used by core/scope.ts)
//
// ThingsBoard quirks to keep in mind when changing this file (see DECISIONS "ThingsBoard quirks"):
//   - `values/timeseries` returns at most 100 points when `limit` is omitted with agg NONE, so
//     `series()` always passes `limit`.
//   - Name lookups such as /api/tenant/assets?assetName= return 404 (not an empty page) when nothing
//     matches; pass `allow404` to `request()` to get `null` instead of an exception.
//   - Attribute values written as objects come back as JSON strings; `getAttrs()` parses them back.

/** Minimal ThingsBoard entity id: `{ id: uuid, entityType: 'DEVICE' | 'ASSET' | 'USER' | ... }`. */
import { liveHub } from './live';

export interface EntityRef {
  id: string;
  entityType: string;
}

/**
 * Non-2xx response from ThingsBoard (or 401 "Not logged in" when no JWT is present).
 * `status` is the HTTP status, `path` the request path, `body` the raw response text; the message
 * keeps only the first 200 characters of the body.
 */
export class ApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`${status} ${path}: ${body.slice(0, 200)}`);
  }
}

type RefreshHook = () => Promise<void>;
let refreshHook: RefreshHook | null = null;

/**
 * Registers the ThingsBoard widget context so a 401 can trigger the TB UI's own token refresh.
 * The hook calls GET /api/auth/user through `ctx.http` (Angular HttpClient with TB's interceptors,
 * which refresh `localStorage.jwt_token`) and resolves whether that call succeeds or not.
 * Module-global: the last bound context wins, which is fine because all widgets on a page share
 * one login. Without a ctx (tests, harness) 401s are thrown straight away.
 * @param ctx ThingsBoard widget `self.ctx`; ignored when it has no `http`.
 */
export function bindWidgetContext(ctx: any) {
  if (!ctx?.http) return;
  refreshHook = () =>
    new Promise<void>((resolve) => {
      try {
        ctx.http.get('/api/auth/user').subscribe({ next: () => resolve(), error: () => resolve() });
      } catch {
        resolve();
      }
    });
}

/** Current JWT of the logged-in user. Throws ApiError(401) when the TB UI holds no token. */
function token(): string {
  const t = localStorage.getItem('jwt_token');
  if (!t) throw new ApiError(401, 'auth', 'Not logged in');
  return t;
}

/**
 * Performs one REST call as the logged-in user (`X-Authorization: Bearer <jwt>`).
 * - 401: refreshes the token once through the bound widget ctx, then retries.
 * - 429 / 5xx: retried up to 3 times with back-off 0.8 s, 1.6 s, 3.2 s.
 * - 404 with `allow404`: returns null (TB returns 404 for empty name lookups).
 * @param method HTTP method.
 * @param path   absolute ThingsBoard path, e.g. `/api/auth/user` (same origin as the TB UI).
 * @param body   JSON-serialised when given; sets Content-Type.
 * @returns parsed JSON body, or null for an empty body.
 * @throws ApiError for any other non-2xx status.
 */
export async function request<T = any>(method: string, path: string, body?: unknown, allow404 = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { 'X-Authorization': `Bearer ${token()}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && attempt === 0 && refreshHook) {
      await refreshHook();
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (res.status === 404 && allow404) return null as T;
    if (!res.ok) throw new ApiError(res.status, path, text);
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** GET shorthand for `request()`. */
export const get = <T = any>(p: string) => request<T>('GET', p);
/** POST shorthand for `request()`. */
export const post = <T = any>(p: string, b?: unknown) => request<T>('POST', p, b);

// ---------- attributes ----------

/**
 * Reads attributes of an entity.
 * @param e     entity to read from.
 * @param keys  keys to read; omitted or empty = all keys in the scope.
 * @param scope 'SERVER_SCOPE' (default), 'SHARED_SCOPE' or 'CLIENT_SCOPE'.
 * @returns key -> value; JSON-looking strings are parsed (see `parseMaybeJson`). Missing keys are
 *          simply absent from the result.
 */
export async function getAttrs(e: EntityRef, keys?: string[], scope = 'SERVER_SCOPE'): Promise<Record<string, any>> {
  const q = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
  const rows = await get<{ key: string; value: any }[]>(`/api/plugins/telemetry/${e.entityType}/${e.id}/values/attributes/${scope}${q}`);
  const out: Record<string, any> = {};
  for (const r of rows) out[r.key] = parseMaybeJson(r.value);
  return out;
}

/**
 * Writes (upserts) attributes on an entity; objects are stored as JSON by ThingsBoard.
 * Only the given keys change; others are kept. Customer users may write SERVER/SHARED attributes on
 * any device/asset of their customer and on their own user (D-012), so callers must do their own
 * permission checks (UI-only enforcement).
 */
export function saveAttrs(e: EntityRef, attrs: Record<string, unknown>, scope = 'SERVER_SCOPE') {
  return post(`/api/plugins/telemetry/${e.entityType}/${e.id}/attributes/${scope}`, attrs);
}

/** Deletes attribute keys from an entity in the given scope (default SERVER_SCOPE). */
export function deleteAttrs(e: EntityRef, keys: string[], scope = 'SERVER_SCOPE') {
  return request('DELETE', `/api/plugins/telemetry/${e.entityType}/${e.id}/${scope}?keys=${encodeURIComponent(keys.join(','))}`);
}

/**
 * Returns `v` parsed as JSON when it is a string that looks like an object or array
 * (starts with `{` or `[`); otherwise, or when parsing fails, returns `v` unchanged.
 */
export function parseMaybeJson(v: any): any {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

// ---------- telemetry ----------

/** Latest value per key; a key is absent/undefined when the device has no (non-empty) value for it. */
export type Latest = Record<string, { ts: number; value: number | string } | undefined>;

/**
 * Latest telemetry values of a device (GET values/timeseries without a time window).
 * Values that look numeric are converted to numbers; null/empty values are dropped.
 */
export async function latest(deviceId: string, keys: string[]): Promise<Latest> {
  if (!keys.length) return {};
  // Live cache first (WebSocket, D-021); REST only until the subscription's first reply or while the socket is down.
  const L = liveHub();
  if (L) {
    L.want(deviceId, keys);
    // cold page: give the socket a moment (it is usually ready in a few hundred ms) instead of a REST call
    const c = L.get(deviceId, keys) ?? ((await L.waitReady(deviceId, keys, LIVE_WAIT_MS)) ? L.get(deviceId, keys) : null);
    if (c) return c as Latest;
  }
  const r = await get<Record<string, { ts: number; value: string }[]>>(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(keys.join(','))}`,
  );
  const out: Latest = {};
  for (const k of keys) {
    const p = r?.[k]?.[0];
    if (p && p.value !== null && p.value !== undefined && String(p.value) !== '') out[k] = { ts: p.ts, value: toNum(p.value) };
  }
  return out;
}

/**
 * How long `latest()` / `latestMany()` wait for a WebSocket subscription that is still being set up before
 * falling back to REST (D-022). Short enough that a slow socket costs little; long enough for the usual case.
 */
export const LIVE_WAIT_MS = 1500;

/** ThingsBoard aggregation function for `series()`. */
export type Agg = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM';

/**
 * Timeseries of a device between `startTs` and `endTs` (ms), sorted ascending by ts.
 * Picks an aggregation interval (`pickInterval`) so each series has at most about `maxPoints`
 * points, and always passes `limit` (TB returns only 100 points without it).
 * Raw data (`agg` NONE) is switched to AVG when the span is long (more than maxPoints x 10 s),
 * to avoid huge responses.
 * @returns key -> points; a key with no data maps to an empty array. Non-numeric values are kept as
 *          they come (typed as number for the charts).
 */
export async function series(
  deviceId: string,
  keys: string[],
  startTs: number,
  endTs: number,
  agg: Agg = 'AVG',
  maxPoints = 500,
): Promise<Record<string, { ts: number; value: number }[]>> {
  if (!keys.length) return {};
  // Cache + live append (D-021). A window ending "now" with AVG/NONE aggregation is fetched over REST once,
  // then extended with the points pushed over the WebSocket; it is re-fetched every 5 minutes (bucket drift).
  // SUM/MIN/MAX windows and past windows can't be extended point by point: they are re-fetched after 55 s /
  // 5 min. With the socket down the cache is bypassed (REST every call, the pre-D-021 behaviour).
  const L = liveHub();
  const now = Date.now();
  const offsetMin = Math.round((now - endTs) / 60e3);
  const ck = `s|${deviceId}|${keys.join(',')}|${agg}|${maxPoints}|${Math.round((endTs - startTs) / 60e3)}|${offsetMin}`;
  const appendable = !!L && (agg === 'AVG' || agg === 'NONE') && offsetMin <= 1;
  if (L && appendable) L.want(deviceId, keys);
  if (L?.isLive()) {
    const c = seriesCache.get(ck);
    if (c) {
      const age = now - c.fetchedAt;
      const since = appendable ? L.liveSince(deviceId, keys) : null;
      if (appendable && since != null && since <= c.fetchedAt && age < 5 * 60e3) {
        const out: Record<string, { ts: number; value: number }[]> = {};
        for (const k of keys) {
          const base = c.data[k] ?? [];
          const lastTs = base.length ? base[base.length - 1].ts : c.fetchedAt - 1;
          const extra = (L.since(deviceId, k, lastTs) ?? []).map((p) => ({ ts: p.ts, value: p.value as number }));
          out[k] = base.concat(extra).filter((p) => p.ts >= startTs);
        }
        return out;
      }
      if (!appendable && age < (offsetMin > 1 ? 5 * 60e3 : 55e3)) return c.data;
    }
  }
  const span = Math.max(1, endTs - startTs);
  const interval = pickInterval(span, maxPoints);
  // assumes roughly one sample per 10 s (the simulator rate)
  const useAgg = agg === 'NONE' && span / 10000 > maxPoints ? 'AVG' : agg;
  const q =
    `keys=${encodeURIComponent(keys.join(','))}&startTs=${startTs}&endTs=${endTs}&limit=${maxPoints * 4}` +
    (useAgg === 'NONE' ? '&agg=NONE&orderBy=ASC' : `&agg=${useAgg}&interval=${interval}&orderBy=ASC`);
  const r = await get<Record<string, { ts: number; value: string }[]>>(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?${q}`);
  const out: Record<string, { ts: number; value: number }[]> = {};
  for (const k of keys) out[k] = (r?.[k] ?? []).map((p) => ({ ts: p.ts, value: toNum(p.value) as number })).sort((a, b) => a.ts - b.ts);
  if (L) cachePut(seriesCache, ck, { fetchedAt: now, data: out });
  return out;
}

// ---------- caches used while the WebSocket is live (D-021) ----------

const seriesCache = new Map<string, { fetchedAt: number; data: Record<string, { ts: number; value: number }[]> }>();
const getCache = new Map<string, { fetchedAt: number; data: any }>();

/** Map insert with a 300-entry cap (oldest dropped first). */
function cachePut<V>(m: Map<string, V>, k: string, v: V) {
  m.delete(k);
  m.set(k, v);
  if (m.size > 300) m.delete(m.keys().next().value as string);
}

/**
 * GET with a time-to-live, for window queries the WebSocket can't keep current (bar buckets, heatmap,
 * state timeline, window aggregates, alarms). `key` must identify the query without its exact timestamps.
 * While the socket is down the cache is bypassed, so behaviour is the same as a plain `get`.
 */
export async function getCached<T = any>(key: string, path: string, ttlMs: number): Promise<T> {
  const L = liveHub();
  const hit = getCache.get(key);
  if (L?.isLive() && hit && Date.now() - hit.fetchedAt < ttlMs) return hit.data as T;
  const data = await get<T>(path);
  if (L) cachePut(getCache, key, { fetchedAt: Date.now(), data });
  return data;
}

/** Clears the caches (tests). */
export function clearCaches() {
  seriesCache.clear();
  getCache.clear();
}

/**
 * Smallest step from a fixed ladder (1 min ... 7 days) that keeps `spanMs / step <= maxPoints`;
 * the largest step (7 days) when none does.
 */
export function pickInterval(spanMs: number, maxPoints: number): number {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3];
  for (const s of steps) if (spanMs / s <= maxPoints) return s;
  return steps[steps.length - 1];
}

/** Number when `v` is numeric (and not blank), otherwise `v` unchanged (booleans/text states). */
function toNum(v: any): number | string {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v;
}

// ---------- alarms ----------

/** Flattened alarm as used by the alarm-list widget. */
export interface AlarmRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  startTs: number;
  endTs: number;
  originatorId: string;
  originatorName: string;
  originatorLabel?: string;
  acknowledged: boolean;
  cleared: boolean;
}

/**
 * Alarms of an entity, newest first (GET /api/v2/alarm/{type}/{id}, first page only).
 * For an asset this includes alarms propagated up `Contains` relations (D-003).
 * @param opts.status     ACTIVE / CLEARED filter; ANY or omitted = no filter.
 * @param opts.severities severity filter, e.g. ['CRITICAL', 'MAJOR'].
 * @param opts.limit      page size (default 20).
 * @param opts.startTs    only alarms from this time (ms).
 */
export async function alarms(
  e: EntityRef,
  opts: { status?: 'ACTIVE' | 'CLEARED' | 'ANY'; severities?: string[]; limit?: number; startTs?: number } = {},
): Promise<AlarmRow[]> {
  const status = opts.status && opts.status !== 'ANY' ? `&statusList=${opts.status}` : '';
  const sev = opts.severities?.length ? `&severityList=${opts.severities.join(',')}` : '';
  const start = opts.startTs ? `&startTime=${opts.startTs}` : '';
  // Alarms are not pushed over the socket; while it is live they are re-read at most every 15 s per query.
  const path = `/api/v2/alarm/${e.entityType}/${e.id}?pageSize=${opts.limit ?? 20}&page=0&sortProperty=createdTime&sortOrder=DESC${status}${sev}`;
  const r = await getCached<any>(`a|${path}|${opts.startTs ? Math.round((Date.now() - opts.startTs) / 60e3) : ''}`, path + start, 15e3);
  return (r?.data ?? []).map((a: any) => ({
    id: a.id.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    startTs: a.startTs,
    endTs: a.endTs,
    originatorId: a.originator?.id,
    originatorName: a.originatorName,
    originatorLabel: a.originatorLabel,
    acknowledged: a.acknowledged,
    cleared: a.cleared,
  }));
}

// ---------- entities / relations ----------

/** Relation row from /api/relations/info (includes the entity names). */
export interface RelInfo {
  from: EntityRef;
  to: EntityRef;
  type: string;
  toName?: string;
  fromName?: string;
}

/** Outgoing relations of `e` of the given type (default `Contains`, the hierarchy relation). */
export const childrenOf = (e: EntityRef, type = 'Contains') =>
  get<RelInfo[]>(`/api/relations/info?fromId=${e.id}&fromType=${e.entityType}&relationTypeGroup=COMMON`).then((rs) =>
    (rs ?? []).filter((r) => r.type === type),
  );

/** Incoming relations of `e` of the given type (default `Contains`), i.e. its parents. */
export const parentsOf = (e: EntityRef, type = 'Contains') =>
  get<RelInfo[]>(`/api/relations/info?toId=${e.id}&toType=${e.entityType}&relationTypeGroup=COMMON`).then((rs) =>
    (rs ?? []).filter((r) => r.type === type),
  );

/** Devices by id (raw TB Device objects), fetched in chunks of 100 ids. Unknown/unreadable ids are omitted by TB. */
export async function devicesByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/devices?deviceIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

/** Assets by id (raw TB Asset objects), fetched in chunks of 100 ids. Unknown/unreadable ids are omitted by TB. */
export async function assetsByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/assets?assetIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

/** Every telemetry key the device has stored (used to warn about missing properties before an apply). */
export async function timeseriesKeys(deviceId: string): Promise<string[]> {
  return (await get<string[]>(`/api/plugins/telemetry/DEVICE/${deviceId}/keys/timeseries`)) ?? [];
}

// ---------- bulk queries (D-022) ----------
// One call each instead of one call per entity. They are what keeps the first page load at a fixed number
// of calls however big the customer's hierarchy is.

/** Plain relation row from POST /api/relations (no names). */
export interface Rel {
  from: EntityRef;
  to: EntityRef;
  type: string;
}

/**
 * Every `relationType` relation below (`direction` FROM) or above (TO) `root`, over up to `maxLevel` levels,
 * in ONE call (POST /api/relations, EntityRelationsQuery). For FROM, `entityTypes` filters the child side;
 * for TO, the parent side. ThingsBoard drops relations to entities the user may not read.
 */
export function relationsTree(root: EntityRef, direction: 'FROM' | 'TO', entityTypes: string[], maxLevel = 12, relationType = 'Contains'): Promise<Rel[]> {
  return post<Rel[]>('/api/relations', {
    parameters: { rootId: root.id, rootType: root.entityType, direction, relationTypeGroup: 'COMMON', maxLevel, fetchLastLevelOnly: false },
    filters: [{ relationType, entityTypes }],
  }).then((r) => r ?? []);
}

/** One entity from `entityData()`: entity fields (name, label, type...), SERVER attributes and latest telemetry. */
export interface EntityRow {
  id: string;
  entityType: string;
  fields: Record<string, string>;
  /** SERVER_SCOPE attributes; a key the entity doesn't have is absent. JSON values are parsed. */
  attrs: Record<string, any>;
  /** Latest telemetry; a key without a value is absent (same shape as `latest()`). */
  ts: Latest;
}

/**
 * Entity fields, SERVER attributes and latest telemetry of many entities of one type in ONE call per 500 ids
 * (POST /api/entitiesQuery/find, entityList filter). Unknown or unreadable ids are left out by ThingsBoard.
 * Customer users get only their customer's entities, the same as the single-entity endpoints.
 */
export async function entityData(
  entityType: 'ASSET' | 'DEVICE',
  ids: string[],
  opts: { fields?: string[]; attrs?: string[]; ts?: string[] } = {},
): Promise<EntityRow[]> {
  const out: EntityRow[] = [];
  const fields = opts.fields ?? ['name', 'label', 'type'];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const r = await post<any>('/api/entitiesQuery/find', {
      entityFilter: { type: 'entityList', entityType, entityList: chunk },
      pageLink: { page: 0, pageSize: chunk.length },
      entityFields: fields.map((key) => ({ type: 'ENTITY_FIELD', key })),
      latestValues: [...(opts.attrs ?? []).map((key) => ({ type: 'SERVER_ATTRIBUTE', key })), ...(opts.ts ?? []).map((key) => ({ type: 'TIME_SERIES', key }))],
    });
    for (const d of r?.data ?? []) {
      const l = d.latest ?? {};
      const row: EntityRow = { id: d.entityId.id, entityType: d.entityId.entityType, fields: {}, attrs: {}, ts: {} };
      for (const [k, v] of Object.entries<any>(l.ENTITY_FIELD ?? {})) row.fields[k] = v?.value ?? '';
      // missing values come back as {ts: 0, value: ""}
      for (const [k, v] of Object.entries<any>(l.SERVER_ATTRIBUTE ?? {})) if (v && v.ts > 0) row.attrs[k] = parseMaybeJson(v.value);
      for (const [k, v] of Object.entries<any>(l.TIME_SERIES ?? {}))
        if (v && v.ts > 0 && v.value !== null && v.value !== undefined && String(v.value) !== '') row.ts[k] = { ts: v.ts, value: toNum(v.value) };
      out.push(row);
    }
  }
  return out;
}

/**
 * Latest values of many devices (keys per device). Devices already live on the WebSocket are served from the
 * live cache; the rest come from ONE entityData call for the union of their keys. Every device is also
 * subscribed, so later redraws are served live. Errors give empty results for the affected devices.
 */
export async function latestMany(req: { deviceId: string; keys: string[] }[]): Promise<Map<string, Latest>> {
  const out = new Map<string, Latest>();
  const L = liveHub();
  let todo = req.filter((r) => r.keys.length);
  if (L) {
    for (const r of todo) L.want(r.deviceId, r.keys);
    const take = () =>
      (todo = todo.filter((r) => {
        const c = L.get(r.deviceId, r.keys);
        if (c) out.set(r.deviceId, c as Latest);
        return !c;
      }));
    take();
    // a cold page subscribes everything at once; give the socket the same short grace as latest()
    if (todo.length && (await L.waitReady(todo[0].deviceId, todo[0].keys, LIVE_WAIT_MS))) take();
  }
  if (todo.length) {
    const keys = [...new Set(todo.flatMap((r) => r.keys))];
    const rows = await entityData('DEVICE', [...new Set(todo.map((r) => r.deviceId))], { fields: [], ts: keys }).catch(() => [] as EntityRow[]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of todo) {
      const ts = byId.get(r.deviceId)?.ts ?? {};
      out.set(r.deviceId, Object.fromEntries(r.keys.filter((k) => ts[k]).map((k) => [k, ts[k]])));
    }
  }
  for (const r of req) if (!out.has(r.deviceId)) out.set(r.deviceId, {});
  return out;
}

/**
 * Number of ACTIVE alarms per device (devices without alarms are absent) in ONE call
 * (POST /api/alarmsQuery/find, entityList filter; counts the first 1000 alarms). Re-read at most every 15 s
 * while the socket is live, like `alarms()`.
 */
export async function activeAlarmCounts(deviceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!deviceIds.length) return out;
  const ids = [...new Set(deviceIds)].sort();
  const key = `ac|${ids.join(',')}`;
  const L = liveHub();
  const hit = getCache.get(key);
  let data: any;
  if (L?.isLive() && hit && Date.now() - hit.fetchedAt < 15e3) data = hit.data;
  else {
    data = await post<any>('/api/alarmsQuery/find', {
      entityFilter: { type: 'entityList', entityType: 'DEVICE', entityList: ids },
      pageLink: { page: 0, pageSize: 1000, statusList: ['ACTIVE'], sortOrder: { key: { type: 'ALARM_FIELD', key: 'createdTime' }, direction: 'DESC' } },
      alarmFields: [{ type: 'ALARM_FIELD', key: 'type' }],
      entityFields: [],
      latestValues: [],
    });
    if (L) cachePut(getCache, key, { fetchedAt: Date.now(), data });
  }
  for (const a of data?.data ?? []) {
    const id = a.originator?.id ?? a.entityId?.id;
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}
