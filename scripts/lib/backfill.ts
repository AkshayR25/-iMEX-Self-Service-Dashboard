// Phase 1 backfill (build instructions 4.3): 7 days at 5-minute intervals per device.
// Uses the tenant REST telemetry API (POST /api/plugins/telemetry/DEVICE/{id}/timeseries/ANY), which saves
// directly without passing through the rule engine, so historic points do not create alarms (DECISIONS.md D-004).
// The generator also never produces threshold excursions during backfill.

import { TbClient, Log } from './tb';
import { DEVICES } from './model';
import { initState, next } from './generator';

export interface BackfillOptions {
  days?: number;
  intervalMin?: number;
  batchSize?: number;
  batchDelayMs?: number;
  /** Leave the most recent minutes empty so live data owns "latest". */
  endOffsetMin?: number;
  /** Only these device names (default: all). */
  only?: string[];
}

export async function runBackfill(
  tb: TbClient,
  deviceIds: Record<string, string>,
  log: Log,
  opts: BackfillOptions = {},
): Promise<Record<string, number>> {
  const days = opts.days ?? 7;
  const stepMs = (opts.intervalMin ?? 5) * 60000;
  const batchSize = opts.batchSize ?? 200;
  const delay = opts.batchDelayMs ?? 1000;
  const end = Math.floor((Date.now() - (opts.endOffsetMin ?? 10) * 60000) / stepMs) * stepMs;
  const start = end - days * 24 * 3600000 + stepMs;
  const written: Record<string, number> = {};

  for (const d of DEVICES) {
    if (opts.only && !opts.only.includes(d.name)) continue;
    const id = deviceIds[d.name];
    if (!id) throw new Error(`No id for device ${d.name}; run setup first.`);
    const st = initState(d.profile, d.utcOffsetH, start - stepMs);
    const points: { ts: number; values: Record<string, number> }[] = [];
    for (let ts = start; ts <= end; ts += stepMs) points.push({ ts, values: next(st, ts) });

    written[d.name] = 0;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await tb.post(`/api/plugins/telemetry/DEVICE/${id}/timeseries/ANY`, batch);
      written[d.name] += batch.length;
      log(`backfill ${d.name}: ${written[d.name]}/${points.length}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return written;
}
