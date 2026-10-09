// Tests for D-042 / D-046: the live hub over ThingsBoard's own WebSocket (core/tb-socket.ts), with a fake subscription
// API: one subscription per batch of machines, pushed alarm counts, pushed attributes.
import { describe, it, expect, beforeEach } from 'vitest';
import { Live } from '../src/core/live';
import { TbSocket, registerLiveProvider, unregisterLiveProvider, currentProvider, canCarry, connectLive, watchAlarmCounts, watchAttribute } from '../src/core/tb-socket';
import * as api from '../src/core/api';

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
    await tick(); // D-046: new commands are sent together in the next tick
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

/** A context whose subscriptions keep the whole datasource list, plus createSubscription for alarm counts (D-046). */
function batchCtx() {
  const subs = new Map<number, { info: any[]; options: any; removed: boolean }>();
  const counts = new Map<number, { options: any; removed: boolean }>();
  let next = 1;
  const ctx = {
    $container: [{ isConnected: true }],
    subscriptionApi: {
      createSubscriptionFromInfo(_type: string, info: any[], options: any) {
        const id = next++;
        subs.set(id, { info, options, removed: false });
        return { subscribe: (ok: (s: any) => void) => ok({ id }) };
      },
      createSubscription(options: any) {
        const id = next++;
        counts.set(id, { options, removed: false });
        return { subscribe: (ok: (s: any) => void) => ok({ id }) };
      },
      removeSubscription(id: number) {
        const s = subs.get(id) ?? counts.get(id);
        if (s) s.removed = true;
      },
    },
  };
  /** Pushes rows for several devices of one subscription: {deviceId: {key: [ts, value]}}. */
  const push = (id: number, byDev: Record<string, Record<string, [number, any]>>) =>
    subs.get(id)!.options.callbacks.onDataUpdated({
      data: Object.entries(byDev).flatMap(([dev, vals]) => Object.entries(vals).map(([k, v]) => ({ datasource: { entityId: dev }, dataKey: { name: k }, data: [v] }))),
    });
  const live = () => [...subs.entries()].filter(([, s]) => !s.removed);
  return { ctx, subs, counts, push, live };
}

describe('one subscription for many machines (D-046)', () => {
  it('devices asked for in the same tick share one ThingsBoard subscription; each gets only its own values', async () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    const changed: string[][] = [];
    live.onChange((d) => changed.push(d));
    live.want('a', ['power']);
    live.want('b', ['power', 'temp']);
    live.want('c', ['flow']);
    await tick();
    await tick();
    expect(f.live().length).toBe(1);
    const [id, s] = f.live()[0];
    expect(s.info.map((x: any) => [x.entityId, x.timeseries.map((k: any) => k.name)])).toEqual([
      ['a', ['power']],
      ['b', ['power', 'temp']],
      ['c', ['flow']],
    ]);
    f.push(id, { a: { power: [10, '1'] }, b: { power: [10, '2'], temp: [10, '30'] }, c: { flow: [10, '5'] } });
    await tick();
    expect(live.get('a', ['power'])).toEqual({ power: { ts: 10, value: 1 } });
    expect(live.get('b', ['power', 'temp'])).toEqual({ power: { ts: 10, value: 2 }, temp: { ts: 10, value: 30 } });
    expect(live.get('c', ['flow'])).toEqual({ flow: { ts: 10, value: 5 } });
    // the next push changes only b: only b is reported as changed
    changed.length = 0;
    f.push(id, { a: { power: [10, '1'] }, b: { power: [20, '3'], temp: [10, '30'] }, c: { flow: [10, '5'] } });
    await tick();
    expect(changed).toEqual([['b']]);
    expect(live.get('b', ['power'])).toEqual({ power: { ts: 20, value: 3 } });
  });

  it('adding a key to one device re-creates the group once, with the other devices kept', async () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    live.want('a', ['power']);
    live.want('b', ['power']);
    await tick();
    await tick();
    const [first] = f.live()[0];
    f.push(first, { a: { power: [10, '1'] }, b: { power: [10, '2'] } });
    live.want('b', ['temp']);
    await tick();
    expect(f.subs.get(first)!.removed).toBe(true);
    expect(f.live().length).toBe(1);
    const [second, s] = f.live()[0];
    expect(s.info.map((x: any) => [x.entityId, x.timeseries.map((k: any) => k.name).sort()]).sort()).toEqual([
      ['a', ['power']],
      ['b', ['power', 'temp']],
    ]);
    // a keeps its values; b is served once its new subscription answered
    expect(live.get('a', ['power'])).toEqual({ power: { ts: 10, value: 1 } });
    f.push(second, { a: { power: [10, '1'] }, b: { power: [10, '2'], temp: [11, '40'] } });
    expect(live.get('b', ['power', 'temp'])).toEqual({ power: { ts: 10, value: 2 }, temp: { ts: 11, value: 40 } });
  });

  it('closing the socket removes the shared subscription', async () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const live = new Live({ host: 'tb.test', token: () => 'jwt', connect: connectLive });
    live.want('a', ['power']);
    live.want('b', ['power']);
    await tick();
    await tick();
    expect(f.live().length).toBe(1);
    live.close();
    expect(f.live().length).toBe(0);
  });
});

describe('pushed alarm counts and attributes (D-046)', () => {
  it('watchAlarmCounts: one subscription, one alarmCount datasource per spec, counts matched by order', async () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const w = watchAlarmCounts([
      { name: 'a', filter: { type: 'singleEntity', singleEntity: { entityType: 'DEVICE', id: 'a' } }, status: ['ACTIVE'] },
      { name: 'b', filter: { type: 'singleEntity', singleEntity: { entityType: 'DEVICE', id: 'b' } }, status: ['ACTIVE'] },
    ])!;
    expect(f.counts.size).toBe(1);
    const [, c] = [...f.counts.entries()][0];
    expect(c.options.datasources.map((d: any) => [d.type, d.entityFilter.singleEntity.id, d.alarmFilterConfig.statusList])).toEqual([
      ['alarmCount', 'a', ['ACTIVE']],
      ['alarmCount', 'b', ['ACTIVE']],
    ]);
    expect(w.counts()).toBeNull();
    const ready = w.waitReady(1000);
    // ThingsBoard renames count datasources; the order is what counts
    c.options.callbacks.onDataUpdated({ data: [{ datasource: { name: 'Alarms count' }, data: [[1, 3]] }, { datasource: { name: 'Alarms count 2' }, data: [[1, 0]] }] });
    expect(await ready).toBe(true);
    expect(w.counts()).toEqual({ a: 3, b: 0 });
    w.stop();
    expect(c.removed).toBe(true);
  });

  it('a count watch dies with its provider widget; without a provider there is none', () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const w = watchAlarmCounts([{ name: 'a', filter: {}, status: [] }])!;
    expect(w.alive()).toBe(true);
    unregisterLiveProvider(f.ctx);
    expect(w.alive()).toBe(false);
    expect(watchAlarmCounts([{ name: 'a', filter: {}, status: [] }])).toBeNull();
  });

  it('api.activeAlarmCounts reads the pushed counts and makes no REST call', async () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const calls: string[] = [];
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = async (u: string) => {
      calls.push(u);
      throw new Error('no REST expected');
    };
    api.clearCaches();
    const p = api.activeAlarmCounts(['y', 'x']);
    await tick();
    const [, c] = [...f.counts.entries()].pop()!;
    expect(c.options.datasources.map((d: any) => d.name)).toEqual(['x', 'y']);
    c.options.callbacks.onDataUpdated({ data: [{ data: [[1, 2]] }, { data: [[1, 0]] }] });
    const m = await p;
    expect([...m.entries()]).toEqual([['x', 2]]);
    expect(calls).toEqual([]);
    api.clearCaches();
    (globalThis as any).fetch = realFetch;
  });

  it('watchAttribute pushes the current value, then every change; stop removes it', () => {
    const f = batchCtx();
    registerLiveProvider(f.ctx);
    const got: unknown[] = [];
    const w = watchAttribute({ id: 'store', entityType: 'ASSET' }, 'dbb_chat_resp_u1', (v) => got.push(v))!;
    const [id, s] = f.live()[0];
    expect(s.info).toEqual([{ type: 'entity', entityType: 'ASSET', entityId: 'store', attributes: [{ name: 'dbb_chat_resp_u1' }] }]);
    s.options.callbacks.onDataUpdated({ data: [{ dataKey: { name: 'dbb_chat_resp_u1' }, data: [[0, '']] }] });
    s.options.callbacks.onDataUpdated({ data: [{ dataKey: { name: 'dbb_chat_resp_u1' }, data: [[5, '{"reqId":"r1"}']] }] });
    expect(got).toEqual([undefined, '{"reqId":"r1"}']);
    w.stop();
    expect(f.subs.get(id)!.removed).toBe(true);
  });
});
