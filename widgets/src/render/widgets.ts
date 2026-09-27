// Widget renderers shared by the builder canvas, the machine dashboard renderer and previews.
import * as api from '../core/api';
import * as scope from '../core/scope';
import type { UserContext, Node } from '../core/scope';
import type { KeyMeta } from '../core/types';
import { Widget, Binding, WIDGET_CAPS, WIDGET_LABELS, rangeMs } from '../core/schema';
import { SERIES, STATUS, SEVERITY_COLOR, esc, fmtNum, ago, bandColor, miniMarkdown } from './theme';
import { lineChart, barChart, gauge } from './charts';

export interface RenderEnv {
  ctx: UserContext;
  /** Machine the dashboard is opened for (null for standalone dashboards). */
  deviceId: string | null;
  timeRange: string;
}

export interface BoundDevices {
  devices: Node[];
  /** Devices referenced by the binding but outside the user's scope. */
  hidden: number;
  problem?: string;
}

export function resolveBinding(env: RenderEnv, b: Binding): BoundDevices {
  const { ctx, deviceId } = env;
  const cur = deviceId ? ctx.nodes.get(deviceId) : undefined;
  switch (b.mode) {
    case 'none':
      return { devices: [], hidden: 0 };
    case 'current':
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      if (!cur) return { devices: [], hidden: 1 };
      return { devices: [cur], hidden: 0 };
    case 'fixed': {
      const devices = b.deviceIds.map((id) => ctx.nodes.get(id)).filter((n): n is Node => !!n && n.entityType === 'DEVICE');
      return { devices, hidden: b.deviceIds.length - devices.length };
    }
    case 'siblings':
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      return { devices: scope.siblings(ctx, deviceId, b.profile), hidden: 0 };
    case 'nearest': {
      if (!deviceId) return { devices: [], hidden: 0, problem: 'Open this dashboard for a machine to see data.' };
      const n = scope.nearest(ctx, deviceId, b.profile);
      return n ? { devices: [n], hidden: 0 } : { devices: [], hidden: 0, problem: `No ${b.profile} found near this machine.` };
    }
    case 'nodeQuery':
      if (!ctx.nodes.has(b.nodeId)) return { devices: [], hidden: 1 };
      return { devices: scope.devicesUnder(ctx, b.nodeId, b.profile), hidden: 0 };
  }
}

export function keyMeta(ctx: UserContext, profile: string, key: string): KeyMeta {
  const m = ctx.profileKeys[profile]?.find((k) => k.key === key);
  return m ?? { key, displayName: key, unit: '', decimals: 1, min: 0, max: 100 };
}

export function bindingLabel(ctx: UserContext, b: Binding): string {
  switch (b.mode) {
    case 'current':
      return 'This machine';
    case 'fixed':
      return b.deviceIds.map((id) => ctx.nodes.get(id)?.label ?? 'machine outside your access').join(', ');
    case 'siblings':
      return `${b.profile} machines at the same location`;
    case 'nearest':
      return `Nearest ${b.profile}`;
    case 'nodeQuery':
      return `All ${b.profile} in ${ctx.nodes.get(b.nodeId)?.label ?? 'a node outside your access'}`;
    default:
      return '';
  }
}

export interface WidgetHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

const placeholder = (body: HTMLElement, msg: string) => (body.innerHTML = `<div class="dbb-ph">${esc(msg)}</div>`);

export function renderWidget(container: HTMLElement, w: Widget, env: RenderEnv, opts: { chrome?: boolean } = {}): WidgetHandle {
  container.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'dbb-card';
  const showTitle = w.type !== 'text' && opts.chrome !== false;
  card.innerHTML = `${showTitle ? `<div class="dbb-card-h"><div class="dbb-card-t" title="${esc(w.title)}">${esc(w.title || WIDGET_LABELS[w.type])}</div></div>` : ''}<div class="dbb-card-b"></div>`;
  container.appendChild(card);
  const body = card.querySelector('.dbb-card-b') as HTMLElement;
  let alive = true;

  const refresh = async () => {
    if (!alive) return;
    try {
      await draw(body, w, env);
    } catch (e: any) {
      placeholder(body, `Could not load data (${e?.status ?? ''} ${e?.message?.slice(0, 80) ?? e})`);
    }
  };
  void refresh();
  return {
    refresh,
    destroy() {
      alive = false;
      container.innerHTML = '';
    },
  };
}

async function draw(body: HTMLElement, w: Widget, env: RenderEnv) {
  const { ctx } = env;
  if (w.type === 'text') {
    body.innerHTML = `<div class="dbb-md">${miniMarkdown(w.settings.markdown ?? w.title ?? '')}</div>`;
    return;
  }
  const cap = WIDGET_CAPS[w.type];
  if (w.type !== 'alarms' && w.keys.length < cap.keys[0]) return placeholder(body, 'Choose a property in the widget settings.');
  const bound = resolveBinding(env, w.binding);
  if (bound.problem) return placeholder(body, bound.problem);
  if (!bound.devices.length) return placeholder(body, bound.hidden ? 'No data in your scope' : 'No machines match this data source.');
  const devices = cap.multiDevice ? bound.devices.slice(0, 10) : bound.devices.slice(0, 1);
  const s = w.settings;
  const endTs = Date.now();
  const startTs = endTs - rangeMs(s.timeRange ?? env.timeRange);

  if (w.type === 'value' || w.type === 'gauge' || w.type === 'status') {
    const d = devices[0];
    const key = w.keys[0];
    const meta = keyMeta(ctx, d.profile, key);
    const lv = (await api.latest(d.id, [key]))[key];
    if (!lv) return placeholder(body, `Not available on this device (${d.label} doesn't report ${meta.displayName})`);
    const v = Number(lv.value);
    const unit = s.unit ?? meta.unit;
    const dec = s.decimals ?? meta.decimals;
    const sub = `${devices.length && w.binding.mode !== 'current' ? esc(d.label) + ' · ' : ''}${ago(lv.ts)}`;
    if (w.type === 'value') {
      const c = bandColor(v, s.bands);
      body.innerHTML = `<div class="dbb-value"><div>${c ? `<span class="dbb-dot" style="background:${c};margin-right:8px;vertical-align:middle"></span>` : ''}<span class="v">${fmtNum(v, dec)}</span><span class="u">${esc(unit)}</span></div><div class="s">${sub}</div></div>`;
    } else if (w.type === 'gauge') {
      gauge(body, v, { min: s.min ?? meta.min, max: s.max ?? meta.max, unit, decimals: dec, bands: s.bands, sub });
    } else {
      const map = s.statusMap?.length
        ? s.statusMap
        : [
            { value: 1, label: 'Running', color: STATUS.good },
            { value: 0, label: 'Stopped', color: STATUS.neutral },
          ];
      const hit = map.find((m) => String(m.value) === String(lv.value) || Number(m.value) === v);
      const offline = Date.now() - lv.ts > 5 * 60e3;
      const label = offline ? 'Offline' : hit?.label ?? String(lv.value);
      const color = offline ? STATUS.neutral : hit?.color ?? STATUS.neutral;
      body.innerHTML = `<div class="dbb-value"><div class="dbb-chip" style="font-size:20px;color:var(--ink)"><span class="dbb-dot" style="background:${color};width:14px;height:14px"></span>${esc(label)}</div><div class="s">${sub}</div></div>`;
    }
    return;
  }

  if (w.type === 'line') {
    const agg = s.agg ?? 'AVG';
    const series: Parameters<typeof lineChart>[1] = [];
    let slot = 0;
    const missing: string[] = [];
    for (const d of devices) {
      const data = await api.series(d.id, w.keys, startTs, endTs, agg, 500);
      for (const k of w.keys) {
        if (series.length >= 10) break;
        const meta = keyMeta(ctx, d.profile, k);
        if (!data[k]?.length) missing.push(`${d.label}: ${meta.displayName}`);
        series.push({
          name: devices.length > 1 ? `${d.label} · ${meta.displayName}` : meta.displayName,
          color: SERIES[slot++ % SERIES.length],
          unit: s.unit ?? meta.unit,
          decimals: s.decimals ?? meta.decimals,
          points: data[k] ?? [],
        });
      }
    }
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    lineChart(body, series, { startTs, endTs, showLegend: s.showLegend });
    if (bound.hidden) body.insertAdjacentHTML('beforeend', `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) not shown: no data in your scope</div>`);
    return;
  }

  if (w.type === 'bar') {
    const key = w.keys[0];
    const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
    const group = s.groupBy ?? (devices.length > 1 ? 'device' : 'day');
    const meta = keyMeta(ctx, devices[0].profile, key);
    const dec = s.decimals ?? meta.decimals;
    if (group === 'device') {
      const bars = await Promise.all(
        devices.map(async (d, i) => {
          const r = await api.get<any>(
            `/api/plugins/telemetry/DEVICE/${d.id}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${endTs - startTs}&limit=10`,
          );
          const v = r?.[key]?.[0]?.value;
          return { label: d.label, value: v == null ? null : Number(v), color: SERIES[i % SERIES.length], detail: `${d.label} · ${agg.toLowerCase()} ${meta.displayName}` };
        }),
      );
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec });
    } else {
      const step = group === 'hour' ? 3600e3 : 86400e3;
      const d = devices[0];
      const r = await api.get<any>(
        `/api/plugins/telemetry/DEVICE/${d.id}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${step}&limit=1000&orderBy=ASC`,
      );
      const pts: { ts: number; value: string }[] = r?.[key] ?? [];
      const bars = pts.map((p) => {
        const dt = new Date(p.ts);
        const label = group === 'hour' ? dt.toLocaleTimeString(undefined, { hour: '2-digit' }) : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return { label, value: Number(p.value), color: SERIES[0], detail: `${d.label} · ${dt.toLocaleString()}` };
      });
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec });
    }
    return;
  }

  if (w.type === 'table') {
    const rows = await Promise.all(devices.map(async (d) => ({ d, v: await api.latest(d.id, w.keys) })));
    const metas = w.keys.map((k) => keyMeta(ctx, devices[0].profile, k));
    body.innerHTML =
      `<div class="dbb-scroll"><table class="dbb-table"><thead><tr><th>Machine</th>${metas
        .map((m) => `<th class="num">${esc(m.displayName)}${m.unit ? ` (${esc(m.unit)})` : ''}</th>`)
        .join('')}</tr></thead><tbody>` +
      rows
        .map(
          ({ d, v }) =>
            `<tr><td>${esc(d.label)}</td>${w.keys
              .map((k, i) => `<td class="num">${v[k] ? fmtNum(v[k]!.value, s.decimals ?? metas[i].decimals) : '<span title="Not available on this device">—</span>'}</td>`)
              .join('')}</tr>`,
        )
        .join('') +
      `</tbody></table>${bound.hidden ? `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) outside your scope not shown</div>` : ''}</div>`;
    return;
  }

  if (w.type === 'alarms') {
    const lists = await Promise.all(
      devices.map((d) =>
        api.alarms({ id: d.id, entityType: 'DEVICE' }, { status: s.alarmStatus ?? 'ANY', severities: s.severities, limit: s.maxRows ?? 20, startTs }),
      ),
    );
    const all = lists
      .flat()
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, s.maxRows ?? 20);
    if (!all.length) return placeholder(body, 'No alarms in this time range');
    body.innerHTML =
      `<div class="dbb-scroll"><table class="dbb-table"><thead><tr><th>Time</th><th>Machine</th><th>Alarm</th><th>Severity</th><th>Status</th></tr></thead><tbody>` +
      all
        .map(
          (a) =>
            `<tr><td>${esc(new Date(a.startTs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td><td>${esc(
              ctx.nodes.get(a.originatorId)?.label ?? a.originatorLabel ?? a.originatorName,
            )}</td><td>${esc(a.type)}</td><td><span class="dbb-sev"><span class="dbb-dot" style="background:${SEVERITY_COLOR[a.severity] ?? STATUS.neutral}"></span>${esc(
              a.severity,
            )}</span></td><td>${a.cleared ? 'Cleared' : 'Active'}${a.acknowledged ? ' · ack' : ''}</td></tr>`,
        )
        .join('') +
      `</tbody></table></div>`;
    return;
  }
}

/** Default layout when no dashboard is assigned: value cards for all keys, 24 h trend of two main keys, active alarms. */
export function defaultWidgets(ctx: UserContext, profile: string): Widget[] {
  const keys = (ctx.profileKeys[profile] ?? []).map((k) => k.key);
  const cur = { mode: 'current' as const };
  const ws: Widget[] = [];
  keys.forEach((k, i) => {
    const m = keyMeta(ctx, profile, k);
    const isStatus = /status/i.test(k);
    ws.push({ id: `def-${k}`, type: isStatus ? 'status' : 'value', title: m.displayName, x: (i % 4) * 3, y: Math.floor(i / 4) * 2, w: 3, h: 2, binding: cur, keys: [k], settings: {} });
  });
  const rows = Math.ceil(keys.length / 4) * 2;
  // one chart per main key (different units never share an axis)
  const trend = keys.filter((k) => !/status|hours/i.test(k)).slice(0, 2);
  trend.forEach((k, i) =>
    ws.push({ id: `def-trend-${k}`, type: 'line', title: `${keyMeta(ctx, profile, k).displayName} · 24 h`, x: trend.length === 1 ? 0 : i * 6, y: rows, w: trend.length === 1 ? 12 : 6, h: 4, binding: cur, keys: [k], settings: { timeRange: '24h' } }),
  );
  const ay = rows + (trend.length ? 4 : 0);
  ws.push({ id: 'def-alarms', type: 'alarms', title: 'Active alarms', x: 0, y: ay, w: 12, h: 3, binding: cur, keys: [], settings: { alarmStatus: 'ACTIVE', maxRows: 10 } });
  return ws;
}
