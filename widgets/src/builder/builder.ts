/**
 * Full-screen Dashboard Builder overlay.
 *
 * Where it runs: in the browser, inside a ThingsBoard CE page. The code is part of the shared
 * IIFE bundle (`widgets/dist/imex-dbb.js`) embedded in each custom widget type (DECISIONS D-010).
 * The builder is not a widget itself: it appends a fixed overlay `<div class="dbb-root dbb-overlay">`
 * to `document.body` and removes it on close.
 *
 * Main export: `openBuilder(options)`. Callers:
 *   - `entries/launcher.ts` `open()` - the navbar edit menu's "Dashboard Builder" item
 *     (also reachable via `window.IMEX_DBB.open`).
 *   - `entries/renderer.ts` - "Edit this dashboard" on the machine page.
 * Both pass an `onClose(changed)` callback so the page can refresh after a save/apply/delete.
 *
 * Modules it calls:
 *   - `core/store`  - load/save/apply/delete dashboards and resolve what a machine shows. Every
 *                     write goes to ThingsBoard attributes over REST with the user's own JWT
 *                     (storage layout: DECISIONS D-013).
 *   - `core/chat`   - chat turns via the rule-chain relay (D-014).
 *   - `core/schema` - Dashboard/Widget types, limits (MAX_WIDGETS, MAX_KEYS, MAX_DEVICES) and
 *                     `checkDashboard` (D-020).
 *   - `core/compat` - which property kinds each widget type accepts (D-020).
 *   - `core/scope`  - the user's machine tree (from `selectedNodes`, D-011).
 *   - `core/audit`  - `dbb_audit` entries for save/apply/restore/delete/chat (D-012).
 *   - `render/grid` - the 12-column drag/resize canvas; `render/*` draws the widget cards.
 *   - `./editors`   - Style / Colours / Theme / rich-text sub-editors; `./ui` - modal, toast.
 *
 * Key concepts and data flow:
 *   - `draft` is the in-memory Dashboard being edited. Nothing reaches ThingsBoard until Save
 *     (or Apply / Restore / Delete, which write immediately).
 *   - `baseline` is the JSON of the last loaded/saved draft; `dirty()` compares against it.
 *   - Undo/redo are stacks of JSON snapshots (max 50). `commit`/`mutate` push one snapshot per
 *     change and redraw everything. `quiet`/`quietWidget` are for sub-editors: they coalesce
 *     rapid edits from the same source into one undo step and do not rebuild the right panel,
 *     so inputs keep focus.
 *   - Layout: top bar (machine, name, time range, tools), banner row, left palette, centre
 *     canvas (Grid), right panel (Widget/Dashboard settings, Style, Colours, Chat tabs).
 *   - Save validates with `checkDashboard`, stores via `store.saveDashboard` (optimistic
 *     concurrency on `version`), then on first save / chat proposal / save-as opens the Apply
 *     dialog (D-017).
 *
 * Security: the admin check in `openBuilder` and every "only admins" branch here are UI-only.
 * CE lets any customer user write these attributes through REST (DECISIONS D-012).
 */
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

/** Options for {@link openBuilder}. */
export interface BuilderOptions {
  /** Logged-in user's context: scope tree, role, store asset, profile key catalogue (see core/scope). */
  ctx: UserContext;
  /** Machine to start on. Ignored (treated as none) if it is not in the user's scope. */
  deviceId?: string | null;
  /** Saved dashboard to open directly; takes precedence over `deviceId` for what is loaded. */
  dashboardId?: string | null;
  /** Show the Chat tab and "Describe it in chat" button. Defaults to true (only `false` hides it). */
  chatEnabled?: boolean;
  /** Called after the overlay is removed. `changed` is true if anything was saved, applied or deleted. */
  onClose?(changed: boolean): void;
}

/** Palette icons (SVG markup) per widget type. */
const ICON = WIDGET_ICON as Record<WidgetType, string>;

/**
 * One-line descriptions shown in the palette tooltip; also matched by the palette search.
 * Note: some texts predate the D-020 limits (8 lines per chart, bars per 15 min/hour, heatmap
 * as machines x time); the schema/renderer are authoritative.
 */
const HELP: Record<WidgetType, string> = {
  value: 'Latest value of one property, coloured by rules',
  kpi: 'Big number with a trend sparkline and % change',
  gauge: 'Half-circle gauge with rule zones',
  progress: 'Horizontal or vertical (tank) level bar',
  status: 'Running / stopped / fault pill',
  multivalue: 'Several properties of one machine in one card',
  summary: 'Min, average, max and current over the time range',
  line: 'Trends of up to 4 properties, with threshold lines',
  area: 'Filled trend; can stack series',
  bar: 'Every 15 minutes, per hour or machine-by-machine bars',
  donut: 'Share of time in each state, or share by machine',
  timeline: 'When each machine was running, stopped or faulted',
  heatmap: 'Machines × time pattern of a property',
  table: 'Machines as rows, properties as columns, coloured cells',
  alarms: 'Alarm list with severity filters',
  text: 'Headings and notes with fonts, colours and live values',
  image: 'Logo, photo or diagram from an address or upload',
  link: 'Button that opens a page of the app or a website',
  embed: 'Another web page inside the dashboard',
};

/**
 * Opens the full-screen Dashboard Builder over the current page.
 *
 * Side effects: injects the core, grid and builder stylesheets once (by id), appends the overlay
 * to `document.body`, adds `keydown` and `beforeunload` listeners (removed on close) and starts
 * loading `o.dashboardId` or the dashboard `o.deviceId` currently shows.
 *
 * @param o builder options; `o.ctx.isAdmin` must be true.
 * @returns the Builder instance (callers normally ignore it).
 * @throws Error if the user is not an admin.
 */
export function openBuilder(o: BuilderOptions) {
  // Building is admin-only (scope decision 27 Sep 2026, DECISIONS D-017). UI-level check only; see D-012.
  if (!o.ctx.isAdmin) throw new Error('Only admins can build dashboards.');
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-grid', GRID_CSS);
  ensureCss('dbb-css-builder', BUILDER_CSS);
  const b = new Builder(o);
  b.mount();
  return b;
}

/**
 * The builder overlay: holds the draft, undo/redo stacks and UI state, and renders every region.
 * Not exported; create it through {@link openBuilder}.
 *
 * Rendering is plain innerHTML + event wiring per region (`renderTop`, `renderBanner`,
 * `renderLeft`, `renderCanvas`, `renderRight`). `renderAll` redraws all of them; most state
 * changes go through `commit`, which calls it.
 */
class Builder {
  ctx: UserContext;
  /** The overlay element; all DOM queries are scoped to it. */
  root!: HTMLElement;
  /** Canvas grid, created lazily on the first `renderCanvas`. */
  grid: Grid | null = null;
  /** Machine the draft is previewed for ("This machine" widgets read from it); null = standalone. */
  deviceId: string | null;
  /** Dashboard being edited. Replace it via commit/mutate/quiet/loadDraft, not by direct assignment. */
  draft: Dashboard;
  /** JSON of the last loaded or saved draft; `dirty()` compares against it. */
  baseline = '';
  /** Id of the selected widget, or null (right panel then shows dashboard settings/theme). */
  selected: string | null = null;
  /** Undo/redo stacks of draft JSON snapshots. Undo is capped at 50 entries. */
  undo: string[] = [];
  redo: string[] = [];
  /** Preview mode hides the side panels and disables selection. */
  preview = false;
  /** Active right-panel tab ('rules' is shown as "Colours"). */
  tab: 'settings' | 'style' | 'rules' | 'chat' = 'settings';
  /** Palette search text. */
  palFilter = '';
  /** Time and tag of the last `quiet` update; used to merge rapid edits into one undo step. */
  quietAt = 0;
  quietKey = '';
  /** Messages shown in the Chat tab (UI only). */
  chatLog: { role: 'user' | 'assistant' | 'system'; text: string; changed?: chat.ChatResult['changed']; options?: string[] }[] = [];
  /** Conversation sent to the LLM on each turn. Reset when another dashboard is loaded. */
  chatHistory: chat.Turn[] = [];
  /** Draft JSON from before the first chat change since load/save; enables "Discard chat changes". */
  preChat: string | null = null;
  /** Apply target suggested by chat; the Apply dialog opens with it pre-selected after the next Save. */
  pendingApply: chat.ApplyProposal | null = null;
  /** Widget ids briefly highlighted on the canvas ("Highlight" link in chat). */
  highlight = new Set<string>();
  /** True while a REST call or chat turn is in flight (spinner shown, chat Send disabled). */
  busy = false;
  /** Reported to `onClose` so the host page knows to reload. */
  savedAnything = false;
  /** What the selected machine currently shows (store.resolveForDevice); drives the banner. */
  source: store.Resolved | null = null;
  /** Machines using the draft and machines with customised copies of it (store.usage). */
  usageInfo: { devices: string[]; customised: string[] } | null = null;
  // Kept as fields so the same function references can be removed in close().
  keyHandler = (e: KeyboardEvent) => this.onKey(e);
  unloadHandler = (e: BeforeUnloadEvent) => {
    if (this.dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  /** Starts with a blank draft; `mount()` then loads the real dashboard asynchronously. */
  constructor(private o: BuilderOptions) {
    this.ctx = o.ctx;
    // A device outside the user's scope is silently dropped (standalone mode).
    this.deviceId = o.deviceId && this.ctx.nodes.has(o.deviceId) ? o.deviceId : null;
    this.draft = store.blankDashboard(this.ctx, 'Untitled dashboard', this.deviceId ? this.ctx.nodes.get(this.deviceId)!.profile : null);
    this.baseline = JSON.stringify(this.draft);
  }

  // ---------- lifecycle ----------

  /**
   * Adds the overlay to `document.body`, registers keyboard and beforeunload listeners and
   * loads the initial content: `dashboardId` first, else what `deviceId` shows, else an empty draft.
   */
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

  /**
   * Closes the overlay after confirming if there are unsaved changes. Removes listeners,
   * destroys the grid and calls `onClose(savedAnything)`. Does nothing if the user cancels.
   */
  async close() {
    if (this.dirty() && !(await confirmModal(this.root, 'Discard unsaved changes?', 'You have changes that are not saved.', 'Discard', true))) return;
    document.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('beforeunload', this.unloadHandler);
    this.grid?.destroy();
    this.root.remove();
    this.o.onClose?.(this.savedAnything);
  }

  /** True if the draft differs from the baseline. An empty draft is never dirty (nothing to lose). */
  dirty() {
    return JSON.stringify(this.draft) !== this.baseline && this.draft.widgets.length > 0;
  }

  // ---------- state changes ----------
  // Every edit replaces `draft` with a new object and pushes the old one (as JSON) on the undo stack.

  /**
   * Makes `next` the draft as one undo step and redraws everything.
   * Clears redo unless `opts.keepRedo`. Recomputes `kind` (device vs standalone) from the widgets.
   * @param next new draft; must not share objects with the current draft.
   */
  commit(next: Dashboard, opts: { keepRedo?: boolean } = {}) {
    this.undo.push(JSON.stringify(this.draft));
    if (this.undo.length > 50) this.undo.shift();
    if (!opts.keepRedo) this.redo = [];
    // kind decides whether the dashboard can be applied to machines (device) or is standalone.
    next.kind = dashboardKind(next.widgets);
    this.draft = next;
    this.renderAll();
  }

  /** Edits a deep copy of the draft with `fn`, then commits it (one undo step, full redraw). */
  mutate(fn: (d: Dashboard) => void) {
    const d: Dashboard = JSON.parse(JSON.stringify(this.draft));
    fn(d);
    this.commit(d);
  }

  /** Restores the previous snapshot (Ctrl+Z, toolbar, or "undo" in chat). No-op when the stack is empty. */
  undoLast() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(prev);
    // The selected widget may not exist in the older snapshot.
    if (this.selected && !this.draft.widgets.some((w) => w.id === this.selected)) this.selected = null;
    this.renderAll();
  }

  /** Re-applies the last undone snapshot (Ctrl+Shift+Z). */
  redoLast() {
    const nxt = this.redo.pop();
    if (!nxt) return;
    this.undo.push(JSON.stringify(this.draft));
    this.draft = JSON.parse(nxt);
    this.renderAll();
  }

  /**
   * Document-level shortcuts: Ctrl/Cmd+Z undo, +Shift redo, Delete/Backspace removes the selected
   * widget, Escape closes (unless a modal is open). Ignored while typing in form fields.
   */
  onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    // Let inputs keep their native undo and Backspace. (contenteditable is not excluded.)
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

  /**
   * Switches the builder to machine `id` (or to no machine) and loads the dashboard that machine
   * shows now (personal -> device -> location -> customer-wide, see D-013), or a blank draft
   * for its profile when it only shows the default layout.
   * Asks first if the draft is dirty. REST: store.resolveForDevice, then store.usage in the background.
   * Load errors are shown as a toast; the previous draft stays.
   */
  async selectMachine(id: string | null) {
    if (this.dirty() && !(await confirmModal(this.root, 'Switch machine?', 'Unsaved changes to the current dashboard will be lost.', 'Switch', true))) {
      // Re-render so the machine <select> goes back to the current machine.
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

  /**
   * Loads saved dashboard `id` from the store asset into the draft. If its machine type differs
   * from the selected machine, switches to the first in-scope machine of that type (or none),
   * so "This machine" widgets have data to preview. Does not ask about unsaved changes;
   * callers (Open dialog, mount) are responsible for that.
   */
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

  /**
   * Replaces the draft with a copy of `d` and treats it as clean: resets baseline, undo/redo,
   * selection and the chat conversation. Redraws everything.
   */
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

  /**
   * Refreshes `usageInfo` (which machines use the draft / have customised copies) and the banner.
   * Skipped for unsaved or standalone dashboards. store.usage resolves every same-type machine
   * in scope, so this can take several seconds on a slow server; errors are ignored.
   */
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

  /**
   * Adds a widget of `type` with sensible defaults: first compatible property of the machine type
   * (D-020), a title from that property, type-specific settings, and "This machine" binding when a
   * machine is selected. Placed at `at` (a canvas drop) or in the first free grid slot.
   * Refuses with a toast when the page already has MAX_WIDGETS (10, D-020) or no property of the
   * machine type fits. Selects the new widget and opens the Widget tab.
   */
  addWidget(type: WidgetType, at?: { x: number; y: number }) {
    if (this.draft.widgets.length >= MAX_WIDGETS) return toast(this.root, `A dashboard can have at most ${MAX_WIDGETS} widgets.`, 'warn');
    const size = DEFAULT_SIZE[type];
    const profile = this.draft.profile ?? (this.deviceId ? this.ctx.nodes.get(this.deviceId)?.profile ?? null : null);
    const metas = profile ? this.ctx.profileKeys[profile] ?? [] : [];
    const keys = metas.map((k) => k.key);
    const content = CONTENT_TYPES.has(type);
    // A new donut starts in "time in each state" mode.
    const mode = type === 'donut' ? 'state' : undefined;
    const ok = metas.filter((m) => compatible(type, m, { donutMode: mode }).ok);
    // With no catalogue for the profile we can't judge, so allow it.
    if (!content && type !== 'alarms' && profile && metas.length && !ok.length) return toast(this.root, this.paletteBlock(type) ?? `No property of ${profile} fits this widget.`, 'warn');
    // Prefer a live property over running-hours counters.
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
    // On/off property on a state widget: start with the Running/Stopped preset.
    if (firstKey && firstKey === statusKey && ['status', 'timeline', 'donut'].includes(type))
      w.settings.colorRules = [
        { op: 'isTrue', color: '#0ca30c', label: 'Running' },
        { op: 'isFalse', color: '#8a8983', label: 'Stopped' },
      ];
    if (w.keys.length === 1 && profile && !content) w.title = keyMeta(this.ctx, profile, w.keys[0]).displayName + (type === 'timeline' ? ' · timeline' : type === 'heatmap' ? ' · heatmap' : '');
    if (at) {
      // Keep the widget inside the 12-column grid.
      w.x = Math.min(at.x, 12 - w.w);
      w.y = at.y;
    } else {
      const p = firstFit(this.draft.widgets, w.w, w.h);
      w.x = p.x;
      w.y = p.y;
    }
    this.mutate((d) => {
      // The first "This machine" widget ties the dashboard to the machine type.
      if (!d.profile && profile && w.binding.mode === 'current') d.profile = profile;
      d.widgets.push(w);
    });
    // Resolve overlaps from a drop position. Assigned directly (not via mutate), so it is part of
    // the same undo step as the add.
    if (at) {
      this.draft.widgets = resolveCollisions(this.draft.widgets, w.id) as Widget[];
      this.renderAll();
    }
    this.selected = w.id;
    this.tab = 'settings';
    this.renderAll();
  }

  /** Removes widget `id` (one undo step) and clears the selection if it was selected. */
  removeWidget(id: string) {
    this.mutate((d) => (d.widgets = d.widgets.filter((w) => w.id !== id)));
    if (this.selected === id) this.selected = null;
    this.renderAll();
  }

  /**
   * Edits widget `id` in a copy of the draft as one undo step, with a full redraw (including the
   * right panel). Use for form fields in the Widget tab; sub-editors use `quietWidget` instead.
   */
  updateWidget(id: string, fn: (w: Widget) => void) {
    this.mutate((d) => {
      const w = d.widgets.find((x) => x.id === id);
      if (w) fn(w);
    });
  }

  /**
   * Update from a sub-editor (rich text, rules, style, theme): redraws the top bar and canvas but
   * keeps the right panel (so colour pickers and the text editor keep focus), unless
   * `opts.panel` is set. Edits with the same `tag` less than 1.5 s apart coalesce into one undo
   * step. Always clears redo.
   * @param tag identifies the edit source, e.g. 'theme' or '<widgetId>:style'.
   */
  quiet(tag: string, fn: (d: Dashboard) => void, opts: { panel?: boolean } = {}) {
    const d: Dashboard = JSON.parse(JSON.stringify(this.draft));
    fn(d);
    const now = Date.now();
    // Only the first edit of a burst pushes an undo snapshot. The 1.5 s window restarts on every
    // edit, so continuous typing or dragging a colour picker stays one step.
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

  /** `quiet` for a single widget; the undo-coalescing tag is `<id>:<tag>`. No-op if the widget is gone. */
  quietWidget(id: string, tag: string, fn: (w: Widget) => void, opts: { panel?: boolean } = {}) {
    this.quiet(`${id}:${tag}`, (d) => {
      const w = d.widgets.find((x) => x.id === id);
      if (w) fn(w);
    }, opts);
  }

  // ---------- rendering ----------
  // Each render* method rebuilds one region's innerHTML and re-attaches its handlers.

  /** Creates the empty region containers once; the render* methods fill them. */
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

  /** Redraws every region. */
  renderAll() {
    this.renderTop();
    this.renderBanner();
    this.renderLeft();
    this.renderCanvas();
    this.renderRight();
  }

  /** Shows or hides the full-overlay spinner with `label`, and sets `busy`. */
  setBusy(on: boolean, label = '') {
    this.busy = on;
    const b = this.root.querySelector('.dbb-busy') as HTMLElement;
    if (!b) return;
    b.hidden = !on;
    (b.querySelector('span') as HTMLElement).textContent = label;
  }

  /**
   * `<option>` HTML for the Machine select: in-scope devices sorted by path and grouped by their
   * parent location, plus a "No machine (standalone)" option.
   */
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

  /**
   * Info/warning strip under the top bar: scope warnings from the user context, what the
   * selected machine shows now and where it comes from, how many machines a save will update,
   * machines with customised copies (not updated by a save), and "machine-specific copy".
   */
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

  /**
   * Top bar: machine picker, dashboard name, time range (Realtime or Historic 1-8 h, D-020) and
   * tools (Open, Templates, Undo/Redo, Preview, History, Delete, Save as, Apply, Save, Close).
   * History, Save as and Apply appear only once the dashboard has been saved (version > 0).
   */
  renderTop() {
    const top = this.root.querySelector('.dbb-top') as HTMLElement;
    const d = this.draft;
    // Mirrors store.deleteDashboard's owner-or-admin rule (UI-only, D-012).
    const canDelete = d.version > 0 && (d.ownerId === this.ctx.userId || this.ctx.isAdmin);
    // Wraps SVG path markup in a 24x24 stroke icon.
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
        // Switching to Historic from Realtime starts at 1 h; clicking Historic again keeps the current range.
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

  /**
   * Left palette: searchable widget tiles grouped by WIDGET_GROUPS, and the "n / MAX_WIDGETS"
   * counter. Tiles that can't be added (see `paletteBlock`) are greyed out and only explain why
   * on click. Other tiles add on click or can be dragged onto the canvas ('text/dbb-widget').
   */
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
    // Re-rendering replaces the search input, so restore focus and caret on the new one.
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

  /**
   * Draws the draft on the Grid canvas (live data for the selected machine), applies the theme,
   * and shows the empty-state card (templates, default layout, chat) when there are no widgets.
   * Creates the Grid on first call; its callbacks route selection, drag/resize, palette drops and
   * card actions (delete/duplicate) back into the builder.
   */
  renderCanvas() {
    const canvas = this.root.querySelector('.dbb-canvas') as HTMLElement;
    const center = this.root.querySelector('.dbb-center') as HTMLElement;
    const empty = this.root.querySelector('.dbb-empty') as HTMLElement;
    const themeSig = JSON.stringify(this.draft.theme ?? {});
    const { dark } = applyTheme(center, this.draft.theme);
    // editing: true keeps link widgets inert and marks cards as editable in the renderers.
    const env = { ctx: this.ctx, deviceId: this.deviceId, timeRange: this.draft.timeRange, theme: this.draft.theme ?? null, dark, editing: true };
    if (!this.grid) {
      this.grid = new Grid(canvas, env, {
        editable: true,
        onSelect: (id) => {
          if (this.preview) return;
          const was = this.selected;
          this.selected = id;
          // Selecting a widget from the dashboard view leaves Chat for the widget's settings.
          if (id && !was && this.tab === 'chat') this.tab = 'settings';
          this.grid!.setOptions({ selectedId: id });
          this.renderRight();
        },
        onChange: (ws) => this.mutate((d) => (d.widgets = ws as Widget[])),
        onDrop: (t, x, y) => this.addWidget(t as WidgetType, { x, y }),
        onAction: (id, a) => (a === 'del' ? this.removeWidget(id) : this.duplicate(id)),
      });
      // Remember the theme the grid was built with (ad-hoc field) to detect theme changes below.
      (this.grid as any).__theme = themeSig;
    }
    canvas.classList.toggle('preview', this.preview);
    this.grid.setOptions({ selectedId: this.selected, highlight: this.highlight });
    // setEnv force-redraws every card (reloading its data), so only call it when machine, range or
    // theme changed. render() alone redraws just the widgets whose config changed.
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
    // Redraw the palette only when the page crosses the MAX_WIDGETS limit (tiles grey out / come back).
    if (this.palFull !== this.draft.widgets.length >= MAX_WIDGETS) this.renderLeft();
  }

  /** Whether the palette was last drawn with a full page; set as a side effect of `paletteBlock`. */
  palFull = false;

  /**
   * Why a palette widget can't be added right now (page full, or no property of this machine type
   * fits, D-020), or null. Content widgets and alarms never need a property. With no machine type
   * or an empty catalogue nothing is blocked. A donut is allowed if either of its modes fits.
   * Side effect: updates `palFull`.
   */
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

  /** Copies widget `id` (new id, first free grid slot) and selects the copy. Respects MAX_WIDGETS. */
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

  /** HTML for one template tile: a mini layout preview in the template's colours, name and description. */
  tplCard(t: (typeof TEMPLATES)[number]): string {
    const [a, b, c] = t.swatch;
    return `<button class="dbb-tpl" data-tpl="${t.id}" title="${esc(t.description)}">
      <span class="pv" style="background:${a}"><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface};grid-column:1/3"><b style="background:${b}"></b></i><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface}"><b style="background:${c}"></b></i><i style="background:${PRESETS[t.theme.preset ?? 'light'].surface};grid-column:1/4"><b style="background:${b};width:70%"></b></i></span>
      <span class="nm">${esc(t.name)}</span><span class="ds">${esc(t.description)}</span></button>`;
  }

  /**
   * Replaces the draft's widgets, theme and time range with template `id`, built from the selected
   * machine's properties (D-019). Needs a selected machine. Asks first if the draft has widgets.
   * Renames the draft only if it is unsaved and still has a default or template-generated name.
   * One undo step.
   */
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

  /** Modal with every template; picking one calls `useTemplate`. */
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

  /**
   * Right panel. With a widget selected: Widget / Style / Colours (data widgets only) tabs.
   * With nothing selected: Dashboard (theme) tab. Plus Chat when enabled. Falls back to the
   * settings tab when the current tab doesn't apply to the selection.
   */
  renderRight() {
    const right = this.root.querySelector('.dbb-right') as HTMLElement;
    right.hidden = this.preview;
    const chatOn = this.o.chatEnabled !== false;
    const w = this.draft.widgets.find((x) => x.id === this.selected);
    if (!w && (this.tab === 'style' || this.tab === 'rules')) this.tab = 'settings';
    // Content widgets and alarms have no values to colour.
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

  /** Dashboard tab: theme editor (D-019). Changes are quiet updates tagged 'theme'; null theme removes it. */
  renderTheme(panel: HTMLElement) {
    themeEditor(panel, this.draft.theme, (t) => {
      this.quiet('theme', (d) => {
        if (t) d.theme = t;
        else delete d.theme;
      });
      this.renderRight();
    }, { onTemplates: () => void this.templatesDialog() });
  }

  /**
   * Style tab for widget `w` (D-019/D-020: icon, title, card look, alignment, description, footer).
   * Edits are quiet updates. "Copy style to all" is a normal (full-redraw) step and keeps each
   * widget's own icon. Empty description text removes the description.
   */
  renderStyle(panel: HTMLElement, w: Widget) {
    styleEditor(panel, {
      widget: w,
      onChange: (style, extra) => {
        this.quietWidget(w.id, 'style', (x) => {
          if (style) x.settings.style = style;
          else delete x.settings.style;
          // extra: non-style settings the editor owns (e.g. footer); undefined deletes the key.
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

  /**
   * Colours tab: value-based colour rules for widget `w` (D-019).
   * For a "This machine" widget it first reads the latest values (REST `api.latest`) so the rule
   * editor can guess the property type from real samples; on failure it uses the catalogue only.
   * Setting rules drops the legacy `bands` / `statusMap` settings.
   */
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
      // The user may have switched widget or tab while the request was in flight.
      if (this.selected !== w.id || this.tab !== 'rules') return;
    }
    // Use the current copy: the draft may have changed during the await.
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
    // Keeps the import referenced (unused here).
    void initialRules;
  }

  // ---------- settings panel ----------

  /**
   * Machine types (device profiles) a widget's data source can cover: the dashboard's profile for
   * "This machine", the profiles of the chosen devices for "Specific machines", none for content
   * widgets, else the binding's own profile (siblings / nearest / nodeQuery).
   */
  profilesForBinding(w: Widget): string[] {
    const b = w.binding;
    if (b.mode === 'current') return this.draft.profile ? [this.draft.profile] : this.deviceId ? [this.ctx.nodes.get(this.deviceId)!.profile] : [];
    if (b.mode === 'fixed') return [...new Set(b.deviceIds.map((id) => this.ctx.nodes.get(id)?.profile).filter(Boolean) as string[])];
    if (b.mode === 'none') return [];
    return [b.profile];
  }

  /**
   * Widget tab for the selected widget: title, type, then either content fields (text/image/
   * link/embed) or 1 Data source, 2 Properties, 3 Options. Enforces the D-020 limits in the UI:
   * at most MAX_KEYS properties, MAX_DEVICES specific machines, and greys out properties and
   * widget types that don't fit (reason in the tooltip). Every change is a normal undo step
   * via `updateWidget`.
   */
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
    // Property list: radios for single-key widgets, checkboxes (capped at cap.keys[1]) otherwise.
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

    // ----- event wiring -----
    const on = (sel: string, ev: string, fn: (e: any) => void) => panel.querySelectorAll(sel).forEach((x) => x.addEventListener(ev, fn));
    on('[data-go]', 'click', (e) => {
      e.preventDefault();
      this.tab = e.currentTarget.dataset.go;
      this.renderRight();
    });
    on('[data-s="title"]', 'change', (e) => this.updateWidget(w.id, (x) => (x.title = e.target.value)));
    // Changing the widget type: trim keys to the new cap, switch binding between content (none) and
    // data, keep only style/description/footer for content types, swap to a fitting property
    // (D-020), and grow to the new type's minimum height (full width if the type is full-width).
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
        // Single-machine types can't keep multi-machine bindings.
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
    // Data source radio: build a default binding for the chosen mode.
    on(`input[name="src-${w.id}"]`, 'change', (e) =>
      this.updateWidget(w.id, (x) => {
        const mode = e.target.value;
        const curProf = this.deviceId ? this.ctx.nodes.get(this.deviceId)!.profile : allProfiles[0];
        if (mode === 'current') x.binding = { mode: 'current' };
        if (mode === 'fixed') x.binding = { mode: 'fixed', deviceIds: this.deviceId ? [this.deviceId] : ([devices[0]?.id].filter(Boolean) as string[]) };
        if (mode === 'siblings') x.binding = { mode: 'siblings', profile: curProf };
        // "Nearest" usually means another type (e.g. the site weather station), so default to a different profile.
        if (mode === 'nearest') x.binding = { mode: 'nearest', profile: allProfiles.find((p) => p !== curProf) ?? curProf };
        if (mode === 'nodeQuery') x.binding = { mode: 'nodeQuery', nodeId: this.ctx.rootIds[0] ?? nodes[0]?.id, profile: curProf };
        this.fixKeys(x);
      }),
    );
    on('[data-s="dev"]', 'change', () =>
      this.updateWidget(w.id, (x) => {
        const ids = [...panel.querySelectorAll<HTMLInputElement>('[data-s="dev"]:checked')].map((i) => i.value).slice(0, WIDGET_CAPS[x.type].multiDevice ? MAX_DEVICES : 1);
        // Machines outside this user's scope aren't listed but are kept (another admin chose them).
        // Unticking everything leaves the binding unchanged.
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
        // Only retitle if the title was still automatic (empty, the type label, or the old property name).
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

  /**
   * Form HTML for content widgets (no data source, D-019): rich text, image (https address or
   * upload up to 150 KB), link/button (app page or website) and embedded page. Wired by `wireContent`.
   */
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
    // The stand-in app's ThingsBoard dashboard state ids (D-018). An unknown stored state is kept as an extra option.
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

  /**
   * Wires the content fields from `contentFields`. All edits are quiet updates (per-field tag),
   * so typing doesn't lose focus. The rich-text editor offers {{placeholders}} for machine,
   * location, time, date and every catalogue property of the dashboard's machine type; its output
   * replaces the legacy `markdown` setting (sanitising happens in the editor, D-019).
   */
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
    // Sets or (for '' / undefined) deletes one setting. panelRefresh re-renders the panel, needed
    // when the field changes which other fields are shown (link kind, image upload, toggles).
    const set = (k: string, v: any, panelRefresh = false) =>
      this.quietWidget(w.id, `c-${k}`, (x) => (v === undefined || v === '' ? delete (x.settings as any)[k] : ((x.settings as any)[k] = v)), { panel: panelRefresh });
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-c]').forEach((inp) => {
      const k = inp.dataset.c!;
      if (k === 'file') {
        inp.addEventListener('change', () => {
          const f = (inp as HTMLInputElement).files?.[0];
          if (!f) return;
          // Uploads are stored inline as a data: URI in the dashboard JSON, hence the 150 KB cap (D-019).
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
      // Colour pickers update live while dragging; they must not re-render the panel or the picker closes.
      inp.addEventListener(inp.type === 'color' ? 'input' : 'change', () => {
        if (inp.type === 'color') (inp.parentElement as HTMLElement).style.background = inp.value;
        set(k, k === 'url' ? inp.value.trim() : inp.value, k !== 'url' && inp.type !== 'color');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-fit]').forEach((b) => b.addEventListener('click', () => set('fit', b.dataset.fit, true)));
    panel.querySelectorAll<HTMLElement>('[data-lk]').forEach((b) => b.addEventListener('click', () => set('linkKind', b.dataset.lk, true)));
    panel.querySelectorAll<HTMLElement>('[data-bs]').forEach((b) => b.addEventListener('click', () => set('buttonStyle', b.dataset.bs, true)));
  }

  /**
   * "3 · Options" form HTML for data widgets: unit/decimals, min/max, orientation, KPI options,
   * aggregation, smoothing/stacking/legend, bar grouping, donut mode, heatmap colours, per-widget
   * time range and alarm filters, depending on the type. Placeholders show the catalogue defaults.
   * Wired by `wireAppearance`.
   */
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
    // 'day' grouping was dropped with the 8 h cap (D-020); stored 'day' is shown as 'hour'.
    if (w.type === 'bar') f.push(sel('groupBy', 'Group by', [['15m', 'Every 15 minutes'], ['hour', 'Hour'], ['device', 'Compare machines']], s.groupBy === 'day' ? 'hour' : s.groupBy ?? 'hour'));
    if (w.type === 'donut') f.push(sel('donutMode', 'Show', [['state', 'Time in each state (one machine)'], ['devices', 'Share by machine']], s.donutMode ?? 'state'));
    if (w.type === 'heatmap') f.push(sel('heatColor', 'Colours', [['blue', 'Blue scale'], ['orange', 'Orange scale'], ['rules', 'Use the Colours rules']], s.heatColor ?? 'blue'));
    // Per-widget time range override for time-based widgets; '' means follow the dashboard.
    // Legacy values (24h/7d/30d) are normalised to 8h for display (D-020).
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

  /**
   * Wires the Options form. Settings are stored sparsely: a value equal to the renderer's default
   * is deleted rather than stored (e.g. showLegend/sparkline/upIsGood default true, smooth/stacked
   * default false, empty inputs mean "use the catalogue default"). Each change is one undo step.
   */
  wireAppearance(panel: HTMLElement, w: Widget) {
    panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ap]').forEach((inp) =>
      inp.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const a = inp.dataset.ap!;
          const v = (inp as HTMLInputElement).type === 'checkbox' ? (inp as HTMLInputElement).checked : inp.value;
          const s: any = x.settings;
          // Numeric fields; decimals and maxRows are non-negative integers.
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
          // "Share by machine" needs several machines: move "This machine" to same-type machines at its location.
          if (a === 'donutMode' && v === 'devices' && x.binding.mode === 'current') x.binding = this.deviceId ? { mode: 'siblings', profile: this.ctx.nodes.get(this.deviceId)!.profile } : x.binding;
          if (a === 'donutMode') this.fixKeys(x);
        }),
      ),
    );
    panel.querySelectorAll<HTMLInputElement>('[data-sev]').forEach((c) =>
      c.addEventListener('change', () =>
        this.updateWidget(w.id, (x) => {
          const sel = [...panel.querySelectorAll<HTMLInputElement>('[data-sev]:checked')].map((i) => i.value);
          // All four ticked = no filter (setting removed).
          if (sel.length === 4) delete x.settings.severities;
          else x.settings.severities = sel as any;
        }),
      ),
    );
  }

  /**
   * Properties that can be chosen for this widget's data source: the catalogue entries
   * (`ctx.profileKeys`, from `dbb_profile_keys`, D-013) of every profile it covers, deduplicated by key.
   */
  metasFor(w: Widget): KeyMeta[] {
    const seen = new Map<string, KeyMeta>();
    for (const p of this.profilesForBinding(w)) for (const k of this.ctx.profileKeys[p] ?? []) if (!seen.has(k.key)) seen.set(k.key, k);
    return [...seen.values()];
  }

  /**
   * Donut mode as the renderer will use it: the explicit setting, else "time in each state" for a
   * single-machine binding and "share by machine" for multi-machine bindings.
   */
  donutMode(w: Widget): 'state' | 'devices' {
    if (w.settings.donutMode) return w.settings.donutMode;
    const b = w.binding;
    return b.mode === 'current' || b.mode === 'nearest' || (b.mode === 'fixed' && b.deviceIds.length === 1) ? 'state' : 'devices';
  }

  /**
   * Can property `m` be shown with widget type `t` (core/compat rules, D-020)? Returns
   * `{ ok, reason? }`. For a donut, uses `w`'s effective mode, or with `anyDonutMode` accepts
   * either mode (used for the widget-type dropdown).
   */
  fits(t: WidgetType, m: KeyMeta, w: Widget, anyDonutMode = false) {
    if (t === 'donut' && anyDonutMode) {
      const a = compatible(t, m, { donutMode: 'state' });
      return a.ok ? a : compatible(t, m, { donutMode: 'devices' });
    }
    return compatible(t, m, { donutMode: t === 'donut' ? this.donutMode(w) : undefined });
  }

  /** Short label for a property's kind, shown next to greyed-out properties. */
  kindWord(m: KeyMeta): string {
    return { number: 'number', boolean: 'on/off', string: 'text', coded: 'state' }[propKind(m)];
  }

  /**
   * Keep only known properties that fit the widget type (at most MAX_KEYS and the type's cap);
   * pick a fitting one if none are left and the type needs one. May also set a donut to
   * "share by machine" when its property is a plain number. Mutates `x` in place; call it inside
   * an updateWidget/mutate callback after changing type, binding or donut mode.
   */
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
  // Chat edits the draft only; nothing is saved until Save. Transport is the rule-chain relay (D-014).

  /**
   * Chat tab: message log (with change summaries and a "Highlight" link), clarification option
   * buttons, suggested prompts for an empty draft, "Discard chat changes" (back to `preChat`) and
   * "Undo last", and the input form (Enter sends, Shift+Enter is a newline).
   */
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
    // Discard is itself an undoable step (commit), so it can be reverted with Ctrl+Z.
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

  /**
   * Sends one chat message and applies the result to the draft.
   *
   * Flow: local "undo" shortcut -> browser-side rate limit (30/hour, `rateOk`) -> `chat.chatTurn`,
   * which writes `dbb_chat_req` on the store asset and polls `dbb_chat_resp_<userId>` for up to
   * 30 s (D-014). The reply is either a clarification (options shown as buttons, draft unchanged)
   * or a new draft, committed as one undo step. The draft from before the first chat change is kept
   * in `preChat`. An apply target proposed by the model is remembered in `pendingApply` for Save.
   * Writes a `chat` audit entry on success and failure. Errors are shown in the chat log.
   */
  async sendChat(text: string) {
    text = text.trim();
    if (!text || this.busy) return;
    if (text.length > 1000) return toast(this.root, 'Please keep messages under 1000 characters.', 'warn');
    // "undo" is handled locally and does not count towards the rate limit or call the LLM.
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
        // Also commit when only layout/dashboard fields changed (no widget added/updated/removed).
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

  /**
   * Saves the draft to the store asset (`dbb_d_<id>` + history `dbb_h_<id>`, D-013).
   *
   * Steps, in order:
   *   1. Non-admin editing a shared dashboard -> offer "Save as copy" instead (D-015). Since
   *      D-017 only admins can open the builder, so this branch is normally unreachable.
   *   2. Validate with `checkDashboard` (D-020 limits and property/widget compatibility) and
   *      require at least one widget; problems are shown as a toast and nothing is written.
   *   3. Save as: ask for a name and turn the draft into a new dashboard (new id, version 0).
   *   4. For machine dashboards, warn if some same-type machines (first 50) don't report a used
   *      property (REST: one resolve + key list per machine; slow on the demo server).
   *   5. `store.saveDashboard` (optimistic concurrency on `version`). On ConflictError the user
   *      can reload the other version or save theirs as a copy.
   *   6. On first save, a pending chat apply proposal, or save-as, open the Apply dialog (D-017).
   * Writes a `dashboard.save` / `dashboard.saveAs` audit entry.
   *
   * @param asCopy true for "Save as" (always creates a new dashboard).
   */
  async save(asCopy: boolean): Promise<void> {
    // UI-only guard (D-012, D-015).
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
    // A machine dashboard must name its machine type so it can be applied to same-type machines.
    if (d.kind === 'device' && !d.profile && this.deviceId) d.profile = this.ctx.nodes.get(this.deviceId)!.profile;
    const problems = checkDashboard(d, metaLookup(this.ctx, d));
    if (!d.widgets.length) problems.push('Add at least one widget.');
    if (problems.length) return toast(this.root, problems.join(' '), 'err');
    if (asCopy) {
      const name = await promptModal(this.root, 'Save as a new dashboard', 'Name', `${d.name} (copy)`);
      if (!name) return;
      Object.assign(d, { id: newId('d'), name, version: 0, ownerId: this.ctx.userId, ownerName: this.ctx.displayName, copiedFrom: null });
    }
    // Warn about keys missing on same-type machines (capped at 50 machines to bound REST calls).
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
      // Hide the spinner before the Apply dialog, which runs its own busy state.
      this.setBusy(false);
      // First save, a chat proposal or a new copy -> ask where to apply (D-017).
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

  /**
   * "Apply dashboard" dialog (D-017): only the selected machine, all machines of this type, or
   * don't apply. "All" means customer-wide (`dbb_assign_customer` on the store asset) when the
   * admin's scope roots are top-level, otherwise a device-level `dbb_assign` on every same-type
   * machine in scope (D-011, D-013). Standalone dashboards can't be applied.
   *
   * While open, each selection change runs `store.previewApply` (affected machines, dashboards
   * that will be replaced, machines keeping their own, missing properties); a sequence counter
   * drops stale previews. Replacing an existing assignment must be ticked before Apply enables.
   * On Apply: `store.apply` (REST attribute writes), `dashboard.apply` audit entry, then refreshes
   * `source` and `usageInfo`. Consumes `pendingApply` (it only sets the initial choice).
   */
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
    // A chat proposal for a location/customer maps to "all"; otherwise default to "only this machine".
    const initial = (p?.target === 'customer' || p?.target === 'node') && admin && others.length ? 'all' : dev && isDeviceDash ? 'device' : 'none';
    // Location targets are no longer offered (D-017); `nodes` is kept referenced only.
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
    // Maps the selected radio to a store.ApplyTarget.
    const target = (): store.ApplyTarget => {
      const t = (body.querySelector('input[name="t"]:checked') as HTMLInputElement)?.value ?? 'none';
      if (t === 'device') return { type: 'devices', deviceIds: [dev!.id], mode: 'linked' };
      if (t === 'all')
        return this.ctx.rootsAreTop ? { type: 'customer', profile: profile! } : { type: 'devices', deviceIds: sameType.map((x) => x.id), mode: 'linked' };
      return { type: 'none' };
    };
    // Recomputes the preview; `seq` makes sure only the latest (possibly slow) preview is shown.
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
      // Apply stays disabled on errors, an unticked "Replace existing assignment", or no machines.
      const rep = pvEl.querySelector('[data-replace]') as HTMLInputElement | null;
      const setBtn = () => (m.button('apply').disabled = !!pv.errors?.length || (!!rep && !rep.checked) || (t.type === 'devices' && !t.deviceIds.length));
      rep?.addEventListener('change', setBtn);
      setBtn();
    };
    body.addEventListener('change', (e) => {
      // The replace checkbox only toggles the button; re-running the preview would reset it.
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

  // ---------- open / history / delete dialogs ----------

  /**
   * "Open dashboard" modal: lists saved dashboards from the store asset (store.listDashboards)
   * and offers "New blank dashboard". Does not ask about unsaved changes before replacing the draft.
   */
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

  /**
   * "Version history" modal: the last 10 saved versions (`dbb_h_<id>`, D-013). Restore saves the
   * old content as a new version (store.restoreVersion), writes a `dashboard.restore` audit entry
   * and reloads the draft; unsaved draft changes are dropped without asking.
   */
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

  /**
   * Deletes the saved dashboard after confirmation. store.deleteDashboard removes the dashboard
   * attributes and every device, location and customer-wide assignment pointing at it within the
   * user's scope; affected machines fall back to the next dashboard in line (D-013).
   * Writes a `dashboard.delete` audit entry, then reloads whatever the selected machine now shows.
   */
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
      // Mark clean so selectMachine doesn't ask "Switch machine?" about the deleted draft.
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


/** Short summary of a chat change set, e.g. "Added 2 widgets, changed 1". Empty string if nothing changed. */
function summarise(c: chat.ChatResult['changed']): string {
  const p: string[] = [];
  if (c.added.length) p.push(`Added ${c.added.length} widget${c.added.length > 1 ? 's' : ''}`);
  if (c.updated.length) p.push(`changed ${c.updated.length}`);
  if (c.removed.length) p.push(`removed ${c.removed.length}`);
  return p.join(', ');
}

/**
 * Chat rate limit: at most 30 requests per user per rolling hour (D-014). Records the request
 * when allowed. Kept in this browser's localStorage (`dbb_rate_<userId>`), so it is per browser
 * and easy to bypass; it protects the API budget from accidents, not from a determined user.
 * If localStorage is unavailable the limit is effectively off.
 */
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

/** Single text-input modal. Resolves to the trimmed value, or null if cancelled or empty. */
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

/** Modal with Cancel plus the given choices (the last one is primary). Resolves to the chosen key or 'cancel'. */
async function choiceModal(root: HTMLElement, title: string, text: string, choices: [string, string][]): Promise<string> {
  const m = modal(root, title, `<div>${esc(text)}</div>`, [['cancel', 'Cancel'], ...choices.map(([k, l], i) => [k, l, i === choices.length - 1 ? 'primary' : ''] as [string, string, string])]);
  return m.result;
}

// Keep these imports referenced (bindingLabel is currently unused here).
void bindingLabel;
void api;
