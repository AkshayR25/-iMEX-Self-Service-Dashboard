// D-035: relation infos on ThingsBoard 4.3 (path form only) and 4.2 (query form only).
// Own file with a fresh api module per test, because api.ts remembers the working form for the page.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeTB, ithena } from './fake-tb';

let tb: FakeTB;
beforeEach(() => {
  vi.resetModules();
  tb = ithena();
  vi.stubGlobal('fetch', tb.fetch);
  vi.stubGlobal('localStorage', { getItem: () => 'x', setItem: () => undefined });
});
const node = (id: string, entityType = 'DEVICE') => ({ id, entityType });

describe('relation infos across ThingsBoard versions (D-035)', () => {
  it('4.3: uses /api/relations/info/{from|to}/{type}/{id} and never the removed query form', async () => {
    tb.relInfoPaths = true;
    const api = await import('../src/core/api');
    const dev = [...tb.entities.values()].find((e) => e.entityType === 'DEVICE')!;
    const parents = await api.parentsOf(node(dev.id));
    expect(parents.length).toBe(1);
    expect((await api.childrenOf(node(parents[0].from.id, 'ASSET'))).some((r) => r.to.id === dev.id)).toBe(true);
    expect(tb.calls.filter((c) => c === 'GET /api/relations/info')).toEqual([]);
  });

  it('4.2: one 404 on the path form, then the query form only', async () => {
    const api = await import('../src/core/api');
    const dev = [...tb.entities.values()].find((e) => e.entityType === 'DEVICE')!;
    expect((await api.parentsOf(node(dev.id))).length).toBe(1);
    expect((await api.parentsOf(node(dev.id))).length).toBe(1);
    expect(tb.calls.filter((c) => c.startsWith('GET /api/relations/info/'))).toHaveLength(1);
    expect(tb.calls.filter((c) => c === 'GET /api/relations/info')).toHaveLength(2);
  });
});
