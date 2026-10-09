// Shift calendar core (core/shiftcal.ts): runs every vector in shift-vectors.json (byte-identical copy of the App UI's
// tests/shift-vectors.json, the contract shared with the JavaScript and Python copies), plus unit tests for
// validateVersion, coverageGaps, TEMPLATES and the zone helpers.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as core from '../src/core/shiftcal';
import type { ShiftCalendar, ShiftInstance } from '../src/core/shiftcal';

const V: any = JSON.parse(readFileSync(new URL('./shift-vectors.json', import.meta.url), 'utf8'));

const ms = (s: string): number => {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error('bad ISO in vectors: ' + s);
  return t;
};
const iso = (t: number): string => new Date(t).toISOString().replace('.000Z', 'Z');

// the fields an expectation lists, read from an instance (timestamps as ISO UTC so failures are readable)
function pick(got: ShiftInstance | null, exp: any): any {
  if (got === null || exp === null) return got;
  const o: any = {};
  for (const k of Object.keys(exp)) {
    if (k === 'start' || k === 'end') o[k] = iso(got[k]);
    else if (k === 'breaks') o[k] = got.breaks.map((b) => ({ name: b.name, start: iso(b.start), end: iso(b.end) }));
    else o[k] = (got as any)[k];
  }
  return o;
}
const normExp = (e: any): any =>
  e === null
    ? null
    : Object.fromEntries(
        Object.entries(e).map(([k, v]: [string, any]) => [
          k,
          k === 'start' || k === 'end'
            ? iso(ms(v))
            : k === 'breaks'
              ? v.map((b: any) => ({ name: b.name, start: iso(ms(b.start)), end: iso(ms(b.end)) }))
              : v,
        ]),
      );

function runQuery(cal: ShiftCalendar, q: any): void {
  const where = `${q.fn} ${q.ts || q.from + ' .. ' + q.to}`;
  switch (q.fn) {
    case 'at':
    case 'previous':
    case 'next': {
      const e = normExp(q.expect);
      const fn = q.fn as 'at' | 'previous' | 'next';
      expect(pick(cal[fn](ms(q.ts)), e), where).toEqual(e);
      break;
    }
    case 'productionDay':
      expect(cal.productionDay(ms(q.ts)), where).toBe(q.expect);
      break;
    case 'between': {
      const got = cal.between(ms(q.from), ms(q.to));
      const e = q.expect.map(normExp);
      expect(got.length, where + ' (count)').toBe(e.length);
      expect(
        got.map((g, i) => pick(g, e[i])),
        where,
      ).toEqual(e);
      break;
    }
    case 'boundaries':
      expect(cal.boundaries(ms(q.from), ms(q.to)).map(iso), where).toEqual(q.expect.map((x: string) => iso(ms(x))));
      break;
    default:
      throw new Error('unknown fn ' + q.fn);
  }
}

describe('shift vectors (shared contract)', () => {
  let total = 0;
  for (const c of V.cases) {
    total += c.queries.length;
    it(c.name, () => {
      const cal = core.calendar({ chain: c.chain, tz: c.tz });
      for (const q of c.queries) runQuery(cal, q);
    });
  }
  it('covers every vector query (133 in 16 cases)', () => {
    expect(V.cases.length).toBe(16);
    expect(total).toBe(133);
  });
  it('validateVersion codes', () => {
    expect(V.validate.length).toBe(31);
    for (const v of V.validate) {
      const codes = [...new Set(core.validateVersion(v.version).map((x) => x.code))].sort();
      expect(codes, v.name).toEqual(v.expectCodes);
    }
  });
});

// clock.js replaces Intl.DateTimeFormat and forces 12-hour output; the core must keep using the original
describe('zone maths and the clock.js Intl override', () => {
  const OrigDTF = Intl.DateTimeFormat;
  const override = function (l?: any, o?: any) {
    const opts = Object.assign({}, o || {});
    delete opts.hourCycle;
    opts.hour12 = true;
    return new OrigDTF(l, opts);
  } as any;
  // a fresh module instance (its formatter cache is per module), loaded while the override is in place
  async function withOverride<T>(saveOrig: boolean, fn: (c: typeof core) => T): Promise<T> {
    (Intl as any).DateTimeFormat = override;
    if (saveOrig) (globalThis as any).__imxOrigDTF = OrigDTF;
    try {
      vi.resetModules();
      const fresh = (await import('../src/core/shiftcal')) as typeof core;
      return fn(fresh);
    } finally {
      (Intl as any).DateTimeFormat = OrigDTF;
      delete (globalThis as any).__imxOrigDTF;
      vi.resetModules();
    }
  }

  it('uses __imxOrigDTF when present (all vectors still pass)', async () => {
    await withOverride(true, (c) => {
      for (const vc of V.cases) {
        const cal = c.calendar({ chain: vc.chain, tz: vc.tz });
        for (const q of vc.queries) runQuery(cal, q);
      }
      expect(c.localParts(Date.parse('2026-10-09T15:00:00+05:30'), 'Asia/Kolkata').hour).toBe(15);
    });
  });

  it('without __imxOrigDTF the override really writes 12-hour times, and the core still reads them (AM/PM)', async () => {
    await withOverride(false, (c) => {
      const raw = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', hour: '2-digit' });
      const t = Date.parse('2026-10-09T15:00:00+05:30');
      expect(raw.formatToParts(new Date(t)).find((p) => p.type === 'hour')?.value).toBe('03');
      expect(c.localParts(t, 'Asia/Kolkata').hour).toBe(15);
      for (const vc of V.cases) {
        const cal = c.calendar({ chain: vc.chain, tz: vc.tz });
        for (const q of vc.queries) runQuery(cal, q);
      }
    });
  });

  it('an engine without formatToParts, or a throwing formatter: UTC, never an exception', async () => {
    for (const make of [
      (f: Intl.DateTimeFormat) => ({ resolvedOptions: () => f.resolvedOptions(), format: (d: Date) => f.format(d) }),
      (f: Intl.DateTimeFormat) => ({ resolvedOptions: () => f.resolvedOptions(), formatToParts: () => { throw new Error('x'); } }),
    ]) {
      (Intl as any).DateTimeFormat = function (l?: any, o?: any) { return make(new OrigDTF(l, o)); };
      try {
        vi.resetModules();
        const c = (await import('../src/core/shiftcal')) as typeof core;
        const cal = c.calendar({ chain: V.cases[0].chain, tz: 'Asia/Kolkata' });
        const t = Date.parse('2026-10-09T10:00:00Z');
        expect(c.offset(t, 'Asia/Kolkata')).toBe(0);
        expect(iso(cal.at(t)!.start)).toBe('2026-10-09T06:00:00Z');
        expect(cal.between(t, t + 864e5).length).toBe(4);
      } finally {
        (Intl as any).DateTimeFormat = OrigDTF;
        vi.resetModules();
      }
    }
  });
});

// the review fixes of 2026-10-09, as in the App UI's tests/shifts.test.mjs
describe('spring gap, offsets cache, zone names, read-only templates', () => {
  it('instances never overlap and are never empty (random versions around five spring gaps)', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
    const hmS = (m: number) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    const zones = [['America/New_York', '2026-03-08'], ['America/St_Johns', '2026-03-08'], ['Australia/Lord_Howe', '2026-10-04'],
      ['Europe/Berlin', '2026-03-29'], ['America/Havana', '2026-03-08']];
    let checked = 0;
    for (let k = 0; k < 300; k++) {
      const cuts = new Set<number>();
      const n = 2 + Math.floor(rnd() * 5);
      while (cuts.size < n) cuts.add(rnd() < 0.5 ? 60 + Math.floor(rnd() * 37) * 5 : Math.floor(rnd() * 288) * 5);
      const c = [...cuts].sort((a, b) => a - b);
      const shifts = c.map((a, i) => ({ id: 's' + i, name: 'S' + i, start: hmS(a), end: hmS(c[(i + 1) % c.length]),
        breaks: [{ name: 'B', start: hmS(a + 5), end: hmS(a + 10) }] }));
      const v = { id: 'v', from: null, shifts };
      if (core.validateVersion(v).length) continue;
      const [tz, d] = zones[k % zones.length];
      const cal = core.calendar({ chain: [{ v: 1, versions: [v] }], tz });
      const t = Date.parse(d + 'T00:00:00Z');
      const list = cal.between(t - 2 * 864e5, t + 3 * 864e5);
      list.forEach((x, i) => {
        expect(x.end > x.start).toBe(true);
        if (i) expect(list[i - 1].end <= x.start).toBe(true);
        x.breaks.forEach((b, j) => {
          expect(b.end > b.start && b.start >= x.start && b.end <= x.end).toBe(true);
          if (j) expect(x.breaks[j - 1].end <= b.start).toBe(true);
        });
        const a = cal.at(x.start)!;
        expect([a.start, a.end]).toEqual([x.start, x.end]);
        const p = cal.previous(x.end)!;
        expect(p.end <= x.end && p.start < x.end).toBe(true);
      });
      checked += list.length;
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('cached offsets equal the formatter at every second around changes on odd minutes and seconds', () => {
    const f: Record<string, Intl.DateTimeFormat> = {};
    const direct = (ts: number, tz: string) => {
      f[tz] = f[tz] || new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p: Record<string, number> = {};
      for (const x of f[tz].formatToParts(new Date(ts))) p[x.type] = +x.value;
      return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ts / 1000) * 1000) / 60000);
    };
    // Goose Bay changed at 00:01 local until 2011 (not on a quarter hour), Monrovia was -0:44:30 until 1972
    for (const [tz, at] of [['America/Goose_Bay', '1990-04-01T04:01:00Z'], ['Africa/Monrovia', '1972-01-07T00:44:30Z'],
      ['Australia/Lord_Howe', '2026-10-03T15:30:00Z'], ['America/New_York', '2026-11-01T06:00:00Z']]) {
      const T = Date.parse(at);
      for (let ts = T - 3600000; ts < T + 3600000; ts += 1000) if (core.offset(ts, tz) !== direct(ts, tz)) expect(core.offset(ts, tz), tz + ' ' + ts).toBe(direct(ts, tz));
    }
  });

  it('isValidTimeZone: case-exact IANA names only (as Python zoneinfo)', () => {
    for (const z of ['Asia/Kolkata', 'Asia/Calcutta', 'US/Eastern', 'UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires', 'Australia/Lord_Howe']) expect(core.isValidTimeZone(z), z).toBe(true);
    for (const z of ['asia/kolkata', 'ASIA/KOLKATA', 'Asia/kolkata', '+05:30', '-03:00', 'Mars/Base', 'Factory', 'localtime', '', null, 5]) expect(core.isValidTimeZone(z), String(z)).toBe(false);
    expect(core.calendar({ chain: [], tz: 'asia/kolkata' }).tz).toBe('UTC');
    expect(core.offset(Date.parse('2026-10-09T00:00:00Z'), '+05:30')).toBe(0);
  });

  it('TEMPLATES is read-only', () => {
    expect(Object.isFrozen(core.TEMPLATES) && Object.isFrozen(core.TEMPLATES['3x8'].shifts[0]) && Object.isFrozen(core.TEMPLATES.day.shifts[0].days)).toBe(true);
    expect(() => { (core.TEMPLATES['3x8'].shifts[0] as any).start = '07:00'; }).toThrow(TypeError);
    expect(core.template('3x8')[0].start).toBe('06:00');
  });
});

describe('TEMPLATES and template()', () => {
  it('are valid, as specified, and template() returns a fresh copy', () => {
    expect(Object.keys(core.TEMPLATES)).toEqual(['3x8', '2x12', 'day', 'custom']);
    expect(Object.values(core.TEMPLATES).map((t) => t.label)).toEqual(['3 × 8', '2 × 12', 'Day shift', 'Custom']);
    for (const k of Object.keys(core.TEMPLATES)) expect(core.validateVersion({ id: 'x', from: null, shifts: core.template(k) }), k).toEqual([]);
    const t = core.template('3x8');
    expect(t.map((s) => [s.id, s.name, s.start, s.end])).toEqual([
      ['a', 'Morning', '06:00', '14:00'],
      ['b', 'Afternoon', '14:00', '22:00'],
      ['c', 'Night', '22:00', '06:00'],
    ]);
    t[0].name = 'changed';
    expect(core.TEMPLATES['3x8'].shifts[0].name).toBe('Morning');
    expect(core.template('2x12').map((s) => [s.name, s.start, s.end])).toEqual([
      ['Day', '06:00', '18:00'],
      ['Night', '18:00', '06:00'],
    ]);
    expect(core.template('day')).toEqual([{ id: 'a', name: 'Day', start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] }]);
    expect(core.template('custom')).toEqual([]);
    expect(core.template('nope')).toEqual([]);
    expect(core.template('toString')).toEqual([]);
  });
});

describe('coverageGaps', () => {
  it('per weekday, with crossing and week-wrapping shifts', () => {
    const full = [[0, 1440]];
    const g3 = core.coverageGaps({ shifts: core.template('3x8') });
    for (let d = 1; d <= 7; d++) expect(g3[d as 1], 'day ' + d).toEqual([]);
    const gd = core.coverageGaps({ shifts: core.template('day') });
    for (let d = 1; d <= 5; d++) expect(gd[d as 1]).toEqual([[0, 480], [1020, 1440]]);
    expect(gd[6]).toEqual(full);
    expect(gd[7]).toEqual(full);
    // Friday night only: Friday is free until 22:00, Saturday from 06:00
    const gf = core.coverageGaps({ shifts: [{ id: 'n', name: 'Night', start: '22:00', end: '06:00', days: [5] }] });
    expect(gf[5]).toEqual([[0, 1320]]);
    expect(gf[6]).toEqual([[360, 1440]]);
    expect(gf[4]).toEqual(full);
    // Sunday night runs into Monday morning (week wrap)
    const gs = core.coverageGaps({ shifts: [{ id: 'n', name: 'Night', start: '22:00', end: '06:00', days: [7] }] });
    expect(gs[1]).toEqual([[360, 1440]]);
    expect(gs[7]).toEqual([[0, 1320]]);
    // 24-hour shift every day
    const g24 = core.coverageGaps({ shifts: [{ id: 'x', name: 'All', start: '06:00', end: '06:00' }] });
    for (let d = 1; d <= 7; d++) expect(g24[d as 1]).toEqual([]);
    // nothing configured / unreadable
    expect(core.coverageGaps({ shifts: [] })[3]).toEqual(full);
    expect(core.coverageGaps(null)[7]).toEqual(full);
  });
});

describe('validateVersion', () => {
  it('reports shiftId and readable messages', () => {
    const r = core.validateVersion({
      id: 'x',
      from: null,
      shifts: [
        { id: 'a', name: 'Morning', start: '06:00', end: '14:00' },
        { id: 'b', name: 'Day', start: '08:00', end: '17:00' },
      ],
    });
    expect(r.length).toBe(1);
    expect(r[0].code).toBe('OVERLAP');
    expect(r[0].shiftId).toBe('b');
    expect(r[0].message).toMatch(/Day overlaps Morning/);
    expect(core.validateVersion(null).map((x) => x.code)).toEqual(['SHIFTS_INVALID']);
    expect(core.validateVersion([]).map((x) => x.code)).toEqual(['SHIFTS_INVALID']);
    expect(core.validateVersion({ shifts: 'x' }).map((x) => x.code)).toEqual(['SHIFTS_INVALID']);
    const longBreak = { shifts: [{ id: 'a', name: 'A', start: '06:00', end: '14:00', breaks: [{ name: 'B'.repeat(41), start: '10:00', end: '10:30' }] }] };
    expect(core.validateVersion(longBreak).map((x) => x.code)).toEqual(['NAME_INVALID']);
    expect(core.validateVersion({ shifts: [{ id: 'a', name: 'A', start: '06:00', end: '14:00', breaks: 'x' }] }).map((x) => x.code)).toEqual(['BREAK_INVALID']);
    // no shiftId on version-level issues
    expect(core.validateVersion({ from: '2026-02-30', shifts: [] })).toEqual([{ code: 'FROM_INVALID', message: expect.any(String) }]);
  });
});

describe('zone helpers', () => {
  it('offset, localParts, fromLocal, isValidTimeZone', () => {
    const t = Date.parse('2026-10-09T10:00:00+05:30');
    expect(core.offset(t, 'Asia/Kolkata')).toBe(330);
    expect(core.offset(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(core.offset(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(core.offset(t, 'Mars/Base')).toBe(0);
    expect(core.localParts(t, 'Asia/Kolkata')).toEqual({ year: 2026, month: 10, day: 9, hour: 10, minute: 0, second: 0, weekday: 5, date: '2026-10-09' });
    expect(core.localParts(Date.parse('2026-10-11T18:29:59Z'), 'Asia/Kolkata').hour).toBe(23);
    expect(core.localParts(Date.parse('2026-10-11T18:30:00Z'), 'Asia/Kolkata').hour).toBe(0);
    expect(iso(core.fromLocal('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00Z'); // gap -> 03:30 EDT
    expect(iso(core.fromLocal('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00Z'); // first 01:30
    expect(iso(core.fromLocal('2026-10-25', '02:30', 'Europe/Berlin'))).toBe('2026-10-25T00:30:00Z');
    expect(iso(core.fromLocal('2026-03-29', '02:30', 'Europe/Berlin'))).toBe('2026-03-29T01:30:00Z');
    expect(iso(core.fromLocal('2026-12-31', '23:30', 'Asia/Kolkata'))).toBe('2026-12-31T18:00:00Z');
    expect(core.fromLocal('2026-02-30', '10:00', 'UTC')).toBeNaN();
    expect(core.fromLocal('2026-02-10', '24:00', 'UTC')).toBeNaN();
    expect(core.fromLocal('2026-02-10', '6:00', 'UTC')).toBeNaN();
    expect(core.isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(core.isValidTimeZone('Mars/Base')).toBe(false);
    expect(core.isValidTimeZone('')).toBe(false);
  });
});

describe('robustness', () => {
  it('JSON-string docs, invalid zone -> UTC, bad input never throws', () => {
    const doc = { v: 1 as const, versions: [{ id: 'v1', from: null, shifts: core.template('3x8') }] };
    const cal = core.calendar({ chain: [JSON.stringify(doc)], tz: 'Asia/Kolkata' });
    expect(cal.tz).toBe('Asia/Kolkata');
    expect(cal.at(Date.parse('2026-10-09T10:00:00+05:30'))?.name).toBe('Morning');
    const u = core.calendar({ chain: [doc], tz: 'Not/AZone' });
    expect(u.tz).toBe('UTC');
    expect(iso(u.at(Date.parse('2026-10-09T07:00:00Z'))!.start)).toBe('2026-10-09T06:00:00Z');
    expect(cal.at(NaN)).toBeNull();
    expect(cal.previous(NaN)).toBeNull();
    expect(cal.next(NaN)).toBeNull();
    expect(cal.between(10, 5)).toEqual([]);
    expect(cal.boundaries(10, 5)).toEqual([]);
    expect(core.calendar({ chain: ['{not json', null, 7 as any, [] as any], tz: 'UTC' }).at(Date.now())).toBeNull();
    expect(core.calendar({}).next(Date.now())).toBeNull();
    expect(core.calendar().tz).toBe('UTC');
    // returned instances are copies: changing one does not change the calendar
    const a = cal.at(Date.parse('2026-10-09T10:00:00+05:30'))!;
    a.end = 0;
    a.breaks.push({ name: 'x', start: 0, end: 1 });
    const again = cal.at(Date.parse('2026-10-09T10:00:00+05:30'))!;
    expect(again.end).not.toBe(0);
    expect(again.breaks).toEqual([]);
    // only at()/current() carry inBreak; instances have exactly the documented fields
    expect(Object.keys(again).sort()).toEqual(['breaks', 'end', 'id', 'inBreak', 'name', 'productionDay', 'start', 'versionId']);
    expect(Object.keys(cal.next(Date.parse('2026-10-09T10:00:00+05:30'))!).sort()).toEqual(['breaks', 'end', 'id', 'name', 'productionDay', 'start', 'versionId']);
    // current() is at()
    expect(cal.current(Date.parse('2026-10-09T23:00:00+05:30'))?.name).toBe('Night');
    // a shift with unreadable times is skipped; a non-list days means every day
    const bad = core.calendar({
      chain: [{ v: 1, versions: [{ id: 'v', from: null, shifts: [{ id: 'z', name: 'Z', start: '6:00', end: '14:00' }, { id: 'y', name: 'Y', start: '06:00', end: '14:00', days: 'x' as any }] }] }],
      tz: 'UTC',
    });
    expect(bad.at(Date.parse('2026-10-11T07:00:00Z'))?.name).toBe('Y');
  });
});

describe('speed', () => {
  it('between() over 31 days for 100 machines', () => {
    const t0 = performance.now();
    const from = Date.parse('2026-10-01T00:00:00+05:30'), to = Date.parse('2026-11-01T00:00:00+05:30');
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const site = { v: 1 as const, versions: [{ id: 'v1', from: null, shifts: core.template('3x8') }, { id: 'v2', from: '2026-10-15', shifts: core.template('2x12') }] };
      const dev = i % 5 ? null : { v: 1 as const, versions: [{ id: 'm', from: null, shifts: core.template('day') }] };
      const cal = core.calendar({ chain: [dev, site], tz: i % 2 ? 'Asia/Kolkata' : 'America/New_York' });
      n += cal.between(from, to).length;
    }
    const dt = performance.now() - t0;
    console.log(`  between() x100 over 31 days: ${n} instances in ${dt.toFixed(0)} ms`);
    expect(n).toBe(6610);
    expect(dt).toBeLessThan(1500);
  });
});
