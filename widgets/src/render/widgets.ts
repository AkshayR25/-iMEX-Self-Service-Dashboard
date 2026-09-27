// Widget renderers shared by the builder canvas, the machine dashboard renderer and previews.
import * as api from '../core/api';
import * as scope from '../core/scope';
import type { UserContext, Node } from '../core/scope';
import type { KeyMeta } from '../core/types';
import { Widget, Binding, WIDGET_CAPS, WIDGET_LABELS, CONTENT_TYPES, rangeMs, CardStyle, DashboardTheme, ColorRule } from '../core/schema';
import { SERIES, SERIES_DARK, STATUS, SEVERITY_COLOR, RAMP_BLUE, RAMP_ORANGE, esc, fmtNum, ago, miniMarkdown, fontStack, loadFont, safeUrl } from './theme';
import { lineChart, barChart, gauge, sparkline, donut, stateTimeline, heatmap, Slice, TimelineRow, HeatCell } from './charts';
import { effectiveRules, matchRule, thresholdLines, stateLabel, valueType, asBool } from './rules';
import { sanitizeHtml, fillPlaceholders, placeholderKeys } from './rich';
import { icon, ICON_SVG } from './icons';

export interface RenderEnv {
  ctx: UserContext;
  /** Machine the dashboard is opened for (null for standalone dashboards). */
  deviceId: string | null;
  timeRange: string;
  theme?: DashboardTheme | null;
  dark?: boolean;
  /** Builder canvas: links and buttons don't navigate. */
  editing?: boolean;
  /** Opens a dashboard state (link widgets). nodeId: machine or location to open it for. */
  navigate?(stateId: string, nodeId: string | null): void;
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

// ---------- card styling ----------

function hexLum(c?: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c ?? '');
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SHADOW: Record<string, string> = {
  none: 'none',
  soft: '0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.08)',
  strong: '0 4px 10px rgba(16,24,40,.08), 0 12px 28px rgba(16,24,40,.12)',
};
const PAD: Record<string, string> = { compact: '6px', normal: '10px', roomy: '16px' };

/** CSS custom properties for a card from its style settings. */
export function cardVars(st: CardStyle | undefined): string {
  if (!st) return '';
  const v: string[] = [];
  if (st.bg) {
    v.push(`--card-bg:${st.gradient ? `linear-gradient(135deg, ${st.bg}, color-mix(in srgb, ${st.bg} 72%, #000))` : st.bg}`);
    const L = hexLum(st.bg);
    if (L !== null && L < 0.3) v.push('--ink:#ffffff;--ink-2:rgba(255,255,255,.8);--ink-3:rgba(255,255,255,.62);--grid:rgba(255,255,255,.14);--line:rgba(255,255,255,.2);--hover:rgba(255,255,255,.08)');
    else if (L !== null) v.push('--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#6e6d68;--grid:rgba(0,0,0,.07);--line:rgba(0,0,0,.1);--hover:rgba(0,0,0,.04)');
  }
  if (st.border) v.push(`--card-border:${st.border === 'none' ? '0' : `${st.border === 'thick' ? 2 : 1}px solid ${st.borderColor ?? 'var(--line)'}`}`);
  else if (st.borderColor) v.push(`--card-border:1px solid ${st.borderColor}`);
  if (st.radius !== undefined) v.push(`--card-radius:${st.radius}px`);
  if (st.shadow) v.push(`--card-shadow:${SHADOW[st.shadow]}`);
  if (st.padding) v.push(`--card-pad:${PAD[st.padding]}`);
  if (st.titleColor) v.push(`--card-title-color:${st.titleColor}`);
  if (st.titleSize) v.push(`--card-title-size:${st.titleSize}px`);
  if (st.titleWeight) v.push(`--card-title-weight:${st.titleWeight}`);
  if (st.titleFont) v.push(`--card-title-font:${fontStack(st.titleFont)}`);
  if (st.titleAlign) v.push(`--card-title-justify:${st.titleAlign === 'center' ? 'center' : st.titleAlign === 'right' ? 'flex-end' : 'flex-start'}`);
  if (st.iconColor) v.push(`--card-icon:${st.iconColor}`);
  if (st.valueSize) v.push(`--card-value-size:${st.valueSize}px`);
  if (st.valueColor) v.push(`--card-value-color:${st.valueColor}`);
  if (st.valueFont) v.push(`--card-value-font:${fontStack(st.valueFont)}`);
  if (st.align) v.push(`--card-align:${st.align};--card-align-items:${st.align === 'center' ? 'center' : st.align === 'right' ? 'flex-end' : 'flex-start'}`);
  if (st.accentBar) v.push(`--card-accent:${st.accentBar}`);
  return v.join(';');
}

const INFO = ICON_SVG.info;

/** Rule effect on the card: tint / accent bar / icon colour / value colour. */
function applyRuleToCard(card: HTMLElement, w: Widget, rule: ColorRule | null) {
  const target = w.settings.colorTarget ?? 'background';
  card.classList.toggle('accent', !!(rule && target !== 'value' && target !== 'icon') || !!w.settings.style?.accentBar);
  card.style.background = '';
  if (!rule) {
    if (w.settings.style?.accentBar) card.style.setProperty('--card-accent', w.settings.style.accentBar);
    return;
  }
  if (target === 'background') {
    card.style.setProperty('--card-accent', rule.color);
    card.style.background = `linear-gradient(0deg, color-mix(in srgb, ${rule.color} 13%, transparent), color-mix(in srgb, ${rule.color} 13%, transparent)), var(--card-bg, var(--surface))`;
  } else if (target === 'accent') card.style.setProperty('--card-accent', rule.color);
  else if (target === 'icon') card.style.setProperty('--card-icon', rule.color);
  else card.style.setProperty('--card-value-color', rule.color);
}

export function renderWidget(container: HTMLElement, w: Widget, env: RenderEnv, opts: { chrome?: boolean } = {}): WidgetHandle {
  container.innerHTML = '';
  const st = w.settings.style;
  if (st?.titleFont) loadFont(st.titleFont);
  if (st?.valueFont) loadFont(st.valueFont);
  const card = document.createElement('div');
  card.className = 'dbb-card';
  card.dataset.type = w.type;
  const vars = cardVars(st);
  if (vars) card.setAttribute('style', vars);
  const content = CONTENT_TYPES.has(w.type);
  const hasTitle = content ? !!w.title && w.type !== 'link' : true;
  const showTitle = hasTitle && !st?.hideTitle && opts.chrome !== false;
  const desc = w.settings.description ? sanitizeHtml(w.settings.description) : '';
  const ic = icon(st?.icon);
  card.innerHTML = `${
    showTitle || desc
      ? `<div class="dbb-card-h">${ic && showTitle ? `<span class="dbb-card-i">${ic}</span>` : ''}${showTitle ? `<div class="dbb-card-t" title="${esc(w.title)}">${esc(w.title || WIDGET_LABELS[w.type])}</div>` : ''}<span class="grow"></span>${
          desc ? `<span class="dbb-info" tabindex="0" aria-label="About this widget">${INFO}<span class="dbb-info-pop">${desc}</span></span>` : ''
        }</div>`
      : ''
  }<div class="dbb-card-b"></div>${w.settings.footer ? `<div class="dbb-card-f">${esc(w.settings.footer)}</div>` : ''}`;
  if (st?.accentBar) {
    card.classList.add('accent');
    card.style.setProperty('--card-accent', st.accentBar);
  }
  if (w.type === 'link' && st?.bg === undefined && st?.border === undefined) card.classList.add('plain');
  container.appendChild(card);
  const body = card.querySelector('.dbb-card-b') as HTMLElement;
  if (w.type === 'image' || w.type === 'embed' || w.type === 'link') body.style.padding = showTitle ? '4px var(--card-pad,var(--pad)) var(--card-pad,var(--pad))' : w.type === 'link' ? '0' : 'var(--card-pad,var(--pad))';
  let alive = true;

  const refresh = async () => {
    if (!alive) return;
    try {
      const rule = await draw(body, w, env);
      if (rule !== undefined) applyRuleToCard(card, w, rule);
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

// ---------- data helpers ----------

async function rawSeries(deviceId: string, key: string, startTs: number, endTs: number): Promise<{ ts: number; value: string }[]> {
  const r = await api.get<Record<string, { ts: number; value: string }[]>>(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${startTs}&endTs=${endTs}&agg=NONE&orderBy=ASC&limit=5000`,
  );
  return (r?.[key] ?? []).slice().sort((a, b) => a.ts - b.ts);
}

async function aggValue(deviceId: string, key: string, startTs: number, endTs: number, agg: string): Promise<number | null> {
  const r = await api.get<any>(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${encodeURIComponent(key)}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${endTs - startTs}&limit=10`);
  const v = r?.[key]?.[0]?.value;
  return v == null ? null : Number(v);
}

/** State segments: a value holds until the next point; gaps longer than max(3x median step, 15 min) are "no data". */
function toSegments(pts: { ts: number; value: string }[], endTs: number) {
  const steps = pts.slice(1).map((p, i) => p.ts - pts[i].ts).sort((a, b) => a - b);
  const maxGap = Math.max(15 * 60e3, 3 * (steps[Math.floor(steps.length / 2)] || 0));
  const segs: { start: number; end: number; value: string }[] = [];
  pts.forEach((p, i) => {
    const next = i + 1 < pts.length ? pts[i + 1].ts : Math.min(endTs, Date.now());
    const end = Math.min(next, p.ts + maxGap);
    const last = segs[segs.length - 1];
    if (last && last.value === String(p.value) && last.end >= p.ts - 1) last.end = end;
    else segs.push({ start: p.ts, end, value: String(p.value) });
  });
  return segs.filter((s) => s.end > s.start);
}

function stateColor(raw: string, rules: ColorRule[], key: string, order: string[], palette: string[]): string {
  const r = matchRule(rules, raw, key);
  if (r) return r.color;
  const b = asBool(raw);
  if (b === true) return STATUS.good;
  if (b === false) return STATUS.neutral;
  let i = order.indexOf(raw);
  if (i < 0) i = order.push(raw) - 1;
  return palette[i % palette.length];
}

function ruleLabelPill(rule: ColorRule | null): string {
  return rule?.label ? `<span class="lbl" style="background:${rule.color};color:${(hexLum(rule.color) ?? 0) > 0.45 ? '#0b0b0b' : '#fff'}">${esc(rule.label)}</span>` : '';
}

const fmtVal = (raw: unknown, dec: number) => (Number.isFinite(Number(raw)) && raw !== '' && raw !== null && typeof raw !== 'boolean' ? fmtNum(raw, dec) : esc(String(raw ?? '—')));

// ---------- drawing ----------

/** Draws the widget body. Returns the colour rule to apply to the card (undefined = leave card as is). */
async function draw(body: HTMLElement, w: Widget, env: RenderEnv): Promise<ColorRule | null | undefined> {
  const { ctx } = env;
  const s = w.settings;
  const palette = env.dark ? SERIES_DARK : SERIES;
  const rules = effectiveRules(s);

  if (w.type === 'text') return drawText(body, w, env);
  if (w.type === 'image') {
    const u = safeUrl(s.url);
    body.innerHTML = u ? `<img class="dbb-img" src="${esc(u)}" alt="${esc(w.title || 'Image')}" style="object-fit:${s.fit ?? 'contain'}" referrerpolicy="no-referrer"/>` : `<div class="dbb-ph">Add an image address (https://…) in the widget settings.</div>`;
    return undefined;
  }
  if (w.type === 'embed') {
    const u = safeUrl(s.url);
    body.innerHTML = u && u.startsWith('https://')
      ? `<iframe class="dbb-frame" src="${esc(u)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer" loading="lazy" title="${esc(w.title || 'Embedded page')}"></iframe>`
      : `<div class="dbb-ph">Add a page address (https://…) in the widget settings. Some sites refuse to be embedded.</div>`;
    return undefined;
  }
  if (w.type === 'link') return drawLink(body, w, env);

  const cap = WIDGET_CAPS[w.type];
  if (w.type !== 'alarms' && w.keys.length < cap.keys[0]) return void placeholder(body, 'Choose a property in the widget settings.');
  const bound = resolveBinding(env, w.binding);
  if (bound.problem) return void placeholder(body, bound.problem);
  if (!bound.devices.length) return void placeholder(body, bound.hidden ? 'No data in your scope' : 'No machines match this data source.');
  const devices = cap.multiDevice ? bound.devices.slice(0, 10) : bound.devices.slice(0, 1);
  const endTs = Date.now();
  const startTs = endTs - rangeMs(s.timeRange ?? env.timeRange);
  const d0 = devices[0];
  const sub = (d: Node, ts: number) => `${w.binding.mode !== 'current' ? esc(d.label) + ' · ' : ''}${ago(ts)}`;

  if (w.type === 'value' || w.type === 'gauge' || w.type === 'status' || w.type === 'progress' || w.type === 'kpi') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const lv = (await api.latest(d0.id, [key]))[key];
    if (!lv) return void placeholder(body, `Not available on this device (${d0.label} doesn't report ${meta.displayName})`);
    const v = Number(lv.value);
    const unit = s.unit ?? meta.unit;
    const dec = s.decimals ?? meta.decimals;
    const rule = matchRule(rules, lv.value, key);
    const min = s.min ?? meta.min;
    const max = s.max ?? meta.max;

    if (w.type === 'value') {
      const vt = valueType(meta, lv.value);
      const shown = vt === 'number' ? fmtVal(lv.value, dec) : esc(rule?.label ?? stateLabel(lv.value, rules, meta, key));
      body.innerHTML = `<div class="dbb-value"><div><span class="v">${shown}</span>${vt === 'number' ? `<span class="u">${esc(unit)}</span>` : ''}</div>${vt === 'number' ? ruleLabelPill(rule) : ''}<div class="s">${sub(d0, lv.ts)}</div></div>`;
      return rule;
    }
    if (w.type === 'gauge') {
      gauge(body, v, { min, max, unit, decimals: dec, rules, key, sub: sub(d0, lv.ts), label: rule?.label ? `${unit} · ${rule.label}` : unit, valueColor: (s.colorTarget ?? 'background') === 'value' && rule ? rule.color : undefined });
      return (s.colorTarget ?? 'background') === 'value' ? null : rule;
    }
    if (w.type === 'progress') {
      const pct = Math.max(0, Math.min(100, ((v - min) / (max - min || 1)) * 100));
      const col = rule?.color ?? 'var(--accent)';
      const vert = s.orientation === 'vertical';
      const ticks = thresholdLines(rules, key)
        .filter((t) => t.value > min && t.value < max)
        .map((t) => {
          const p = ((t.value - min) / (max - min)) * 100;
          return vert ? `<span class="dbb-prog-tick" style="left:0;right:0;bottom:${p}%;height:2px" title="${esc(t.label ?? fmtNum(t.value, dec))}"></span>` : `<span class="dbb-prog-tick" style="top:0;bottom:0;left:${p}%;width:2px" title="${esc(t.label ?? fmtNum(t.value, dec))}"></span>`;
        })
        .join('');
      const txt = `<div class="dbb-value" style="height:auto"><div><span class="v">${fmtVal(lv.value, dec)}</span><span class="u">${esc(unit)}</span></div>${ruleLabelPill(rule)}<div class="s">${fmtNum(pct, 0)}% of ${fmtNum(max, 0)} ${esc(unit)} · ${ago(lv.ts)}</div></div>`;
      body.innerHTML = vert
        ? `<div class="dbb-prog vert"><div class="dbb-prog-track" style="width:${Math.max(28, Math.min(64, body.clientWidth / 4))}px;height:100%;border-radius:10px"><div class="dbb-prog-fill" style="width:100%;height:${pct}%;background:${col};border-radius:8px"></div>${ticks}</div>${txt}</div>`
        : `<div class="dbb-prog">${txt}<div class="dbb-prog-track" style="height:12px"><div class="dbb-prog-fill" style="height:100%;width:${pct}%;background:${col}"></div>${ticks}</div></div>`;
      return (s.colorTarget ?? 'background') === 'background' ? null : rule;
    }
    if (w.type === 'kpi') {
      const data = s.sparkline === false && s.compare === 'none' ? {} : await api.series(d0.id, [key], startTs, endTs, 'AVG', 120);
      const pts = (data as any)[key] ?? [];
      let delta = '';
      if (s.compare !== 'none' && pts.length > 1 && Number.isFinite(v)) {
        const first = pts[0].value;
        const ch = first ? ((v - first) / Math.abs(first)) * 100 : 0;
        const dir = Math.abs(ch) < 0.5 ? 'flat' : ch > 0 ? 'up' : 'down';
        const good = s.upIsGood === false ? (dir === 'up' ? 'down' : dir === 'down' ? 'up' : 'flat') : dir;
        delta = `<span class="dbb-delta ${good}" title="Change since the start of the time range">${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'} ${fmtNum(Math.abs(ch), 1)}%</span>`;
      }
      body.innerHTML = `<div class="dbb-kpi"><div class="dbb-value" style="height:auto"><div class="row"><span><span class="v">${fmtVal(lv.value, dec)}</span><span class="u">${esc(unit)}</span></span>${delta}</div>${ruleLabelPill(rule)}<div class="s">${sub(d0, lv.ts)} · vs ${esc(s.timeRange ?? env.timeRange)} ago</div></div>${s.sparkline !== false ? '<div class="dbb-spark"></div>' : ''}</div>`;
      const sp = body.querySelector('.dbb-spark') as HTMLElement | null;
      if (sp) requestAnimationFrame(() => sparkline(sp, pts, rule?.color ?? palette[0]));
      return rule;
    }
    // status
    const offline = Date.now() - lv.ts > 5 * 60e3;
    let label: string;
    let color: string;
    if (rules.length && s.colorRules?.length) {
      label = rule?.label ?? stateLabel(lv.value, rules, meta, key);
      color = rule?.color ?? STATUS.neutral;
    } else {
      const map = s.statusMap?.length
        ? s.statusMap
        : [
            { value: 1, label: meta.states?.['1'] ?? 'Running', color: STATUS.good },
            { value: 0, label: meta.states?.['0'] ?? 'Stopped', color: STATUS.neutral },
          ];
      const hit = map.find((m) => String(m.value) === String(lv.value) || Number(m.value) === v);
      label = hit?.label ?? String(lv.value);
      color = hit?.color ?? STATUS.neutral;
    }
    if (offline) {
      label = 'Offline';
      color = STATUS.neutral;
    }
    body.innerHTML = `<div class="dbb-value"><div class="dbb-pill" style="--pill:${color}"><span class="dbb-dot"></span>${esc(label)}</div><div class="s" style="margin-top:8px">${sub(d0, lv.ts)}</div></div>`;
    return s.colorTarget && s.colorTarget !== 'value' ? ({ op: 'eq', value: '', color } as ColorRule) : null;
  }

  if (w.type === 'multivalue') {
    const lv = await api.latest(d0.id, w.keys);
    body.innerHTML = `<div class="dbb-mv">${w.keys
      .map((k) => {
        const meta = keyMeta(ctx, d0.profile, k);
        const x = lv[k];
        const r = x ? matchRule(rules, x.value, k) : null;
        const vt = valueType(meta, x?.value);
        const val = !x ? '<span class="u" title="Not available on this device">—</span>' : vt === 'number' ? `${fmtVal(x.value, s.decimals ?? meta.decimals)}<span class="u">${esc(meta.unit)}</span>` : esc(r?.label ?? stateLabel(x.value, rules, meta, k));
        const colorText = r && s.colorTarget === 'value';
        return `<div class="dbb-mv-row"><span class="dbb-dot" style="background:${r?.color ?? 'var(--grid)'}"></span><span class="k" title="${esc(meta.displayName)}">${esc(meta.displayName)}</span><span class="v" ${colorText ? `style="color:${r!.color}"` : ''}>${val}</span>${r?.label && vt === 'number' ? `<span class="dbb-muted" style="font-size:11px;color:${r.color};font-weight:600">${esc(r.label)}</span>` : ''}</div>`;
      })
      .join('')}</div>`;
    return undefined;
  }

  if (w.type === 'summary') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const dec = s.decimals ?? meta.decimals;
    const unit = s.unit ?? meta.unit;
    const [mn, av, mx, lv] = await Promise.all([
      aggValue(d0.id, key, startTs, endTs, 'MIN'),
      aggValue(d0.id, key, startTs, endTs, 'AVG'),
      aggValue(d0.id, key, startTs, endTs, 'MAX'),
      api.latest(d0.id, [key]).then((l) => l[key]),
    ]);
    const cell = (k: string, v: number | string | null | undefined) => {
      const r = v == null ? null : matchRule(rules, v, key);
      return `<div><span class="k">${k}</span><span class="v" ${r ? `style="color:${r.color}"` : ''} title="${r?.label ? esc(r.label) : ''}">${v == null ? '—' : fmtVal(v, dec)}<span class="dbb-muted" style="font-weight:400"> ${esc(unit)}</span></span></div>`;
    };
    body.innerHTML = `<div class="dbb-sum">${cell('Min', mn)}${cell('Avg', av)}${cell('Max', mx)}${cell('Now', lv?.value ?? null)}</div>`;
    return undefined;
  }

  if (w.type === 'line' || w.type === 'area') {
    const agg = s.agg ?? 'AVG';
    const series: Parameters<typeof lineChart>[1] = [];
    let slot = 0;
    for (const d of devices) {
      const data = await api.series(d.id, w.keys, startTs, endTs, agg, 500);
      for (const k of w.keys) {
        if (series.length >= 10) break;
        const meta = keyMeta(ctx, d.profile, k);
        series.push({
          name: devices.length > 1 ? `${d.label} · ${meta.displayName}` : meta.displayName,
          color: palette[slot++ % palette.length],
          unit: s.unit ?? meta.unit,
          decimals: s.decimals ?? meta.decimals,
          points: data[k] ?? [],
        });
      }
    }
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    const thr = s.showThresholds === false ? [] : thresholdLines(rules, w.keys.length === 1 ? w.keys[0] : undefined).filter((t) => w.keys.length === 1 || !rules.some((r) => r.key));
    lineChart(body, series, { startTs, endTs, showLegend: s.showLegend, area: w.type === 'area', stacked: w.type === 'area' && !!s.stacked, smooth: s.smooth, thresholds: thr });
    if (bound.hidden) body.insertAdjacentHTML('beforeend', `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) not shown: no data in your scope</div>`);
    return undefined;
  }

  if (w.type === 'bar') {
    const key = w.keys[0];
    const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
    const group = s.groupBy ?? (devices.length > 1 ? 'device' : 'day');
    const meta = keyMeta(ctx, d0.profile, key);
    const dec = s.decimals ?? meta.decimals;
    const col = (v: number | null, fallback: string) => (v != null && matchRule(rules, v, key)?.color) || fallback;
    const thr = s.showThresholds === false ? [] : thresholdLines(rules, key);
    if (group === 'device') {
      const bars = await Promise.all(
        devices.map(async (d, i) => {
          const v = await aggValue(d.id, key, startTs, endTs, agg);
          return { label: d.label, value: v, color: col(v, palette[i % palette.length]), detail: `${d.label} · ${agg.toLowerCase()} ${meta.displayName}` };
        }),
      );
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec, thresholds: thr });
    } else {
      const step = group === 'hour' ? 3600e3 : 86400e3;
      const r = await api.get<any>(`/api/plugins/telemetry/DEVICE/${d0.id}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&agg=${agg}&interval=${step}&limit=1000&orderBy=ASC`);
      const pts: { ts: number; value: string }[] = r?.[key] ?? [];
      const bars = pts.map((p) => {
        const dt = new Date(p.ts);
        const label = group === 'hour' ? dt.toLocaleTimeString(undefined, { hour: '2-digit' }) : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return { label, value: Number(p.value), color: col(Number(p.value), palette[0]), detail: `${d0.label} · ${dt.toLocaleString()}` };
      });
      barChart(body, bars, { unit: s.unit ?? meta.unit, decimals: dec, thresholds: thr });
    }
    return undefined;
  }

  if (w.type === 'donut') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const mode = s.donutMode ?? (devices.length > 1 ? 'devices' : 'state');
    if (mode === 'devices') {
      const agg = s.agg && s.agg !== 'NONE' ? s.agg : 'AVG';
      const vals = await Promise.all(devices.map((d) => aggValue(d.id, key, startTs, endTs, agg)));
      const slices: Slice[] = devices.map((d, i) => ({ label: d.label, value: Math.max(0, vals[i] ?? 0), color: palette[i % palette.length], detail: `${d.label} · ${agg.toLowerCase()} ${meta.displayName}` }));
      donut(body, slices, { unit: s.unit ?? meta.unit, decimals: s.decimals ?? meta.decimals });
    } else {
      const pts = await rawSeries(d0.id, key, startTs, endTs);
      const segs = toSegments(pts, endTs);
      const by = new Map<string, number>();
      for (const g of segs) by.set(g.value, (by.get(g.value) ?? 0) + (g.end - g.start));
      const order: string[] = [];
      const slices: Slice[] = [...by.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([val, ms]) => ({ label: stateLabel(val, rules, meta, key), value: ms / 3600e3, color: stateColor(val, rules, key, order, palette), detail: `${stateLabel(val, rules, meta, key)} · ${fmtNum(ms / 3600e3, 1)} h` }));
      // merge slices that share a label (e.g. two raw values mapped to one rule)
      const merged = new Map<string, Slice>();
      for (const x of slices) {
        const m = merged.get(x.label);
        if (m) m.value += x.value;
        else merged.set(x.label, { ...x });
      }
      donut(body, [...merged.values()], { unit: 'h', decimals: 1 });
    }
    return undefined;
  }

  if (w.type === 'timeline') {
    const key = w.keys[0];
    const order: string[] = [];
    const legend = new Map<string, string>();
    const rows: TimelineRow[] = [];
    for (const d of devices) {
      const meta = keyMeta(ctx, d.profile, key);
      const pts = await rawSeries(d.id, key, startTs, endTs);
      rows.push({
        label: d.label,
        segments: toSegments(pts, endTs).map((g) => {
          const color = stateColor(g.value, rules, key, order, palette);
          const label = stateLabel(g.value, rules, meta, key);
          legend.set(label, color);
          return { start: g.start, end: g.end, color, label };
        }),
      });
    }
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    stateTimeline(body, devices.length > 1 ? rows : rows.map((r) => ({ ...r, label: '' })), { startTs, endTs, legend: [...legend.entries()].map(([label, color]) => ({ label, color })) });
    return undefined;
  }

  if (w.type === 'heatmap') {
    const key = w.keys[0];
    const meta = keyMeta(ctx, d0.profile, key);
    const r = await api.get<any>(`/api/plugins/telemetry/DEVICE/${d0.id}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&agg=${s.agg && s.agg !== 'NONE' ? s.agg : 'AVG'}&interval=3600000&limit=2000&orderBy=ASC`);
    const cells: HeatCell[] = (r?.[key] ?? []).map((p: any) => {
      const dt = new Date(p.ts);
      const day = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
      return { day, hour: dt.getHours(), value: Number(p.value) };
    });
    const ramp = s.heatColor === 'orange' ? RAMP_ORANGE : RAMP_BLUE;
    const useRules = s.heatColor === 'rules' && rules.length;
    heatmap(body, cells, {
      unit: s.unit ?? meta.unit,
      decimals: s.decimals ?? meta.decimals,
      legend: useRules ? undefined : ramp,
      colorOf: (v, lo, hi) => (useRules ? matchRule(rules, v, key)?.color ?? 'var(--grid)' : ramp[Math.min(ramp.length - 1, Math.floor(((v - lo) / (hi - lo || 1)) * ramp.length))]),
    });
    return undefined;
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
              .map((k, i) => {
                const x = v[k];
                if (!x) return '<td class="num"><span title="Not available on this device">—</span></td>';
                const r = matchRule(rules, x.value, k);
                const vt = valueType(metas[i], x.value);
                const txt = vt === 'number' ? fmtVal(x.value, s.decimals ?? metas[i].decimals) : esc(stateLabel(x.value, rules, metas[i], k));
                return `<td class="num">${r ? `<span class="cell" style="background:color-mix(in srgb, ${r.color} 18%, transparent);box-shadow:inset 3px 0 0 ${r.color}" title="${esc(r.label ?? '')}">${txt}</span>` : txt}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('') +
      `</tbody></table>${bound.hidden ? `<div class="dbb-ph" style="height:auto">${bound.hidden} machine(s) outside your scope not shown</div>` : ''}</div>`;
    return undefined;
  }

  if (w.type === 'alarms') {
    const lists = await Promise.all(devices.map((d) => api.alarms({ id: d.id, entityType: 'DEVICE' }, { status: s.alarmStatus ?? 'ANY', severities: s.severities, limit: s.maxRows ?? 20, startTs })));
    const all = lists
      .flat()
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, s.maxRows ?? 20);
    if (!all.length) return void (body.innerHTML = `<div class="dbb-ph"><span style="display:inline-flex;align-items:center;gap:6px;color:${STATUS.good}"><span style="width:18px;height:18px;display:inline-flex">${ICON_SVG.check}</span></span>&nbsp;No alarms in this time range</div>`);
    body.innerHTML =
      `<div class="dbb-scroll"><table class="dbb-table"><thead><tr><th>Time</th><th>Machine</th><th>Alarm</th><th>Severity</th><th>Status</th></tr></thead><tbody>` +
      all
        .map(
          (a) =>
            `<tr><td>${esc(new Date(a.startTs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td><td>${esc(
              ctx.nodes.get(a.originatorId)?.label ?? a.originatorLabel ?? a.originatorName,
            )}</td><td>${esc(a.type)}</td><td><span class="dbb-sev"><span class="dbb-dot" style="background:${SEVERITY_COLOR[a.severity] ?? STATUS.neutral}"></span>${esc(a.severity)}</span></td><td>${a.cleared ? 'Cleared' : 'Active'}${a.acknowledged ? ' · ack' : ''}</td></tr>`,
        )
        .join('') +
      `</tbody></table></div>`;
    return undefined;
  }
  return undefined;
}

async function drawText(body: HTMLElement, w: Widget, env: RenderEnv): Promise<undefined> {
  const s = w.settings;
  let html = s.html !== undefined ? sanitizeHtml(s.html) : miniMarkdown(s.markdown ?? w.title ?? '');
  if (/\{\{/.test(html)) {
    const values: Record<string, string> = {};
    const dev = env.deviceId ? env.ctx.nodes.get(env.deviceId) : null;
    values.time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    values.date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    if (dev) {
      values.machine = dev.label;
      values.type = dev.profile;
      values.location = dev.parentId ? env.ctx.nodes.get(dev.parentId)?.label ?? '' : '';
      const keys = placeholderKeys(html);
      if (keys.length) {
        const lv = await api.latest(dev.id, keys).catch(() => ({}) as api.Latest);
        for (const k of keys) {
          const x = lv[k];
          if (!x) continue;
          const meta = keyMeta(env.ctx, dev.profile, k);
          values[k] = valueType(meta, x.value) === 'number' ? `${fmtNum(x.value, meta.decimals)}${meta.unit ? ' ' + meta.unit : ''}` : stateLabel(x.value, undefined, meta, k);
        }
      }
    }
    html = fillPlaceholders(html, values);
  }
  body.innerHTML = `<div class="dbb-md">${html}</div>`;
  return undefined;
}

function drawLink(body: HTMLElement, w: Widget, env: RenderEnv): undefined {
  const s = w.settings;
  const st = s.style;
  const kind = s.linkKind ?? 'state';
  const color = s.buttonColor ?? 'var(--accent)';
  const ic = icon(st?.icon ?? (kind === 'url' ? 'link' : 'list'));
  const label = esc(w.title || 'Open');
  const cls = `dbb-go ${s.buttonStyle ?? 'filled'}`;
  const url = kind === 'url' ? safeUrl(s.url) : null;
  const inner = `${ic ? `<span class="ic" style="display:inline-flex">${ic}</span>` : ''}<span>${label}</span>`;
  if (kind === 'url')
    body.innerHTML = `<div class="dbb-linkw">${url && !env.editing ? `<a class="${cls}" style="--go:${color}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="${cls}" style="--go:${color}" aria-disabled="true" title="${url ? 'Links are disabled while editing' : 'Set an https:// address'}">${inner}</span>`}</div>`;
  else {
    body.innerHTML = `<div class="dbb-linkw"><button class="${cls}" style="--go:${color}" ${env.editing || !env.navigate ? 'aria-disabled="true"' : ''} title="${env.editing ? 'Buttons are disabled while editing' : ''}">${inner}</button></div>`;
    const btn = body.querySelector('button')!;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (env.editing || !env.navigate) return;
      const target = s.linkDevice === 'current' ? env.deviceId : s.linkDevice === 'location' ? (env.deviceId ? env.ctx.nodes.get(env.deviceId)?.parentId ?? null : null) : s.linkDevice || null;
      env.navigate(s.linkState || 'default', target);
    };
  }
  return undefined;
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
