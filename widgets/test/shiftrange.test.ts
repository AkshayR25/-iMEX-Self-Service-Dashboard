// Tests for the shift time ranges' header text and how their series are cached (D-047): the current shift so far is
// one cache entry extended with live points, the previous shift is not read again each minute.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeTB, ithena } from './fake-tb';
import * as api from '../src/core/api';
import { shiftWindowText } from '../src/core/shifts';
import { calendar, template } from '../src/core/shiftcal';
import { rangeWindow } from '../src/core/schema';

const H = 3600e3;
const MIN = 60e3;

describe('shiftWindowText (D-047 header and picker text)', () => {
  const kolkata = calendar({ chain: [{ v: 1, versions: [{ id: 'v1', from: null, shifts: template('3x8') }] }] as any, tz: 'Asia/Kolkata' });

  it('names the shift with its start and end as wall times in the site zone', () => {
    const now = Date.UTC(2026, 9, 9, 3, 0); // 08:30 in Kolkata: Morning 06:00-14:00
    const t = shiftWindowText(rangeWindow('shift', kolkata, now), 'Asia/Kolkata');
    expect(t).toMatch(/^Morning · 6:00\s?(AM|am)?–2:00\s?(PM|pm)?|^Morning · 0?6:00–14:00/);
    expect(t.startsWith('Between')).toBe(false);
  });

  it('adds the zone city only when the browser is in another zone at that moment', () => {
    const now = Date.UTC(2026, 9, 9, 3, 0);
    const win = rangeWindow('shift', kolkata, now);
    const browserOffset = -new Date(win!.shift!.start).getTimezoneOffset();
    const t = shiftWindowText(win, 'Asia/Kolkata');
    if (browserOffset === 330) expect(t).not.toMatch(/\(Kolkata time\)/);
    else expect(t).toMatch(/\(Kolkata time\)$/);
    const ny = shiftWindowText(win, 'America/New_York');
    if (browserOffset === -240) expect(ny).not.toMatch(/time\)$/);
    else expect(ny).toMatch(/\(New York time\)$/);
  });

  it('marks the previous shift shown between shifts, and says when there is none', () => {
    const gaps = calendar({ chain: [{ v: 1, versions: [{ id: 'v1', from: null, shifts: [{ id: 's1', name: 'Day', start: '08:00', end: '16:00' }] }] }] as any, tz: 'UTC' });
    const evening = Date.UTC(2026, 9, 9, 18, 0);
    expect(shiftWindowText(rangeWindow('shift', gaps, evening), 'UTC')).toMatch(/^Between shifts · Day · /);
    expect(shiftWindowText(rangeWindow('prevshift', gaps, evening), 'UTC')).toMatch(/^Day · /);
    expect(shiftWindowText(null)).toBe('No shifts set');
    expect(shiftWindowText(rangeWindow('8h', null, evening))).toBe('No shifts set');
  });
});

describe('series of the shift ranges while live values are pushed (D-047)', () => {
  let tb: FakeTB;
  const mem = new Map<string, string>();
  let pushed: { ts: number; value: number }[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 9, 10, 0));
    tb = ithena();
    tb.telemetry.set('rc', { powerKw: [0, 1, 2, 3, 4].map((i) => ({ ts: Date.now() - (4 - i) * H, value: 10 + i })) });
    mem.clear();
    mem.set('jwt_token', 'x');
    pushed = [];
    vi.stubGlobal('fetch', tb.fetch);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => mem.set(k, v) });
    // a live hub that is connected and pushes the points in `pushed` (core/live.ts Live, as api.series uses it)
    const fakeLive = {
      want() {},
      isLive: () => true,
      liveSince: () => 0,
      since: (_d: string, _k: string, ts: number) => pushed.filter((p) => p.ts > ts),
    };
    vi.stubGlobal('window', { WebSocket: function () {}, __imexDbbLive1: fakeLive });
    api.clearCaches();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const reads = () => tb.calls.filter((c) => c.endsWith('/values/timeseries')).length;

  it('the current shift so far: read once, then extended with pushed points as it grows', async () => {
    const start = Date.now() - 2 * H; // shift started 2 h ago
    const first = await api.series('rc', ['powerKw'], start, Date.now(), 'AVG', 500, { fixedStart: true });
    expect(reads()).toBe(1);
    expect(first.powerKw.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(3 * MIN);
    pushed.push({ ts: Date.now() - 1000, value: 42 });
    const later = await api.series('rc', ['powerKw'], start, Date.now(), 'AVG', 500, { fixedStart: true });
    expect(reads()).toBe(1);
    expect(later.powerKw[later.powerKw.length - 1]).toEqual({ ts: Date.now() - 1000, value: 42 });
    // still re-read after 5 minutes (bucket drift), like the rolling windows
    vi.advanceTimersByTime(3 * MIN);
    await api.series('rc', ['powerKw'], start, Date.now(), 'AVG', 500, { fixedStart: true });
    expect(reads()).toBe(2);
  });

  it('without fixedStart a window of another length is another entry (rolling windows keep their behaviour)', async () => {
    const start = Date.now() - 2 * H;
    await api.series('rc', ['powerKw'], start, Date.now(), 'AVG', 500);
    vi.advanceTimersByTime(3 * MIN);
    await api.series('rc', ['powerKw'], start, Date.now(), 'AVG', 500);
    expect(reads()).toBe(2);
  });

  it('the previous shift (a past window) is kept by where it is, not read again every minute', async () => {
    const start = Date.now() - 10 * H;
    const end = Date.now() - 2 * H;
    await api.series('rc', ['powerKw'], start, end, 'AVG', 500);
    vi.advanceTimersByTime(2 * MIN);
    await api.series('rc', ['powerKw'], start, end, 'AVG', 500);
    vi.advanceTimersByTime(2 * MIN);
    await api.series('rc', ['powerKw'], start, end, 'AVG', 500);
    expect(reads()).toBe(1);
    // another past window (the next previous shift) is its own entry
    await api.series('rc', ['powerKw'], end, Date.now() - 3 * MIN, 'AVG', 500);
    expect(reads()).toBe(2);
  });
});
