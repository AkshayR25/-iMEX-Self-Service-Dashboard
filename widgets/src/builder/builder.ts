// Full-screen Dashboard Builder overlay. Opened from the navbar button (launcher widget).
import * as api from '../core/api';
import * as scope from '../core/scope';
import type { UserContext } from '../core/scope';
import * as store from '../core/store';
import * as chat from '../core/chat';
import { Dashboard, Widget, WidgetType, WIDGET_TYPES, WIDGET_LABELS, WIDGET_CAPS, DEFAULT_SIZE, TIME_RANGES, MAX_WIDGETS, MAX_SERIES, checkDashboard, dashboardKind, newId } from '../core/schema';
import { Grid, GRID_CSS, firstFit, resolveCollisions } from '../render/grid';
import { CSS, ensureCss, esc, el } from '../render/theme';
import { bindingLabel, defaultWidgets, keyMeta } from '../render/widgets';
import { BUILDER_CSS } from './styles';
import { modal, confirmModal, toast } from './ui';
import { audit } from '../core/audit';

export interface BuilderOptions {
  ctx: UserContext;
  deviceId?: string | null;
  dashboardId?: string | null;
  chatEnabled?: boolean;
  onClose?(changed: boolean): void;
}

const ICON: Record<WidgetType, string> = {
  value: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 14h4M7 10h8" stroke="currentColor" stroke-width="1.6"/></svg>',
  gauge: '<svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 16l4-5" stroke="currentColor" stroke-width="1.6"/></svg>',
  status: '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="3.5" fill="currentColor"/><path d="M14 12h6" stroke="currentColor" stroke-width="1.6"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 5-7 4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  bar: '<svg viewBox="0 0 24 24"><path d="M5 19V11M10 19V6M15 19v-5M20 19V9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  table: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h18M9 10v9" stroke="currentColor" stroke-width="1.6"/></svg>',
  alarms: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 20h4" stroke="currentColor" stroke-width="1.6"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v13" stroke="currentColor" stroke-width="1.8"/></svg>',
};

export function openBuilder(o: BuilderOptions) {
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
  tab: 'settings' | 'chat' = 'settings';
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
    const keys = profile ? (this.ctx.profileKeys[profile] ?? []).map((k) => k.key) : [];
    const firstKey = type === 'status' ? keys.find((k) => /status/i.test(k)) ?? keys[0] : keys.find((k) => !/status|hours/i.test(k)) ?? keys[0];
    const w: Widget = {
      id: newId(),
      type,
      title: type === 'text' ? '' : WIDGET_LABELS[type],
      x: 0,
      y: 0,
      w: size.w,
      h: size.h,
      binding: type === 'text' ? { mode: 'none' } : this.deviceId ? { mode: 'current' } : { mode: 'none' },
      keys: WIDGET_CAPS[type].keys[1] === 0 || !firstKey || !this.deviceId ? [] : [firstKey],
      settings: type === 'text' ? { markdown: '## Heading' } : type === 'alarms' ? { alarmStatus: 'ANY', maxRows: 10 } : {},
    };
    if (w.keys[0] && profile) w.title = keyMeta(this.ctx, profile, w.keys[0]).displayName;
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

  renderTop() {
    const top = this.root.querySelector('.dbb-top') as HTMLElement;
    const d = this.draft;
    const canDelete = d.version > 0 && (d.ownerId === this.ctx.userId || this.ctx.isAdmin);
    top.innerHTML = `
      <div class="dbb-brand">Dashboard Builder</div>
      <label class="dbb-field"><span>Machine</span><select data-a="machine">${this.machineOptions()}</select></label>
      <button class="dbb-btn" data-a="open" title="Open an existing dashboard">Open…</button>
      <label class="dbb-field grow"><span>Dashboard name</span><input data-a="name" maxlength="120" value="${esc(d.name)}"/></label>
      <label class="dbb-field"><span>Time range</span><select data-a="range">${TIME_RANGES.map((r) => `<option ${r === d.timeRange ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <div class="dbb-tools">
        <button class="dbb-btn icon" data-a="undo" title="Undo (Ctrl+Z)" ${this.undo.length ? '' : 'disabled'}>↶</button>
        <button class="dbb-btn icon" data-a="redo" title="Redo (Ctrl+Shift+Z)" ${this.redo.length ? '' : 'disabled'}>↷</button>
        <button class="dbb-btn" data-a="preview">${this.preview ? 'Edit' : 'Preview'}</button>
        ${d.version > 0 ? `<button class="dbb-btn" data-a="versions" title="Version history">History</button>` : ''}
        ${canDelete ? `<button class="dbb-btn danger" data-a="delete">Delete</button>` : ''}
        ${d.version > 0 ? `<button class="dbb-btn" data-a="saveas">Save as</button>` : ''}
        ${d.version > 0 ? `<button class="dbb-btn" data-a="apply">Apply to…</button>` : ''}
        <button class="dbb-btn primary" data-a="save">${this.dirty() || d.version === 0 ? 'Save' : 'Saved'}</button>
        <button class="dbb-btn icon" data-a="close" title="Close (Esc)" aria-label="Close">✕</button>
      </div>`;
    const q = (a: string) => top.querySelector(`[data-a="${a}"]`) as HTMLElement;
    (q('machine') as HTMLSelectElement).onchange = (e) => void this.selectMachine((e.target as HTMLSelectElement).value || null);
    (q('name') as HTMLInputElement).onchange = (e) => this.mutate((x) => (x.name = (e.target as HTMLInputElement).value.trim() || 'Untitled dashboard'));
    (q('range') as HTMLSelectElement).onchange = (e) => this.mutate((x) => (x.timeRange = (e.target as HTMLSelectElement).value as any));
    q('undo').onclick = () => this.undoLast();
    q('redo').onclick = () => this.redoLast();
    q('preview').onclick = () => {
      this.preview = !this.preview;
      this.selected = null;
      this.renderAll();
    };
    q('open').onclick = () => void this.openDialog();
    q('save').onclick = () => void this.save(false);
    q('close').onclick = () => void this.close();
    q('saveas')?.addEventListener('click', () => void this.save(true));
    q('apply')?.addEventListener('click', () => void this.applyDialog());
    q('versions')?.addEventListener('click', () => void this.versionsDialog());
    q('delete')?.addEventListener('click', () => void this.deleteDialog());
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

  renderLeft() {
    const left = this.root.querySelector('.dbb-left') as HTMLElement;
    left.hidden = this.preview;
    left.innerHTML = `<div class="dbb-sec">Widgets</div>
      <div class="dbb-palette">${WIDGET_TYPES.map(
        (t) => `<button class="dbb-pal" draggable="true" data-t="${t}" title="Drag onto the canvas or click to add">${ICON[t]}<span>${WIDGET_LABELS[t]}</span></button>`,
      ).join('')}</div>
      <div class="dbb-hint">Drag a widget onto the canvas, or click to add it. Select a widget to set its data and look.</div>
      <div class="dbb-sec" style="margin-top:14px">Layout</div>
      <div class="dbb-count">${this.draft.widgets.length} / ${MAX_WIDGETS} widgets</div>`;
    left.querySelectorAll<HTMLElement>('.dbb-pal').forEach((p) => {
      p.ondragstart = (e) => {
        e.dataTransfer!.setData('text/dbb-widget', p.dataset.t!);
        e.dataTransfer!.effectAllowed = 'copy';
      };
      p.onclick = () => this.addWidget(p.dataset.t as WidgetType);
    });
  }

  renderCanvas() {
    const canvas = this.root.querySelector('.dbb-canvas') as HTMLElement;
    const empty = this.root.querySelector('.dbb-empty') as HTMLElement;
    const env = { ctx: this.ctx, deviceId: this.deviceId, timeRange: this.draft.timeRange };
    if (!this.grid) {
      this.grid = new Grid(canvas, env, {
        editable: true,
        onSelect: (id) => {
          if (this.preview) return;
          this.selected = id;
          if (id) this.tab = 'settings';
          this.grid!.setOptions({ selectedId: id });
          this.renderRight();
        },
        onChange: (ws) => this.mutate((d) => (d.widgets = ws as Widget[])),
        onDrop: (t, x, y) => this.addWidget(t as WidgetType, { x, y }),
      });
    }
    canvas.classList.toggle('preview', this.preview);
    this.grid.setOptions({ selectedId: this.selected, highlight: this.highlight });
    const envChanged = (this.grid as any).env?.deviceId !== this.deviceId || (this.grid as any).env?.timeRange !== this.draft.timeRange;
    if (envChanged) this.grid.setEnv(env);
    this.grid.render(this.draft.widgets);
    empty.hidden = this.draft.widgets.length > 0;
    if (!this.draft.widgets.length) {
      const n = this.deviceId ? this.ctx.nodes.get(this.deviceId) : null;
      empty.innerHTML = `<div class="dbb-empty-card">
        <div class="dbb-empty-t">${n ? `Design a dashboard for ${esc(n.label)}` : 'Start a dashboard'}</div>
        <div class="dbb-empty-s">${n ? `Widgets set to <b>This machine</b> follow whichever ${esc(n.profile)} the dashboard is opened for.` : 'Pick a machine at the top to build a reusable machine dashboard, or build a standalone one from specific machines.'}</div>
        <div class="dbb-empty-a">
          ${n ? `<button class="dbb-btn" data-a="default">Start from the default layout</button>` : ''}
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
      empty.querySelector<HTMLElement>('[data-a="chat"]')?.addEventListener('click', () => {
        this.tab = 'chat';
        this.renderRight();
        (this.root.querySelector('.dbb-chat-in') as HTMLTextAreaElement)?.focus();
      });
    }
    const cnt = this.root.querySelector('.dbb-count');
    if (cnt) cnt.textContent = `${this.draft.widgets.length} / ${MAX_WIDGETS} widgets`;
  }

  renderRight() {
    const right = this.root.querySelector('.dbb-right') as HTMLElement;
    right.hidden = this.preview;
    const chatOn = this.o.chatEnabled !== false;
    right.innerHTML = `<div class="dbb-tabs">
        <button class="dbb-tab ${this.tab === 'settings' ? 'on' : ''}" data-tab="settings">Widget settings</button>
        ${chatOn ? `<button class="dbb-tab ${this.tab === 'chat' ? 'on' : ''}" data-tab="chat">Chat</button>` : ''}
      </div><div class="dbb-panel"></div>`;
    right.querySelectorAll<HTMLElement>('.dbb-tab').forEach((t) => (t.onclick = () => ((this.tab = t.dataset.tab as any), this.renderRight())));
    const panel = right.querySelector('.dbb-panel') as HTMLElement;
    if (this.tab === 'chat' && chatOn) this.renderChat(panel);
    else this.renderSettings(panel);
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
    if (!w) {
      panel.innerHTML = `<div class="dbb-ph" style="height:auto;padding:24px 8px">Select a widget on the canvas to edit its data and appearance.</div>`;
      return;
    }
    const cap = WIDGET_CAPS[w.type];
    const profiles = this.profilesForBinding(w);
    const allProfiles = [...new Set(scope.allDevices(this.ctx).map((d) => d.profile))];
    const nodes = [...this.ctx.nodes.values()].filter((n) => n.entityType === 'ASSET');
    const devices = scope.allDevices(this.ctx);
    const b = w.binding;
    const s = w.settings;
    const keyRows = (() => {
      if (cap.keys[1] === 0) return '';
      const keyset = new Map<string, { name: string; unit: string }>();
      for (const p of profiles) for (const k of this.ctx.profileKeys[p] ?? []) keyset.set(k.key, { name: k.displayName, unit: k.unit });
      if (!keyset.size) return `<div class="dbb-hint">Choose a data source first.</div>`;
      const multi = cap.keys[1] > 1;
      return `<div class="dbb-keys">${[...keyset.entries()]
        .map(
          ([k, m]) =>
            `<label class="dbb-check"><input type="${multi ? 'checkbox' : 'radio'}" name="k-${w.id}" value="${esc(k)}" ${w.keys.includes(k) ? 'checked' : ''}/> ${esc(m.name)}${m.unit ? ` <span class="dbb-muted">(${esc(m.unit)})</span>` : ''}</label>`,
        )
        .join('')}</div>${multi ? `<div class="dbb-hint">Up to ${cap.keys[1]} properties${cap.multiDevice ? `; ${MAX_SERIES} series in total` : ''}.</div>` : ''}`;
    })();

    const srcOpt = (mode: string, label: string, allowed = true) =>
      allowed ? `<label class="dbb-check"><input type="radio" name="src-${w.id}" value="${mode}" ${b.mode === mode ? 'checked' : ''}/> <span>${label}</span></label>` : '';
    const profSel = (cur: string | undefined, a: string) =>
      `<select data-s="${a}">${allProfiles.map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>`;

    panel.innerHTML = `
      <div class="dbb-form">
        <label class="dbb-field"><span>Title</span><input data-s="title" value="${esc(w.title)}" maxlength="120"/></label>
        <label class="dbb-field"><span>Widget type</span><select data-s="type">${WIDGET_TYPES.map((t) => `<option value="${t}" ${t === w.type ? 'selected' : ''}>${WIDGET_LABELS[t]}</option>`).join('')}</select></label>
        ${
          w.type === 'text'
            ? `<label class="dbb-field"><span>Text (Markdown: # heading, **bold**, - list)</span><textarea data-s="markdown" rows="6">${esc(s.markdown ?? '')}</textarea></label>`
            : `<div class="dbb-sec">1 · Data source</div>
        <div class="dbb-src">
          ${srcOpt('current', 'This machine <span class="dbb-muted">(whichever machine the dashboard is opened for)</span>', !!(this.deviceId || this.draft.profile))}
          ${srcOpt('fixed', 'Specific machines')}
          ${b.mode === 'fixed' ? `<div class="dbb-sub"><div class="dbb-keys">${devices
            .map(
              (d) =>
                `<label class="dbb-check"><input type="${cap.multiDevice ? 'checkbox' : 'radio'}" data-s="dev" value="${d.id}" ${b.deviceIds.includes(d.id) ? 'checked' : ''}/> ${esc(d.label)} <span class="dbb-muted">${esc(d.profile)}</span></label>`,
            )
            .join('')}</div>${b.deviceIds.some((id) => !this.ctx.nodes.has(id)) ? `<div class="dbb-hint">Includes machines outside your access (kept).</div>` : ''}</div>` : ''}
          ${cap.multiDevice ? srcOpt('siblings', 'Same-type machines at this machine\'s location', !!this.deviceId) : ''}
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
        <div class="dbb-sec">3 · Appearance</div>
        ${this.appearanceFields(w)}`
        }
        <div class="dbb-row" style="margin-top:14px">
          <button class="dbb-btn" data-s="dup">Duplicate</button>
          <button class="dbb-btn danger" data-s="del">Remove widget</button>
        </div>
      </div>`;

    const on = (sel: string, ev: string, fn: (e: any) => void) => panel.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, fn));
    on('[data-s="title"]', 'change', (e) => this.updateWidget(w.id, (x) => (x.title = e.target.value)));
    on('[data-s="markdown"]', 'change', (e) => this.updateWidget(w.id, (x) => (x.settings.markdown = e.target.value)));
    on('[data-s="type"]', 'change', (e) =>
      this.updateWidget(w.id, (x) => {
        const t = e.target.value as WidgetType;
        const c = WIDGET_CAPS[t];
        x.type = t;
        x.keys = x.keys.slice(0, c.keys[1]);
        if (t === 'text') {
          x.binding = { mode: 'none' };
          x.settings = { markdown: x.settings.markdown ?? `## ${x.title}` };
        } else if (x.binding.mode === 'none') x.binding = this.deviceId ? { mode: 'current' } : { mode: 'fixed', deviceIds: [scope.allDevices(this.ctx)[0]?.id].filter(Boolean) as string[] };
        if (!c.multiDevice && x.binding.mode === 'fixed') x.binding.deviceIds = x.binding.deviceIds.slice(0, 1);
        if (!c.multiDevice && (x.binding.mode === 'siblings' || x.binding.mode === 'nodeQuery')) x.binding = this.deviceId ? { mode: 'current' } : x.binding;
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
        if (mode === 'fixed') x.binding = { mode: 'fixed', deviceIds: this.deviceId ? [this.deviceId] : [devices[0]?.id].filter(Boolean) as string[] };
        if (mode === 'siblings') x.binding = { mode: 'siblings', profile: curProf };
        if (mode === 'nearest') x.binding = { mode: 'nearest', profile: allProfiles.find((p) => p !== curProf) ?? curProf };
        if (mode === 'nodeQuery') x.binding = { mode: 'nodeQuery', nodeId: this.ctx.rootIds[0] ?? nodes[0]?.id, profile: curProf };
        this.fixKeys(x);
      }),
    );
    on('[data-s="dev"]', 'change', () =>
      this.updateWidget(w.id, (x) => {
        const ids = [...panel.querySelectorAll<HTMLInputElement>('[data-s="dev"]:checked')].map((i) => i.value).slice(0, MAX_SERIES);
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
        const ks = [...panel.querySelectorAll<HTMLInputElement>(`input[name="k-${w.id}"]:checked`)].map((i) => i.value).slice(0, WIDGET_CAPS[x.type].keys[1]);
        const wasAuto = !x.title || x.title === WIDGET_LABELS[x.type] || profiles.some((p) => x.keys[0] && keyMeta(this.ctx, p, x.keys[0]).displayName === x.title);
        x.keys = ks;
        if (wasAuto && ks.length === 1 && profiles[0]) x.title = keyMeta(this.ctx, profiles[0], ks[0]).displayName;
      }),
    );
    this.wireAppearance(panel, w);
    on('[data-s="del"]', 'click', () => this.removeWidget(w.id));
    on('[data-s="dup"]', 'click', () => {
      const c: Widget = JSON.parse(JSON.stringify(w));
      c.id = newId();
      const p = firstFit(this.draft.widgets, c.w, c.h);
      c.x = p.x;
      c.y = p.y;
      this.mutate((d) => d.widgets.push(c));
      this.selected = c.id;
      this.renderAll();
    });
  }

  /** Drops keys that the new data source's machine types don't have. */
  fixKeys(x: Widget) {
    const profs = this.profilesForBinding(x);
    const known = new Set(profs.flatMap((p) => (this.ctx.profileKeys[p] ?? []).map((k) => k.key)));
    x.keys = x.keys.filter((k) => known.has(k));
    if (!x.keys.length && WIDGET_CAPS[x.type].keys[0] > 0) {
      const first = [...known].find((k) => !/status|hours/i.test(k)) ?? [...known][0];
      if (first) x.keys = [first];
    }
  }

  appearanceFields(w: Widget): string {
    const s = w.settings;
    const meta = this.profilesForBinding(w)[0] && w.keys[0] ? keyMeta(this.ctx, this.profilesForBinding(w)[0], w.keys[0]) : null;
    const f: string[] = [];
    const num = (a: string, label: string, v: number | undefined, ph = '') =>
      `<label class="dbb-field half"><span>${label}</span><input type="number" step="any" data-ap="${a}" value="${v ?? ''}" placeholder="${esc(ph)}"/></label>`;
    if (['value', 'gauge', 'line', 'bar', 'table'].includes(w.type)) {
      f.push(`<div class="dbb-row">
        <label class="dbb-field half"><span>Unit</span><input data-ap="unit" value="${esc(s.unit ?? '')}" placeholder="${esc(meta?.unit ?? '')}"/></label>
        ${num('decimals', 'Decimals', s.decimals, String(meta?.decimals ?? 1))}</div>`);
    }
    if (w.type === 'gauge') f.push(`<div class="dbb-row">${num('min', 'Min', s.min, String(meta?.min ?? 0))}${num('max', 'Max', s.max, String(meta?.max ?? 100))}</div>`);
    if (w.type === 'value' || w.type === 'gauge') {
      const b = s.bands ?? [];
      const g = b[0]?.upTo ?? '';
      const a = b[1]?.upTo ?? '';
      f.push(`<div class="dbb-field"><span>Colour thresholds</span>
        <div class="dbb-bands"><span class="dbb-dot" style="background:#0ca30c"></span> green up to <input type="number" step="any" data-ap="bandG" value="${g}"/>
        <span class="dbb-dot" style="background:#fab219"></span> amber up to <input type="number" step="any" data-ap="bandA" value="${a}"/>
        <span class="dbb-dot" style="background:#d03b3b"></span> red above</div></div>`);
    }
    if (w.type === 'status') {
      const m = s.statusMap ?? [
        { value: 1, label: 'Running', color: '#0ca30c' },
        { value: 0, label: 'Stopped', color: '#8a8983' },
      ];
      f.push(`<div class="dbb-field"><span>Value → label</span>${m
        .map((x, i) => `<div class="dbb-row"><input style="width:60px" data-sm="v${i}" value="${esc(x.value)}"/><input data-sm="l${i}" value="${esc(x.label)}"/><input type="color" data-sm="c${i}" value="${esc(x.color)}"/></div>`)
        .join('')}</div>`);
    }
    if (w.type === 'line' || w.type === 'bar')
      f.push(`<label class="dbb-field"><span>Aggregation</span><select data-ap="agg">${(w.type === 'bar' ? ['AVG', 'MIN', 'MAX', 'SUM'] : ['AVG', 'MIN', 'MAX', 'NONE'])
        .map((a) => `<option ${a === (s.agg ?? 'AVG') ? 'selected' : ''}>${a}</option>`)
        .join('')}</select></label>`);
    if (w.type === 'bar')
      f.push(`<label class="dbb-field"><span>Group by</span><select data-ap="groupBy">${['day', 'hour', 'device']
        .map((a) => `<option value="${a}" ${a === (s.groupBy ?? 'day') ? 'selected' : ''}>${a === 'device' ? 'compare machines' : a}</option>`)
        .join('')}</select></label>`);
    if (['line', 'bar', 'alarms'].includes(w.type))
      f.push(`<label class="dbb-field"><span>Time range</span><select data-ap="timeRange"><option value="">Dashboard (${this.draft.timeRange})</option>${TIME_RANGES.map(
        (r) => `<option ${r === s.timeRange ? 'selected' : ''}>${r}</option>`,
      ).join('')}</select></label>`);
    if (w.type === 'line') f.push(`<label class="dbb-check"><input type="checkbox" data-ap="showLegend" ${s.showLegend !== false ? 'checked' : ''}/> Show legend</label>`);
    if (w.type === 'alarms') {
      f.push(`<div class="dbb-field"><span>Severities</span><div class="dbb-row wrap">${['CRITICAL', 'MAJOR', 'MINOR', 'WARNING']
        .map((v) => `<label class="dbb-check"><input type="checkbox" data-sev value="${v}" ${!s.severities || s.severities.includes(v as any) ? 'checked' : ''}/> ${v.toLowerCase()}</label>`)
        .join('')}</div></div>`);
      f.push(`<div class="dbb-row"><label class="dbb-field half"><span>Status</span><select data-ap="alarmStatus">${['ANY', 'ACTIVE', 'CLEARED']
        .map((v) => `<option ${v === (s.alarmStatus ?? 'ANY') ? 'selected' : ''}>${v}</option>`)
        .join('')}</select></label>${num('maxRows', 'Max rows', s.maxRows, '20')}</div>`);
    }
    return f.join('') || '<div class="dbb-hint">No appearance options.</div>';
  }

  wireAppearance(panel: HTMLElement, w: Widget) {
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ap]').forEach((inp) =>
      inp.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const a = inp.dataset.ap!;
          const v = (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : inp.value;
          const s: any = x.settings;
          if (a === 'bandG' || a === 'bandA') {
            const g = (panel.querySelector('[data-ap="bandG"]') as HTMLInputElement).value;
            const am = (panel.querySelector('[data-ap="bandA"]') as HTMLInputElement).value;
            if (g === '' && am === '') delete s.bands;
            else
              s.bands = [
                { upTo: g === '' ? null : Number(g), color: '#0ca30c' },
                ...(am !== '' ? [{ upTo: Number(am), color: '#fab219' }] : []),
                { upTo: null, color: '#d03b3b' },
              ].filter((b, i, arr) => !(b.upTo === null && i < arr.length - 1));
            return;
          }
          if (['decimals', 'min', 'max', 'maxRows'].includes(a)) {
            if (v === '') delete s[a];
            else s[a] = a === 'decimals' || a === 'maxRows' ? Math.max(0, Math.round(Number(v))) : Number(v);
          } else if (a === 'showLegend') s.showLegend = v;
          else if (v === '') delete s[a];
          else s[a] = v;
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
    panel.querySelectorAll<HTMLInputElement>('[data-sm]').forEach((c) =>
      c.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const rows = [0, 1].map((i) => ({
            value: (panel.querySelector(`[data-sm="v${i}"]`) as HTMLInputElement).value,
            label: (panel.querySelector(`[data-sm="l${i}"]`) as HTMLInputElement).value,
            color: (panel.querySelector(`[data-sm="c${i}"]`) as HTMLInputElement).value,
          }));
          x.settings.statusMap = rows.map((r) => ({ ...r, value: Number.isFinite(Number(r.value)) && r.value !== '' ? Number(r.value) : r.value }));
        }),
      ),
    );
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
    const problems = checkDashboard(d);
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
    const initial = p?.target === 'customer' && admin ? 'customer' : p?.target === 'node' && admin ? 'node' : dev && isDeviceDash ? 'device' : 'none';

    const m = modal(
      this.root,
      'Apply dashboard',
      `
      <div class="dbb-form">
        <div class="dbb-hint">Choose which machines show “${esc(d.name)}”. ${isDeviceDash ? `It is a <b>${esc(profile!)}</b> dashboard: “This machine” widgets follow each machine.` : 'It is a standalone dashboard (fixed machines); open it from My dashboards.'}</div>
        ${
          isDeviceDash && dev && dev.profile === profile
            ? `<label class="dbb-check"><input type="radio" name="t" value="personal"/> Only for me, on ${esc(dev.label)}</label>
               <label class="dbb-check"><input type="radio" name="t" value="device" ${initial === 'device' ? 'checked' : ''}/> ${esc(dev.label)} (everyone)</label>`
            : ''
        }
        ${
          isDeviceDash
            ? `<label class="dbb-check ${admin ? '' : 'dis'}"><input type="radio" name="t" value="selected" ${admin ? '' : 'disabled'}/> Selected ${esc(profile!)} machines${admin ? '' : ' <span class="dbb-muted">(admins only)</span>'}</label>
               <div class="dbb-sub" data-for="selected" hidden><div class="dbb-keys">${sameType
                 .map((x) => `<label class="dbb-check"><input type="checkbox" data-sel value="${x.id}" ${x.id === dev?.id ? 'checked' : ''}/> ${esc(x.label)} <span class="dbb-muted">${esc(scope.pathLabel(this.ctx, x.parentId ?? x.id))}</span></label>`)
                 .join('')}</div>
                 <div class="dbb-row"><label class="dbb-check"><input type="radio" name="lm" value="linked" checked/> Linked <span class="dbb-muted">(one dashboard; later edits update all)</span></label></div>
                 <div class="dbb-row"><label class="dbb-check"><input type="radio" name="lm" value="copy"/> Copy <span class="dbb-muted">(each machine gets its own copy)</span></label></div></div>
               <label class="dbb-check ${admin ? '' : 'dis'}"><input type="radio" name="t" value="node" ${initial === 'node' ? 'checked' : ''} ${admin && nodes.length ? '' : 'disabled'}/> All ${esc(profile!)} machines under a location <span class="dbb-muted">(includes machines added later)</span></label>
               <div class="dbb-sub" data-for="node" hidden><select data-node>${nodes
                 .map((n) => `<option value="${n.id}" ${p?.nodeId === n.id ? 'selected' : ''}>${esc(scope.pathLabel(this.ctx, n.id))}</option>`)
                 .join('')}</select></div>
               <label class="dbb-check ${admin ? '' : 'dis'}"><input type="radio" name="t" value="customer" ${initial === 'customer' ? 'checked' : ''} ${admin ? '' : 'disabled'}/> All ${esc(profile!)} machines <span class="dbb-muted">(customer-wide, includes machines added later)</span></label>`
            : ''
        }
        <label class="dbb-check"><input type="radio" name="t" value="none" ${initial === 'none' ? 'checked' : ''}/> Don't apply now</label>
        ${!admin ? `<div class="dbb-hint">Applying to more than one machine needs an Admin role.</div>` : ''}
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
      if (t === 'personal') return { type: 'personal', deviceId: dev!.id };
      if (t === 'device') return { type: 'devices', deviceIds: [dev!.id], mode: 'linked' };
      if (t === 'selected')
        return {
          type: 'devices',
          deviceIds: [...body.querySelectorAll<HTMLInputElement>('[data-sel]:checked')].map((i) => i.value),
          mode: ((body.querySelector('input[name="lm"]:checked') as HTMLInputElement)?.value as any) ?? 'linked',
        };
      if (t === 'node') return { type: 'node', nodeId: (body.querySelector('[data-node]') as HTMLSelectElement).value, profile: profile! };
      if (t === 'customer') return { type: 'customer', profile: profile! };
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
