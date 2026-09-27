// Which widget types can show which kind of property. Plain rules, no AI: a gauge needs a number,
// a state timeline needs on/off or text states, and so on. Used to grey out combinations in the
// builder and to reject them in chat output and on save.
import type { KeyMeta } from './types';
import type { WidgetType } from './schema';
import { WIDGET_LABELS, CONTENT_TYPES, setCompatCheck } from './schema';
import type { Widget, MetaOf, Dashboard } from './schema';
import type { UserContext } from './scope';
import { valueType } from '../render/rules';

export type PropKind = 'number' | 'boolean' | 'string' | 'coded';

/** Kind of a property. 'coded' = a number whose values are named states (meta.states), e.g. 0 = Idle, 1 = Run, 2 = Fault. */
export function propKind(meta: Partial<KeyMeta> | null | undefined, sample?: unknown): PropKind {
  const t = valueType(meta, sample);
  if (t === 'number' && meta?.states && Object.keys(meta.states).length) return 'coded';
  return t;
}

export const KIND_LABEL: Record<PropKind, string> = {
  number: 'a number',
  boolean: 'on/off',
  string: 'text',
  coded: 'a coded state',
};

const NUM = ['number', 'coded'] as const;
const STATE = ['boolean', 'string', 'coded'] as const;
const ALL = ['number', 'boolean', 'string', 'coded'] as const;

/** Property kinds each widget type accepts. */
export const ACCEPTS: Record<WidgetType, readonly PropKind[]> = {
  value: ALL,
  kpi: NUM,
  gauge: NUM,
  progress: NUM,
  status: STATE,
  multivalue: ALL,
  summary: NUM,
  line: NUM,
  area: NUM,
  bar: NUM,
  donut: ALL, // narrowed by donutMode below
  timeline: STATE,
  heatmap: NUM,
  table: ALL,
  alarms: [],
  text: [],
  image: [],
  link: [],
  embed: [],
};

const NEEDS: Partial<Record<WidgetType, string>> = {
  kpi: 'a number',
  gauge: 'a number',
  progress: 'a number',
  summary: 'a number',
  line: 'a number',
  area: 'a number',
  bar: 'a number',
  heatmap: 'a number',
  status: 'on/off or text states',
  timeline: 'on/off or text states',
};

export interface Compat {
  ok: boolean;
  reason?: string;
}

/** Can widget `type` show this property? donutMode: 'state' needs states, 'devices' needs a number. */
export function compatible(type: WidgetType, meta: Partial<KeyMeta> | null | undefined, o: { donutMode?: 'state' | 'devices'; sample?: unknown } = {}): Compat {
  if (CONTENT_TYPES.has(type) || type === 'alarms') return { ok: true };
  const kind = propKind(meta, o.sample);
  const name = meta?.displayName ?? meta?.key ?? 'This property';
  let accepts = ACCEPTS[type];
  let needs = NEEDS[type];
  if (type === 'donut') {
    accepts = o.donutMode === 'devices' ? NUM : STATE;
    needs = o.donutMode === 'devices' ? 'a number' : 'on/off or text states';
  }
  if (accepts.includes(kind)) return { ok: true };
  return { ok: false, reason: `${WIDGET_LABELS[type]} needs ${needs}; ${name} is ${KIND_LABEL[kind]}.` };
}

/** Widget types that can show every one of these properties. */
export function typeAllowed(type: WidgetType, metas: (Partial<KeyMeta> | null | undefined)[], o: { donutMode?: 'state' | 'devices' } = {}): Compat {
  for (const m of metas) {
    const c = compatible(type, m, o);
    if (!c.ok) return c;
  }
  return { ok: true };
}

/** First type problem of a widget, or null. */
export function widgetProblem(w: Widget, metaOf: MetaOf): string | null {
  for (const k of w.keys) {
    const m = metaOf(w, k);
    if (!m) continue;
    const c = compatible(w.type, m, { donutMode: w.settings.donutMode });
    if (!c.ok) return c.reason!;
  }
  return null;
}
setCompatCheck(widgetProblem);

/** Property metadata for a widget's keys, from the profile catalogue (profile from the binding). */
export function metaLookup(ctx: Pick<UserContext, 'profileKeys' | 'nodes'>, d: Pick<Dashboard, 'profile'>): MetaOf {
  return (w, key) => {
    const b = w.binding;
    const profile =
      b.mode === 'current' ? d.profile : b.mode === 'fixed' ? ctx.nodes.get(b.deviceIds[0])?.profile ?? null : b.mode === 'none' ? null : b.profile;
    if (!profile) return undefined;
    return ctx.profileKeys[profile]?.find((k) => k.key === key);
  };
}
