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
  me = { id: { id: 'u1' }, customerId: { id: 'c1' }, email: 'admin@x', authority: 'CUSTOMER_USER', firstName: 'Asha', lastName: 'Admin' };
  failNext: { match: RegExp; status: number } | null = null;

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
        const a = [...t[k]].sort((x, y) => (asc ? x.ts - y.ts : y.ts - x.ts));
        return (hist ? a : a.slice(0, 1)).map((x) => ({ ts: x.ts, value: String(x.value) }));
      };
      return resp(200, Object.fromEntries(keys.filter((k) => t[k]).map((k) => [k, rows(k)])));
    }
    if ((m = /^\/api\/plugins\/telemetry\/ASSET\/([\w-]+)\/timeseries\/ANY$/.exec(p))) return resp(200, null);
    if (p === '/api/relations/info') {
      const from = u.searchParams.get('fromId');
      const to = u.searchParams.get('toId');
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
