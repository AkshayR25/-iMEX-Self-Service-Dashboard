// Dashboard JSON schema (schemaVersion 1). Shared by builder, renderer and chat validation.
import { z } from 'zod';

/** Widgets per dashboard page (load on the demo server; user decision 27 Sep 2026). */
export const MAX_WIDGETS = 10;
/** Properties per widget. */
export const MAX_KEYS = 4;
/** Specific machines per widget. */
export const MAX_DEVICES = 4;
/** Series drawn in one chart (machines x properties). */
export const MAX_SERIES = 8;
/** Legacy limits, only so dashboards saved before 27 Sep 2026 still load (checkDashboard enforces the new ones on save). */
const LEGACY_MAX_WIDGETS = 40;
const LEGACY_MAX_KEYS = 10;
export const GRID_COLS = 12;

export const WIDGET_TYPES = [
  'value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary',
  'line', 'area', 'bar', 'donut', 'timeline', 'heatmap',
  'table', 'alarms',
  'text', 'image', 'link', 'embed',
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  value: 'Value card',
  kpi: 'KPI + trend',
  gauge: 'Gauge',
  progress: 'Level / progress bar',
  status: 'Status indicator',
  multivalue: 'Multi-value card',
  summary: 'Min / avg / max',
  line: 'Line chart',
  area: 'Area chart',
  bar: 'Bar chart',
  donut: 'Donut / share',
  timeline: 'State timeline',
  heatmap: 'Heatmap (machines × time)',
  table: 'Table',
  alarms: 'Alarm list',
  text: 'Rich text',
  image: 'Image / logo',
  link: 'Button / link',
  embed: 'Embedded page',
};

/** Palette groups in the builder. */
export const WIDGET_GROUPS: { title: string; types: WidgetType[] }[] = [
  { title: 'Values', types: ['value', 'kpi', 'gauge', 'progress', 'status', 'multivalue', 'summary'] },
  { title: 'Charts', types: ['line', 'area', 'bar', 'donut', 'timeline', 'heatmap'] },
  { title: 'Lists', types: ['table', 'alarms'] },
  { title: 'Content', types: ['text', 'image', 'link', 'embed'] },
];

/** How many keys and devices each widget type accepts. */
export const WIDGET_CAPS: Record<WidgetType, { keys: [number, number]; multiDevice: boolean; needsData: boolean }> = {
  value: { keys: [1, 1], multiDevice: false, needsData: true },
  kpi: { keys: [1, 1], multiDevice: false, needsData: true },
  gauge: { keys: [1, 1], multiDevice: false, needsData: true },
  progress: { keys: [1, 1], multiDevice: false, needsData: true },
  status: { keys: [1, 1], multiDevice: false, needsData: true },
  multivalue: { keys: [1, MAX_KEYS], multiDevice: false, needsData: true },
  summary: { keys: [1, 1], multiDevice: false, needsData: true },
  line: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  area: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  bar: { keys: [1, 1], multiDevice: true, needsData: true },
  donut: { keys: [1, 1], multiDevice: true, needsData: true },
  timeline: { keys: [1, 1], multiDevice: true, needsData: true },
  heatmap: { keys: [1, 1], multiDevice: true, needsData: true },
  table: { keys: [1, MAX_KEYS], multiDevice: true, needsData: true },
  alarms: { keys: [0, 0], multiDevice: true, needsData: true },
  text: { keys: [0, 0], multiDevice: false, needsData: false },
  image: { keys: [0, 0], multiDevice: false, needsData: false },
  link: { keys: [0, 0], multiDevice: false, needsData: false },
  embed: { keys: [0, 0], multiDevice: false, needsData: false },
};

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  value: { w: 3, h: 2 },
  kpi: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  progress: { w: 3, h: 2 },
  status: { w: 3, h: 2 },
  multivalue: { w: 4, h: 3 },
  summary: { w: 4, h: 2 },
  line: { w: 12, h: 4 },
  area: { w: 12, h: 4 },
  bar: { w: 6, h: 4 },
  donut: { w: 4, h: 4 },
  timeline: { w: 12, h: 3 },
  heatmap: { w: 8, h: 4 },
  table: { w: 6, h: 4 },
  alarms: { w: 6, h: 4 },
  text: { w: 12, h: 1 },
  image: { w: 3, h: 2 },
  link: { w: 3, h: 1 },
  embed: { w: 6, h: 5 },
};

/** Widget types that have no data source. */
export const CONTENT_TYPES = new Set<WidgetType>(['text', 'image', 'link', 'embed']);

export const Binding = z.discriminatedUnion('mode', [
  /** The machine the dashboard is opened for. */
  z.object({ mode: z.literal('current') }),
  /** Specific machines. */
  z.object({ mode: z.literal('fixed'), deviceIds: z.array(z.string()).min(1).max(LEGACY_MAX_KEYS) }),
  /** Machines of a profile under the same parent as the current machine (includes current). */
  z.object({ mode: z.literal('siblings'), profile: z.string() }),
  /** Closest machine of a profile found walking up from the current machine. */
  z.object({ mode: z.literal('nearest'), profile: z.string() }),
  /** All machines of a profile under a node (future machines included). */
  z.object({ mode: z.literal('nodeQuery'), nodeId: z.string(), profile: z.string() }),
  /** Text widgets. */
  z.object({ mode: z.literal('none') }),
]);
export type Binding = z.infer<typeof Binding>;

const Band = z.object({ upTo: z.number().nullable(), color: z.string() });

const Color = z.string().max(40).regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/, 'colour must be #hex or rgb()');

export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'contains', 'isTrue', 'isFalse'] as const;
export type RuleOp = (typeof RULE_OPS)[number];
export const RULE_OP_LABELS: Record<RuleOp, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  eq: '=',
  neq: '≠',
  contains: 'contains',
  isTrue: 'is true',
  isFalse: 'is false',
};
/** Value-based colour rule. First matching rule wins. */
export const ColorRule = z.object({
  /** Only for this property (multi-key widgets); empty = every property. */
  key: z.string().optional(),
  op: z.enum(RULE_OPS),
  value: z.union([z.number(), z.string()]).optional(),
  value2: z.number().optional(),
  color: Color,
  /** Optional text shown instead of the value (e.g. "Too hot"), and in state charts. */
  label: z.string().max(40).optional(),
});
export type ColorRule = z.infer<typeof ColorRule>;

export const ICONS = [
  'gauge', 'bolt', 'thermometer', 'droplet', 'fan', 'wind', 'clock', 'alert', 'check', 'power',
  'factory', 'wrench', 'chart', 'speed', 'battery', 'flame', 'snow', 'info', 'star', 'pin', 'link', 'cpu', 'home', 'list',
] as const;

/** Per-widget card style. All optional; the dashboard theme supplies defaults. */
export const CardStyle = z
  .object({
    bg: Color.optional(),
    gradient: z.boolean().optional(),
    border: z.enum(['none', 'thin', 'thick']).optional(),
    borderColor: Color.optional(),
    accentBar: Color.optional(),
    radius: z.number().int().min(0).max(28).optional(),
    shadow: z.enum(['none', 'soft', 'strong']).optional(),
    padding: z.enum(['compact', 'normal', 'roomy']).optional(),
    hideTitle: z.boolean().optional(),
    titleColor: Color.optional(),
    titleSize: z.number().int().min(10).max(28).optional(),
    titleWeight: z.enum(['400', '500', '600', '700']).optional(),
    titleAlign: z.enum(['left', 'center', 'right']).optional(),
    titleFont: z.string().max(40).optional(),
    icon: z.enum(ICONS).optional(),
    iconColor: Color.optional(),
    valueSize: z.number().int().min(12).max(72).optional(),
    valueColor: Color.optional(),
    valueFont: z.string().max(40).optional(),
    /** Horizontal alignment of values and labels. */
    align: z.enum(['left', 'center', 'right']).optional(),
    /** Vertical alignment of values and labels. */
    valign: z.enum(['top', 'middle', 'bottom']).optional(),
    /** Title above (default) or below the content. */
    titlePos: z.enum(['top', 'bottom']).optional(),
  })
  .strict();
export type CardStyle = z.infer<typeof CardStyle>;

export const WidgetSettings = z
  .object({
    unit: z.string().optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Colour bands, ascending; last band has upTo = null. */
    bands: z.array(Band).max(6).optional(),
    /** Status mapping value -> label/colour. */
    statusMap: z.array(z.object({ value: z.union([z.number(), z.string()]), label: z.string(), color: z.string() })).max(8).optional(),
    agg: z.enum(['NONE', 'AVG', 'MIN', 'MAX', 'SUM']).optional(),
    /** 'day' is legacy (drawn per hour). */
    groupBy: z.enum(['15m', 'hour', 'day', 'device']).optional(),
    /** Per-widget override of the dashboard time range ('realtime' | '1h' | '2h' | '4h' | '8h'). */
    timeRange: z.string().optional(),
    showLegend: z.boolean().optional(),
    severities: z.array(z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INDETERMINATE'])).optional(),
    alarmStatus: z.enum(['ACTIVE', 'CLEARED', 'ANY']).optional(),
    maxRows: z.number().int().min(1).max(100).optional(),
    markdown: z.string().max(4000).optional(),
    /** Sanitised rich text (text widget). Supports {{key}} placeholders for live values. */
    html: z.string().max(12000).optional(),
    /** Value-based colours; replaces bands for new widgets. */
    colorRules: z.array(ColorRule).max(12).optional(),
    /** What a matching rule colours on cards. */
    colorTarget: z.enum(['value', 'background', 'accent', 'icon']).optional(),
    /** Draw numeric rules as dashed lines on line/area charts. */
    showThresholds: z.boolean().optional(),
    style: CardStyle.optional(),
    /** Rich text shown in an (i) tooltip next to the title. */
    description: z.string().max(4000).optional(),
    footer: z.string().max(200).optional(),
    // kpi
    sparkline: z.boolean().optional(),
    compare: z.enum(['start', 'none']).optional(),
    upIsGood: z.boolean().optional(),
    // progress
    orientation: z.enum(['horizontal', 'vertical']).optional(),
    // area / line
    stacked: z.boolean().optional(),
    smooth: z.boolean().optional(),
    // donut
    donutMode: z.enum(['state', 'devices']).optional(),
    // heatmap
    heatColor: z.enum(['blue', 'orange', 'rules']).optional(),
    // image / link / embed
    url: z
      .string()
      .max(210000)
      .refine((u) => u.length <= 2000 || /^data:image\//i.test(u), 'Web addresses are limited to 2000 characters')
      .optional(),
    fit: z.enum(['contain', 'cover']).optional(),
    linkKind: z.enum(['url', 'state']).optional(),
    linkState: z.string().max(60).optional(),
    linkDevice: z.string().max(60).optional(),
    buttonStyle: z.enum(['filled', 'outline', 'card']).optional(),
    buttonColor: Color.optional(),
  })
  .strict();
export type WidgetSettings = z.infer<typeof WidgetSettings>;

export const Widget = z.object({
  id: z.string(),
  type: z.enum(WIDGET_TYPES),
  title: z.string().max(120),
  x: z.number().int().min(0).max(GRID_COLS - 1),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(GRID_COLS),
  h: z.number().int().min(1).max(20),
  binding: Binding,
  keys: z.array(z.string()).max(LEGACY_MAX_KEYS),
  settings: WidgetSettings,
});
export type Widget = z.infer<typeof Widget>;

/** 'realtime' = latest values, refreshed every 10 s; charts show a rolling last hour. The others are historic windows ending now. */
export const TIME_RANGES = ['realtime', '1h', '2h', '4h', '8h'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
export const HISTORIC_RANGES = ['1h', '2h', '4h', '8h'] as const;
/** Ranges longer than 8 h were removed (load time). Older saves are read as 8 h. */
export function normalizeRange(r: unknown): TimeRange {
  if (typeof r !== 'string') return 'realtime';
  if ((TIME_RANGES as readonly string[]).includes(r)) return r as TimeRange;
  if (r === 'live') return 'realtime';
  return /^\d+[hd]$/.test(r) ? '8h' : 'realtime';
}
export function rangeLabel(r: string): string {
  const n = normalizeRange(r);
  return n === 'realtime' ? 'Realtime' : `Last ${n.replace('h', ' h')}`;
}

export const THEME_PRESETS = ['light', 'dark', 'slate', 'ocean', 'sand'] as const;
export const FONTS = ['Roboto', 'Inter', 'Poppins', 'Montserrat', 'Source Serif 4', 'JetBrains Mono'] as const;
export const DashboardTheme = z
  .object({
    preset: z.enum(THEME_PRESETS).optional(),
    accent: Color.optional(),
    font: z.string().max(40).optional(),
    bg: Color.optional(),
    bgImage: z.string().max(2000).optional(),
    cardBg: Color.optional(),
    radius: z.number().int().min(0).max(28).optional(),
    shadow: z.enum(['none', 'soft', 'strong']).optional(),
    density: z.enum(['compact', 'normal', 'roomy']).optional(),
    titleAlign: z.enum(['left', 'center']).optional(),
  })
  .strict();
export type DashboardTheme = z.infer<typeof DashboardTheme>;

export const Dashboard = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string().min(1).max(120),
  /** 'device' when any widget uses a current-device-relative binding; needs a target profile. */
  kind: z.enum(['device', 'standalone']),
  profile: z.string().nullable(),
  timeRange: z.preprocess(normalizeRange, z.enum(TIME_RANGES)),
  widgets: z.array(Widget).max(LEGACY_MAX_WIDGETS),
  theme: DashboardTheme.optional(),
  ownerId: z.string(),
  ownerName: z.string(),
  version: z.number().int().min(0),
  updatedAt: z.number(),
  updatedBy: z.string(),
  /** Set on per-machine copies made by "Customise for this machine" or copy-mode apply. */
  copiedFrom: z.string().nullable().optional(),
});
export type Dashboard = z.infer<typeof Dashboard>;

export const RELATIVE_MODES = new Set(['current', 'siblings', 'nearest']);

export function dashboardKind(widgets: Widget[]): 'device' | 'standalone' {
  return widgets.some((w) => RELATIVE_MODES.has(w.binding.mode)) ? 'device' : 'standalone';
}

/** Window length of a range. Realtime charts use a rolling hour. */
export function rangeMs(r: string): number {
  const n = normalizeRange(r);
  return n === 'realtime' ? 3600e3 : Number(n.replace('h', '')) * 3600e3;
}

/** Metadata lookup for a widget's property (for type checks). Undefined = unknown, not checked. */
export type MetaOf = (w: Widget, key: string) => import('./types').KeyMeta | undefined;
/** Type check hook, set by core/compat (kept out of this module to avoid an import cycle). */
let compatCheck: ((w: Widget, metaOf: MetaOf) => string | null) | null = null;
export function setCompatCheck(fn: typeof compatCheck) {
  compatCheck = fn;
}

/** Semantic checks beyond the Zod shape. Returns human-readable problems. */
export function checkDashboard(d: Dashboard, metaOf?: MetaOf): string[] {
  const errs: string[] = [];
  if (d.widgets.length > MAX_WIDGETS) errs.push(`At most ${MAX_WIDGETS} widgets per page (this one has ${d.widgets.length}).`);
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (ids.has(w.id)) errs.push(`Duplicate widget id ${w.id}.`);
    ids.add(w.id);
    const cap = WIDGET_CAPS[w.type];
    if (w.keys.length > cap.keys[1]) errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} takes at most ${cap.keys[1]} propert${cap.keys[1] === 1 ? 'y' : 'ies'}.`);
    if (w.x + w.w > 12) errs.push(`"${w.title}" is wider than the grid.`);
    if (!cap.multiDevice && w.binding.mode === 'fixed' && w.binding.deviceIds.length > 1)
      errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} shows one machine only.`);
    if (w.binding.mode === 'fixed' && w.binding.deviceIds.length > MAX_DEVICES) errs.push(`"${w.title}": at most ${MAX_DEVICES} specific machines per widget.`);
    if (metaOf && compatCheck) {
      const why = compatCheck(w, metaOf);
      if (why) errs.push(`"${w.title || WIDGET_LABELS[w.type]}": ${why}`);
    }
    if (!CONTENT_TYPES.has(w.type) && w.binding.mode === 'none') errs.push(`"${w.title}" has no data source.`);
    if ((w.type === 'image' || w.type === 'embed') && w.settings.url && !/^https:\/\//i.test(w.settings.url) && !/^data:image\//i.test(w.settings.url))
      errs.push(`"${w.title}": the address must start with https://.`);
  }
  if (d.kind === 'device' && !d.profile) errs.push('A machine dashboard needs a machine type (profile).');
  return errs;
}

export function newId(prefix = 'w'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
