/**
 * Value-based colour rules ("colour rules", see DECISIONS D-019): evaluation, legacy band
 * conversion and value-type inference.
 *
 * Runs in the browser inside every ThingsBoard widget of the bundle, and in Node unit tests
 * (pure functions, no DOM).
 *
 * Main exports:
 * - `valueType` / `asBool`: decide whether a property is a number, on/off or text.
 *   `core/compat.ts` builds its property kinds (D-020) on `valueType`, and the builder's rule
 *   editor (`builder/editors.ts`) uses it to pick which operators to offer.
 * - `ruleMatches` / `matchRule`: evaluate a widget's `ColorRule[]` against a live value.
 *   Called by `render/widgets.ts` (card, table cell and status colours) and `render/charts.ts`.
 * - `bandsToRules` / `effectiveRules`: turn the legacy `bands` setting into rules so old
 *   dashboards keep their colours.
 * - `thresholdLines`: numeric rules as lines for charts and zones for gauges.
 * - `stateLabel`: human label for a state value (timeline, status pill, donut legend).
 *
 * Evaluation order: rules are checked top to bottom and the FIRST match wins. A rule with a
 * `key` only applies to that property; a key-less rule applies to every property of the widget.
 * Put the most specific / most severe rule first (e.g. "> 90 red" before "> 75 amber").
 */
import { COLOR_RE, type ColorRule } from '../core/schema';
import type { KeyMeta } from '../core/types';

/** The three value types a rule editor can work in. `coded` states (D-020) are numbers here. */
export type ValueType = 'number' | 'boolean' | 'string';

// Spellings accepted as on/off. Compared lower-cased and trimmed.
const TRUE = new Set(['true', '1', 'on', 'yes', 'running', 'open']);
const FALSE = new Set(['false', '0', 'off', 'no', 'stopped', 'closed']);

/**
 * Reads a telemetry value as on/off.
 * @param v Raw value (boolean, number or string; ThingsBoard often sends strings).
 * @returns `true` / `false` for a recognised spelling (see TRUE / FALSE), else `null`
 *   (so "unknown" never matches an is-on or is-off rule).
 */
export function asBool(v: unknown): boolean | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return null;
}

/**
 * Infers the value type of a property. Checked in this order, first answer wins:
 * 1. `meta.type` set explicitly in the profile-key catalogue (`dbb_profile_keys`, D-013).
 * 2. Key name ends in a status-like word (status, running, enabled, alarm, fault, isOn, onOff,
 *    open, active) AND its catalogue `max` is at most 1 (a missing `max` counts as 1) → boolean.
 * 3. A sample value: `"true"`/`"false"` → boolean; anything not parseable as a number → string.
 * 4. Otherwise number (also when there is no sample).
 *
 * Note that a sample of `0`/`1` alone is read as a number; only the key-name rule makes it on/off.
 * @param meta Catalogue entry for the key (may be partial or missing).
 * @param sample Optional latest value, used when the catalogue does not say.
 */
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

/**
 * Tests one rule against one value. Ignores the rule's `key` (see `matchRule` for that).
 *
 * - gt / gte / lt / lte / between only match numeric values; null, '' and non-numbers never match.
 *   `between` is inclusive, accepts bounds in either order, and without `value2` it is a single point.
 * - eq / neq compare numerically when both sides are numbers, else as trimmed, case-insensitive text.
 * - contains is a case-insensitive substring test.
 * - isTrue / isFalse use `asBool`, so an unrecognised value matches neither.
 * @returns true if the value satisfies the rule's condition.
 */
export function ruleMatches(r: ColorRule, raw: unknown): boolean {
  const n = Number(raw);
  // Number('') and Number(null) are 0, so empty values must be excluded explicitly.
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

/**
 * First rule (for this key, or key-less) that matches the value, in list order.
 * @param rules The widget's effective rules (see `effectiveRules`); undefined/empty → null.
 * @param raw The live value.
 * @param key Property the value belongs to. When omitted, keyed rules are NOT filtered out,
 *   so every rule is considered (used for single-property widgets and the editor's test box).
 * @returns The matching rule (its `color` and optional `label` are what callers use), or null.
 */
export function matchRule(rules: ColorRule[] | undefined, raw: unknown, key?: string): ColorRule | null {
  if (!rules?.length) return null;
  for (const r of rules) {
    if (r.key && key && r.key !== key) continue;
    if (ruleMatches(r, raw)) return r;
  }
  return null;
}

/**
 * Converts legacy green/amber/red bands to rules, so old dashboards keep their colours.
 * Bands are stored in ascending `upTo` order; each becomes `<= upTo`, which gives the same
 * result under first-match-wins. An open-ended last band (`upTo: null`) becomes a catch-all
 * `> -Infinity` rule at the end. Pure; does not change the widget.
 */
export function bandsToRules(bands?: { upTo: number | null; color: string }[]): ColorRule[] {
  if (!bands?.length) return [];
  const out: ColorRule[] = [];
  bands.forEach((b) => {
    if (b.upTo === null) return;
    out.push({ op: 'lte', value: b.upTo, color: b.color });
  });
  const last = bands[bands.length - 1];
  // -Infinity is not finite, so thresholdLines() never draws this catch-all as a line.
  if (last.upTo === null) out.push({ op: 'gt', value: Number.NEGATIVE_INFINITY, color: last.color });
  return out;
}

/**
 * Effective rules for a widget: explicit `colorRules` if any, else legacy `bands` converted.
 * The legacy status `statusMap` is handled separately by the renderer and the rule editor.
 * @param s The widget's settings.
 */
export function effectiveRules(s: { colorRules?: ColorRule[]; bands?: { upTo: number | null; color: string }[] }): ColorRule[] {
  const r = s.colorRules?.length ? s.colorRules : bandsToRules(s.bands);
  // D-028: every rule colour ends up in markup and CSS; a stored value that is not a plain colour becomes grey
  return r.some((x) => !isColor(x.color)) ? r.map((x) => (isColor(x.color) ? x : { ...x, color: NEUTRAL })) : r;
}

const NEUTRAL = '#8a8983';
/** D-028: true for #hex, rgb()/rgba() and 'transparent' only. */
export function isColor(c: unknown): c is string {
  return typeof c === 'string' && c.length <= 40 && COLOR_RE.test(c);
}
/** D-028: `c` if it is a plain colour, else neutral grey; use for every colour written into HTML or CSS. */
export function cssColor(c: unknown, fallback = NEUTRAL): string {
  return isColor(c) ? c : fallback;
}

/**
 * Numeric thresholds to draw on charts (dashed lines) and gauges (zones), sorted ascending.
 * gt/gte/lt/lte give one line at `value`; between gives two (value and value2). Text, on/off
 * and eq/neq rules give none; non-finite values are skipped.
 * @param key When given, rules scoped to another key are skipped.
 */
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

/**
 * Display label for a state value, first found of:
 * 1. the `label` of the matching rule;
 * 2. the catalogue's `states` name for a coded value (e.g. `{ "2": "Loading" }`);
 * 3. for on/off properties, "Running"/"Stopped" when the key looks like a run state
 *    (run, status, state, motor, pump), else "On"/"Off";
 * 4. the raw value as text, or an em dash for null/undefined.
 */
export function stateLabel(raw: unknown, rules: ColorRule[] | undefined, meta?: Partial<KeyMeta> | null, key?: string): string {
  const r = matchRule(rules, raw, key);
  if (r?.label) return r.label;
  const m = meta?.states?.[String(raw)];
  if (m) return m;
  const b = asBool(raw);
  if (b !== null && valueType(meta, raw) === 'boolean') return /run|status|state|motor|pump/i.test(meta?.key ?? '') ? (b ? 'Running' : 'Stopped') : b ? 'On' : 'Off';
  return String(raw ?? '—');
}
