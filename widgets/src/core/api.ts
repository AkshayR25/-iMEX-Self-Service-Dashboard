// Browser-side ThingsBoard API for widgets. Runs as the logged-in (customer) user.
// Uses the JWT the ThingsBoard UI keeps in localStorage; on 401 it asks the TB UI's own
// HttpClient to make a call (which refreshes the token) and retries once.

export interface EntityRef {
  id: string;
  entityType: string;
}

export class ApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`${status} ${path}: ${body.slice(0, 200)}`);
  }
}

type RefreshHook = () => Promise<void>;
let refreshHook: RefreshHook | null = null;

/** Register the widget ctx so 401s can trigger the TB UI's token refresh. */
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

function token(): string {
  const t = localStorage.getItem('jwt_token');
  if (!t) throw new ApiError(401, 'auth', 'Not logged in');
  return t;
}

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

export const get = <T = any>(p: string) => request<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => request<T>('POST', p, b);

// ---------- attributes ----------

export async function getAttrs(e: EntityRef, keys?: string[], scope = 'SERVER_SCOPE'): Promise<Record<string, any>> {
  const q = keys?.length ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
  const rows = await get<{ key: string; value: any }[]>(`/api/plugins/telemetry/${e.entityType}/${e.id}/values/attributes/${scope}${q}`);
  const out: Record<string, any> = {};
  for (const r of rows) out[r.key] = parseMaybeJson(r.value);
  return out;
}

export function saveAttrs(e: EntityRef, attrs: Record<string, unknown>, scope = 'SERVER_SCOPE') {
  return post(`/api/plugins/telemetry/${e.entityType}/${e.id}/attributes/${scope}`, attrs);
}

export function deleteAttrs(e: EntityRef, keys: string[], scope = 'SERVER_SCOPE') {
  return request('DELETE', `/api/plugins/telemetry/${e.entityType}/${e.id}/${scope}?keys=${encodeURIComponent(keys.join(','))}`);
}

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

export type Latest = Record<string, { ts: number; value: number | string } | undefined>;

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

export type Agg = 'NONE' | 'AVG' | 'MIN' | 'MAX' | 'SUM';

/** Timeseries with a sensible interval so no series exceeds ~maxPoints. Always passes `limit` (TB defaults to 100). */
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
  const useAgg = agg === 'NONE' && span / 10000 > maxPoints ? 'AVG' : agg;
  const q =
    `keys=${encodeURIComponent(keys.join(','))}&startTs=${startTs}&endTs=${endTs}&limit=${maxPoints * 4}` +
    (useAgg === 'NONE' ? '&agg=NONE&orderBy=ASC' : `&agg=${useAgg}&interval=${interval}&orderBy=ASC`);
  const r = await get<Record<string, { ts: number; value: string }[]>>(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?${q}`);
  const out: Record<string, { ts: number; value: number }[]> = {};
  for (const k of keys) out[k] = (r?.[k] ?? []).map((p) => ({ ts: p.ts, value: toNum(p.value) as number })).sort((a, b) => a.ts - b.ts);
  return out;
}

export function pickInterval(spanMs: number, maxPoints: number): number {
  const steps = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3];
  for (const s of steps) if (spanMs / s <= maxPoints) return s;
  return steps[steps.length - 1];
}

function toNum(v: any): number | string {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v;
}

// ---------- alarms ----------

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

export interface RelInfo {
  from: EntityRef;
  to: EntityRef;
  type: string;
  toName?: string;
  fromName?: string;
}

export const childrenOf = (e: EntityRef, type = 'Contains') =>
  get<RelInfo[]>(`/api/relations/info?fromId=${e.id}&fromType=${e.entityType}&relationTypeGroup=COMMON`).then((rs) =>
    (rs ?? []).filter((r) => r.type === type),
  );

export const parentsOf = (e: EntityRef, type = 'Contains') =>
  get<RelInfo[]>(`/api/relations/info?toId=${e.id}&toType=${e.entityType}&relationTypeGroup=COMMON`).then((rs) =>
    (rs ?? []).filter((r) => r.type === type),
  );

export async function devicesByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/devices?deviceIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

export async function assetsByIds(ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await get<any[]>(`/api/assets?assetIds=${ids.slice(i, i + 100).join(',')}`)));
  return out;
}

export async function timeseriesKeys(deviceId: string): Promise<string[]> {
  return (await get<string[]>(`/api/plugins/telemetry/DEVICE/${deviceId}/keys/timeseries`)) ?? [];
}
