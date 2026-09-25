import { describe, it, expect } from 'vitest';
import { initState, next } from '../lib/generator';
import { DEVICES, DEVICE_PROFILES } from '../lib/model';
import { buildAlarm } from '../lib/setup';

const WEEK = 7 * 24 * 3600000, STEP = 5 * 60000;

describe('generator', () => {
  for (const d of DEVICES) {
    it(`${d.name}: 7 days of backfill stays below alarm thresholds`, () => {
      const p = DEVICE_PROFILES.find((x) => x.name === d.profile)!;
      const t0 = Date.now() - WEEK;
      const st = initState(d.profile, d.utcOffsetH, t0);
      let n = 0;
      for (let ts = t0 + STEP; ts <= t0 + WEEK; ts += STEP, n++) {
        const v = next(st, ts);
        for (const a of p.alarms) expect(v[a.key]).toBeLessThanOrEqual(a.defaultValue);
        for (const k of p.keys) expect(v[k.key]).toBeTypeOf('number');
      }
      expect(n).toBe(2016);
    });
  }

  it('excursion pushes past threshold', () => {
    const st = initState('Compressor', 0, 0);
    st.excursionUntil = 10_000_000;
    expect(next(st, 10_000).dischargeTemp).toBeGreaterThan(95);
  });

  it('stopped compressor drops pressure, current, power and freezes runHours', () => {
    const st = initState('Compressor', 0, 0);
    st.running = false; st.stoppedUntil = 1e12;
    const a = next(st, 600_000), b = next(st, 1_200_000);
    expect(a.runStatus).toBe(0);
    expect(a.powerKw).toBeLessThan(1);
    expect(b.runHours).toBe(a.runHours);
  });
});

describe('alarm rule', () => {
  it('uses a dynamic server-attribute threshold with default and a clear rule', () => {
    const a = buildAlarm(DEVICE_PROFILES[0].alarms[0]);
    const pred = a.createRules.MAJOR.condition.condition[0].predicate;
    expect(pred.value.dynamicValue.sourceAttribute).toBe('thr_dischargeTemp_high');
    expect(pred.value.defaultValue).toBe(95);
    expect(a.clearRule.condition.condition[0].predicate.operation).toBe('LESS_OR_EQUAL');
  });
});
