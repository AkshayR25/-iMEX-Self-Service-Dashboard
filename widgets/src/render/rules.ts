// Value-based colour rules: evaluation, legacy band conversion and value-type inference.
import type { ColorRule } from '../core/schema';
import type { KeyMeta } from '../core/types';

export type ValueType = 'number' | 'boolean' | 'string';

const TRUE = new Set(['true', '1', 'on', 'yes', 'running', 'open']);
const FALSE = new Set(['false', '0', 'off', 'no', 'stopped', 'closed']);

export function asBool(v: unknown): boolean | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return null;
}

/** Type of a property: explicit meta.type, else 0/1 status-like keys are boolean, else inferred from a sample value. */
export function valueType(meta: Partial<KeyMeta> | null | undefined, sample?: unknown): ValueType {
  if (meta?.type) return meta.type;
  const k = meta?.key ?? '';
  if (/(status|running|enabled|alarm|fault|isOn|onOff|open|active)$/i.test(k) && (meta?.max ?? 1) <= 1) return 'boolean';
  if (sample !== undefined && sample !== null && sample !== '') {
    const s = String(sample).trim().toLowerCase();
    if (s === 'true' || s === 'false') return 'boolean';
    if (!Number.isFinite(Number(s))) return 'string';
  }
  return 'number';
}

export function ruleMatches(r: ColorRule, raw: unknown): boolean {
  const n = Number(raw);
  const num = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n);
  const rv = Number(r.value);
  switch (r.op) {
    case 'gt':
      return num && n > rv;
    case 'gte':
      return num && n >= rv;
    case 'lt':
      return num && n < rv;
    case 'lte':
      return num && n <= rv;
    case 'between': {
      const lo = Math.min(rv, r.value2 ?? rv);
      const hi = Math.max(rv, r.value2 ?? rv);
      return num && n >= lo && n <= hi;
    }
    case 'eq':
      if (num && r.value !== '' && Number.isFinite(rv)) return n === rv;
      return String(raw ?? '').trim().toLowerCase() === String(r.value ?? '').trim().toLowerCase();
    case 'neq':
      if (num && r.value !== '' && Number.isFinite(rv)) return n !== rv;
      return String(raw ?? '').trim().toLowerCase() !== String(r.value ?? '').trim().toLowerCase();
    case 'contains':
      return String(raw ?? '').toLowerCase().includes(String(r.value ?? '').toLowerCase());
    case 'isTrue':
      return asBool(raw) === true;
    case 'isFalse':
      return asBool(raw) === false;
  }
  return false;
}

/** First rule (for this key, or key-less) that matches the value. */
export function matchRule(rules: ColorRule[] | undefined, raw: unknown, key?: string): ColorRule | null {
  if (!rules?.length) return null;
  for (const r of rules) {
    if (r.key && key && r.key !== key) continue;
    if (ruleMatches(r, raw)) return r;
  }
  return null;
}

/** Legacy green/amber/red bands as rules, so old dashboards keep their colours. */
export function bandsToRules(bands?: { upTo: number | null; color: string }[]): ColorRule[] {
  if (!bands?.length) return [];
  const out: ColorRule[] = [];
  bands.forEach((b) => {
    if (b.upTo === null) return;
    out.push({ op: 'lte', value: b.upTo, color: b.color });
  });
  const last = bands[bands.length - 1];
  if (last.upTo === null) out.push({ op: 'gt', value: Number.NEGATIVE_INFINITY, color: last.color });
  return out;
}

/** Effective rules for a widget: explicit rules, else legacy bands. */
export function effectiveRules(s: { colorRules?: ColorRule[]; bands?: { upTo: number | null; color: string }[] }): ColorRule[] {
  return s.colorRules?.length ? s.colorRules : bandsToRules(s.bands);
}

/** Numeric thresholds to draw on charts / gauges, ascending. */
export function thresholdLines(rules: ColorRule[], key?: string): { value: number; color: string; label?: string }[] {
  const out: { value: number; color: string; label?: string }[] = [];
  for (const r of rules) {
    if (r.key && key && r.key !== key) continue;
    if (['gt', 'gte', 'lt', 'lte'].includes(r.op) && Number.isFinite(Number(r.value))) out.push({ value: Number(r.value), color: r.color, label: r.label });
    if (r.op === 'between') {
      if (Number.isFinite(Number(r.value))) out.push({ value: Number(r.value), color: r.color, label: r.label });
      if (Number.isFinite(Number(r.value2))) out.push({ value: Number(r.value2), color: r.color, label: r.label });
    }
  }
  return out.sort((a, b) => a.value - b.value);
}

/** Label for a state value: matching rule label, meta state label, else the raw value. */
export function stateLabel(raw: unknown, rules: ColorRule[] | undefined, meta?: Partial<KeyMeta> | null, key?: string): string {
  const r = matchRule(rules, raw, key);
  if (r?.label) return r.label;
  const m = meta?.states?.[String(raw)];
  if (m) return m;
  const b = asBool(raw);
  if (b !== null && valueType(meta, raw) === 'boolean') return /run|status|state|motor|pump/i.test(meta?.key ?? '') ? (b ? 'Running' : 'Stopped') : b ? 'On' : 'Off';
  return String(raw ?? '—');
}
