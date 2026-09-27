// Starter dashboards for the builder's template gallery. Each template adapts to the machine type's
// properties (status key, main numeric keys, power key) so it works for compressors, dryers, weather stations...
import type { UserContext } from '../core/scope';
import type { Widget, DashboardTheme, ColorRule } from '../core/schema';
import { newId } from '../core/schema';
import { STATUS } from './theme';
import { keyMeta } from './widgets';
import { valueType } from './rules';

export interface Template {
  id: string;
  name: string;
  description: string;
  theme: DashboardTheme;
  /** Preview colours for the gallery card. */
  swatch: [string, string, string];
  needsSiblings?: boolean;
  build(ctx: UserContext, profile: string, deviceId: string | null): Widget[];
}

interface Keys {
  status?: string;
  nums: string[];
  power?: string;
}

function pickKeys(ctx: UserContext, profile: string): Keys {
  const all = ctx.profileKeys[profile] ?? [];
  const status = all.find((k) => valueType(k) === 'boolean' || /status|state/i.test(k.key))?.key;
  const nums = all.filter((k) => k.key !== status && valueType(k) === 'number' && !/hours|count|total/i.test(k.key)).map((k) => k.key);
  const power = all.find((k) => /power|kw|energy|current/i.test(k.key))?.key;
  return { status, nums: nums.length ? nums : all.map((k) => k.key).filter((k) => k !== status), power };
}

const cur = { mode: 'current' as const };
const W = (type: Widget['type'], title: string, x: number, y: number, w: number, h: number, keys: string[], settings: Widget['settings'] = {}, binding: Widget['binding'] = cur): Widget => ({
  id: newId(),
  type,
  title,
  x,
  y,
  w,
  h,
  binding: type === 'text' || type === 'link' || type === 'image' || type === 'embed' ? { mode: 'none' } : binding,
  keys,
  settings,
});

/** Amber above ~75% and red above ~90% of the property's range. */
function rangeRules(ctx: UserContext, profile: string, key: string): ColorRule[] {
  const m = keyMeta(ctx, profile, key);
  const span = m.max - m.min || 1;
  const r = (f: number) => Math.round((m.min + span * f) * 10) / 10;
  return [
    { op: 'gt', value: r(0.9), color: STATUS.critical, label: 'High' },
    { op: 'gt', value: r(0.75), color: STATUS.warning, label: 'Watch' },
  ];
}

const statusRules: ColorRule[] = [
  { op: 'isTrue', color: STATUS.good, label: 'Running' },
  { op: 'isFalse', color: STATUS.neutral, label: 'Stopped' },
];

const header = (html: string, y = 0, h = 1): Widget => W('text', '', 0, y, 12, h, [], { html, style: { bg: 'transparent', border: 'none', shadow: 'none', padding: 'compact' } });

export const TEMPLATES: Template[] = [
  {
    id: 'overview',
    name: 'Machine overview',
    description: 'Live status, KPI cards with trends, a gauge, an area chart and the run-state timeline.',
    theme: { preset: 'light', font: 'Inter', radius: 14 },
    swatch: ['#f4f5f7', '#2a78d6', '#0ca30c'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const ws: Widget[] = [header('<h2>{{machine}} <span style="color: #898781; font-weight: 400">· {{location}}</span></h2>')];
      let x = 0;
      if (k.status) {
        ws.push(W('status', 'Status', 0, 1, 3, 2, [k.status], { colorRules: statusRules, style: { icon: 'power' } }));
        x = 3;
      }
      k.nums.slice(0, 3).forEach((key, i) => {
        const m = keyMeta(ctx, profile, key);
        ws.push(W('kpi', m.displayName, x + i * 3, 1, 3, 2, [key], { colorRules: rangeRules(ctx, profile, key), colorTarget: 'accent', style: { icon: /temp/i.test(key) ? 'thermometer' : /press/i.test(key) ? 'gauge' : /power|kw/i.test(key) ? 'bolt' : 'chart' } }));
      });
      const main = k.nums[0];
      if (main) {
        ws.push(W('gauge', keyMeta(ctx, profile, main).displayName, 0, 3, 4, 4, [main], { colorRules: rangeRules(ctx, profile, main) }));
        ws.push(W('area', `${keyMeta(ctx, profile, main).displayName} · trend`, 4, 3, 8, 4, [main], { smooth: true, colorRules: rangeRules(ctx, profile, main) }));
      }
      let y = 7;
      if (k.status) {
        ws.push(W('timeline', 'Run state', 0, y, 12, 2, [k.status], { colorRules: statusRules }));
        y += 2;
      }
      ws.push(W('alarms', 'Alarms', 0, y, 12, 3, [], { alarmStatus: 'ANY', maxRows: 10 }));
      return ws;
    },
  },
  {
    id: 'energy',
    name: 'Energy & performance',
    description: 'Power KPI, min/avg/max, daily bars, an hour-by-day heatmap and running-time share.',
    theme: { preset: 'ocean', font: 'Poppins', radius: 12 },
    swatch: ['#eaf1fa', '#256abf', '#eb6834'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const key = k.power ?? k.nums[0];
      if (!key) return [];
      const m = keyMeta(ctx, profile, key);
      const ws: Widget[] = [
        W('kpi', m.displayName, 0, 0, 4, 2, [key], { style: { icon: 'bolt', iconColor: '#eb6834' }, upIsGood: false }),
        W('summary', `${m.displayName} · this period`, 4, 0, 8, 2, [key], {}),
        W('bar', `${m.displayName} by day`, 0, 2, 6, 4, [key], { groupBy: 'day', agg: 'AVG', timeRange: '7d' }),
        W('heatmap', `${m.displayName} · hour × day`, 6, 2, 6, 4, [key], { timeRange: '7d', heatColor: 'orange' }),
      ];
      if (k.status) ws.push(W('donut', 'Running time share', 0, 6, 4, 4, [k.status], { donutMode: 'state', colorRules: statusRules, timeRange: '7d' }));
      ws.push(W('line', `${m.displayName} · 24 h`, k.status ? 4 : 0, 6, k.status ? 8 : 12, 4, [key], { timeRange: '24h', smooth: true }));
      return ws;
    },
  },
  {
    id: 'alarms',
    name: 'Alarm & health board',
    description: 'Dark control-room look: status, colour-coded table of same-type machines, state timelines and the alarm list.',
    theme: { preset: 'slate', font: 'Inter', radius: 10, shadow: 'none' },
    swatch: ['#141a23', '#3987e5', '#d03b3b'],
    needsSiblings: true,
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const ws: Widget[] = [header('<h2><span style="color: #3987e5">●</span> {{machine}} health</h2>')];
      const sib = { mode: 'siblings' as const, profile };
      if (k.status) ws.push(W('status', 'Status', 0, 1, 3, 2, [k.status], { colorRules: statusRules, colorTarget: 'accent' }));
      const cols = k.nums.slice(0, 3);
      if (cols.length) {
        const rules: ColorRule[] = cols.flatMap((c) => rangeRules(ctx, profile, c).map((r) => ({ ...r, key: c })));
        ws.push(W('table', `All ${profile} machines here`, k.status ? 3 : 0, 1, k.status ? 9 : 12, 3, cols, { colorRules: rules }, sib));
      }
      if (k.status) ws.push(W('timeline', 'Run state · same-type machines', 0, 4, 12, 3, [k.status], { colorRules: statusRules }, sib));
      ws.push(W('alarms', 'Alarms', 0, 7, 12, 4, [], { alarmStatus: 'ANY', maxRows: 20 }, sib));
      return ws;
    },
  },
  {
    id: 'compare',
    name: 'Compare machines',
    description: 'Side-by-side of every same-type machine at the location: bars, share donut and trend lines.',
    theme: { preset: 'sand', font: 'Montserrat', radius: 16 },
    swatch: ['#f4efe6', '#c9501f', '#1baf7a'],
    needsSiblings: true,
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const key = k.power ?? k.nums[0];
      if (!key) return [];
      const m = keyMeta(ctx, profile, key);
      const sib = { mode: 'siblings' as const, profile };
      return [
        W('bar', `Average ${m.displayName} per machine`, 0, 0, 6, 4, [key], { groupBy: 'device', agg: 'AVG' }, sib),
        W('donut', `${m.displayName} share`, 6, 0, 6, 4, [key], { donutMode: 'devices', agg: 'AVG' }, sib),
        W('line', `${m.displayName} · all machines`, 0, 4, 12, 4, [key], { smooth: true }, sib),
        W('table', 'Latest values', 0, 8, 12, 3, k.nums.slice(0, 4), {}, sib),
      ];
    },
  },
  {
    id: 'executive',
    name: 'Executive summary',
    description: 'Big numbers on coloured cards, a level bar, one trend and a notes panel — made for a wall screen.',
    theme: { preset: 'dark', font: 'Montserrat', radius: 18, density: 'roomy' },
    swatch: ['#0d0d0d', '#3987e5', '#1baf7a'],
    build(ctx, profile) {
      const k = pickKeys(ctx, profile);
      const colors = ['#184f95', '#0f6e4f', '#6b3fa0'];
      const ws: Widget[] = [header('<h1 style="text-align: center">{{machine}}</h1>', 0, 1)];
      k.nums.slice(0, 3).forEach((key, i) =>
        ws.push(W('value', keyMeta(ctx, profile, key).displayName, i * 4, 1, 4, 2, [key], { style: { bg: colors[i], gradient: true, valueSize: 40, align: 'center', titleAlign: 'center', icon: 'star', iconColor: '#ffffff', border: 'none' } })),
      );
      const main = k.nums[0];
      if (main) {
        ws.push(W('progress', `${keyMeta(ctx, profile, main).displayName} vs range`, 0, 3, 4, 2, [main], { colorRules: rangeRules(ctx, profile, main), colorTarget: 'value' }));
        ws.push(W('area', 'Trend', 4, 3, 8, 4, [main], { smooth: true, showLegend: false }));
      }
      ws.push(W('text', 'Notes', 0, 5, 4, 2, [], { html: '<p><b>Shift notes</b></p><ul><li>Last updated {{time}}</li><li>Edit this text in the builder</li></ul>' }));
      return ws;
    },
  },
];
