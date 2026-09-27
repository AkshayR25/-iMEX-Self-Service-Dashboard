// Full-screen Dashboard Builder overlay. Opened from the navbar button (launcher widget).
import * as api from '../core/api';
import * as scope from '../core/scope';
import type { UserContext } from '../core/scope';
import * as store from '../core/store';
import * as chat from '../core/chat';
import { Dashboard, Widget, WidgetType, WIDGET_TYPES, WIDGET_LABELS, WIDGET_CAPS, WIDGET_GROUPS, CONTENT_TYPES, DEFAULT_SIZE, TIME_RANGES, HISTORIC_RANGES, MAX_WIDGETS, MAX_KEYS, MAX_DEVICES, normalizeRange, rangeLabel, checkDashboard, dashboardKind, newId } from '../core/schema';
import { Grid, GRID_CSS, firstFit, resolveCollisions } from '../render/grid';
import { CSS, ensureCss, esc, el, applyTheme, PRESETS, miniMarkdown as miniToHtml } from '../render/theme';
import { bindingLabel, defaultWidgets, keyMeta } from '../render/widgets';
import { WIDGET_ICON } from '../render/icons';
import { TEMPLATES } from '../render/templates';
import { richEditor, ruleEditor, styleEditor, themeEditor, initialRules } from './editors';
import { BUILDER_CSS } from './styles';
import { modal, confirmModal, toast } from './ui';
import { audit } from '../core/audit';
import { compatible, metaLookup, propKind } from '../core/compat';
import type { KeyMeta } from '../core/types';

export interface BuilderOptions {
  ctx: UserContext;
  deviceId?: string | null;
  dashboardId?: string | null;
  chatEnabled?: boolean;
  onClose?(changed: boolean): void;
}

const ICON = WIDGET_ICON as Record<WidgetType, string>;

/** One-line descriptions shown in the palette tooltip. */
const HELP: Record<WidgetType, string> = {
  value: 'Latest value of one property, coloured by rules',
  kpi: 'Big number with a trend sparkline and % change',
  gauge: 'Half-circle gauge with rule zones',
  progress: 'Horizontal or vertical (tank) level bar',
  status: 'Running / stopped / fault pill',
  multivalue: 'Several properties of one machine in one card',
  summary: 'Min, average, max and current over the time range',
  line: 'Trends of up to 10 series, with threshold lines',
  area: 'Filled trend; can stack series',
  bar: 'Per hour, per day or machine-by-machine bars',
  donut: 'Share of time in each state, or share by machine',
  timeline: 'When each machine was running, stopped or faulted',
  heatmap: 'Hour-of-day by day pattern of a property',
  table: 'Machines as rows, properties as columns, coloured cells',
  alarms: 'Alarm list with severity filters',
  text: 'Headings and notes with fonts, colours and live values',
  image: 'Logo, photo or diagram from an address or upload',
  link: 'Button that opens a page of the app or a website',
  embed: 'Another web page inside the dashboard',
};

export function openBuilder(o: BuilderOptions) {
  // Building is admin-only (scope decision 27 Sep 2026). UI-level check; see DECISIONS D-012.
  if (!o.ctx.isAdmin) throw new Error('Only admins can build dashboards.');
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-grid', GRID_CSS);
  ensureCss('dbb-css-builder', BUILDER_CSS);
  const b = new Builder(o);
  b.mount();
  return b;
}

class Builder {
  ctx: UserContext;
  root!: HTMLElement;
  grid: Grid | null = null;
  deviceId: string | null;
  draft: Dashboard;
  baseline = '';
  selected: string | null = null;
  undo: string[] = [];
  redo: string[] = [];
  preview = false;
  tab: 'settings' | 'style' | 'rules' | 'chat' = 'settings';
  palFilter = '';
  quietAt = 0;
  quietKey = '';
  chatLog: { role: 'user' | 'assistant' | 'system'; text: string; changed?: chat.ChatResult['changed']; options?: string[] }[] = [];
  chatHistory: chat.Turn[] = [];
  preChat: string | null = null;
  pendingApply: chat.ApplyProposal | null = null;
  highlight = new Set<string>();
  busy = false;
  savedAnything = false;
  source: store.Resolved | null = null;
  usageInfo: { devices: string[]; customised: string[] } | null = null;
  keyHandler = (e: KeyboardEvent) => this.onKey(e);
  unloadHandler = (e: BeforeUnloadEvent) => {
    if (this.dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  constructor(private o: BuilderOptions) {
    this.ctx = o.ctx;
    this.deviceId = o.deviceId && this.ctx.nodes.has(o.deviceId) ? o.deviceId : null;
    this.draft = store.blankDashboard(this.ctx, 'Untitled dashboard', this.deviceId ? this.ctx.nodes.get(this.deviceId)!.profile : null);
    this.baseline = JSON.stringify(this.draft);
  }

  // ---------- lifecycle ----------

  mount() {
    this.root = el('div', { class: 'dbb-root dbb-overlay', role: 'dialog', 'aria-label': 'Dashboard Builder' });
    document.body.appendChild(this.root);
    document.addEventListener('keydown', this.keyHandler);
    window.addEventListener('beforeunload', this.unloadHandler);
    this.renderShell();
    if (this.o.dashboardId) void this.openDashboard(this.o.dashboardId);
    else if (this.deviceId) void this.selectMachine(this.deviceId);
    else this.renderAll();
  }

  async close() {
    if (this.dirty() && !(await confirmModal(this.root, 'Discard unsaved changes?', 'You have changes that are not saved.', 'Discard', true))) return;
    document.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('beforeunload', this.unloadHandler);
    this.grid?.destroy();
    this.root.remove();
    this.o.onClose?.(this.savedAnything);
  }

  dirty() {
    return JSON.stringify(this.draft) !== this.baseline && this.draft.widgets.length > 0;
  }

  // ---------- state changes ----------

  commit(next: Dashboard, opts: { keepRedo?: boolean } = {}) {
    this.undo.push(JSON.stringify(this.draft));
    if (this.undo.length > 50) this.undo.shift();
    if (!opts.keepRedo) this.redo = [];
    next.kind = dashboardKind(next.widgets);
    this.draft = next;
    this.renderAll();
  }

  mutate(fn: (d: Dashboard) => void) {
    const d: Dashboard = JSON.parse(JSON.stringify(this.draft));
    fn(d);
    this.commit(d);
  }

  undoLast() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(prev);
    if (this.selected && !this.draft.widgets.some((w) => w.id === this.selected)) this.selected = null;
    this.renderAll();
  }

  redoLast() {
    const nxt = this.redo.pop();
    if (!nxt) return;
    this.undo.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(nxt);
    this.renderAll();
  }

  onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redoLast() : this.undoLast();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected && !this.preview) {
      e.preventDefault();
      this.removeWidget(this.selected);
    } else if (e.key === 'Escape' && !this.root.querySelector('.dbb-modal')) {
      void this.close();
    }
  }

  // ---------- machine / dashboard selection ----------

  async selectMachine(id: string | null) {
    if (this.dirty() && !(await confirmModal(this.root, 'Switch machine?', 'Unsaved changes to the current dashboard will be lost.', 'Switch', true))) {
      this.renderTop();
      return;
    }
    this.deviceId = id;
    this.source = null;
    this.usageInfo = null;
    const node = id ? this.ctx.nodes.get(id) : null;
    this.setBusy(true, 'Loading…');
    try {
      if (node) {
        this.source = await store.resolveForDevice(this.ctx, node.id, node.profile);
        if (this.source.dashboard) {
          this.loadDraft(this.source.dashboard);
          void this.loadUsage();
        } else this.loadDraft(store.blankDashboard(this.ctx, `${node.profile} dashboard`, node.profile));
      } else this.loadDraft(store.blankDashboard(this.ctx, 'Untitled dashboard', null));
    } catch (e: any) {
      toast(this.root, `Could not load: ${e.message}`, 'err');
    } finally {
      this.setBusy(false);
    }
  }

  async openDashboard(id: string) {
    this.setBusy(true, 'Loading…');
    try {
      const d = await store.getDashboard(this.ctx, id);
      if (!d) throw new Error('Dashboard not found.');
      if (d.profile && (!this.deviceId || this.ctx.nodes.get(this.deviceId)?.profile !== d.profile)) {
        this.deviceId = scope.allDevices(this.ctx, d.profile)[0]?.id ?? null;
      }
      if (this.deviceId) {
        const n = this.ctx.nodes.get(this.deviceId)!;
        this.source = await store.resolveForDevice(this.ctx, n.id, n.profile).catch(() => null);
      }
      this.loadDraft(d);
      void this.loadUsage();
    } catch (e: any) {
      toast(this.root, e.message, 'err');
    } finally {
      this.setBusy(false);
    }
  }

  loadDraft(d: Dashboard) {
    this.draft = JSON.parse(JSON.stringify(d));
    this.baseline = JSON.stringify(this.draft);
    this.undo = [];
    this.redo = [];
    this.selected = null;
    this.preChat = null;
    this.chatLog = [];
    this.chatHistory = [];
    this.renderAll();
  }

  async loadUsage() {
    if (this.draft.version === 0 || !this.draft.profile) {
      this.usageInfo = null;
      return this.renderBanner();
    }
    try {
      this.usageInfo = await store.usage(this.ctx, this.draft);
    } catch {
      this.usageInfo = null;
    }
    this.renderBanner();
  }

  // ---------- widgets ----------

  addWidget(type: WidgetType, at?: { x: number; y: number }) {
    if (this.draft.widgets.length >= MAX_WIDGETS) return toast(this.root, `A dashboard can have at most ${MAX_WIDGETS} widgets.`, 'warn');
    const size = DEFAULT_SIZE[type];
    const profile = this.draft.profile ?? (this.deviceId ? this.ctx.nodes.get(this.deviceId)?.profile ?? null : null);
    const metas = profile ? this.ctx.profileKeys[profile] ?? [] : [];
    const keys = metas.map((k) => k.key);
    const content = CONTENT_TYPES.has(type);
    const mode = type === 'donut' ? 'state' : undefined;
    const ok = metas.filter((m) => compatible(type, m, { donutMode: mode }).ok);
    if (!content && type !== 'alarms' && profile && metas.length && !ok.length) return toast(this.root, this.paletteBlock(type) ?? `No property of ${profile} fits this widget.`, 'warn');
    const firstKey = (ok.find((m) => !/hours/i.test(m.key)) ?? ok[0])?.key;
    const statusKey = ok.find((m) => compatible('status', m).ok)?.key;
    const w: Widget = {
      id: newId(),
      type,
      title: type === 'text' ? '' : type === 'link' ? 'Open machine listing' : type === 'image' || type === 'embed' ? '' : WIDGET_LABELS[type],
      x: 0,
      y: 0,
      w: size.w,
      h: size.h,
      binding: content ? { mode: 'none' } : this.deviceId ? { mode: 'current' } : { mode: 'none' },
      keys: WIDGET_CAPS[type].keys[1] === 0 || !firstKey || !this.deviceId ? [] : type === 'multivalue' ? keys.slice(0, MAX_KEYS) : [firstKey],
      settings:
        type === 'text'
          ? { html: '<h2>Heading</h2><p>Write something here. Insert live values like {{machine}}.</p>' }
          : type === 'alarms'
            ? { alarmStatus: 'ANY', maxRows: 10 }
            : type === 'link'
              ? { linkKind: 'state', linkState: 'listing', linkDevice: 'location', buttonStyle: 'filled' }
              : type === 'area'
                ? { smooth: true }
                : type === 'kpi'
                  ? { sparkline: true }
                  : {},
    };
    if (firstKey && firstKey === statusKey && ['status', 'timeline', 'donut'].includes(type))
      w.settings.colorRules = [
        { op: 'isTrue', color: '#0ca30c', label: 'Running' },
        { op: 'isFalse', color: '#8a8983', label: 'Stopped' },
      ];
    if (w.keys.length === 1 && profile && !content) w.title = keyMeta(this.ctx, profile, w.keys[0]).displayName + (type === 'timeline' ? ' · timeline' : type === 'heatmap' ? ' · heatmap' : '');
    if (at) {
      w.x = Math.min(at.x, 12 - w.w);
      w.y = at.y;
    } else {
      const p = firstFit(this.draft.widgets, w.w, w.h);
      w.x = p.x;
      w.y = p.y;
    }
    this.mutate((d) => {
      if (!d.profile && profile && w.binding.mode === 'current') d.profile = profile;
      d.widgets.push(w);
    });
    // resolve overlaps from a drop position
    if (at) {
      this.draft.widgets = resolveCollisions(this.draft.widgets, w.id) as Widget[];
      this.renderAll();
    }
    this.selected = w.id;
    this.tab = 'settings';
    this.renderAll();
  }

  removeWidget(id: string) {
    this.mutate((d) => (d.widgets = d.widgets.filter((w) => w.id !== id)));
    if (this.selected === id) this.selected = null;
    this.renderAll();
  }

  updateWidget(id: string, fn: (w: Widget) => void) {
    this.mutate((d) => {
      const w = d.widgets.find((x) => x.id === id);
      if (w) fn(w);
    });
  }

  /**
   * Update from a sub-editor (rich text, rules, style, theme): redraws the canvas but keeps the
   * right panel (so colour pickers and the text editor keep focus). Rapid edits from the same
   * source coalesce into one undo step.
   */
  quiet(tag: string, fn: (d: Dashboard) => void, opts: { panel?: boolean } = {}) {
    const d: Dashboard = JSON.parse(JSON.stringify(this.draft));
    fn(d);
    const now = Date.now();
    if (!(tag === this.quietKey && now - this.quietAt < 1500)) {
      this.undo.push(JSON.stringify(this.draft));
      if (this.undo.length > 50) this.undo.shift();
    }
    this.quietKey = tag;
    this.quietAt = now;
    this.redo = [];
    d.kind = dashboardKind(d.widgets);
    this.draft = d;
    this.renderTop();
    this.renderCanvas();
    if (opts.panel) this.renderRight();
  }

  quietWidget(id: string, tag: string, fn: (w: Widget) => void, opts: { panel?: boolean } = {}) {
    this.quiet(`${id}:${tag}`, (d) => {
      const w = d.widgets.find((x) => x.id === id);
      if (w) fn(w);
    }, opts);
  }

  // ---------- rendering ----------

  renderShell() {
    this.root.innerHTML = `
      <div class="dbb-top"></div>
      <div class="dbb-banner-row"></div>
      <div class="dbb-main">
        <aside class="dbb-left"></aside>
        <section class="dbb-center"><div class="dbb-empty"></div><div class="dbb-canvas"></div></section>
        <aside class="dbb-right"></aside>
      </div>
      <div class="dbb-busy" hidden><div class="dbb-spin"></div><span></span></div>`;
  }

  renderAll() {
    this.renderTop();
    this.renderBanner();
    this.renderLeft();
    this.renderCanvas();
    this.renderRight();
  }

  setBusy(on: boolean, label = '') {
    this.busy = on;
    const b = this.root.querySelector('.dbb-busy') as HTMLElement;
    if (!b) return;
    b.hidden = !on;
    (b.querySelector('span') as HTMLElement).textContent = label;
  }

  machineOptions(): string {
    const devices = scope.allDevices(this.ctx).sort((a, b) => scope.pathLabel(this.ctx, a.id).localeCompare(scope.pathLabel(this.ctx, b.id)));
    const groups = new Map<string, scope.Node[]>();
    for (const d of devices) {
      const p = d.parentId ? scope.pathLabel(this.ctx, d.parentId) : '—';
      groups.set(p, [...(groups.get(p) ?? []), d]);
    }
    let html = `<option value="">No machine (standalone dashboard)</option>`;
    for (const [g, ds] of groups)
      html += `<optgroup label="${esc(g)}">${ds.map((d) => `<option value="${d.id}" ${d.id === this.deviceId ? 'selected' : ''}>${esc(d.label)} · ${esc(d.profile)}</option>`).join('')}</optgroup>`;
    return html;
  }

  renderBanner() {
    const row = this.root.querySelector('.dbb-banner-row') as HTMLElement;
    const parts: string[] = [];
    for (const w of this.ctx.warnings) parts.push(`<div class="dbb-banner warn">${esc(w)}</div>`);
    if (this.source && this.deviceId) {
      const n = this.ctx.nodes.get(this.deviceId)!;
      if (this.source.dashboard && this.source.dashboard.id === this.draft.id)
        parts.push(`<div class="dbb-banner">Editing what <b>${esc(n.label)}</b> shows now · From: ${esc(this.source.sourceLabel)}</div>`);
      else if (!this.source.dashboard && this.draft.version === 0) parts.push(`<div class="dbb-banner">${esc(n.label)} has no dashboard assigned yet; it shows the default layout.</div>`);
    }
    if (this.usageInfo && this.draft.version > 0) {
      if (this.usageInfo.devices.length > 1)
        parts.push(`<div class="dbb-banner">Used by ${this.usageInfo.devices.length} machines. Saving changes updates all of them.</div>`);
      if (this.usageInfo.customised.length)
        parts.push(
          `<div class="dbb-banner warn">${this.usageInfo.customised.length} machine${this.usageInfo.customised.length > 1 ? 's have' : ' has'} customised versions and won't be updated: ${esc(this.usageInfo.customised.join(', '))}</div>`,
        );
    }
    if (this.draft.copiedFrom) parts.push(`<div class="dbb-banner">This is a machine-specific copy; it no longer follows its template.</div>`);
    row.innerHTML = parts.join('');
    row.hidden = !parts.length;
  }

  renderTop() {
    const top = this.root.querySelector('.dbb-top') as HTMLElement;
    const d = this.draft;
    const canDelete = d.version > 0 && (d.ownerId === this.ctx.userId || this.ctx.isAdmin);
    const U = (p: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
    top.innerHTML = `
      <div class="dbb-brand"><span class="dbb-logo">${U('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>')}</span><span>Dashboard Builder</span></div>
      <label class="dbb-field"><span>Machine</span><select data-a="machine">${this.machineOptions()}</select></label>
      <label class="dbb-field grow"><span>Dashboard name</span><input data-a="name" maxlength="120" value="${esc(d.name)}"/></label>
      <div class="dbb-field"><span>Time range</span><div class="dbb-range"><div class="dbb-seg sm" role="radiogroup" aria-label="Time range">
        <button data-rng="realtime" class="${d.timeRange === 'realtime' ? 'on' : ''}" title="Latest values, updated every 10 s. Charts show a rolling last hour."><span class="dbb-live"></span>Realtime</button>
        <button data-rng="hist" class="${d.timeRange !== 'realtime' ? 'on' : ''}" title="A fixed window ending now: 1 to 8 hours">Historic</button></div>
        ${d.timeRange !== 'realtime' ? `<select data-a="range" aria-label="Historic duration">${HISTORIC_RANGES.map((r) => `<option value="${r}" ${r === d.timeRange ? 'selected' : ''}>Last ${r.replace('h', ' h')}</option>`).join('')}</select>` : ''}</div></div>
      <div class="dbb-tools">
        <button class="dbb-btn" data-a="open" title="Open an existing dashboard">${U('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}Open</button>
        <button class="dbb-btn" data-a="templates" title="Start from a template">${U('<path d="M12 3l2.4 5 5.6.8-4 3.9 1 5.5L12 15.6 7 18.2l1-5.5-4-3.9 5.6-.8z"/>')}Templates</button>
        <span class="dbb-vsep"></span>
        <button class="dbb-btn icon" data-a="undo" title="Undo (Ctrl+Z)" ${this.undo.length ? '' : 'disabled'}>${U('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>')}</button>
        <button class="dbb-btn icon" data-a="redo" title="Redo (Ctrl+Shift+Z)" ${this.redo.length ? '' : 'disabled'}>${U('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>')}</button>
        <button class="dbb-btn ${this.preview ? 'on' : ''}" data-a="preview">${U(this.preview ? '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>' : '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>')}${this.preview ? 'Edit' : 'Preview'}</button>
        ${d.version > 0 ? `<button class="dbb-btn icon" data-a="versions" title="Version history">${U('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}</button>` : ''}
        ${canDelete ? `<button class="dbb-btn icon danger" data-a="delete" title="Delete dashboard">${U('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>')}</button>` : ''}
        ${d.version > 0 ? `<button class="dbb-btn" data-a="saveas">Save as</button>` : ''}
        ${d.version > 0 ? `<button class="dbb-btn" data-a="apply">Apply to…</button>` : ''}
        <button class="dbb-btn primary" data-a="save">${this.dirty() || d.version === 0 ? 'Save' : '✓ Saved'}</button>
        <button class="dbb-btn icon" data-a="close" title="Close (Esc)" aria-label="Close">${U('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
      </div>`;
    const q = (a: string) => top.querySelector(`[data-a="${a}"]`) as HTMLElement;
    (q('machine') as HTMLSelectElement).onchange = (e) => void this.selectMachine((e.target as HTMLSelectElement).value || null);
    (q('name') as HTMLInputElement).onchange = (e) => this.mutate((x) => (x.name = (e.target as HTMLInputElement).value.trim() || 'Untitled dashboard'));
    q('range')?.addEventListener('change', (e) => this.mutate((x) => (x.timeRange = normalizeRange((e.target as HTMLSelectElement).value))));
    top.querySelectorAll<HTMLElement>('[data-rng]').forEach((b) =>
      b.addEventListener('click', () => {
        const next = b.dataset.rng === 'realtime' ? 'realtime' : this.draft.timeRange === 'realtime' ? '1h' : this.draft.timeRange;
        if (next !== this.draft.timeRange) this.mutate((x) => (x.timeRange = next));
      }),
    );
    q('undo').onclick = () => this.undoLast();
    q('redo').onclick = () => this.redoLast();
    q('preview').onclick = () => {
      this.preview = !this.preview;
      this.selected = null;
      this.renderAll();
    };
    q('open').onclick = () => void this.openDialog();
    q('templates').onclick = () => void this.templatesDialog();
    q('save').onclick = () => void this.save(false);
    q('close').onclick = () => void this.close();
    q('saveas')?.addEventListener('click', () => void this.save(true));
    q('apply')?.addEventListener('click', () => void this.applyDialog());
    q('versions')?.addEventListener('click', () => void this.versionsDialog());
    q('delete')?.addEventListener('click', () => void this.deleteDialog());
  }

  renderLeft() {
    const left = this.root.querySelector('.dbb-left') as HTMLElement;
    left.hidden = this.preview;
    const f = this.palFilter.trim().toLowerCase();
    const match = (t: WidgetType) => !f || WIDGET_LABELS[t].toLowerCase().includes(f) || HELP[t].toLowerCase().includes(f);
    left.innerHTML = `<div class="dbb-pal-search"><input type="search" placeholder="Search widgets" value="${esc(this.palFilter)}" aria-label="Search widgets"/></div>
      ${WIDGET_GROUPS.map((g) => {
        const ts = g.types.filter(match);
        if (!ts.length) return '';
        return `<div class="dbb-sec">${esc(g.title)}</div><div class="dbb-palette">${ts
          .map((t) => {
            const why = this.paletteBlock(t);
            return why
              ? `<button class="dbb-pal off" data-t="${t}" aria-disabled="true" title="${esc(why)}">${ICON[t]}<span>${WIDGET_LABELS[t]}</span></button>`
              : `<button class="dbb-pal" draggable="true" data-t="${t}" title="${esc(HELP[t])} — drag onto the canvas or click to add">${ICON[t]}<span>${WIDGET_LABELS[t]}</span></button>`;
          })
          .join('')}</div>`;
      }).join('') || '<div class="dbb-hint">No widget matches.</div>'}
      <div class="dbb-count ${this.draft.widgets.length >= MAX_WIDGETS ? 'full' : ''}">${this.draft.widgets.length} / ${MAX_WIDGETS} widgets on this page</div>`;
    const inp = left.querySelector('.dbb-pal-search input') as HTMLInputElement;
    inp.oninput = () => {
      this.palFilter = inp.value;
      const pos = inp.selectionStart;
      this.renderLeft();
      const n = this.root.querySelector('.dbb-pal-search input') as HTMLInputElement;
      n.focus();
      n.setSelectionRange(pos, pos);
    };
    left.querySelectorAll<HTMLElement>('.dbb-pal.off').forEach((p) => (p.onclick = () => toast(this.root, p.title, 'warn')));
    left.querySelectorAll<HTMLElement>('.dbb-pal:not(.off)').forEach((p) => {
      p.ondragstart = (e) => {
        e.dataTransfer!.setData('text/dbb-widget', p.dataset.t!);
        e.dataTransfer!.effectAllowed = 'copy';
      };
      p.onclick = () => this.addWidget(p.dataset.t as WidgetType);
    });
  }

  renderCanvas() {
    const canvas = this.root.querySelector('.dbb-canvas') as HTMLElement;
    const center = this.root.querySelector('.dbb-center') as HTMLElement;
    const empty = this.root.querySelector('.dbb-empty') as HTMLElement;
    const themeSig = JSON.stringify(this.draft.theme ?? {});
    const { dark } = applyTheme(center, this.draft.theme);
    const env = { ctx: this.ctx, deviceId: this.deviceId, timeRange: this.draft.timeRange, theme: this.draft.theme ?? null, dark, editing: true };
    if (!this.grid) {
      this.grid = new Grid(canvas, env, {
        editable: true,
        onSelect: (id) => {
          if (this.preview) return;
          const was = this.selected;
          this.selected = id;
          if (id && !was && this.tab === 'chat') this.tab = 'settings';
          this.grid!.setOptions({ selectedId: id });
          this.renderRight();
        },
        onChange: (ws) => this.mutate((d) => (d.widgets = ws as Widget[])),
        onDrop: (t, x, y) => this.addWidget(t as WidgetType, { x, y }),
        onAction: (id, a) => (a === 'del' ? this.removeWidget(id) : this.duplicate(id)),
      });
      (this.grid as any).__theme = themeSig;
    }
    canvas.classList.toggle('preview', this.preview);
    this.grid.setOptions({ selectedId: this.selected, highlight: this.highlight });
    const g = this.grid as any;
    const envChanged = g.env?.deviceId !== this.deviceId || g.env?.timeRange !== this.draft.timeRange || g.__theme !== themeSig;
    g.__theme = themeSig;
    if (envChanged) this.grid.setEnv(env);
    this.grid.render(this.draft.widgets);
    empty.hidden = this.draft.widgets.length > 0;
    if (!this.draft.widgets.length) {
      const n = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
      const tpls = n ? TEMPLATES.slice(0, 4) : [];
      empty.innerHTML = `<div class="dbb-empty-card">
        <div class="dbb-empty-t">${n ? `Design a dashboard for ${esc(n.label)}` : 'Start a dashboard'}</div>
        <div class="dbb-empty-s">${n ? `Widgets set to <b>This machine</b> follow whichever ${esc(n.profile)} the dashboard is opened for.` : 'Pick a machine at the top to build a reusable machine dashboard, or build a standalone one from specific machines.'}</div>
        ${tpls.length ? `<div class="dbb-tpl-grid mini">${tpls.map((t) => this.tplCard(t)).join('')}</div>` : ''}
        <div class="dbb-empty-a">
          ${n ? `<button class="dbb-btn" data-a="default">Simple default layout</button><button class="dbb-btn" data-a="alltpl">All templates…</button>` : ''}
          ${this.o.chatEnabled !== false ? `<button class="dbb-btn" data-a="chat">Describe it in chat</button>` : ''}
        </div>
        <div class="dbb-empty-s">…or drag widgets from the left.</div></div>`;
      empty.querySelector<HTMLElement>('[data-a="default"]')?.addEventListener('click', () => {
        const p = n!.profile;
        this.mutate((d) => {
          d.profile = p;
          d.widgets = defaultWidgets(this.ctx, p).map((w) => ({ ...w, id: newId() }));
        });
      });
      empty.querySelector<HTMLElement>('[data-a="alltpl"]')?.addEventListener('click', () => void this.templatesDialog());
      empty.querySelectorAll<HTMLElement>('[data-tpl]').forEach((b) => b.addEventListener('click', () => this.useTemplate(b.dataset.tpl!)));
      empty.querySelector<HTMLElement>('[data-a="chat"]')?.addEventListener('click', () => {
        this.tab = 'chat';
        this.renderRight();
        (this.root.querySelector('.dbb-chat-in') as HTMLTextAreaElement)?.focus();
      });
    }
    const cnt = this.root.querySelector('.dbb-count');
    if (cnt) {
      cnt.textContent = `${this.draft.widgets.length} / ${MAX_WIDGETS} widgets on this page`;
      cnt.classList.toggle('full', this.draft.widgets.length >= MAX_WIDGETS);
    }
    if (this.palFull !== this.draft.widgets.length >= MAX_WIDGETS) this.renderLeft();
  }

  palFull = false;

  /** Why a palette widget can't be added right now (page full, or no property of this machine type fits), or null. */
  paletteBlock(t: WidgetType): string | null {
    this.palFull = this.draft.widgets.length >= MAX_WIDGETS;
    if (this.palFull) return `This page already has ${MAX_WIDGETS} widgets (the limit, to keep it fast). Remove one to add another.`;
    if (CONTENT_TYPES.has(t) || t === 'alarms') return null;
    const profile = this.draft.profile ?? (this.deviceId ? this.ctx.nodes.get(this.deviceId)?.profile ?? null : null);
    const metas = profile ? this.ctx.profileKeys[profile] ?? [] : [];
    if (!metas.length) return null;
    const fits = metas.some((m) => compatible(t, m, { donutMode: t === 'donut' ? 'state' : undefined }).ok || (t === 'donut' && compatible(t, m, { donutMode: 'devices' }).ok));
    if (fits) return null;
    const c = compatible(t, metas[0], { donutMode: 'state' });
    return `${WIDGET_LABELS[t]} isn't available for ${profile}: ${c.reason?.split(';')[0].replace(WIDGET_LABELS[t] + ' needs', 'it needs')} and no ${profile} property is one.`;
  }

  duplicate(id: string) {
    const w = this.draft.widgets.find((x) => x.id === id);
    if (!w) return;
    if (this.draft.widgets.length >= MAX_WIDGETS) return toast(this.root, `A dashboard can have at most ${MAX_WIDGETS} widgets.`, 'warn');
    const c: Widget = JSON.parse(JSON.stringify(w));
    c.id = newId();
    const p = firstFit(this.draft.widgets, c.w, c.h);
    c.x = p.x;
    c.y = p.y;
    this.mutate((d) => d.widgets.push(c));
    this.selected = c.id;
    this.renderAll();
  }

  tplCard(t: (typeof TEMPLATES)[number]): string {
    const [a, b, c] = t.swatch;
    return `<button class="dbb-tpl" data-tpl="${t.id}" title="${esc(t.description)}">
      <span class="pv" style="background:${a}"><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface};grid-column:1/3"><b style="background:${b}"></b></i><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface}"><b style="background:${c}"></b></i><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface};grid-column:1/4"><b style="background:${b};width:70%"></b></i></span>
      <span class="nm">${esc(t.name)}</span><span class="ds">${esc(t.description)}</span></button>`;
  }

  async useTemplate(id: string) {
    const t = TEMPLATES.find((x) => x.id === id);
    const n = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
    if (!t) return;
    if (!n) return toast(this.root, 'Pick a machine at the top first; templates adapt to its properties.', 'warn');
    if (this.draft.widgets.length && !(await confirmModal(this.root, `Use “${t.name}”?`, 'This replaces the widgets and theme of the current draft. You can undo it.', 'Use template'))) return;
    const ws = t.build(this.ctx, n.profile, n.id);
    if (!ws.length) return toast(this.root, `${n.profile} has no suitable properties for this template.`, 'warn');
    this.mutate((d) => {
      d.profile = n.profile;
      d.widgets = ws;
      d.theme = { ...t.theme };
      d.timeRange = t.timeRange;
      if (!d.version && (/^(Untitled|.* dashboard)$/.test(d.name) || TEMPLATES.some((x) => d.name === `${n.profile} · ${x.name}`))) d.name = `${n.profile} · ${t.name}`;
    });
    this.selected = null;
    this.renderAll();
    toast(this.root, `Started from “${t.name}”. Everything is editable.`, 'ok');
  }

  async templatesDialog() {
    const n = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
    const m = modal(
      this.root,
      'Start from a template',
      `${n ? `<div class="dbb-hint">Templates adapt to the properties of <b>${esc(n.profile)}</b> machines. You can change everything afterwards.</div>` : `<div class="dbb-banner warn">Pick a machine at the top first; templates adapt to its properties.</div>`}
       <div class="dbb-tpl-grid">${TEMPLATES.map((t) => this.tplCard(t)).join('')}</div>`,
      [['cancel', 'Close']],
    );
    m.body.querySelectorAll<HTMLElement>('[data-tpl]').forEach((b) =>
      b.addEventListener('click', () => {
        m.close('pick');
        void this.useTemplate(b.dataset.tpl!);
      }),
    );
  }

  renderRight() {
    const right = this.root.querySelector('.dbb-right') as HTMLElement;
    right.hidden = this.preview;
    const chatOn = this.o.chatEnabled !== false;
    const w = this.draft.widgets.find((x) => x.id === this.selected);
    if (!w && (this.tab === 'style' || this.tab === 'rules')) this.tab = 'settings';
    const dataW = w && !CONTENT_TYPES.has(w.type) && w.type !== 'alarms';
    if (w && this.tab === 'rules' && !dataW) this.tab = 'settings';
    const tabs: [string, string][] = w
      ? [
          ['settings', 'Widget'],
          ['style', 'Style'],
          ...(dataW ? ([['rules', 'Colours']] as [string, string][]) : []),
        ]
      : [['settings', 'Dashboard']];
    if (chatOn) tabs.push(['chat', 'Chat']);
    right.innerHTML = `${w ? `<div class="dbb-sel-h"><span class="ic">${ICON[w.type]}</span><div><div class="t">${esc(w.title || WIDGET_LABELS[w.type])}</div><div class="s">${WIDGET_LABELS[w.type]}</div></div><button class="dbb-btn icon sm" data-desel title="Back to dashboard settings">✕</button></div>` : ''}
      <div class="dbb-tabs">${tabs.map(([k, l]) => `<button class="dbb-tab ${this.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div><div class="dbb-panel"></div>`;
    right.querySelectorAll<HTMLElement>('.dbb-tab').forEach((t) => (t.onclick = () => ((this.tab = t.dataset.tab as any), this.renderRight())));
    right.querySelector('[data-desel]')?.addEventListener('click', () => {
      this.selected = null;
      this.grid?.setOptions({ selectedId: null });
      this.renderRight();
    });
    const panel = right.querySelector('.dbb-panel') as HTMLElement;
    if (this.tab === 'chat' && chatOn) this.renderChat(panel);
    else if (!w) this.renderTheme(panel);
    else if (this.tab === 'style') this.renderStyle(panel, w);
    else if (this.tab === 'rules') this.renderRules(panel, w);
    else this.renderSettings(panel);
  }

  renderTheme(panel: HTMLElement) {
    themeEditor(panel, this.draft.theme, (t) => {
      this.quiet('theme', (d) => {
        if (t) d.theme = t;
        else delete d.theme;
      });
      this.renderRight();
    }, { onTemplates: () => void this.templatesDialog() });
  }

  renderStyle(panel: HTMLElement, w: Widget) {
    styleEditor(panel, {
      widget: w,
      onChange: (style, extra) => {
        this.quietWidget(w.id, 'style', (x) => {
          if (style) x.settings.style = style;
          else delete x.settings.style;
          if (extra) for (const [k, v] of Object.entries(extra)) v === undefined ? delete (x.settings as any)[k] : ((x.settings as any)[k] = v);
        });
        this.renderRight();
      },
      onCopyToAll: () => {
        const st = w.settings.style;
        this.mutate((d) => d.widgets.forEach((x) => (st ? (x.settings.style = { ...st, icon: x.settings.style?.icon }) : delete x.settings.style)));
        toast(this.root, 'Style copied to every widget (icons kept).', 'ok');
      },
      descriptionHost: (el) =>
        richEditor(el, {
          html: w.settings.description ?? '',
          minHeight: 60,
          onChange: (html) =>
            this.quietWidget(w.id, 'desc', (x) => {
              const txt = html.replace(/<[^>]+>/g, '').trim();
              if (txt) x.settings.description = html;
              else delete x.settings.description;
            }),
        }),
    });
  }

  async renderRules(panel: HTMLElement, w: Widget) {
    const profs = this.profilesForBinding(w);
    const metas = (w.keys.length ? w.keys : []).map((k) => keyMeta(this.ctx, profs[0] ?? '', k));
    if (!metas.length) {
      panel.innerHTML = `<div class="dbb-hint">Choose a property in the Widget tab first.</div>`;
      return;
    }
    let samples: Record<string, unknown> = {};
    if (this.deviceId && w.binding.mode === 'current') {
      try {
        const l = await api.latest(this.deviceId, w.keys);
        samples = Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v?.value]));
      } catch {
        /* type inference falls back to metadata */
      }
      if (this.selected !== w.id || this.tab !== 'rules') return;
    }
    const cur = this.draft.widgets.find((x) => x.id === w.id) ?? w;
    ruleEditor(panel, {
      widget: cur,
      metas,
      samples,
      onChange: (rules, extra) =>
        this.quietWidget(w.id, 'rules', (x) => {
          if (rules) {
            x.settings.colorRules = rules;
            delete x.settings.bands;
            if (x.type === 'status') delete x.settings.statusMap;
          } else if (!extra) {
            delete x.settings.colorRules;
            delete x.settings.bands;
          }
          if (extra) for (const [k, v] of Object.entries(extra)) v === undefined ? delete (x.settings as any)[k] : ((x.settings as any)[k] = v);
          if (!rules && extra && 'bands' in extra) delete x.settings.colorRules;
        }),
    });
    void initialRules;
  }

  // ---------- settings panel ----------

  profilesForBinding(w: Widget): string[] {
    const b = w.binding;
    if (b.mode === 'current') return this.draft.profile ? [this.draft.profile] : this.deviceId ? [this.ctx.nodes.get(this.deviceId)!.profile] : [];
    if (b.mode === 'fixed') return [...new Set(b.deviceIds.map((id) => this.ctx.nodes.get(id)?.profile).filter(Boolean) as string[])];
    if (b.mode === 'none') return [];
    return [b.profile];
  }

  renderSettings(panel: HTMLElement) {
    const w = this.draft.widgets.find((x) => x.id === this.selected);
    if (!w) return this.renderTheme(panel);
    const cap = WIDGET_CAPS[w.type];
    const content = CONTENT_TYPES.has(w.type);
    const profiles = this.profilesForBinding(w);
    const allProfiles = [...new Set(scope.allDevices(this.ctx).map((d) => d.profile))];
    const nodes = [...this.ctx.nodes.values()].filter((n) => n.entityType === 'ASSET');
    const devices = scope.allDevices(this.ctx);
    const b = w.binding;
    const metas = this.metasFor(w);
    const keyRows = (() => {
      if (cap.keys[1] === 0) return '';
      if (!metas.length) return `<div class="dbb-hint">Choose a data source first.</div>`;
      const multi = cap.keys[1] > 1;
      const full = multi && w.keys.length >= cap.keys[1];
      const rows = metas.map((m) => {
        const c = this.fits(w.type, m, w);
        const on = w.keys.includes(m.key);
        const off = !on && (!c.ok || full);
        const why = !c.ok ? c.reason! : full ? `At most ${cap.keys[1]} properties per widget (keeps the dashboard fast). Untick one first.` : '';
        return `<label class="dbb-check ${off ? 'off' : ''} ${!c.ok ? 'bad' : ''}" ${why ? `title="${esc(why)}"` : ''}><input type="${multi ? 'checkbox' : 'radio'}" name="k-${w.id}" value="${esc(m.key)}" ${on ? 'checked' : ''} ${off ? 'disabled' : ''}/> ${esc(m.displayName)}${m.unit ? ` <span class="dbb-muted">(${esc(m.unit)})</span>` : ''}${!c.ok ? ` <span class="dbb-na">${esc(this.kindWord(m))}</span>` : ''}</label>`;
      });
      const bad = metas.filter((m) => !this.fits(w.type, m, w).ok).length;
      return `<div class="dbb-keys">${rows.join('')}</div>${
        multi ? `<div class="dbb-hint">${w.keys.length} of ${cap.keys[1]} selected · at most ${cap.keys[1]} per widget.</div>` : ''
      }${bad ? `<div class="dbb-hint">Greyed out: can't be shown as ${esc(WIDGET_LABELS[w.type].toLowerCase())}. Hover for why.</div>` : ''}`;
    })();

    const srcOpt = (mode: string, label: string, allowed = true) =>
      allowed ? `<label class="dbb-check"><input type="radio" name="src-${w.id}" value="${mode}" ${b.mode === mode ? 'checked' : ''}/> <span>${label}</span></label>` : '';
    const profSel = (cur: string | undefined, a: string) => `<select data-s="${a}">${allProfiles.map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`;
    // A type is greyed out when none of the source's properties can be shown with it.
    const typeOpts = WIDGET_GROUPS.map(
      (g) =>
        `<optgroup label="${esc(g.title)}">${g.types
          .map((t) => {
            const bad = t !== w.type && !CONTENT_TYPES.has(t) && t !== 'alarms' && metas.length > 0 && !metas.some((m) => this.fits(t, m, w, true).ok);
            return `<option value="${t}" ${t === w.type ? 'selected' : ''} ${bad ? 'disabled' : ''}>${WIDGET_LABELS[t]}${bad ? ' — no suitable property' : ''}</option>`;
          })
          .join('')}</optgroup>`,
    ).join('');

    panel.innerHTML = `
      <div class="dbb-form">
        <label class="dbb-field"><span>${w.type === 'link' ? 'Button label' : 'Title'}</span><input data-s="title" value="${esc(w.title)}" maxlength="120" placeholder="${w.type === 'text' || w.type === 'image' || w.type === 'embed' ? 'Optional' : ''}"/></label>
        <label class="dbb-field"><span>Widget type</span><select data-s="type">${typeOpts}</select></label>
        ${
          content
            ? `<div class="dbb-sec">Content</div>${this.contentFields(w)}`
            : `<div class="dbb-sec">1 · Data source</div>
        <div class="dbb-src">
          ${srcOpt('current', 'This machine <span class="dbb-muted">(whichever machine the dashboard is opened for)</span>', !!(this.deviceId || this.draft.profile))}
          ${srcOpt('fixed', 'Specific machines')}
          ${b.mode === 'fixed' ? `<div class="dbb-sub"><div class="dbb-keys">${devices
            .map((d) => {
              const on = b.deviceIds.includes(d.id);
              const off = cap.multiDevice && !on && b.deviceIds.length >= MAX_DEVICES;
              return `<label class="dbb-check ${off ? 'off' : ''}" ${off ? `title="At most ${MAX_DEVICES} machines per widget"` : ''}><input type="${cap.multiDevice ? 'checkbox' : 'radio'}" data-s="dev" value="${d.id}" ${on ? 'checked' : ''} ${off ? 'disabled' : ''}/> ${esc(d.label)} <span class="dbb-muted">${esc(d.profile)}</span></label>`;
            })
            .join('')}</div>${cap.multiDevice ? `<div class="dbb-hint">At most ${MAX_DEVICES} machines.</div>` : ''}${b.deviceIds.some((id) => !this.ctx.nodes.has(id)) ? `<div class="dbb-hint">Includes machines outside your access (kept).</div>` : ''}</div>` : ''}
          ${cap.multiDevice ? srcOpt('siblings', "Same-type machines at this machine's location", !!this.deviceId) : ''}
          ${b.mode === 'siblings' ? `<div class="dbb-sub">Type ${profSel(b.profile, 'sprof')}</div>` : ''}
          ${!cap.multiDevice ? srcOpt('nearest', 'Nearest machine of a type (e.g. the site weather station)', !!this.deviceId) : ''}
          ${b.mode === 'nearest' ? `<div class="dbb-sub">Type ${profSel(b.profile, 'sprof')}</div>` : ''}
          ${cap.multiDevice ? srcOpt('nodeQuery', 'All machines of a type under a location <span class="dbb-muted">(includes machines added later)</span>') : ''}
          ${
            b.mode === 'nodeQuery'
              ? `<div class="dbb-sub">Type ${profSel(b.profile, 'sprof')} under <select data-s="node">${nodes
                  .map((n) => `<option value="${n.id}" ${n.id === b.nodeId ? 'selected' : ''}>${esc(scope.pathLabel(this.ctx, n.id))}</option>`)
                  .join('')}</select></div>`
              : ''
          }
        </div>
        ${cap.keys[1] > 0 ? `<div class="dbb-sec">2 · Properties</div>${keyRows}` : ''}
        <div class="dbb-sec">3 · Options</div>
        ${this.appearanceFields(w)}
        ${w.type !== 'alarms' ? `<div class="dbb-tip-row">Colours by value are in the <a href="#" data-go="rules">Colours</a> tab; fonts, icons and card look in <a href="#" data-go="style">Style</a>.</div>` : ''}`
        }
        <div class="dbb-row" style="margin-top:14px">
          <button class="dbb-btn" data-s="dup">Duplicate</button>
          <button class="dbb-btn danger" data-s="del">Remove widget</button>
        </div>
      </div>`;

    const on = (sel: string, ev: string, fn: (e: any) => void) => panel.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, fn));
    on('[data-go]', 'click', (e) => {
      e.preventDefault();
      this.tab = e.currentTarget.dataset.go;
      this.renderRight();
    });
    on('[data-s="title"]', 'change', (e) => this.updateWidget(w.id, (x) => (x.title = e.target.value)));
    on('[data-s="type"]', 'change', (e) =>
      this.updateWidget(w.id, (x) => {
        const t = e.target.value as WidgetType;
        const c = WIDGET_CAPS[t];
        const wasContent = CONTENT_TYPES.has(x.type);
        x.type = t;
        x.keys = x.keys.slice(0, c.keys[1]);
        if (CONTENT_TYPES.has(t)) {
          x.binding = { mode: 'none' };
          const keep = { style: x.settings.style, description: x.settings.description, footer: x.settings.footer };
          x.settings = t === 'text' ? { ...keep, html: x.settings.html ?? `<h2>${esc(x.title)}</h2>` } : t === 'link' ? { ...keep, linkKind: 'state', linkState: 'listing', linkDevice: 'location' } : { ...keep };
        } else if (x.binding.mode === 'none' || wasContent) {
          x.binding = this.deviceId ? { mode: 'current' } : { mode: 'fixed', deviceIds: [scope.allDevices(this.ctx)[0]?.id].filter(Boolean) as string[] };
          this.fixKeys(x);
        }
        if (!c.multiDevice && x.binding.mode === 'fixed') x.binding.deviceIds = x.binding.deviceIds.slice(0, 1);
        if (!c.multiDevice && (x.binding.mode === 'siblings' || x.binding.mode === 'nodeQuery')) x.binding = this.deviceId ? { mode: 'current' } : x.binding;
        if (!CONTENT_TYPES.has(t)) this.fixKeys(x);
        const size = DEFAULT_SIZE[t];
        if (size.w === 12) {
          x.x = 0;
          x.w = 12;
        }
        x.h = Math.max(x.h, size.h);
      }),
    );
    on(`input[name="src-${w.id}"]`, 'change', (e) =>
      this.updateWidget(w.id, (x) => {
        const mode = e.target.value;
        const curProf = this.deviceId ? this.ctx.nodes.get(this.deviceId)!.profile : allProfiles[0];
        if (mode === 'current') x.binding = { mode: 'current' };
        if (mode === 'fixed') x.binding = { mode: 'fixed', deviceIds: this.deviceId ? [this.deviceId] : ([devices[0]?.id].filter(Boolean) as string[]) };
        if (mode === 'siblings') x.binding = { mode: 'siblings', profile: curProf };
        if (mode === 'nearest') x.binding = { mode: 'nearest', profile: allProfiles.find((p) => p !== curProf) ?? curProf };
        if (mode === 'nodeQuery') x.binding = { mode: 'nodeQuery', nodeId: this.ctx.rootIds[0] ?? nodes[0]?.id, profile: curProf };
        this.fixKeys(x);
      }),
    );
    on('[data-s="dev"]', 'change', () =>
      this.updateWidget(w.id, (x) => {
        const ids = [...panel.querySelectorAll<HTMLInputElement>('[data-s="dev"]:checked')].map((i) => i.value).slice(0, WIDGET_CAPS[x.type].multiDevice ? MAX_DEVICES : 1);
        const hidden = x.binding.mode === 'fixed' ? x.binding.deviceIds.filter((id) => !this.ctx.nodes.has(id)) : [];
        if (ids.length || hidden.length) x.binding = { mode: 'fixed', deviceIds: [...hidden, ...ids] };
        this.fixKeys(x);
      }),
    );
    on('[data-s="sprof"]', 'change', (e) =>
      this.updateWidget(w.id, (x) => {
        if ('profile' in x.binding) (x.binding as any).profile = e.target.value;
        this.fixKeys(x);
      }),
    );
    on('[data-s="node"]', 'change', (e) => this.updateWidget(w.id, (x) => x.binding.mode === 'nodeQuery' && (x.binding.nodeId = e.target.value)));
    on(`input[name="k-${w.id}"]`, 'change', () =>
      this.updateWidget(w.id, (x) => {
        const ks = [...panel.querySelectorAll<HTMLInputElement>(`input[name="k-${w.id}"]:checked`)].map((i) => i.value).slice(0, Math.min(MAX_KEYS, WIDGET_CAPS[x.type].keys[1]));
        const wasAuto = !x.title || x.title === WIDGET_LABELS[x.type] || profiles.some((p) => x.keys[0] && x.title.startsWith(keyMeta(this.ctx, p, x.keys[0]).displayName));
        x.keys = ks;
        if (wasAuto && ks.length === 1 && profiles[0]) x.title = keyMeta(this.ctx, profiles[0], ks[0]).displayName;
      }),
    );
    this.wireAppearance(panel, w);
    this.wireContent(panel, w);
    on('[data-s="del"]', 'click', () => this.removeWidget(w.id));
    on('[data-s="dup"]', 'click', () => this.duplicate(w.id));
  }

  /** Content widgets: rich text, image, button/link, embedded page. */
  contentFields(w: Widget): string {
    const s = w.settings;
    if (w.type === 'text') return `<div data-rte></div><div class="dbb-hint">Live values: pick <b>+ Live value</b> or type <code>{{key}}</code>. <code>{{machine}}</code>, <code>{{location}}</code>, <code>{{time}}</code> and <code>{{date}}</code> also work.</div>`;
    if (w.type === 'image')
      return `<label class="dbb-field"><span>Image address (https://…)</span><input data-c="url" value="${esc(s.url && !s.url.startsWith('data:') ? s.url : '')}" placeholder="https://example.com/logo.png"/></label>
        <label class="dbb-field"><span>…or upload (PNG, JPG, SVG, max 150 KB)</span><input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" data-c="file"/></label>
        ${s.url?.startsWith('data:') ? `<div class="dbb-hint">Uploaded image in use. <a href="#" data-c="clearimg">Remove</a></div>` : ''}
        <div class="dbb-field"><span>Fit</span><div class="dbb-seg sm"><button data-fit="contain" class="${(s.fit ?? 'contain') === 'contain' ? 'on' : ''}">Show whole image</button><button data-fit="cover" class="${s.fit === 'cover' ? 'on' : ''}">Fill the card</button></div></div>`;
    if (w.type === 'embed')
      return `<label class="dbb-field"><span>Page address (https://…)</span><input data-c="url" value="${esc(s.url ?? '')}" placeholder="https://…"/></label><div class="dbb-hint">Many sites (Google, YouTube pages, banking) refuse to be shown inside another page. Use their “embed” link where offered.</div>`;
    // link
    const devices = scope.allDevices(this.ctx);
    const states: [string, string][] = [
      ['default', 'Map page'],
      ['listing', 'Listing page'],
      ['machine', 'Machine page'],
    ];
    const kind = s.linkKind ?? 'state';
    return `<div class="dbb-field"><span>Opens</span><div class="dbb-seg sm"><button data-lk="state" class="${kind === 'state' ? 'on' : ''}">A page of this app</button><button data-lk="url" class="${kind === 'url' ? 'on' : ''}">A website</button></div></div>
      ${
        kind === 'url'
          ? `<label class="dbb-field"><span>Address (https://…)</span><input data-c="url" value="${esc(s.url ?? '')}" placeholder="https://…"/></label>`
          : `<label class="dbb-field"><span>Page</span><select data-c="linkState">${states.map(([v, l]) => `<option value="${v}" ${(s.linkState ?? 'listing') === v ? 'selected' : ''}>${l}</option>`).join('')}${
              s.linkState && !states.some(([v]) => v === s.linkState) ? `<option selected>${esc(s.linkState)}</option>` : ''
            }</select></label>
            <label class="dbb-field"><span>For</span><select data-c="linkDevice">
              <option value="location" ${(s.linkDevice ?? 'location') === 'location' ? 'selected' : ''}>This machine's location</option>
              <option value="current" ${s.linkDevice === 'current' ? 'selected' : ''}>This machine</option>
              <option value="none" ${s.linkDevice === 'none' ? 'selected' : ''}>Nothing (page start)</option>
              <optgroup label="A specific machine">${devices.map((d) => `<option value="${d.id}" ${s.linkDevice === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</optgroup>
            </select></label>`
      }
      <div class="dbb-field"><span>Button style</span><div class="dbb-seg sm">${[
        ['filled', 'Filled'],
        ['outline', 'Outline'],
        ['card', 'Tile'],
      ]
        .map(([v, l]) => `<button data-bs="${v}" class="${(s.buttonStyle ?? 'filled') === v ? 'on' : ''}">${l}</button>`)
        .join('')}</div></div>
      <div class="dbb-field"><span>Button colour</span><span class="dbb-colf"><label class="dbb-swatch" style="background:${esc(s.buttonColor ?? 'var(--accent)')}"><input type="color" data-c="buttonColor" value="${esc(s.buttonColor ?? '#2a78d6')}"/></label></span></div>
      <div class="dbb-hint">Pick the button icon in the Style tab. Buttons don't navigate while you're editing.</div>`;
  }

  wireContent(panel: HTMLElement, w: Widget) {
    const rte = panel.querySelector('[data-rte]') as HTMLElement | null;
    if (rte) {
      const profs = this.draft.profile ? [this.draft.profile] : this.deviceId ? [this.ctx.nodes.get(this.deviceId)!.profile] : [];
      const ph = [
        { key: 'machine', label: 'Machine name' },
        { key: 'location', label: 'Location' },
        { key: 'time', label: 'Current time' },
        { key: 'date', label: "Today's date" },
        ...profs.flatMap((p) => (this.ctx.profileKeys[p] ?? []).map((k) => ({ key: k.key, label: `${k.displayName}${k.unit ? ` (${k.unit})` : ''}` }))),
      ];
      richEditor(rte, {
        html: w.settings.html ?? miniToHtml(w.settings.markdown ?? ''),
        placeholders: ph,
        minHeight: 160,
        onChange: (html) =>
          this.quietWidget(w.id, 'html', (x) => {
            x.settings.html = html;
            delete x.settings.markdown;
          }),
      });
    }
    const set = (k: string, v: any, panelRefresh = false) =>
      this.quietWidget(w.id, `c-${k}`, (x) => (v === undefined || v === '' ? delete (x.settings as any)[k] : ((x.settings as any)[k] = v)), { panel: panelRefresh });
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-c]').forEach((inp) => {
      const k = inp.dataset.c!;
      if (k === 'file') {
        inp.addEventListener('change', () => {
          const f = (inp as HTMLInputElement).files?.[0];
          if (!f) return;
          if (f.size > 150 * 1024) return toast(this.root, 'That image is over 150 KB. Use a smaller file or an https:// address.', 'warn');
          const r = new FileReader();
          r.onload = () => set('url', String(r.result), true);
          r.readAsDataURL(f);
        });
        return;
      }
      if (k === 'clearimg') {
        inp.addEventListener('click', (e) => {
          e.preventDefault();
          set('url', undefined, true);
        });
        return;
      }
      inp.addEventListener(inp.type === 'color' ? 'input' : 'change', () => {
        if (inp.type === 'color') (inp.parentElement as HTMLElement).style.background = inp.value;
        set(k, k === 'url' ? inp.value.trim() : inp.value, k !== 'url' && inp.type !== 'color');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-fit]').forEach((b) => b.addEventListener('click', () => set('fit', b.dataset.fit, true)));
    panel.querySelectorAll<HTMLElement>('[data-lk]').forEach((b) => b.addEventListener('click', () => set('linkKind', b.dataset.lk, true)));
    panel.querySelectorAll<HTMLElement>('[data-bs]').forEach((b) => b.addEventListener('click', () => set('buttonStyle', b.dataset.bs, true)));
  }

  appearanceFields(w: Widget): string {
    const s = w.settings;
    const prof = this.profilesForBinding(w)[0];
    const meta = prof && w.keys[0] ? keyMeta(this.ctx, prof, w.keys[0]) : null;
    const f: string[] = [];
    const num = (a: string, label: string, v: number | undefined, ph = '') =>
      `<label class="dbb-field half"><span>${label}</span><input type="number" step="any" data-ap="${a}" value="${v ?? ''}" placeholder="${esc(ph)}"/></label>`;
    const sel = (a: string, label: string, opts: [string, string][], cur: string | undefined, half = false) =>
      `<label class="dbb-field ${half ? 'half' : ''}"><span>${label}</span><select data-ap="${a}">${opts.map(([v, l]) => `<option value="${v}" ${v === (cur ?? '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
    const chk = (a: string, label: string, on: boolean) => `<label class="dbb-check"><input type="checkbox" data-ap="${a}" ${on ? 'checked' : ''}/> ${label}</label>`;
    if (['value', 'kpi', 'gauge', 'progress', 'summary', 'multivalue', 'line', 'area', 'bar', 'table', 'donut', 'heatmap'].includes(w.type)) {
      f.push(`<div class="dbb-row">
        <label class="dbb-field half"><span>Unit</span><input data-ap="unit" value="${esc(s.unit ?? '')}" placeholder="${esc(meta?.unit ?? '')}"/></label>
        ${num('decimals', 'Decimals', s.decimals, String(meta?.decimals ?? 1))}</div>`);
    }
    if (w.type === 'gauge' || w.type === 'progress') f.push(`<div class="dbb-row">${num('min', 'Min', s.min, String(meta?.min ?? 0))}${num('max', 'Max', s.max, String(meta?.max ?? 100))}</div>`);
    if (w.type === 'progress') f.push(sel('orientation', 'Direction', [['horizontal', 'Horizontal bar'], ['vertical', 'Vertical (tank)']], s.orientation ?? 'horizontal'));
    if (w.type === 'kpi') {
      f.push(chk('sparkline', 'Show trend sparkline', s.sparkline !== false));
      f.push(sel('compare', 'Change badge', [['start', 'Change since start of range'], ['none', 'Hide']], s.compare ?? 'start'));
      f.push(chk('upIsGood', 'Going up is good (green)', s.upIsGood !== false));
    }
    if (['line', 'area', 'bar', 'heatmap'].includes(w.type) || (w.type === 'donut' && s.donutMode === 'devices'))
      f.push(sel('agg', 'Aggregation', (w.type === 'line' || w.type === 'area' ? ['AVG', 'MIN', 'MAX', 'NONE'] : ['AVG', 'MIN', 'MAX', 'SUM']).map((a) => [a, a === 'NONE' ? 'Raw values' : a.toLowerCase()]) as [string, string][], s.agg ?? 'AVG'));
    if (w.type === 'line' || w.type === 'area') {
      f.push(chk('smooth', 'Smooth lines', !!s.smooth));
      if (w.type === 'area') f.push(chk('stacked', 'Stack series (same unit only)', !!s.stacked));
      f.push(chk('showLegend', 'Show legend', s.showLegend !== false));
    }
    if (w.type === 'bar') f.push(sel('groupBy', 'Group by', [['15m', 'Every 15 minutes'], ['hour', 'Hour'], ['device', 'Compare machines']], s.groupBy === 'day' ? 'hour' : s.groupBy ?? 'hour'));
    if (w.type === 'donut') f.push(sel('donutMode', 'Show', [['state', 'Time in each state (one machine)'], ['devices', 'Share by machine']], s.donutMode ?? 'state'));
    if (w.type === 'heatmap') f.push(sel('heatColor', 'Colours', [['blue', 'Blue scale'], ['orange', 'Orange scale'], ['rules', 'Use the Colours rules']], s.heatColor ?? 'blue'));
    if (['line', 'area', 'bar', 'alarms', 'kpi', 'summary', 'donut', 'timeline', 'heatmap'].includes(w.type))
      f.push(sel('timeRange', 'Time range', [['', `Same as dashboard (${rangeLabel(this.draft.timeRange)})`], ...TIME_RANGES.map((r) => [r, r === 'realtime' ? 'Realtime (rolling 1 h)' : rangeLabel(r)] as [string, string])], s.timeRange ? normalizeRange(s.timeRange) : ''));
    if (w.type === 'alarms') {
      f.push(`<div class="dbb-field"><span>Severities</span><div class="dbb-row wrap">${['CRITICAL', 'MAJOR', 'MINOR', 'WARNING']
        .map((v) => `<label class="dbb-check"><input type="checkbox" data-sev value="${v}" ${!s.severities || s.severities.includes(v as any) ? 'checked' : ''}/> ${v.toLowerCase()}</label>`)
        .join('')}</div></div>`);
      f.push(`<div class="dbb-row">${sel('alarmStatus', 'Status', [['ANY', 'Any'], ['ACTIVE', 'Active'], ['CLEARED', 'Cleared']], s.alarmStatus ?? 'ANY', true)}${num('maxRows', 'Max rows', s.maxRows, '20')}</div>`);
    }
    if (w.type === 'status') f.push(`<div class="dbb-hint">Set the labels and colours for each value in the <b>Colours</b> tab.</div>`);
    return f.join('') || '<div class="dbb-hint">No options for this widget.</div>';
  }

  wireAppearance(panel: HTMLElement, w: Widget) {
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ap]').forEach((inp) =>
      inp.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const a = inp.dataset.ap!;
          const v = (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : inp.value;
          const s: any = x.settings;
          if (['decimals', 'min', 'max', 'maxRows'].includes(a)) {
            if (v === '') delete s[a];
            else s[a] = a === 'decimals' || a === 'maxRows' ? Math.max(0, Math.round(Number(v))) : Number(v);
          } else if (a === 'showLegend' || a === 'sparkline' || a === 'upIsGood') {
            if (v) delete s[a];
            else s[a] = false;
          } else if (a === 'smooth' || a === 'stacked') {
            if (v) s[a] = true;
            else delete s[a];
          } else if (v === '') delete s[a];
          else s[a] = v;
          if (a === 'donutMode' && v === 'devices' && x.binding.mode === 'current') x.binding = this.deviceId ? { mode: 'siblings', profile: this.ctx.nodes.get(this.deviceId)!.profile } : x.binding;
          if (a === 'donutMode') this.fixKeys(x);
        }),
      ),
    );
    panel.querySelectorAll<HTMLInputElement>('[data-sev]').forEach((c) =>
      c.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const sel = [...panel.querySelectorAll<HTMLInputElement>('[data-sev]:checked')].map((i) => i.value);
          if (sel.length === 4) delete x.settings.severities;
          else x.settings.severities = sel as any;
        }),
      ),
    );
  }

  /** Properties that can be chosen for this widget's data source. */
  metasFor(w: Widget): KeyMeta[] {
    const seen = new Map<string, KeyMeta>();
    for (const p of this.profilesForBinding(w)) for (const k of this.ctx.profileKeys[p] ?? []) if (!seen.has(k.key)) seen.set(k.key, k);
    return [...seen.values()];
  }

  /** Donut mode as the renderer will use it. */
  donutMode(w: Widget): 'state' | 'devices' {
    if (w.settings.donutMode) return w.settings.donutMode;
    const b = w.binding;
    return b.mode === 'current' || b.mode === 'nearest' || (b.mode === 'fixed' && b.deviceIds.length === 1) ? 'state' : 'devices';
  }

  /** Can this property be shown with widget type t? anyDonutMode: a donut fits if either of its modes fits. */
  fits(t: WidgetType, m: KeyMeta, w: Widget, anyDonutMode = false) {
    if (t === 'donut' && anyDonutMode) {
      const a = compatible(t, m, { donutMode: 'state' });
      return a.ok ? a : compatible(t, m, { donutMode: 'devices' });
    }
    return compatible(t, m, { donutMode: t === 'donut' ? this.donutMode(w) : undefined });
  }

  kindWord(m: KeyMeta): string {
    return { number: 'number', boolean: 'on/off', string: 'text', coded: 'state' }[propKind(m)];
  }

  /** Keep only known properties that fit the widget type (at most MAX_KEYS); pick a fitting one if none are left. */
  fixKeys(x: Widget) {
    const metas = this.metasFor(x);
    const cap = WIDGET_CAPS[x.type];
    if (x.type === 'donut' && !x.settings.donutMode) {
      // a number can only be shown as "share by machine"; states as "time in each state"
      const cur = metas.find((m) => m.key === x.keys[0]);
      if (cur && !compatible('donut', cur, { donutMode: this.donutMode(x) }).ok && compatible('donut', cur, { donutMode: 'devices' }).ok) x.settings.donutMode = 'devices';
    }
    x.keys = x.keys.filter((k) => metas.some((m) => m.key === k && this.fits(x.type, m, x).ok)).slice(0, Math.min(MAX_KEYS, cap.keys[1]));
    if (!x.keys.length && cap.keys[0] > 0) {
      const ok = metas.filter((m) => this.fits(x.type, m, x).ok);
      const first = ok.find((m) => !/hours/i.test(m.key)) ?? ok[0];
      if (first) x.keys = [first.key];
    }
  }

  // ---------- chat panel ----------

  renderChat(panel: HTMLElement) {
    const n = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
    const sugg = !this.draft.widgets.length && !this.chatLog.length ? chat.suggestedPrompts(this.ctx, this.deviceId) : [];
    panel.innerHTML = `<div class="dbb-chat">
      <div class="dbb-chat-log">${
        this.chatLog.length
          ? this.chatLog
              .map((m, i) => {
                const ch = m.changed;
                const sum = ch ? summarise(ch) : '';
                return `<div class="dbb-msg ${m.role}"><div>${esc(m.text)}</div>${sum ? `<div class="dbb-msg-sum">${esc(sum)} <a href="#" data-hl="${i}">Highlight</a></div>` : ''}${
                  m.options ? `<div class="dbb-opts">${m.options.map((o) => `<button class="dbb-btn sm" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''
                }</div>`;
              })
              .join('')
          : `<div class="dbb-hint">Describe the dashboard you want${n ? ` for ${esc(n.label)}` : ''}. The assistant edits the draft on the canvas; nothing is saved until you press Save.</div>`
      }
      ${sugg.length ? `<div class="dbb-opts">${sugg.map((s) => `<button class="dbb-btn sm" data-opt="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
      ${this.busy ? `<div class="dbb-msg assistant"><span class="dbb-typing">Working…</span></div>` : ''}
      </div>
      <div class="dbb-chat-bar">
        ${this.preChat ? `<button class="dbb-btn sm" data-a="discard">Discard chat changes</button>` : ''}
        ${this.undo.length && this.preChat ? `<button class="dbb-btn sm" data-a="cundo">Undo last</button>` : ''}
      </div>
      <form class="dbb-chat-form"><textarea class="dbb-chat-in" rows="3" maxlength="1000" placeholder="e.g. Show discharge pressure and temperature for the last 24 hours, with alarms"></textarea>
      <button class="dbb-btn primary" type="submit" ${this.busy ? 'disabled' : ''}>Send</button></form>
    </div>`;
    const log = panel.querySelector('.dbb-chat-log') as HTMLElement;
    log.scrollTop = log.scrollHeight;
    const form = panel.querySelector('form') as HTMLFormElement;
    const input = panel.querySelector('textarea') as HTMLTextAreaElement;
    form.onsubmit = (e) => {
      e.preventDefault();
      void this.sendChat(input.value);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.sendChat(input.value);
      }
    };
    panel.querySelectorAll<HTMLElement>('[data-opt]').forEach((b) => (b.onclick = () => void this.sendChat(b.dataset.opt!)));
    panel.querySelectorAll<HTMLElement>('[data-hl]').forEach(
      (a) =>
        (a.onclick = (e) => {
          e.preventDefault();
          const m = this.chatLog[Number(a.dataset.hl)];
          this.highlight = new Set([...(m.changed?.added ?? []), ...(m.changed?.updated ?? [])]);
          this.grid?.setOptions({ highlight: this.highlight });
          setTimeout(() => {
            this.highlight.clear();
            this.grid?.setOptions({ highlight: this.highlight });
          }, 2500);
        }),
    );
    panel.querySelector<HTMLElement>('[data-a="discard"]')?.addEventListener('click', () => {
      if (!this.preChat) return;
      this.commit(JSON.parse(this.preChat));
      this.preChat = null;
      this.chatLog.push({ role: 'system', text: 'Chat changes discarded.' });
      this.renderRight();
    });
    panel.querySelector<HTMLElement>('[data-a="cundo"]')?.addEventListener('click', () => {
      this.undoLast();
      this.chatLog.push({ role: 'system', text: 'Undid the last change.' });
      this.renderRight();
    });
  }

  async sendChat(text: string) {
    text = text.trim();
    if (!text || this.busy) return;
    if (text.length > 1000) return toast(this.root, 'Please keep messages under 1000 characters.', 'warn');
    if (/^undo$/i.test(text)) {
      this.undoLast();
      this.chatLog.push({ role: 'user', text }, { role: 'assistant', text: 'Reverted the last change.' });
      return this.renderRight();
    }
    if (!rateOk(this.ctx.userId)) return toast(this.root, 'Chat limit reached (30 requests per hour). Try again later.', 'warn');
    this.chatLog.push({ role: 'user', text });
    this.busy = true;
    this.renderRight();
    const before = JSON.stringify(this.draft);
    try {
      const res = await chat.chatTurn(this.ctx, chat.ruleChainTransport(this.ctx), this.draft, this.chatHistory, text, this.deviceId);
      this.chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply || '(ok)' });
      const changedCount = res.changed.added.length + res.changed.updated.length + res.changed.removed.length;
      if (res.clarification) {
        this.chatLog.push({ role: 'assistant', text: res.clarification.question || res.reply, options: res.clarification.options });
      } else {
        if (changedCount || JSON.stringify(res.draft) !== before) {
          if (!this.preChat) this.preChat = before;
          this.commit(res.draft);
        }
        this.chatLog.push({ role: 'assistant', text: [res.reply, ...res.warnings].filter(Boolean).join(' '), changed: changedCount ? res.changed : undefined });
        if (res.applyProposal) this.pendingApply = res.applyProposal;
        if (res.applyProposal) this.chatLog.push({ role: 'system', text: 'When you press Save, the Apply dialog will open with this target selected.' });
      }
      void audit(this.ctx, 'chat', { message: text, ops: res.changed, ok: true, attempts: res.attempts, usage: res.usage });
    } catch (e: any) {
      this.chatLog.push({ role: 'assistant', text: e.message || "I couldn't build that; try rephrasing." });
      void audit(this.ctx, 'chat', { message: text, ok: false, error: String(e.message ?? e) });
    } finally {
      this.busy = false;
      this.renderRight();
    }
  }

  // ---------- save / apply ----------

  async save(asCopy: boolean): Promise<void> {
    if (!asCopy && !this.ctx.isAdmin && this.draft.version > 0) {
      const u = this.usageInfo ?? (await store.usage(this.ctx, this.draft).catch(() => null));
      const shared = (u?.devices.length ?? 0) > 1 || (this.source?.level === 'node' || this.source?.level === 'customer') && this.source.dashboard?.id === this.draft.id;
      if (shared) {
        const ok = await confirmModal(
          this.root,
          'This dashboard is shared',
          `${this.source && (this.source.level === 'node' || this.source.level === 'customer') ? `It is applied to ${(this.source.sourceLabel || 'a group of machines').replace(/^All/, 'all')}` : `It is used by ${u?.devices.length ?? 'several'} machines`}, and only admins can change it. Save your changes as your own copy instead?`,
          'Save as copy',
        );
        if (ok) return this.save(true);
        return;
      }
    }
    const d: Dashboard = JSON.parse(JSON.stringify(this.draft));
    d.kind = dashboardKind(d.widgets);
    if (d.kind === 'device' && !d.profile && this.deviceId) d.profile = this.ctx.nodes.get(this.deviceId)!.profile;
    const problems = checkDashboard(d, metaLookup(this.ctx, d));
    if (!d.widgets.length) problems.push('Add at least one widget.');
    if (problems.length) return toast(this.root, problems.join(' '), 'err');
    if (asCopy) {
      const name = await promptModal(this.root, 'Save as a new dashboard', 'Name', `${d.name} (copy)`);
      if (!name) return;
      Object.assign(d, { id: newId('d'), name, version: 0, ownerId: this.ctx.userId, ownerName: this.ctx.displayName, copiedFrom: null });
    }
    // warn about keys missing on same-type machines
    if (d.kind === 'device' && d.profile) {
      const pv = await store.previewApply(this.ctx, d, { type: 'devices', deviceIds: scope.allDevices(this.ctx, d.profile).map((x) => x.id).slice(0, 50), mode: 'linked' }).catch(() => null);
      if (pv?.missingKeys.length) {
        const txt = pv.missingKeys.map((m) => `${m.devices.length} of ${pv.affected.length} ${d.profile} machines don't report ${keyMeta(this.ctx, d.profile!, m.key).displayName} (${m.devices.join(', ')})`).join('; ');
        if (!(await confirmModal(this.root, 'Some machines lack a property', `${txt}. Those widgets will show "Not available on this device". Save anyway?`, 'Save anyway'))) return;
      }
    }
    this.setBusy(true, 'Saving…');
    try {
      const saved = await store.saveDashboard(this.ctx, d);
      this.savedAnything = true;
      this.draft = saved;
      this.baseline = JSON.stringify(saved);
      this.preChat = null;
      void audit(this.ctx, asCopy ? 'dashboard.saveAs' : 'dashboard.save', { id: saved.id, name: saved.name, version: saved.version });
      toast(this.root, `Saved “${saved.name}” (version ${saved.version}).`, 'ok');
      this.renderAll();
      void this.loadUsage();
      this.setBusy(false);
      // first save or a chat proposal -> ask where to apply
      if (saved.version === 1 || this.pendingApply || asCopy) await this.applyDialog();
    } catch (e: any) {
      this.setBusy(false);
      if (e instanceof store.ConflictError) {
        const choice = await choiceModal(this.root, 'Someone else saved this dashboard', `${e.message} Your changes were not saved.`, [
          ['reload', 'Reload theirs'],
          ['copy', 'Save mine as a copy'],
        ]);
        if (choice === 'reload') this.loadDraft(e.current);
        if (choice === 'copy') await this.save(true);
      } else toast(this.root, `Save failed: ${e.message}`, 'err');
    }
  }

  async applyDialog() {
    const d = this.draft;
    if (d.version === 0) return toast(this.root, 'Save the dashboard first.', 'warn');
    const dev = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
    const profile = d.profile;
    const isDeviceDash = d.kind === 'device' && !!profile;
    const sameType = profile ? scope.allDevices(this.ctx, profile) : [];
    const nodes = profile ? scope.nodesContaining(this.ctx, profile) : [];
    const admin = this.ctx.isAdmin;
    const p = this.pendingApply;
    this.pendingApply = null;
    // Scope decision 27 Sep 2026: building is admin-only, and a save applies to the selected machine
    // with the option to apply it to every machine of the same type in the admin's scope.
    const others = sameType.filter((x) => x.id !== dev?.id);
    const allLabel = this.ctx.rootsAreTop ? `All ${profile} machines` : `All ${profile} machines you manage`;
    const initial = (p?.target === 'customer' || p?.target === 'node') && admin && others.length ? 'all' : dev && isDeviceDash ? 'device' : 'none';
    void nodes;

    const m = modal(
      this.root,
      'Apply dashboard',
      `
      <div class="dbb-form">
        <div class="dbb-hint">${isDeviceDash ? `Which <b>${esc(profile!)}</b> machines should show “${esc(d.name)}” to all their users? “This machine” widgets follow each machine.` : `“${esc(d.name)}” is a standalone dashboard (fixed machines); open it from My dashboards.`}</div>
        ${
          isDeviceDash && dev && dev.profile === profile
            ? `<label class="dbb-check"><input type="radio" name="t" value="device" ${initial === 'device' ? 'checked' : ''}/> Only ${esc(dev.label)}</label>`
            : ''
        }
        ${
          isDeviceDash && others.length
            ? `<label class="dbb-check ${admin ? '' : 'dis'}"><input type="radio" name="t" value="all" ${initial === 'all' ? 'checked' : ''} ${admin ? '' : 'disabled'}/> ${esc(allLabel)} <span class="dbb-muted">(${sameType.length} machines${this.ctx.rootsAreTop ? ', and machines added later' : ''})</span></label>`
            : ''
        }
        <label class="dbb-check"><input type="radio" name="t" value="none" ${initial === 'none' ? 'checked' : ''}/> Don't apply now</label>
        <div class="dbb-preview"></div>
      </div>`,
      [
        ['cancel', 'Cancel'],
        ['apply', 'Apply', 'primary'],
      ],
    );
    const body = m.body;
    const target = (): store.ApplyTarget => {
      const t = (body.querySelector('input[name="t"]:checked') as HTMLInputElement)?.value ?? 'none';
      if (t === 'device') return { type: 'devices', deviceIds: [dev!.id], mode: 'linked' };
      if (t === 'all')
        return this.ctx.rootsAreTop ? { type: 'customer', profile: profile! } : { type: 'devices', deviceIds: sameType.map((x) => x.id), mode: 'linked' };
      return { type: 'none' };
    };
    let seq = 0;
    const refresh = async () => {
      const t = target();
      body.querySelectorAll<HTMLElement>('[data-for]').forEach((x) => (x.hidden = x.dataset.for !== (body.querySelector('input[name="t"]:checked') as HTMLInputElement)?.value));
      const pvEl = body.querySelector('.dbb-preview') as HTMLElement;
      m.button('apply').disabled = true;
      if (t.type === 'none') {
        pvEl.innerHTML = '';
        m.button('apply').disabled = false;
        m.button('apply').textContent = 'Done';
        return;
      }
      m.button('apply').textContent = 'Apply';
      pvEl.innerHTML = `<div class="dbb-hint">Checking affected machines…</div>`;
      const my = ++seq;
      const pv = await store.previewApply(this.ctx, d, t).catch((e) => ({ errors: [e.message] }) as any as store.ApplyPreview);
      if (my !== seq) return;
      const parts: string[] = [];
      if (pv.errors?.length) parts.push(`<div class="dbb-banner err">${esc(pv.errors.join(' '))}</div>`);
      else {
        parts.push(`<div class="dbb-banner"><b>${pv.affected.length}</b> machine${pv.affected.length === 1 ? '' : 's'} affected: ${esc(pv.affected.map((a) => a.label).join(', '))}</div>`);
        if (pv.replaced.length) parts.push(`<div class="dbb-banner warn">${pv.replaced.length} currently show a different dashboard that will be replaced: ${esc(pv.replaced.map((r) => `${r.label} (${r.from})`).join(', '))}</div>`);
        if (pv.keepOwn.length) parts.push(`<div class="dbb-banner">${pv.keepOwn.length} have their own dashboard and keep it: ${esc(pv.keepOwn.map((r) => r.label).join(', '))}</div>`);
        if (pv.replacesAssignment)
          parts.push(`<label class="dbb-check dbb-banner warn"><input type="checkbox" data-replace/> Replace existing assignment “${esc(pv.replacesAssignment.name)}”?</label>`);
        for (const mk of pv.missingKeys) parts.push(`<div class="dbb-banner warn">${mk.devices.length} of ${pv.affected.length} don't report ${esc(profile ? keyMeta(this.ctx, profile, mk.key).displayName : mk.key)} (${esc(mk.devices.join(', '))})</div>`);
      }
      pvEl.innerHTML = parts.join('');
      const rep = pvEl.querySelector('[data-replace]') as HTMLInputElement | null;
      const setBtn = () => (m.button('apply').disabled = !!pv.errors?.length || (!!rep && !rep.checked) || (t.type === 'devices' && !t.deviceIds.length));
      rep?.addEventListener('change', setBtn);
      setBtn();
    };
    body.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).matches('[data-replace]')) return;
      void refresh();
    });
    void refresh();
    const choice = await m.result;
    if (choice !== 'apply') return;
    const t = target();
    if (t.type === 'none') return;
    this.setBusy(true, 'Applying…');
    try {
      const ids = await store.apply(this.ctx, d, t);
      this.savedAnything = true;
      void audit(this.ctx, 'dashboard.apply', { id: d.id, target: t, devices: ids.length });
      toast(this.root, `Applied to ${ids.length} machine${ids.length === 1 ? '' : 's'}.`, 'ok');
      if (this.deviceId) this.source = await store.resolveForDevice(this.ctx, this.deviceId, this.ctx.nodes.get(this.deviceId)!.profile);
      await this.loadUsage();
    } catch (e: any) {
      toast(this.root, `Apply failed: ${e.message}`, 'err');
    } finally {
      this.setBusy(false);
      this.renderBanner();
    }
  }

  async openDialog() {
    this.setBusy(true, 'Loading dashboards…');
    let list: Awaited<ReturnType<typeof store.listDashboards>> = [];
    try {
      list = await store.listDashboards(this.ctx);
    } catch (e: any) {
      toast(this.root, e.message, 'err');
    }
    this.setBusy(false);
    const rows = list
      .map(
        (d) => `<tr data-id="${d.id}"><td><b>${esc(d.name)}</b>${d.copiedFrom ? ' <span class="dbb-muted">(copy)</span>' : ''}</td><td>${esc(d.profile ?? 'standalone')}</td><td>${d.widgets.length}</td><td>${esc(
          d.ownerName,
        )}${d.visibility === 'private' ? ' · private' : ''}</td><td>${esc(new Date(d.updatedAt).toLocaleString())}</td></tr>`,
      )
      .join('');
    const m = modal(
      this.root,
      'Open dashboard',
      `<div class="dbb-row" style="margin-bottom:8px"><button class="dbb-btn" data-new>New blank dashboard</button></div>
       ${list.length ? `<div class="dbb-scroll" style="max-height:50vh"><table class="dbb-table dbb-pick"><thead><tr><th>Name</th><th>Machine type</th><th>Widgets</th><th>Owner</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="dbb-hint">No saved dashboards yet.</div>'}`,
      [['cancel', 'Close']],
    );
    m.body.querySelector('[data-new]')?.addEventListener('click', () => {
      m.close('new');
      const prof = this.deviceId ? this.ctx.nodes.get(this.deviceId)!.profile : null;
      this.loadDraft(store.blankDashboard(this.ctx, prof ? `${prof} dashboard` : 'Untitled dashboard', prof));
    });
    m.body.querySelectorAll<HTMLElement>('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => {
        m.close('open');
        void this.openDashboard(tr.dataset.id!);
      }),
    );
  }

  async versionsDialog() {
    const vs = await store.versions(this.ctx, this.draft.id).catch(() => []);
    const m = modal(
      this.root,
      'Version history',
      vs.length
        ? `<table class="dbb-table"><thead><tr><th>Version</th><th>Saved</th><th>By</th><th></th></tr></thead><tbody>${vs
            .map(
              (v) =>
                `<tr><td>${v.version}</td><td>${esc(new Date(v.savedAt).toLocaleString())}</td><td>${esc(v.savedBy)}</td><td><button class="dbb-btn sm" data-v="${v.version}">Restore</button></td></tr>`,
            )
            .join('')}</tbody></table><div class="dbb-hint">The last 10 versions are kept. Restoring saves a new version.</div>`
        : '<div class="dbb-hint">No earlier versions.</div>',
      [['cancel', 'Close']],
    );
    m.body.querySelectorAll<HTMLElement>('[data-v]').forEach((b) =>
      b.addEventListener('click', async () => {
        m.close('restore');
        this.setBusy(true, 'Restoring…');
        try {
          const d = await store.restoreVersion(this.ctx, this.draft.id, Number(b.dataset.v));
          void audit(this.ctx, 'dashboard.restore', { id: d.id, fromVersion: Number(b.dataset.v), version: d.version });
          this.loadDraft(d);
          toast(this.root, `Restored version ${b.dataset.v} as version ${d.version}.`, 'ok');
        } catch (e: any) {
          toast(this.root, e.message, 'err');
        } finally {
          this.setBusy(false);
        }
      }),
    );
  }

  async deleteDialog() {
    const u = this.usageInfo ?? (await store.usage(this.ctx, this.draft).catch(() => ({ devices: [], customised: [] })));
    const ok = await confirmModal(
      this.root,
      `Delete “${this.draft.name}”?`,
      u.devices.length
        ? `${u.devices.length} machine(s) use it now: ${u.devices.join(', ')}. They will fall back to the next dashboard in line (or the default layout).`
        : 'It is not assigned to any machine you can see.',
      'Delete',
      true,
    );
    if (!ok) return;
    this.setBusy(true, 'Deleting…');
    try {
      const affected = await store.deleteDashboard(this.ctx, this.draft);
      void audit(this.ctx, 'dashboard.delete', { id: this.draft.id, name: this.draft.name, affected });
      this.savedAnything = true;
      toast(this.root, 'Dashboard deleted.', 'ok');
      this.baseline = JSON.stringify(this.draft);
      await this.selectMachine(this.deviceId);
    } catch (e: any) {
      toast(this.root, e.message, 'err');
    } finally {
      this.setBusy(false);
    }
  }
}

// ---------- helpers ----------


function summarise(c: chat.ChatResult['changed']): string {
  const p: string[] = [];
  if (c.added.length) p.push(`Added ${c.added.length} widget${c.added.length > 1 ? 's' : ''}`);
  if (c.updated.length) p.push(`changed ${c.updated.length}`);
  if (c.removed.length) p.push(`removed ${c.removed.length}`);
  return p.join(', ');
}

function rateOk(userId: string): boolean {
  const key = `dbb_rate_${userId}`;
  const now = Date.now();
  let arr: number[] = [];
  try {
    arr = JSON.parse(localStorage.getItem(key) || '[]').filter((t: number) => now - t < 3600e3);
  } catch {
    arr = [];
  }
  if (arr.length >= 30) return false;
  arr.push(now);
  try {
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
  return true;
}

async function promptModal(root: HTMLElement, title: string, label: string, value: string): Promise<string | null> {
  const m = modal(root, title, `<label class="dbb-field"><span>${esc(label)}</span><input data-in value="${esc(value)}" maxlength="120"/></label>`, [
    ['cancel', 'Cancel'],
    ['ok', 'Save', 'primary'],
  ]);
  const inp = m.body.querySelector('[data-in]') as HTMLInputElement;
  setTimeout(() => inp.select(), 0);
  const r = await m.result;
  return r === 'ok' ? inp.value.trim() || null : null;
}

async function choiceModal(root: HTMLElement, title: string, text: string, choices: [string, string][]): Promise<string> {
  const m = modal(root, title, `<div>${esc(text)}</div>`, [['cancel', 'Cancel'], ...choices.map(([k, l], i) => [k, l, i === choices.length - 1 ? 'primary' : ''] as [string, string, string])]);
  return m.result;
}

void bindingLabel;
void api;
