// Tests for D-042: the live hub over ThingsBoard's own WebSocket (core/tb-socket.ts), with a fake subscription API.
import { describe, it, expect, beforeEach } from 'vitest';
import { Live } from '../src/core/live';
import { TbSocket, registerLiveProvider, unregisterLiveProvider, currentProvider, canCarry, connectLive } from '../src/core/tb-socket';

/** A ThingsBoard widget context whose subscription API records subscriptions; the test pushes data into them. */
function fakeCtx() {
  const subs = new Map<number, { info: any; options: any; removed: boolean }>();
  let next = 1;
  const ctx = {
    $container: [{ isConnected: true }],
    subscriptionApi: {
      createSubscriptionFromInfo(type: string, info: any[], options: any) {
        const id = next++;
        subs.set(id, { info: { ...info[0], subType: type }, options, removed: false });
        return { subscribe: (ok: (s: any) => void) => ok({ id }) };
      },
      removeSubscription(id: number) {
        const s = subs.get(id);
        if (s) s.removed = true;
      },
    },
  };
  const push = (id: number, values: Record<string, [number, any]>) =>
    subs.get(id)!.options.callbacks.onDataUpdated({ data: Object.entries(values).map(([k, v]) => ({ dataKey: { name: k }, data: [v] })) });
  return { ctx, subs, push };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? globalThis;
  (window as any).__imexDbbLiveProviders = [];
});

describe('live values over ThingsBoard\'s own WebSocket (D-042)', () => {
  it('a context without the subscription API cannot carry; one with it becomes the provider', () => {
    expect(canCarry({})).toBe(false);
    const { ctx } = fakeCtx();
    expect(registerLiveProvider(ctx)).toBe(true);
    expect(currentProvider()?.ctx).toBe(ctx);
  });

  it('Live subscribes each device through the API and serves the pushed values; unsubscribe removes it', async () => {
    const { ctx, subs, push } = fakeCtx();
    registerLiveProvider(ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    live.want('dev1', ['power', 'temp']);
    await tick();
    expect(live.isLive()).toBe(true);
    expect(live.throughTb()).toBe(true);
    const [id, s] = [...subs.entries()][0];
    expect(s.info).toMatchObject({ subType: 'latest', type: 'entity', entityType: 'DEVICE', entityId: 'dev1' });
    expect(s.info.timeseries.map((k: any) => k.name)).toEqual(['power', 'temp']);
    push(id, { power: [10, '5.5'], temp: [11, '20'] });
    expect(live.get('dev1', ['power', 'temp'])).toEqual({ power: { ts: 10, value: 5.5 }, temp: { ts: 11, value: 20 } });
    push(id, { power: [20, '6'] });
    expect(live.since('dev1', 'power', 10)).toEqual([{ ts: 20, value: 6 }]);
    // adding a key resubscribes with the union, the old subscription is removed
    live.want('dev1', ['volt']);
    expect(subs.get(id)!.removed).toBe(true);
    const last = [...subs.values()].pop()!;
    expect(last.info.timeseries.map((k: any) => k.name).sort()).toEqual(['power', 'temp', 'volt']);
  });

  it('when the provider widget goes, the subscriptions move to the next provider at once', async () => {
    const a = fakeCtx();
    const b = fakeCtx();
    registerLiveProvider(a.ctx);
    registerLiveProvider(b.ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    live.want('dev1', ['power']);
    await tick();
    expect(b.subs.size).toBe(1); // the newest provider carries
    unregisterLiveProvider(b.ctx);
    expect([...b.subs.values()][0].removed).toBe(true);
    live.reconnect();
    await tick();
    expect(a.subs.size).toBe(1);
    expect(live.throughTb()).toBe(true);
    a.push([...a.subs.keys()][0], { power: [30, '7'] });
    expect(live.get('dev1', ['power'])).toEqual({ power: { ts: 30, value: 7 } });
  });

  it('a subscription error marks only that device failed (REST for it), as with the own socket', async () => {
    const { ctx, subs } = fakeCtx();
    registerLiveProvider(ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    live.want('dev1', ['power']);
    await tick();
    const [, s] = [...subs.entries()][0];
    s.options.callbacks.onDataUpdateError({}, new Error('x'));
    expect(live.get('dev1', ['power'])).toBeNull();
  });

  it('without a provider the hub opens its own WebSocket as before', () => {
    (window as any).__imexDbbLiveProviders = [];
    const made: string[] = [];
    (globalThis as any).WebSocket = function (url: string) { made.push(url); return { readyState: 0, send() {}, close() {} }; };
    const ws = connectLive('ws://tb.test/api/ws');
    expect(ws).not.toBeInstanceOf(TbSocket);
    expect(made).toEqual(['ws://tb.test/api/ws']);
  });
});
