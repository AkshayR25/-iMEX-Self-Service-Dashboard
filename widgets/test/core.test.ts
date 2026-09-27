import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena, asUser } from './fake-tb';
import * as scope from '../src/core/scope';
import * as store from '../src/core/store';
import * as chat from '../src/core/chat';
import { Dashboard, checkDashboard } from '../src/core/schema';
import { resolveCollisions, firstFit } from '../src/render/grid';

let tb: FakeTB;
const mem = new Map<string, string>();
beforeEach(() => {
  tb = ithena();
  mem.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
});

const widget = (over: any = {}) => ({ id: 'w1', type: 'value', title: 'P', x: 0, y: 0, w: 3, h: 2, binding: { mode: 'current' }, keys: ['dischargePressure'], settings: {}, ...over });

async function ctxFor(role: string, nodes: string[]) {
  asUser(tb, `u-${role}`, role, nodes);
  return scope.loadUserContext();
}

describe('selectedNodes parsing (production shape)', () => {
  it('accepts string entityId, object entityId and name-only entries', () => {
    const r = scope.parseSelectedNodes(
      JSON.stringify([
        { ID: 'UCA Systems_WM', categoryId: 'U1', name: 'Misc', entityId: 'a-1' },
        { name: 'X', entityId: { id: 'b-2', entityType: 'ASSET' } },
        { name: 'Only name' },
      ]),
    );
    expect(r.map((x) => x.entityId)).toEqual(['a-1', 'b-2', null]);
    expect(scope.parseSelectedNodes('garbage')).toEqual([]);
    expect(scope.parseSelectedNodes(undefined)).toEqual([]);
  });
});

describe('user scope', () => {
  it('Pune viewer sees only the Pune subtree', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    expect(ctx.isAdmin).toBe(false);
    expect(scope.allDevices(ctx).map((d) => d.name).sort()).toEqual(['PUN-COMP-01', 'PUN-WS-01']);
    expect(scope.inScope(ctx, 'rc')).toBe(false);
    expect(ctx.store?.id).toBe('store');
  });
  it('Admin role (production value "Admin") is admin; tree queries work', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    expect(ctx.isAdmin).toBe(true);
    expect(scope.devicesUnder(ctx, 'root', 'Compressor').map((d) => d.id).sort()).toEqual(['pc', 'rc']);
    expect(scope.siblings(ctx, 'rc', 'Dryer').map((d) => d.id)).toEqual(['rd']);
    expect(scope.nearest(ctx, 'pc', 'Weather Station')?.id).toBe('pw');
    expect(scope.pathLabel(ctx, 'pc')).toBe('ITHENA › Pune › Pune Compressor 1');
  });
});

describe('dashboard store, apply and resolution precedence', () => {
  const mk = (ctx: scope.UserContext, name: string, profile = 'Compressor'): Dashboard => ({ ...store.blankDashboard(ctx, name, profile), widgets: [widget() as any] });

  it('saves with versioning and rejects stale saves', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const v1 = await store.saveDashboard(ctx, mk(ctx, 'A'));
    expect(v1.version).toBe(1);
    const v2 = await store.saveDashboard(ctx, { ...v1, name: 'A2' });
    expect(v2.version).toBe(2);
    await expect(store.saveDashboard(ctx, { ...v1, name: 'stale' })).rejects.toBeInstanceOf(store.ConflictError);
    const hist = await store.versions(ctx, v1.id);
    expect(hist[0].version).toBe(1);
    const restored = await store.restoreVersion(ctx, v1.id, 1);
    expect(restored.name).toBe('A');
    expect(restored.version).toBe(3);
  });

  it('customer-wide template applies to every compressor, including one added later', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'Compressor template'));
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
    for (const d of ['rc', 'pc']) {
      const r = await store.resolveForDevice(ctx, d, 'Compressor');
      expect(r.dashboard?.id).toBe(t.id);
      expect(r.level).toBe('customer');
    }
    tb.add({ id: 'cc', entityType: 'DEVICE', name: 'CHN-COMP-01', label: 'Chennai Compressor 1', type: 'Compressor' }, 'root');
    const r = await store.resolveForDevice(ctx, 'cc', 'Compressor');
    expect(r.dashboard?.id).toBe(t.id);
  });

  it('precedence: personal > device > nearest node > customer > default', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cw = await store.saveDashboard(ctx, mk(ctx, 'customer'));
    const site = await store.saveDashboard(ctx, mk(ctx, 'site'));
    const org = await store.saveDashboard(ctx, mk(ctx, 'org'));
    const dev = await store.saveDashboard(ctx, mk(ctx, 'device'));
    const mine = await store.saveDashboard(ctx, mk(ctx, 'mine'));
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).level).toBe('default');
    await store.apply(ctx, cw, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, org, { type: 'node', nodeId: 'root', profile: 'Compressor' });
    await store.apply(ctx, site, { type: 'node', nodeId: 'pun', profile: 'Compressor' });
    let r = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('site'); // nearest ancestor wins
    expect(r.sourceLabel).toContain('Pune');
    expect(r.candidates.map((c) => c.dashboard.name)).toEqual(['site', 'org', 'customer']);
    await store.apply(ctx, dev, { type: 'devices', deviceIds: ['pc'], mode: 'linked' });
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('device');
    await store.apply(ctx, mine, { type: 'personal', deviceId: 'pc' });
    r = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    expect(r.dashboard?.name).toBe('mine');
    expect(r.level).toBe('personal');
    // the Richmond compressor is unaffected by the Pune assignment
    expect((await store.resolveForDevice(ctx, 'rc', 'Compressor')).dashboard?.name).toBe('org');
  });

  it('customise stops following the template; reset falls back', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'template'));
    await store.apply(ctx, t, { type: 'customer', profile: 'Compressor' });
    const copy = await store.customise(ctx, 'pc', t);
    await store.saveDashboard(ctx, { ...t, name: 'template v2' });
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.id).toBe(copy.id);
    expect((await store.resolveForDevice(ctx, 'rc', 'Compressor')).dashboard?.name).toBe('template v2');
    const u = await store.usage(ctx, { ...t, version: 2 });
    expect(u.customised).toEqual(['Pune Compressor 1']);
    await store.resetDevice(ctx, 'pc');
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('template v2');
    expect(await store.getDashboard(ctx, copy.id)).toBeNull();
  });

  it('copy mode gives each machine its own dashboard', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'base'));
    await store.apply(ctx, t, { type: 'devices', deviceIds: ['pc', 'rc'], mode: 'copy' });
    const a = await store.resolveForDevice(ctx, 'pc', 'Compressor');
    const b = await store.resolveForDevice(ctx, 'rc', 'Compressor');
    expect(a.dashboard!.id).not.toBe(b.dashboard!.id);
    expect(a.dashboard!.copiedFrom).toBe(t.id);
  });

  it('non-admins can only apply to a single machine in scope', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const t = await store.saveDashboard(ctx, mk(ctx, 'mgr'));
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['rc'], mode: 'linked' })).toBeNull();
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['pc'], mode: 'linked' })).toMatch(/outside/);
    expect(store.canApply(ctx, { type: 'devices', deviceIds: ['rc', 'rd'], mode: 'linked' })).toMatch(/admin/i);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/admin/i);
    await expect(store.apply(ctx, t, { type: 'node', nodeId: 'ric', profile: 'Compressor' })).rejects.toThrow(/admin/i);
  });

  it('admin scoped to one site cannot assign customer-wide', async () => {
    const ctx = await ctxFor('Admin', ['pun']);
    expect(store.canApply(ctx, { type: 'customer', profile: 'Compressor' })).toMatch(/whole organisation/);
    expect(store.canApply(ctx, { type: 'node', nodeId: 'pun', profile: 'Compressor' })).toBeNull();
  });

  it('preview reports replacements, own dashboards, same-level replace and missing keys', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const a = await store.saveDashboard(ctx, { ...mk(ctx, 'A'), widgets: [widget({ keys: ['powerKw'] }) as any] });
    const b = await store.saveDashboard(ctx, mk(ctx, 'B'));
    await store.apply(ctx, b, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, b, { type: 'devices', deviceIds: ['rc'], mode: 'linked' });
    const pv = await store.previewApply(ctx, a, { type: 'customer', profile: 'Compressor' });
    expect(pv.affected.length).toBe(2);
    expect(pv.replacesAssignment?.name).toBe('B');
    expect(pv.keepOwn.map((x) => x.id)).toEqual(['rc']);
    expect(pv.replaced.map((x) => x.id)).toEqual(['pc']);
    expect(pv.missingKeys).toEqual([{ key: 'powerKw', devices: ['Pune Compressor 1'] }]);
  });

  it('deleting a dashboard removes its assignments so machines fall back', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cw = await store.saveDashboard(ctx, mk(ctx, 'cw'));
    const site = await store.saveDashboard(ctx, mk(ctx, 'site'));
    await store.apply(ctx, cw, { type: 'customer', profile: 'Compressor' });
    await store.apply(ctx, site, { type: 'node', nodeId: 'pun', profile: 'Compressor' });
    const affected = await store.deleteDashboard(ctx, site);
    expect(affected.join()).toContain('Pune');
    expect((await store.resolveForDevice(ctx, 'pc', 'Compressor')).dashboard?.name).toBe('cw');
  });

  it('private dashboards are hidden from other users', async () => {
    const admin = await ctxFor('Admin', ['root']);
    const d = await store.saveDashboard(admin, mk(admin, 'secret'), 'private');
    expect((await store.listDashboards(admin)).map((x) => x.id)).toContain(d.id);
    const viewer = await ctxFor('Viewer', ['pun']);
    expect((await store.listDashboards(viewer)).map((x) => x.id)).not.toContain(d.id);
  });
});

describe('chat operations', () => {
  const out = (ops: any[], extra: any = {}) => chat.normaliseToolInput({ reply: 'ok', ops, ...extra });

  it('builds a 4-widget draft with auto layout from aliases', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const cat = chat.buildCatalog(ctx);
    const rcA = cat.byId.get('rc')!;
    const rdA = cat.byId.get('rd')!;
    const d0 = store.blankDashboard(ctx, 'x', null);
    const res = chat.applyOps(
      ctx,
      d0,
      out([
        { op: 'addWidget', type: 'line', title: 'Trend', binding: { mode: 'fixed', machines: [rcA] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'value', title: 'P', binding: { mode: 'fixed', machines: [rcA] }, keys: ['dischargePressure'] },
        { op: 'addWidget', type: 'value', title: 'Dew', binding: { mode: 'fixed', machines: [rdA] }, keys: ['dewPoint'] },
        { op: 'addWidget', type: 'alarms', title: 'Alarms', binding: { mode: 'fixed', machines: [rcA, rdA] }, keys: [] },
      ]),
      cat,
    );
    expect(res.draft.widgets.length).toBe(4);
    const byT = Object.fromEntries(res.draft.widgets.map((w) => [w.type + w.title, w]));
    expect(byT.valueP.y).toBe(0); // cards on top
    expect(byT.lineTrend.y).toBeGreaterThanOrEqual(2); // chart below
    expect(byT.lineTrend.w).toBe(12);
    expect(res.draft.kind).toBe('standalone');
    expect(checkDashboard(res.draft)).toEqual([]);
  });

  it('rejects unknown keys and aliases (so the retry path triggers)', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'x', 'Compressor') };
    expect(() => chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'gauge', title: 'Vib', binding: { mode: 'current' }, keys: ['vibration'] }]), cat)).toThrow(chat.OpsError);
    expect(() => chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'value', title: 'x', binding: { mode: 'fixed', machines: ['D99'] }, keys: ['dischargePressure'] }]), cat)).toThrow(/unknown machine/);
  });

  it('Pune viewer catalog contains no Richmond entities', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    expect(cat.text).not.toMatch(/Richmond|RIC-/);
    expect([...cat.devAlias.values()].sort()).toEqual(['pc', 'pw']);
  });

  it('out-of-scope ids in a shared draft are masked in the prompt', async () => {
    const ctx = await ctxFor('Viewer', ['pun']);
    const cat = chat.buildCatalog(ctx);
    const d = { ...store.blankDashboard(ctx, 'shared', null), widgets: [widget({ binding: { mode: 'fixed', deviceIds: ['rc'] } })] } as any;
    const p = JSON.stringify(chat.draftForPrompt(d, cat));
    expect(p).toContain('OUTSIDE_ACCESS');
    expect(p).not.toContain('rc"');
  });

  it('update / remove only touch the targeted widget', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const cat = chat.buildCatalog(ctx);
    const d0 = { ...store.blankDashboard(ctx, 'x', 'Compressor'), widgets: [widget({ id: 'a' }), widget({ id: 'b', x: 3, keys: ['dischargeTemp'], title: 'T' })] } as any;
    const r = chat.applyOps(ctx, d0, out([{ op: 'addWidget', type: 'gauge', title: 'Dew', binding: { mode: 'nearest', machineType: 'Dryer' }, keys: ['dewPoint'] }]), cat);
    expect(r.draft.widgets.slice(0, 2)).toEqual(d0.widgets);
    const r2 = chat.applyOps(ctx, r.draft, out([{ op: 'removeWidget', widget: 'W2' }]), cat);
    expect(r2.draft.widgets.map((w) => w.id)).toEqual(['a', r.draft.widgets[2].id]);
  });

  it('non-admin asking to apply customer-wide gets a warning, no proposal', async () => {
    const ctx = await ctxFor('Manager', ['ric']);
    const cat = chat.buildCatalog(ctx);
    const r = chat.applyOps(ctx, store.blankDashboard(ctx, 'x', 'Compressor'), out([{ op: 'setApplyTarget', target: 'customer' }]), cat);
    expect(r.applyProposal).toBeNull();
    expect(r.warnings.join()).toMatch(/admin/);
  });

  it('chatTurn retries once with the validation errors, then gives up without touching the draft', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const bad = { reply: 'x', ops: [{ op: 'addWidget', type: 'value', title: 'v', binding: { mode: 'current' }, keys: ['nope'] }] };
    const good = { reply: 'Added', ops: [{ op: 'addWidget', type: 'value', title: 'v', binding: { mode: 'current' }, keys: ['dischargeTemp'] }] };
    const sent: any[] = [];
    const t1: chat.Transport = { send: async (b) => (sent.push(b), { toolInput: sent.length === 1 ? bad : good }) };
    const d0 = store.blankDashboard(ctx, 'x', 'Compressor');
    const r = await chat.chatTurn(ctx, t1, d0, [], 'add temp', 'rc');
    expect(r.attempts).toBe(2);
    expect(JSON.stringify(sent[1].messages)).toContain('previous answer was invalid');
    expect(r.draft.widgets.length).toBe(1);
    const t2: chat.Transport = { send: async () => ({ toolInput: bad }) };
    await expect(chat.chatTurn(ctx, t2, d0, [], 'add', 'rc')).rejects.toThrow(/couldn't build/);
    expect(d0.widgets.length).toBe(0);
  });

  it('clarification returns buttons and leaves the draft unchanged', async () => {
    const ctx = await ctxFor('Admin', ['root']);
    const t: chat.Transport = { send: async () => ({ toolInput: { reply: '', ops: [], clarification: { question: 'Which compressor?', options: ['Richmond Compressor 1', 'Pune Compressor 1'] } } }) };
    const d0 = store.blankDashboard(ctx, 'x', null);
    const r = await chat.chatTurn(ctx, t, d0, [], 'show the compressor', null);
    expect(r.clarification?.options.length).toBe(2);
    expect(r.draft).toBe(d0);
  });
});

describe('grid', () => {
  it('pushes overlapping widgets down and compacts', () => {
    const items = [
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      { id: 'c', x: 0, y: 2, w: 12, h: 2 },
    ];
    const moved = resolveCollisions(items.map((i) => (i.id === 'c' ? { ...i, y: 0 } : i)), 'c');
    const c = moved.find((i) => i.id === 'c')!;
    expect(c.y).toBe(0);
    for (const o of moved.filter((i) => i.id !== 'c')) expect(o.y).toBeGreaterThanOrEqual(2);
  });
  it('first fit fills gaps', () => {
    expect(firstFit([{ x: 0, y: 0, w: 3, h: 2 }], 3, 2)).toEqual({ x: 3, y: 0 });
    expect(firstFit([{ x: 0, y: 0, w: 12, h: 2 }], 3, 2)).toEqual({ x: 0, y: 2 });
  });
});
