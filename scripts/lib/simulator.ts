// Phase 1 live simulator (build instructions 4.2). Posts through the device transport API
// (/api/v1/{accessToken}/telemetry) so data flows through the rule engine and profile alarm rules.

import { TbClient, Log } from './tb';
import { DEVICES } from './model';
import { GenState, initState, next } from './generator';

export interface SimulatorOptions {
  periodMs?: number; // default 10 s
  excursionEveryMs?: number; // default ~10 min
  excursionLengthMs?: number; // default ~1 min
}

export interface SimDevice {
  name: string;
  profile: string;
  token: string;
  state: GenState;
}

export class Simulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextExcursion = 0;
  private busy = false;
  readonly devices: SimDevice[] = [];
  stats = { sent: 0, failed: 0, excursions: 0, startedAt: 0, lastTickAt: 0 };

  constructor(private tb: TbClient, private log: Log, private opts: SimulatorOptions = {}) {}

  /** Reads access tokens (GET /api/device/{id}/credentials) for the POC devices. */
  async init(deviceIds: Record<string, string>) {
    this.devices.length = 0;
    for (const d of DEVICES) {
      const id = deviceIds[d.name];
      if (!id) continue;
      const cred = await this.tb.get<any>(`/api/device/${id}/credentials`);
      if (cred.credentialsType !== 'ACCESS_TOKEN') {
        this.log(`skip ${d.name}: credentials type ${cred.credentialsType}`);
        continue;
      }
      const state = initState(d.profile, d.utcOffsetH, Date.now());
      // continue the runHours counter from the last stored value (e.g. the end of the backfill)
      const latest = await this.tb.get<any>(`/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=runHours`);
      const last = Number(latest?.runHours?.[0]?.value);
      if (Number.isFinite(last) && last > 0) state.runHours = last;
      this.devices.push({ name: d.name, profile: d.profile, token: cred.credentialsId, state });
    }
    this.log(`simulator ready for ${this.devices.length} devices`);
  }

  start() {
    if (this.timer) return;
    const period = this.opts.periodMs ?? 10000;
    this.stats.startedAt = Date.now();
    this.nextExcursion = Date.now() + 60000; // first excursion after 1 min so an alarm shows up quickly
    this.timer = setInterval(() => void this.tick(), period);
    void this.tick();
    this.log(`simulator started, every ${period / 1000}s`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log('simulator stopped');
  }

  get running() {
    return this.timer !== null;
  }

  private async tick() {
    if (this.busy) return; // previous tick still retrying
    this.busy = true;
    try {
      const now = Date.now();
      if (now >= this.nextExcursion && this.devices.length) {
        const d = this.devices[Math.floor(Math.random() * this.devices.length)];
        d.state.excursionUntil = now + (this.opts.excursionLengthMs ?? 60000);
        this.stats.excursions++;
        this.nextExcursion = now + (this.opts.excursionEveryMs ?? 10 * 60000) * (0.8 + Math.random() * 0.4);
        this.log(`excursion: ${d.name} pushed past its threshold for ~1 min`);
      }
      for (const d of this.devices) {
        const values = next(d.state, now);
        try {
          await this.tb.postDeviceTelemetry(d.token, { ts: now, values });
          this.stats.sent++;
          this.log(`sent ${d.name} ${JSON.stringify(values)}`);
        } catch (e) {
          this.stats.failed++;
          this.log(`FAILED ${d.name}: ${(e as Error).message}`);
        }
      }
      this.stats.lastTickAt = now;
    } finally {
      this.busy = false;
    }
  }
}
