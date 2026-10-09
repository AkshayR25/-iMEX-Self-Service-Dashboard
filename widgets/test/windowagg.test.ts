// Tests for api.windowAgg (D-048): window aggregates (the summary widget's Min / Avg / Max, bar and donut per machine)
// are read once while the WebSocket is live and kept current from the pushed points, instead of a REST read on every
// 60 s safety redraw.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena } from './fake-tb';
import * as api from '../src/core/api';

const H = 3600e3;
const MIN = 60e3;

describe('window aggregates while live values are pushed (D-048)', () => {
  let tb: FakeTB;
  const mem = new Map<string, string>();
  let pushed: { ts: number; value: number | string }[] = [];
  let live = true;
  let readyAt = 0;
  let ready = true;
  /** The subscription's first reply arrives while windowAgg waits (D-049). */
  let readyOnWait = false;
  let waits = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 9, 10, 0));
    tb = ithena();
    // 10, 20, 30, 40 over the last 40 minutes
    tb.telemetry.set('rc', { powerKw: [0, 1, 2, 3].map((i) => ({ ts: Date.now() - (40 - i * 10) * MIN, value: 10 + i * 10 })) });
    mem.clear();
    mem.set('jwt_token', 'x');
    pushed = [];
    live = true;
    readyAt = 0;
    ready = true;
    readyOnWait = false;
    waits = 0;
    vi.stubGlobal('fetch', tb.fetch);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    const fakeLive = {
      want() {},
      isLive: () => live,
      liveSince: () => (live && ready ? readyAt : null),
      since: (_d: string, _k: string, ts: number) => (live ? pushed.filter((p) => p.ts > ts) : null),
      waitReady: async () => {
        waits++;
        if (live && !ready && readyOnWait) {
          ready = true;
          readyAt = Date.now();
        }
        return live && ready;
      },
    };
    vi.stubGlobal('window', { WebSocket: function () {}, __imexDbbLive1: fakeLive });
    api.clearCaches();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const countReads = (agg?: string) => tb.urls.filter((u) => u.includes('/values/timeseries') && (!agg || u.includes(`agg=${agg}&`))).length;
  const hour = () => [Date.now() - H, Date.now()] as const;
  const summary = () => Promise.all((['MIN', 'AVG', 'MAX'] as const).map((a) => api.windowAgg('rc', 'powerKw', ...hour(), a)));

  it('the 60 s safety redraw makes no REST read when nothing was pushed (was MIN/AVG/MAX every minute)', async () => {
    expect(await summary()).toEqual([10, 25, 40]);
    const first = countReads();
    expect(first).toBe(4); // MIN, AVG, MAX + the AVG sample count
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(MIN);
      expect(await summary()).toEqual([10, 25, 40]);
    }
    expect(countReads()).toBe(first);
    // the window has slid 5 minutes: read again (points drop out at its start)
    vi.advanceTimersByTime(MIN);
    await summary();
    expect(countReads()).toBe(first * 2);
  });

  it('pushed points are folded in exactly: new minimum, maximum, average and sum without a read', async () => {
    await summary();
    expect(await api.windowAgg('rc', 'powerKw', ...hour(), 'SUM')).toBe(100);
    const n = countReads();
    vi.advanceTimersByTime(MIN);
    // a non-numeric push is ignored
    pushed.push({ ts: Date.now() - 30e3, value: 5 }, { ts: Date.now() - 20e3, value: 70 }, { ts: Date.now() - 10e3, value: 'n/a' });
    expect(await summary()).toEqual([5, (10 + 20 + 30 + 40 + 5 + 70) / 6, 70]);
    expect(await api.windowAgg('rc', 'powerKw', ...hour(), 'SUM')).toBe(175);
    expect(countReads()).toBe(n);
  });

  it('an empty window takes its first pushed point as the aggregate', async () => {
    tb.telemetry.set('rc', { powerKw: [] });
    expect(await summary()).toEqual([null, null, null]);
    const n = countReads();
    vi.advanceTimersByTime(MIN);
    pushed.push({ ts: Date.now() - 5e3, value: 12 });
    expect(await summary()).toEqual([12, 12, 12]);
    expect(countReads()).toBe(n);
  });

  it('a short window is read again after 1/12 of its length, at least every minute', async () => {
    const tenMin = () => [Date.now() - 10 * MIN, Date.now()] as const;
    await api.windowAgg('rc', 'powerKw', ...tenMin(), 'MAX');
    vi.advanceTimersByTime(30e3);
    await api.windowAgg('rc', 'powerKw', ...tenMin(), 'MAX');
    expect(countReads('MAX')).toBe(1);
    vi.advanceTimersByTime(31e3);
    await api.windowAgg('rc', 'powerKw', ...tenMin(), 'MAX');
    expect(countReads('MAX')).toBe(2);
  });

  it('the current shift so far (fixed start) is one entry kept for 5 minutes as it grows', async () => {
    const start = Date.now() - 2 * H;
    await api.windowAgg('rc', 'powerKw', start, Date.now(), 'MAX', { fixedStart: true });
    vi.advanceTimersByTime(3 * MIN);
    pushed.push({ ts: Date.now() - 1e3, value: 99 });
    expect(await api.windowAgg('rc', 'powerKw', start, Date.now(), 'MAX', { fixedStart: true })).toBe(99);
    expect(countReads('MAX')).toBe(1);
    vi.advanceTimersByTime(2 * MIN);
    await api.windowAgg('rc', 'powerKw', start, Date.now(), 'MAX', { fixedStart: true });
    expect(countReads('MAX')).toBe(2);
  });

  it('the previous shift (a past window) is kept 5 minutes and never takes pushed points', async () => {
    const start = Date.now() - 3 * H;
    const end = Date.now() - 25 * MIN;
    expect(await api.windowAgg('rc', 'powerKw', start, end, 'MAX')).toBe(20);
    pushed.push({ ts: Date.now() - 1e3, value: 99 });
    vi.advanceTimersByTime(4 * MIN);
    expect(await api.windowAgg('rc', 'powerKw', start, end, 'MAX')).toBe(20);
    expect(countReads()).toBe(1);
  });

  it('without a complete live history (subscription not ready at the read) it keeps the old 60 s cache', async () => {
    ready = false; // the subscription's first reply has not arrived yet
    await api.windowAgg('rc', 'powerKw', ...hour(), 'AVG');
    expect(countReads()).toBe(1); // no sample count: it could not be kept current
    vi.advanceTimersByTime(30e3);
    ready = true;
    readyAt = Date.now(); // ready after the read: points before this may be missing
    await api.windowAgg('rc', 'powerKw', ...hour(), 'AVG');
    expect(countReads()).toBe(1);
    vi.advanceTimersByTime(31e3);
    await api.windowAgg('rc', 'powerKw', ...hour(), 'AVG');
    expect(countReads('AVG')).toBe(2);
    expect(countReads('COUNT')).toBe(1); // now covered: read with its count, then kept current
    vi.advanceTimersByTime(MIN);
    await api.windowAgg('rc', 'powerKw', ...hour(), 'AVG');
    expect(countReads('AVG')).toBe(2);
  });

  it('first draw: waits for the subscription, so the first safety redraw makes no read (D-049, QA round 2)', async () => {
    ready = false; // the key was just added to the device's subscription
    readyOnWait = true; // its first reply arrives within the wait
    expect(await summary()).toEqual([10, 25, 40]);
    expect(countReads()).toBe(4); // MIN, AVG, MAX + the AVG sample count: already a read that is kept current
    expect(countReads('COUNT')).toBe(1);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(MIN);
      expect(await summary()).toEqual([10, 25, 40]);
    }
    expect(countReads()).toBe(4); // was MIN / AVG / COUNT / MAX again at the first safety redraw
  });

  it('no wait once the subscription is ready, nor for a past window', async () => {
    await summary();
    expect(await api.windowAgg('rc', 'powerKw', Date.now() - 3 * H, Date.now() - 25 * MIN, 'MAX')).toBe(20);
    expect(waits).toBe(0);
  });

  it('with the socket down every call is a REST read, as before', async () => {
    live = false;
    await summary();
    await summary();
    expect(countReads()).toBe(6);
    expect(countReads('COUNT')).toBe(0);
  });
});
