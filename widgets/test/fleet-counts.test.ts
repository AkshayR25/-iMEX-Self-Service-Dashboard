// D-053: a fleet banner's "N machines · N locations" counts only the equipment in the viewer's access. The counts are
// placeholders ({{machines}}, {{locations}}) filled per viewer by the renderer (render/widgets.ts fleetCounts); banners
// stored before D-053 with the author's numbers baked in are read as those placeholders (liveFleetLine).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena, asGrantee, RIC, PUN, ROOT } from './fake-tb';
import * as scope from '../src/core/scope';
import { designPass } from '../src/core/design';
import { fleetCounts, liveFleetLine, RenderEnv } from '../src/render/widgets';
import { placeholderKeys } from '../src/render/rich';
import type { Widget, Dashboard } from '../src/core/schema';

let tb: FakeTB;
const mem = new Map<string, string>();
const ses = new Map<string, string>();
const RC2 = 'd0000000-0000-4000-8000-000000000001';
const PC2 = 'd0000000-0000-4000-8000-000000000002';
beforeEach(() => {
  tb = ithena();
  tb.add({ id: RC2, entityType: 'DEVICE', name: 'RIC-COMP-02', label: 'Richmond Compressor 2', type: 'Compressor' }, 'ric');
  tb.add({ id: PC2, entityType: 'DEVICE', name: 'PUN-COMP-02', label: 'Pune Compressor 2', type: 'Compressor' }, 'pun');
  mem.clear();
  ses.clear();
  mem.set('jwt_token', 'x');
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => ses.get(k) ?? null,
    setItem: (k: string, v: string) => void ses.set(k, v),
    removeItem: (k: string) => void ses.delete(k),
    key: (i: number) => [...ses.keys()][i] ?? null,
    get length() {
      return ses.size;
    },
  });
  scope.clearRelCache();
});
afterEach(() => vi.unstubAllGlobals());

const W = (id: string, binding: Widget['binding'], type: Widget['type'] = 'table'): Widget => ({ id, type, title: id, x: 0, y: 0, w: 6, h: 3, binding, keys: type === 'text' ? [] : ['dischargePressure'], settings: {} });
/** An "All Plants" style overview: every Compressor under the organisation, two fixed machines, the Richmond dryers. */
const FLEET: Widget[] = [
  W('banner', { mode: 'none' }, 'text'),
  W('comp', { mode: 'nodeQuery', nodeId: ROOT, profile: 'Compressor' }),
  W('fix', { mode: 'fixed', deviceIds: ['rc', 'pw'] }),
  W('dry', { mode: 'nodeQuery', nodeId: RIC, profile: 'Dryer' }),
];
const env = (ctx: scope.UserContext): RenderEnv => ({ ctx, deviceId: null, timeRange: '1h', widgets: FLEET });

describe('fleetCounts: the machines and locations a dashboard shows to this viewer', () => {
  it("an 'all' grant on the organisation counts everything the dashboard binds", async () => {
    asGrantee(tb, 'u-all', [{ id: 'root' }]);
    const ctx = await scope.loadUserContext();
    // rc, pc, RC2, PC2 (compressors) + pw (fixed) + rd (dryer) = 6 machines at Richmond and Pune
    expect(fleetCounts(env(ctx), FLEET)).toEqual({ machines: 6, locations: 2 });
  });

  it('fixed machines: only those two, at their own locations (the critic case: 2 machines, not 5)', async () => {
    asGrantee(tb, 'u-f', [{ id: RC2, type: 'DEVICE' }, { id: PC2, type: 'DEVICE' }]);
    const ctx = await scope.loadUserContext();
    expect(fleetCounts(env(ctx), FLEET)).toEqual({ machines: 2, locations: 2 });
    asGrantee(tb, 'u-f1', [{ id: RC2, type: 'DEVICE' }]);
    expect(fleetCounts(env(await scope.loadUserContext()), FLEET)).toEqual({ machines: 1, locations: 1 });
  });

  it("one site: only that site's machines the dashboard binds", async () => {
    asGrantee(tb, 'u-p', [{ id: 'pun' }]);
    const ctx = await scope.loadUserContext();
    // pc, PC2 (compressors) + pw (fixed); rc and the Richmond dryer are outside
    expect(fleetCounts(env(ctx), FLEET)).toEqual({ machines: 3, locations: 1 });
    expect(ctx.nodes.has(PUN)).toBe(true);
  });

  it('no grants: nothing is counted', async () => {
    tb.me = { ...tb.me, id: { id: 'u-none' }, authority: 'CUSTOMER_USER' };
    tb.setAttrs('USER', 'u-none', { imexAccess: { v: 1, grants: [] } });
    const ctx = await scope.loadUserContext();
    expect(fleetCounts(env(ctx), FLEET)).toEqual({ machines: 0, locations: 0 });
  });
});

describe('the banner line', () => {
  it('a stored banner with baked counts is read as the live placeholders; other text stays', () => {
    const p = (s: string) => `<h2 style="color: #ffffff">All Plants Across the Globe</h2><p style="color: #cfe0ff">${s}</p>`;
    expect(liveFleetLine(p('5 machines · 2 locations · live · {{date}} {{time}}'))).toBe(p('{{machines}} · {{locations}} · live · {{date}} {{time}}'));
    expect(liveFleetLine(p('1 machine · 1 location · live · {{date}} {{time}}'))).toBe(p('{{machines}} · {{locations}} · live · {{date}} {{time}}'));
    expect(liveFleetLine(p('3 machines · live · {{date}} {{time}}'))).toBe(p('{{machines}} · live · {{date}} {{time}}'));
    expect(liveFleetLine(p('12 machines &middot; 3 locations &middot; live &middot; {{date}} {{time}}'))).toBe(p('{{machines}} · {{locations}} &middot; live &middot; {{date}} {{time}}'));
    for (const s of ['We run 5 machines · 2 locations today', '5 machines · 2 locations · live', 'Line 3 machines · live · now'])
      expect(liveFleetLine(p(s))).toBe(p(s));
  });

  it('the design pass writes placeholders, not the author\'s counts; the renderer does not fetch them as telemetry', async () => {
    asGrantee(tb, 'u-all', [{ id: 'root' }]);
    const ctx = await scope.loadUserContext();
    const d: Dashboard = { schemaVersion: 1, id: 'd1', name: 'All Plants', kind: 'standalone', profile: null, timeRange: '1h', widgets: FLEET.slice(1).map((w) => ({ ...w })), ownerId: 'u', ownerName: 'U', version: 0, updatedAt: 0, updatedBy: 'u' };
    const out = designPass(ctx, d);
    const banner = out.widgets.find((w) => w.type === 'text')!;
    expect(banner.settings.html).toContain('{{machines}} · {{locations}} · live · {{date}} {{time}}');
    expect(banner.settings.html).not.toMatch(/\d+ machines?/);
    expect(placeholderKeys(banner.settings.html!)).toEqual([]);
  });
});
