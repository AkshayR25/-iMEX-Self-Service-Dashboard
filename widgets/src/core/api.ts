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
//   latest / series               device timeseries (latest values, windowed history)
//   alarms                        alarm list of an entity (/api/v2/alarm)
//   childrenOf / parentsOf        relations (default type `Contains`, the hierarchy relation)
//   devicesByIds / assetsByIds    bulk entity lookup (chunks of 100 ids)
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
//   GET  /api/auth/user (refresh hook; also used by core/scope.ts)
//
// ThingsBoard quirks to keep in mind when changing this file (see DECISIONS "ThingsBoard quirks"):
//   - `values/timeseries` returns at most 100 points when `limit` is omitted with agg NONE, so
//     `series()` always passes `limit`.
//   - Name lookups such as /api/tenant/assets?assetName= return 404 (not an empty page) when nothing
//     matches; pass `allow404` to `request()` to get `null` instead of an exception.
//   - Attribute values written as objects come back as JSON strings; `getAttrs()` parses them back.

/** Minimal ThingsBoard entity id: `{ id: uuid, entityType: 'DEVICE' | 'ASSET' | 'USER' | ... }`. */
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
  return out;
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
  const r = await get<any>(
    `/api/v2/alarm/${e.entityType}/${e.id}?pageSize=${opts.limit ?? 20}&page=0&sortProperty=createdTime&sortOrder=DESC${status}${sev}${start}`,
  );
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
