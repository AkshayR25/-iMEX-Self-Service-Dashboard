// In-memory fake of the ThingsBoard REST endpoints the widgets use, for unit tests.
export interface FakeEntity {
  id: string;
  entityType: 'ASSET' | 'DEVICE' | 'USER';
  name: string;
  label?: string;
  type?: string;
}

export class FakeTB {
  entities = new Map<string, FakeEntity>();
  attrs = new Map<string, Record<string, any>>(); // `${type}:${id}:${scope}`
  relations: { from: string; to: string }[] = [];
  telemetry = new Map<string, Record<string, { ts: number; value: any }[]>>();
  calls: string[] = [];
  /** Active alarms for /api/alarmsQuery/find. */
  alarms: { originator: string; type: string }[] = [];
  me = { id: { id: 'u1' }, customerId: { id: 'c1' }, email: 'admin@x', authority: 'CUSTOMER_USER', firstName: 'Asha', lastName: 'Admin' };
  failNext: { match: RegExp; status: number } | null = null;
  /** Serve relation infos like ThingsBoard 4.3 (path form only), see the relations/info route below (D-035). */
  relInfoPaths = false;

  add(e: FakeEntity, parent?: string) {
    this.entities.set(e.id, e);
    if (parent) this.relations.push({ from: parent, to: e.id });
    return this;
  }

  setAttrs(type: string, id: string, a: Record<string, any>, scope = 'SERVER_SCOPE') {
    const k = `${type}:${id}:${scope}`;
    this.attrs.set(k, { ...(this.attrs.get(k) ?? {}), ...a });
  }

  getAttrs(type: string, id: string, scope = 'SERVER_SCOPE') {
    return this.attrs.get(`${type}:${id}:${scope}`) ?? {};
  }

  fetch = async (url: string, init: any = {}) => {
    const u = new URL(url, 'http://tb');
    const method = (init.method ?? 'GET').toUpperCase();
    this.calls.push(`${method} ${u.pathname}`);
    if (this.failNext && this.failNext.match.test(u.pathname)) {
      const s = this.failNext.status;
      this.failNext = null;
      return resp(s, { message: 'fail' });
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if (p === '/api/auth/user') return resp(200, this.me);
    if ((m = /^\/api\/plugins\/telemetry\/(\w+)\/([\w-]+)\/values\/attributes\/(\w+)$/.exec(p))) {
      const all = this.getAttrs(m[1], m[2], m[3]);
      const keys = u.searchParams.get('keys')?.split(',');
      return resp(200, Object.entries(all).filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value, lastUpdateTs: 1 })));
    }
    if ((m = /^\/api\/plugins\/telemetry\/(\w+)\/([\w-]+)\/keys\/attributes\/(\w+)$/.exec(p))) return resp(200, Object.keys(this.getAttrs(m[1], m[2], m[3])));
    if ((m = /^\/api\/plugins\/telemetry\/(\w+)\/([\w-]+)\/attributes\/(\w+)$/.exec(p)) && method === 'POST') {
      this.setAttrs(m[1], m[2], JSON.parse(JSON.stringify(body)), m[3]);
      return resp(200, null);
    }
    if ((m = /^\/api\/plugins\/telemetry\/(\w+)\/([\w-]+)\/(\w+)$/.exec(p)) && method === 'DELETE') {
      const k = `${m[1]}:${m[2]}:${m[3]}`;
      const a = { ...(this.attrs.get(k) ?? {}) };
      for (const key of u.searchParams.get('keys')!.split(',')) delete a[key];
      this.attrs.set(k, a);
      return resp(200, null);
    }
    if ((m = /^\/api\/plugins\/telemetry\/DEVICE\/([\w-]+)\/keys\/timeseries$/.exec(p))) return resp(200, Object.keys(this.telemetry.get(m[1]) ?? {}));
    if ((m = /^\/api\/plugins\/telemetry\/DEVICE\/([\w-]+)\/values\/timeseries$/.exec(p))) {
      const t = this.telemetry.get(m[1]) ?? {};
      const keys = u.searchParams.get('keys')!.split(',');
      const hist = u.searchParams.has('startTs');
      const asc = u.searchParams.get('orderBy') === 'ASC';
      const rows = (k: string) => {
        let a = [...t[k]].sort((x, y) => (asc ? x.ts - y.ts : y.ts - x.ts));
        if (!hist) return a.slice(0, 1).map((x) => ({ ts: x.ts, value: String(x.value) }));
        const st = Number(u.searchParams.get('startTs'));
        const en = Number(u.searchParams.get('endTs') ?? Date.now());
        a = a.filter((x) => x.ts >= st && x.ts <= en);
        const agg = u.searchParams.get('agg') ?? 'NONE';
        const iv = Number(u.searchParams.get('interval') ?? 0);
        if (agg !== 'NONE' && iv > 0) {
          const b = new Map<number, number[]>();
          for (const x of a) {
            const i = Math.floor((x.ts - st) / iv);
            b.set(i, [...(b.get(i) ?? []), Number(x.value)]);
          }
          const f = (v: number[]) => (agg === 'MIN' ? Math.min(...v) : agg === 'MAX' ? Math.max(...v) : agg === 'SUM' ? v.reduce((p, c) => p + c, 0) : v.reduce((p, c) => p + c, 0) / v.length);
          const out = [...b.entries()].sort((x, y) => (asc ? x[0] - y[0] : y[0] - x[0])).map(([i, v]) => ({ ts: st + i * iv + Math.floor(iv / 2), value: String(+f(v).toFixed(4)) }));
          return out.slice(0, Number(u.searchParams.get('limit') ?? 1e9));
        }
        return a.slice(0, Number(u.searchParams.get('limit') ?? 1e9)).map((x) => ({ ts: x.ts, value: String(x.value) }));
      };
      return resp(200, Object.fromEntries(keys.filter((k) => t[k]).map((k) => [k, rows(k)])));
    }
    if ((m = /^\/api\/plugins\/telemetry\/ASSET\/([\w-]+)\/timeseries\/ANY$/.exec(p))) return resp(200, null);
    // TB 4.3 (relInfoPaths): only /api/relations/info/{from|to}/{type}/{id}; the query form is gone (500 there).
    // TB 4.2 and older (default): only the query form; the path form is an unknown route (404).
    const rp = this.relInfoPaths ? /^\/api\/relations\/info\/(from|to)\/[A-Z_]+\/([\w-]+)$/.exec(p) : null;
    if (this.relInfoPaths && p === '/api/relations/info') return resp(500, { message: 'Request method GET not supported' });
    if (rp || p === '/api/relations/info') {
      const from = rp ? (rp[1] === 'from' ? rp[2] : null) : u.searchParams.get('fromId');
      const to = rp ? (rp[1] === 'to' ? rp[2] : null) : u.searchParams.get('toId');
      const rs = this.relations.filter((r) => (from ? r.from === from : r.to === to));
      return resp(
        200,
        rs.map((r) => ({
          from: { id: r.from, entityType: this.entities.get(r.from)!.entityType },
          to: { id: r.to, entityType: this.entities.get(r.to)!.entityType },
          type: 'Contains',
          fromName: this.entities.get(r.from)!.name,
          toName: this.entities.get(r.to)!.name,
        })),
      );
    }
    if (p === '/api/assets' || p === '/api/devices') {
      const ids = (u.searchParams.get('assetIds') ?? u.searchParams.get('deviceIds') ?? '').split(',');
      return resp(200, ids.map((id) => this.entities.get(id)).filter(Boolean).map((e) => ({ id: { id: e!.id }, name: e!.name, label: e!.label, type: e!.type })));
    }
    if ((m = /^\/api\/customer\/([\w-]+)\/assets$/.exec(p))) {
      const type = u.searchParams.get('type');
      const data = [...this.entities.values()].filter((e) => e.entityType === 'ASSET' && (!type || e.type === type)).map((e) => ({ id: { id: e.id }, name: e.name, label: e.label, type: e.type }));
      return resp(200, { data, hasNext: false });
    }
    if (/^\/api\/v2\/alarm\//.test(p)) return resp(200, { data: [], hasNext: false });
    if (p === '/api/relations' && method === 'POST') {
      // EntityRelationsQuery: all levels (up to maxLevel) in one direction
      const { rootId, direction, maxLevel } = body.parameters;
      const types: string[] = body.filters?.[0]?.entityTypes ?? [];
      const out: any[] = [];
      let frontier = [rootId];
      const seen = new Set([rootId]);
      for (let lvl = 0; lvl < (maxLevel || 50) && frontier.length; lvl++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const r of this.relations.filter((x) => (direction === 'FROM' ? x.from === id : x.to === id))) {
            const other = direction === 'FROM' ? r.to : r.from;
            const e = this.entities.get(other);
            if (!e || (types.length && !types.includes(e.entityType))) continue;
            out.push({ from: { id: r.from, entityType: this.entities.get(r.from)!.entityType }, to: { id: r.to, entityType: this.entities.get(r.to)!.entityType }, type: 'Contains', typeGroup: 'COMMON' });
            if (!seen.has(other)) {
              seen.add(other);
              next.push(other);
            }
          }
        frontier = next;
      }
      return resp(200, out);
    }
    if (p === '/api/entitiesQuery/find' && method === 'POST') {
      const f = body.entityFilter;
      const rows = (f.entityList as string[])
        .map((id) => this.entities.get(id))
        .filter((e) => e && e.entityType === f.entityType)
        .map((e) => {
          const latest: any = { ENTITY_FIELD: {}, SERVER_ATTRIBUTE: {}, TIME_SERIES: {} };
          for (const x of body.entityFields ?? []) latest.ENTITY_FIELD[x.key] = { ts: 1, value: String(x.key === 'type' ? e!.type ?? '' : (e as any)[x.key] ?? '') };
          const at = this.getAttrs(e!.entityType, e!.id);
          const t = this.telemetry.get(e!.id) ?? {};
          for (const x of body.latestValues ?? []) {
            if (x.type === 'SERVER_ATTRIBUTE') latest.SERVER_ATTRIBUTE[x.key] = x.key in at ? { ts: 1, value: typeof at[x.key] === 'string' ? at[x.key] : JSON.stringify(at[x.key]) } : { ts: 0, value: '' };
            if (x.type === 'TIME_SERIES') {
              const pts = [...(t[x.key] ?? [])].sort((a, b) => b.ts - a.ts);
              latest.TIME_SERIES[x.key] = pts[0] ? { ts: pts[0].ts, value: String(pts[0].value) } : { ts: 0, value: '' };
            }
          }
          return { entityId: { id: e!.id, entityType: e!.entityType }, latest };
        });
      return resp(200, { data: rows, totalElements: rows.length, hasNext: false });
    }
    if (p === '/api/alarmsQuery/find' && method === 'POST') {
      const ids: string[] = body.entityFilter.entityList;
      return resp(200, { data: this.alarms.filter((a) => ids.includes(a.originator)).map((a) => ({ originator: { id: a.originator, entityType: 'DEVICE' }, type: a.type })), totalElements: 0, hasNext: false });
    }
    return resp(404, { message: `fake: no route ${method} ${p}` });
  };
}

function resp(status: number, body: any) {
  const text = body === null ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as any;
}

/** ITHENA sample: root -> Richmond (comp, dryer), Pune (comp, weather), plus a store asset. */
export function ithena(tb = new FakeTB()) {
  tb.add({ id: 'root', entityType: 'ASSET', name: 'ITHENA-ROOT', label: 'ITHENA', type: 'Organization' })
    .add({ id: 'ric', entityType: 'ASSET', name: 'SITE-RICHMOND', label: 'Richmond', type: 'Site' }, 'root')
    .add({ id: 'pun', entityType: 'ASSET', name: 'SITE-PUNE', label: 'Pune', type: 'Site' }, 'root')
    .add({ id: 'rc', entityType: 'DEVICE', name: 'RIC-COMP-01', label: 'Richmond Compressor 1', type: 'Compressor' }, 'ric')
    .add({ id: 'rd', entityType: 'DEVICE', name: 'RIC-DRY-01', label: 'Richmond Dryer 1', type: 'Dryer' }, 'ric')
    .add({ id: 'pc', entityType: 'DEVICE', name: 'PUN-COMP-01', label: 'Pune Compressor 1', type: 'Compressor' }, 'pun')
    .add({ id: 'pw', entityType: 'DEVICE', name: 'PUN-WS-01', label: 'Pune Weather Station', type: 'Weather Station' }, 'pun')
    .add({ id: 'store', entityType: 'ASSET', name: 'DBB-STORE-ITHENA', label: 'Dashboard store', type: 'DashboardStore' });
  tb.setAttrs('ASSET', 'store', {
    dbb_profile_keys: {
      Compressor: [
        { key: 'dischargePressure', displayName: 'Discharge pressure', unit: 'bar', decimals: 2, min: 0, max: 10 },
        { key: 'dischargeTemp', displayName: 'Discharge temperature', unit: '°C', decimals: 1, min: 0, max: 120 },
        { key: 'powerKw', displayName: 'Power', unit: 'kW', decimals: 1, min: 0, max: 100 },
        { key: 'runStatus', displayName: 'Run status', unit: '', decimals: 0, min: 0, max: 1 },
      ],
      Dryer: [{ key: 'dewPoint', displayName: 'Dew point', unit: '°C', decimals: 1, min: -40, max: 20 }],
      'Weather Station': [{ key: 'temperature', displayName: 'Temperature', unit: '°C', decimals: 1, min: -20, max: 60 }],
    },
  });
  for (const [d, keys] of Object.entries({ rc: ['dischargePressure', 'dischargeTemp', 'powerKw', 'runStatus'], pc: ['dischargePressure', 'dischargeTemp', 'runStatus'], rd: ['dewPoint'], pw: ['temperature'] }))
    tb.telemetry.set(d, Object.fromEntries(keys.map((k) => [k, [{ ts: Date.now(), value: 1 }]])));
  return tb;
}

export function asUser(tb: FakeTB, id: string, role: string, nodes: string[]) {
  tb.me = { ...tb.me, id: { id } };
  tb.setAttrs('USER', id, { Role: role, selectedNodes: JSON.stringify(nodes.map((n) => ({ ID: n, name: n, categoryId: 'x', entityId: n }))) });
}
