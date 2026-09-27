// Realistic-looking telemetry: slow drift (bounded random walk) + noise.
// Shared by the backfill and the live simulator. Pure computation (no I/O), covered by unit tests.
// Keys per profile match model.ts DEVICE_PROFILES. An "excursion" (set by the simulator) pushes the
// alarm key above its default threshold (Compressor dischargeTemp 98-101, Dryer dewPoint 6-7,
// Weather Station temperature 43-44.5) to trigger the profile alarm.

/** Telemetry values for one timestamp, key -> number. */
export type Values = Record<string, number>;

/** Bounded random walk: value `v` kept within [lo, hi]; `step` is the noise amplitude per 5 min. */
interface Walk {
  v: number;
  lo: number;
  hi: number;
  step: number;
}

/** Mutable per-device generator state; `next` advances it. */
export interface GenState {
  profile: string;
  utcOffsetH: number;
  walks: Record<string, Walk>;
  running: boolean;
  runHours: number;
  lastTs: number;
  /** When set, the device is pushed past its alarm threshold until this timestamp. */
  excursionUntil: number;
  /** Compressor stop period end, if stopped. */
  stoppedUntil: number;
  /** Smoothed temperature that decays when a compressor stops. */
  tempNow: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const noise = (amp: number) => (Math.random() * 2 - 1) * amp;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

function walk(lo: number, hi: number, step: number): Walk {
  return { v: rnd(lo, hi), lo, hi, step };
}

/** Advances a walk by `dtMin` minutes (noise scales with sqrt of time) and returns the new value. */
function stepWalk(w: Walk, dtMin: number): number {
  const s = w.step * Math.sqrt(Math.max(dtMin, 0.1) / 5);
  w.v += noise(s);
  // soft reflection at bounds
  if (w.v < w.lo) w.v = w.lo + (w.lo - w.v) * 0.5;
  if (w.v > w.hi) w.v = w.hi - (w.v - w.hi) * 0.5;
  return w.v;
}

/**
 * Fresh generator state for a device.
 * @param profile 'Compressor' | 'Dryer' | 'Weather Station' (other profiles produce weather-station keys
 *   with no walks initialised and will fail in `next`).
 * @param utcOffsetH Device local UTC offset, for the weather station's day/night cycle.
 * @param startTs Timestamp the first `next` call measures its time step from.
 */
export function initState(profile: string, utcOffsetH: number, startTs: number): GenState {
  const walks: Record<string, Walk> = {};
  if (profile === 'Compressor') {
    walks.dischargePressure = walk(6.6, 7.4, 0.05);
    walks.dischargeTemp = walk(82, 89, 0.4);
    walks.motorCurrent = walk(112, 128, 1.0);
    walks.powerKw = walk(56, 64, 0.5);
  } else if (profile === 'Dryer') {
    walks.dewPoint = walk(2.2, 3.8, 0.08);
    walks.inletTemp = walk(35, 40, 0.3);
    walks.outletTemp = walk(25, 30, 0.3);
    walks.pressureDrop = walk(0.12, 0.28, 0.01);
  } else if (profile === 'Weather Station') {
    walks.tempBias = walk(-2, 2, 0.1);
    walks.humidity = walk(45, 80, 1.0);
    walks.windSpeed = walk(0.5, 7, 0.3);
    walks.pressure = walk(1008, 1015, 0.2);
  }
  return {
    profile,
    utcOffsetH,
    walks,
    running: true,
    runHours: round(rnd(11000, 14000), 1),
    lastTs: startTs,
    excursionUntil: 0,
    stoppedUntil: 0,
    tempNow: walks.dischargeTemp?.v ?? 0,
  };
}

export interface NextOptions {
  /** Allow random compressor stops (live and backfill both use this). */
  allowStops?: boolean;
}

/** Advances the state to `ts` and returns the telemetry values for that instant. */
export function next(st: GenState, ts: number, opts: NextOptions = {}): Values {
  const dtMin = Math.max(0, (ts - st.lastTs) / 60000);
  st.lastTs = ts;
  const excursion = ts < st.excursionUntil;
  const w = st.walks;

  if (st.profile === 'Compressor') {
    if (opts.allowStops !== false) {
      if (st.running && Math.random() < 0.004 * Math.max(dtMin, 1 / 6)) {
        st.running = false;
        st.stoppedUntil = ts + rnd(5, 25) * 60000;
      } else if (!st.running && ts >= st.stoppedUntil) {
        st.running = true;
      }
    }
    if (excursion) st.running = true;
    const p = stepWalk(w.dischargePressure, dtMin);
    const t = stepWalk(w.dischargeTemp, dtMin);
    const i = stepWalk(w.motorCurrent, dtMin);
    const kw = stepWalk(w.powerKw, dtMin);
    if (st.running) {
      st.runHours += dtMin / 60;
      // temperature recovers towards the walk value after a restart
      st.tempNow += (t - st.tempNow) * Math.min(1, dtMin / 5);
      const temp = excursion ? rnd(98, 101) : st.tempNow + noise(0.3);
      return {
        dischargePressure: round(p + noise(0.03), 2),
        dischargeTemp: round(temp, 1),
        motorCurrent: round(i + noise(0.8), 1),
        powerKw: round(kw + noise(0.4), 1),
        runStatus: 1,
        runHours: round(st.runHours, 1),
      };
    }
    st.tempNow += (35 - st.tempNow) * Math.min(1, dtMin / 15); // cool down
    return {
      dischargePressure: round(Math.max(0, 0.15 + noise(0.05)), 2),
      dischargeTemp: round(st.tempNow + noise(0.2), 1),
      motorCurrent: round(Math.max(0, noise(0.3)), 1),
      powerKw: round(Math.max(0, noise(0.2)), 1),
      runStatus: 0,
      runHours: round(st.runHours, 1),
    };
  }

  if (st.profile === 'Dryer') {
    const dp = stepWalk(w.dewPoint, dtMin);
    return {
      dewPoint: round(excursion ? rnd(6, 7) : dp + noise(0.05), 1),
      inletTemp: round(stepWalk(w.inletTemp, dtMin) + noise(0.2), 1),
      outletTemp: round(stepWalk(w.outletTemp, dtMin) + noise(0.2), 1),
      pressureDrop: round(stepWalk(w.pressureDrop, dtMin) + noise(0.005), 2),
      runStatus: 1,
    };
  }

  // Weather Station: diurnal temperature cycle in local time, peak ~15:00
  const localHour = (((ts / 3600000 + st.utcOffsetH) % 24) + 24) % 24;
  const diurnal = 28 + 6 * Math.cos(((localHour - 15) / 24) * 2 * Math.PI);
  const temp = diurnal + stepWalk(w.tempBias, dtMin) + noise(0.2);
  return {
    temperature: round(excursion ? rnd(43, 44.5) : temp, 1),
    humidity: round(Math.min(100, Math.max(0, stepWalk(w.humidity, dtMin) - (temp - 28) * 1.5)), 0),
    windSpeed: round(Math.max(0, stepWalk(w.windSpeed, dtMin) + noise(0.4)), 1),
    pressure: round(stepWalk(w.pressure, dtMin) + noise(0.1), 1),
  };
}
