// Dashboard JSON schema (schemaVersion 1). Shared by builder, renderer and chat validation.
import { z } from 'zod';

export const MAX_WIDGETS = 30;
export const MAX_SERIES = 10;
export const GRID_COLS = 12;

export const WIDGET_TYPES = ['value', 'gauge', 'status', 'line', 'bar', 'table', 'alarms', 'text'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_LABELS: Record<WidgetType, string> = {
  value: 'Value card',
  gauge: 'Gauge',
  status: 'Status indicator',
  line: 'Line chart',
  bar: 'Bar chart',
  table: 'Table',
  alarms: 'Alarm list',
  text: 'Text / heading',
};

/** How many keys and devices each widget type accepts. */
export const WIDGET_CAPS: Record<WidgetType, { keys: [number, number]; multiDevice: boolean; needsData: boolean }> = {
  value: { keys: [1, 1], multiDevice: false, needsData: true },
  gauge: { keys: [1, 1], multiDevice: false, needsData: true },
  status: { keys: [1, 1], multiDevice: false, needsData: true },
  line: { keys: [1, MAX_SERIES], multiDevice: true, needsData: true },
  bar: { keys: [1, 1], multiDevice: true, needsData: true },
  table: { keys: [1, MAX_SERIES], multiDevice: true, needsData: true },
  alarms: { keys: [0, 0], multiDevice: true, needsData: true },
  text: { keys: [0, 0], multiDevice: false, needsData: false },
};

export const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  value: { w: 3, h: 2 },
  gauge: { w: 3, h: 3 },
  status: { w: 3, h: 2 },
  line: { w: 12, h: 4 },
  bar: { w: 6, h: 4 },
  table: { w: 6, h: 4 },
  alarms: { w: 6, h: 4 },
  text: { w: 12, h: 1 },
};

export const Binding = z.discriminatedUnion('mode', [
  /** The machine the dashboard is opened for. */
  z.object({ mode: z.literal('current') }),
  /** Specific machines. */
  z.object({ mode: z.literal('fixed'), deviceIds: z.array(z.string()).min(1).max(MAX_SERIES) }),
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
    groupBy: z.enum(['hour', 'day', 'device']).optional(),
    timeRange: z.string().optional(), // override, e.g. '7d'
    showLegend: z.boolean().optional(),
    severities: z.array(z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'WARNING', 'INDETERMINATE'])).optional(),
    alarmStatus: z.enum(['ACTIVE', 'CLEARED', 'ANY']).optional(),
    maxRows: z.number().int().min(1).max(100).optional(),
    markdown: z.string().max(4000).optional(),
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
  keys: z.array(z.string()).max(MAX_SERIES),
  settings: WidgetSettings,
});
export type Widget = z.infer<typeof Widget>;

export const TIME_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;

export const Dashboard = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string().min(1).max(120),
  /** 'device' when any widget uses a current-device-relative binding; needs a target profile. */
  kind: z.enum(['device', 'standalone']),
  profile: z.string().nullable(),
  timeRange: z.enum(TIME_RANGES),
  widgets: z.array(Widget).max(MAX_WIDGETS),
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

export function rangeMs(r: string): number {
  const m = /^(\d+)([hd])$/.exec(r);
  if (!m) return 24 * 3600e3;
  return Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
}

/** Semantic checks beyond the Zod shape. Returns human-readable problems. */
export function checkDashboard(d: Dashboard): string[] {
  const errs: string[] = [];
  if (d.widgets.length > MAX_WIDGETS) errs.push(`At most ${MAX_WIDGETS} widgets per dashboard.`);
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (ids.has(w.id)) errs.push(`Duplicate widget id ${w.id}.`);
    ids.add(w.id);
    const cap = WIDGET_CAPS[w.type];
    if (w.keys.length > cap.keys[1]) errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} takes at most ${cap.keys[1]} propert${cap.keys[1] === 1 ? 'y' : 'ies'}.`);
    if (w.x + w.w > 12) errs.push(`"${w.title}" is wider than the grid.`);
    if (!cap.multiDevice && w.binding.mode === 'fixed' && w.binding.deviceIds.length > 1)
      errs.push(`"${w.title}": ${WIDGET_LABELS[w.type]} shows one machine only.`);
    if (w.type !== 'text' && w.binding.mode === 'none') errs.push(`"${w.title}" has no data source.`);
  }
  if (d.kind === 'device' && !d.profile) errs.push('A machine dashboard needs a machine type (profile).');
  return errs;
}

export function newId(prefix = 'w'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
