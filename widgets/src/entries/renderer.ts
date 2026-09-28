// Machine dashboard widget: shows the dashboard resolved for the machine in the dashboard state
// (personal > machine > location > customer-wide > default layout). The page itself shows no editing
// controls: for admins, edit / customise / reset / thresholds / dashboard switcher are published to the
// navbar's edit menu (user decision 27 Sep 2026). Everyone else only views.
// Also renders a standalone dashboard when the state carries `dbbDashboardId`.
//
// ThingsBoard widget type: tenant.imex_dbb_renderer ("iMEX Machine dashboard", 24x12), placed in the
// app's `machine` state. Lifecycle, via the controller glue in widgets/build.mjs: init(self.ctx) on onInit,
// onStateChanged(self.ctx) (reloads for the new machine), destroy(self.ctx) on onDestroy.
//
// Settings (widgets/widget-types.mjs):
//   refreshSeconds  REST polling interval in seconds when the WebSocket is down (default 10)
//   chatEnabled     enable the Chat tab when "Edit this dashboard" opens the builder
//   customerId      customer to show when a tenant admin opens the app (D-018)
//   dashboardId     (not in the settings form) standalone dashboard to show when the state has none
//
// Which machine: the entity of the current dashboard state (stateEntity), set by the listing via
// stateController.openState('machine', {entityId, ...}). Which dashboard: store.resolveForDevice
// (D-013 order), or the one picked in the "Show dashboard" switcher (st.override, reset when the
// machine changes).
//
// Edit actions (admins only, UI-only check, D-012) are not drawn here: they are published with
// publishActions() for the navbar's edit menu (D-020, see common.ts). Reloads on CHANGED_EVENT.
//
// Refresh (D-021): values come over the ThingsBoard WebSocket (core/live.ts). The grid is redrawn when a
// change is pushed (at most every 2 s) and every 60 s; redraws read the live cache, so they make almost no
// REST calls (see core/api.ts). If the socket is down: REST polling as before (refreshSeconds, default 10 s,
// in realtime; 60 s for historic ranges). Skipped while the tab is hidden. See common.ts scheduleRedraw.
import * as api from '../core/api';
import * as scope from '../core/scope';
import * as store from '../core/store';
import type { UserContext } from '../core/scope';
import { rangeLabel, normalizeRange } from '../core/schema';
import type { Dashboard } from '../core/schema';
import { Grid, GRID_CSS } from '../render/grid';
import { CSS, ensureCss, esc, STATUS, ago, applyTheme } from '../render/theme';
import { defaultWidgets } from '../render/widgets';
import { openBuilder } from '../builder/builder';
import { BUILDER_CSS } from '../builder/styles';
import { modal, confirmModal, toast } from '../builder/ui';
import { audit } from '../core/audit';
import { userContext, stateEntity, stateParam, CHANGED_EVENT, notifyChanged, publishActions, EditAction, scheduleRedraw } from './common';

const R_CSS = `
.dbb-rend{height:100%;display:flex;flex-direction:column;background:var(--plane);position:relative}
.dbb-rhead{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:wrap}
.dbb-rtitle{font-size:19px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;letter-spacing:-.01em}
.dbb-crumb{font-size:12px;color:var(--ink-3);margin-bottom:2px}
.dbb-src-chip{font-size:12px;color:var(--ink-2);background:var(--grid);border-radius:999px;padding:4px 11px}
.dbb-range-chip{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--ink-2);background:var(--grid);border-radius:999px;padding:4px 11px}
.dbb-range-chip.live::before{content:"";width:7px;height:7px;border-radius:50%;background:#0ca30c;box-shadow:0 0 0 3px rgba(12,163,12,.2);animation:dbb-pulse 2s ease-in-out infinite}
@keyframes dbb-pulse{50%{box-shadow:0 0 0 6px rgba(12,163,12,0)}}
.dbb-status-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px 3px 8px;background:color-mix(in srgb,var(--pill) 14%,transparent);color:var(--ink)}
.dbb-status-pill .dbb-dot{width:8px;height:8px;background:var(--pill);box-shadow:0 0 0 3px color-mix(in srgb,var(--pill) 25%,transparent)}
.dbb-rtools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dbb-rtools select{font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.dbb-rbody{flex:1;overflow:auto;min-height:0;padding:4px 6px}
`;

/** Counter for unique ids of renderer instances in this library copy (used as the publishActions owner). */
let seq = 0;

/**
 * Widget onInit: builds the header + grid skeleton in `tbCtx.$container`, loads the machine's dashboard
 * and starts the refresh timer.
 *
 * Side effects: injects CSS once per page; stores its state on `tbCtx.__dbb`, cleanup on
 * `tbCtx.__dbbCleanup`, reload hook on `tbCtx.__dbbReload`; listens to CHANGED_EVENT; publishes/clears
 * the edit menu actions. REST reads: user context, store attributes (resolve), latest telemetry and
 * timeseries keys of the device.
 */
export function init(tbCtx: any) {
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-grid', GRID_CSS);
  ensureCss('dbb-css-builder', BUILDER_CSS);
  ensureCss('dbb-css-rend', R_CSS);
  const host: HTMLElement = tbCtx.$container[0];
  const id = `r${++seq}`;
  const st: {
    ctx?: UserContext;
    grid?: Grid;
    deviceId?: string | null;
    shownId?: string | null;
    override?: string | null; // dashboard picked in the switcher
    lastKey?: string;
    range?: string;
    ticks?: number;
  } = {};
  (tbCtx as any).__dbb = st;
  host.innerHTML = `<div class="dbb-root dbb-rend" id="${id}"><div class="dbb-rhead"><div class="dbb-ph" style="height:auto">Loading…</div></div><div class="dbb-rbody"><div class="dbb-rgrid"></div></div></div>`;
  const root = host.querySelector('.dbb-rend') as HTMLElement;
  const head = root.querySelector('.dbb-rhead') as HTMLElement;
  const gridHost = root.querySelector('.dbb-rgrid') as HTMLElement;

  // (Re)loads from the dashboard state: a DEVICE entity -> showDevice; else a `dbbDashboardId` state
  // param or settings.dashboardId -> showStandalone; else a placeholder. `force` reloads the user context.
  const load = async (force = false) => {
    try {
      const ctx = await userContext(tbCtx, force);
      st.ctx = ctx;
      const ent = stateEntity(tbCtx);
      const standaloneId = stateParam(tbCtx, 'dbbDashboardId') ?? tbCtx.settings?.dashboardId;
      const key = `${ent?.id ?? ''}|${standaloneId ?? ''}`;
      if (key !== st.lastKey) st.override = null;
      st.lastKey = key;
      if (ent?.entityType === 'DEVICE') await showDevice(ctx, ent.id);
      else if (standaloneId) await showStandalone(ctx, standaloneId);
      else {
        head.innerHTML = `<div class="dbb-ph" style="height:auto">Open a machine to see its dashboard.</div>`;
        st.grid?.render([]);
        publishActions(id, null);
      }
    } catch (e: any) {
      head.innerHTML = `<div class="dbb-banner err">Could not load the dashboard: ${esc(e.message ?? e)}</div>`;
    }
  };

  const body = root.querySelector('.dbb-rbody') as HTMLElement;
  // Used by link widgets to open another app page; passes the node (if in scope) as the state entity.
  const navigate = (stateId: string, nodeId: string | null) => {
    const n = nodeId && st.ctx ? st.ctx.nodes.get(nodeId) : null;
    const params = n ? { entityId: { id: n.id, entityType: n.entityType }, entityName: n.label, entityLabel: n.label } : {};
    tbCtx.stateController?.openState?.(stateId, params, false);
  };
  // Applies the dashboard theme and creates the read-only grid once, then only updates its environment.
  const ensureGrid = (ctx: UserContext, deviceId: string | null, range: string, theme?: Dashboard['theme']) => {
    const { dark } = applyTheme(root, theme);
    void body;
    const env = { ctx, deviceId, timeRange: range, theme: theme ?? null, dark, navigate };
    if (!st.grid) st.grid = new Grid(gridHost, env, { editable: false });
    else st.grid.setEnv(env);
    return st.grid;
  };

  /**
   * Shows the machine page for `deviceId`: header (path, name, profile, status, time range) and the
   * resolved dashboard, or the built-in default layout when nothing is assigned. Devices outside the
   * user's scope get a warning only (scope is UI-enforced, D-012).
   * Status: Offline when no telemetry for 5 min, else Running/Stopped from `runStatus` (missing = Running).
   * For admins, publishes: edit, customise (shared dashboard from a location/customer assignment),
   * reset (device has a `customised` copy), thresholds, the switcher when several dashboards apply,
   * and "clear personal view" (D-017: personal views are still resolved but no longer created).
   */
  async function showDevice(ctx: UserContext, deviceId: string) {
    st.deviceId = deviceId;
    const node = ctx.nodes.get(deviceId);
    if (!node) {
      head.innerHTML = `<div class="dbb-banner warn">This machine is outside your access.</div>`;
      st.grid?.render([]);
      publishActions(id, null);
      return;
    }
    const res = await store.resolveForDevice(ctx, deviceId, node.profile);
    let dash: Dashboard | null = res.dashboard;
    let label = res.sourceLabel;
    let level = res.level;
    if (st.override) {
      const c = res.candidates.find((x) => x.dashboard.id === st.override);
      if (c) {
        dash = c.dashboard;
        label = c.sourceLabel;
        level = c.level;
      }
    }
    st.shownId = dash?.id ?? null;
    const admin = ctx.isAdmin;
    const canCustomise = admin && (level === 'node' || level === 'customer');
    const canReset = admin && level === 'device' && res.deviceAssignment?.mode === 'customised';
    const range = normalizeRange(dash?.timeRange ?? 'realtime');
    st.range = range;
    head.innerHTML = `
      <div>
        <div class="dbb-crumb">${esc(scope.ancestors(ctx, deviceId).reverse().map((a) => a.label).join(' › '))}</div>
        <div class="dbb-rtitle">${esc(node.label)} <span class="dbb-muted" style="font-size:13px">${esc(node.profile)}</span>
          <span class="dbb-status-pill" style="--pill:${STATUS.neutral}"><span class="dbb-dot"></span>…</span></div>
      </div>
      <span class="dbb-range-chip ${range === 'realtime' ? 'live' : ''}" title="${range === 'realtime' ? 'Values update every 10 seconds; charts show the last hour' : 'Charts and summaries cover this window, ending now'}">${esc(rangeLabel(range))}</span>`;
    const grid = ensureGrid(ctx, deviceId, range, dash?.theme);
    grid.render(dash ? dash.widgets : defaultWidgets(ctx, node.profile));
    // Status pill after the grid has started loading (D-022): the header no longer holds up the widgets.
    void lastTelemetry(ctx, deviceId, node.profile).then(({ lastTs, runStatus }) => {
      if (st.deviceId !== deviceId) return;
      const offline = !lastTs || Date.now() - lastTs > 5 * 60e3;
      const running = !offline && (runStatus === undefined || Number(runStatus) === 1);
      const status = offline ? ['Offline', STATUS.neutral] : running ? ['Running', STATUS.good] : ['Stopped', STATUS.warning];
      const pill = head.querySelector('.dbb-status-pill') as HTMLElement | null;
      if (!pill) return;
      pill.style.setProperty('--pill', status[1]);
      pill.innerHTML = `<span class="dbb-dot"></span>${status[0]}${lastTs ? ` · ${ago(lastTs)}` : ''}`;
    });

    // Editing lives in the navbar's edit menu, not on the page.
    if (!admin) return publishActions(id, null);
    const items: EditAction[] = [{ id: 'edit', label: dash ? 'Edit this dashboard' : 'Build a dashboard for this machine', hint: dash ? `Opens “${dash.name}” in the Dashboard Builder` : 'Opens the Dashboard Builder', icon: 'edit' }];
    if (canCustomise && dash) items.push({ id: 'cust', label: 'Customise for this machine', hint: `Gives ${node.label} its own copy`, icon: 'copy' });
    if (canReset) items.push({ id: 'reset', label: 'Reset to shared dashboard', hint: 'Deletes the customised copy', icon: 'reset', danger: true });
    items.push({ id: 'thr', label: 'Alarm thresholds…', hint: 'Limits that raise alarms for this machine', icon: 'sliders' });
    if (res.candidates.length > 1)
      for (const c of res.candidates) items.push({ id: `switch:${c.dashboard.id}`, label: c.dashboard.name, hint: c.sourceLabel, group: 'switch', checked: c.dashboard.id === st.shownId, icon: 'eye' });
    if (level === 'personal') items.push({ id: 'clearp', label: 'Clear my personal view', icon: 'reset' });
    publishActions(id, {
      el: root,
      title: node.label,
      subtitle: `From: ${label}${dash ? ` · ${dash.name}` : ''}`,
      items,
      run: (a) => {
        if (a === 'edit') openBuilder({ ctx, deviceId, dashboardId: dash?.id ?? null, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() });
        else if (a === 'cust') void customise();
        else if (a === 'reset') void reset();
        else if (a === 'thr') void thresholds(ctx, deviceId, node.label);
        else if (a === 'clearp') void store.clearPersonal(ctx, deviceId).then(notifyChanged);
        else if (a.startsWith('switch:')) {
          st.override = a.slice(7);
          void load();
        }
      },
    });
    // Saves a copy of the shared dashboard and assigns it to this device (`dbb_assign` mode `customised`); audited.
    async function customise() {
      if (!(await confirmModal(root, 'Customise for this machine?', `${node!.label} gets its own copy of “${dash!.name}”. It will stop receiving updates made to the shared dashboard.`, 'Customise'))) return;
      try {
        const copy = await store.customise(ctx, deviceId, dash!);
        void audit(ctx, 'dashboard.customise', { deviceId, template: dash!.id, copy: copy.id });
        toast(root, 'Customised copy created.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    }
    // Removes the device's `dbb_assign` and its customised copy, so it falls back to the shared dashboard; audited.
    async function reset() {
      if (!(await confirmModal(root, 'Reset to the shared dashboard?', `The customised dashboard for ${node!.label} will be deleted and it will show the shared dashboard again.`, 'Reset', true))) return;
      try {
        await store.resetDevice(ctx, deviceId);
        void audit(ctx, 'dashboard.reset', { deviceId });
        toast(root, 'Reset to the shared dashboard.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    }
  }

  /** Shows a stored dashboard not bound to a machine (state param `dbbDashboardId`); admins get "Edit". */
  async function showStandalone(ctx: UserContext, dashboardId: string) {
    st.deviceId = null;
    const d = await store.getDashboard(ctx, dashboardId);
    if (!d) {
      head.innerHTML = `<div class="dbb-banner warn">Dashboard not found.</div>`;
      return;
    }
    const range = normalizeRange(d.timeRange);
    st.range = range;
    head.innerHTML = `<div class="dbb-rtitle">${esc(d.name)}</div><span class="dbb-range-chip ${range === 'realtime' ? 'live' : ''}">${esc(rangeLabel(range))}</span>`;
    ensureGrid(ctx, null, range, d.theme).render(d.widgets);
    publishActions(
      id,
      ctx.isAdmin
        ? { el: root, title: d.name, subtitle: `By ${d.ownerName}`, items: [{ id: 'edit', label: 'Edit this dashboard', icon: 'edit' }], run: () => openBuilder({ ctx, dashboardId: d.id, onClose: (ch) => ch && notifyChanged() }) }
        : null,
    );
  }

  /**
   * "Alarm thresholds" dialog: edits the device's `thr_*` SERVER_SCOPE attributes, which the device
   * profile alarm rules read as dynamic thresholds (D-003). Empty inputs are left unchanged.
   * Writes via api.saveAttrs and adds a `thresholds.update` audit entry with before/after values.
   */
  async function thresholds(ctx: UserContext, deviceId: string, label: string) {
    const attrs = await api.getAttrs({ id: deviceId, entityType: 'DEVICE' }).catch(() => ({}) as Record<string, any>);
    const keys = Object.keys(attrs).filter((k) => k.startsWith('thr_'));
    if (!keys.length) return toast(root, 'This machine has no threshold attributes.', 'warn');
    const m = modal(
      root,
      `Alarm thresholds — ${label}`,
      `<div class="dbb-form">${keys
        .map((k) => `<label class="dbb-field"><span>${esc(k.replace(/^thr_/, '').replace(/_/g, ' '))}</span><input type="number" step="any" data-k="${esc(k)}" value="${esc(attrs[k])}"/></label>`)
        .join('')}<div class="dbb-hint">An alarm is raised when the value goes above the threshold, and cleared when it drops back.</div></div>`,
      [
        ['cancel', 'Cancel'],
        ['save', 'Save', 'primary'],
      ],
    );
    if ((await m.result) !== 'save') return;
    const vals: Record<string, number> = {};
    m.body.querySelectorAll<HTMLInputElement>('[data-k]').forEach((i) => i.value !== '' && (vals[i.dataset.k!] = Number(i.value)));
    try {
      await api.saveAttrs({ id: deviceId, entityType: 'DEVICE' }, vals);
      void audit(ctx, 'thresholds.update', { deviceId, before: Object.fromEntries(keys.map((k) => [k, attrs[k]])), after: vals });
      toast(root, 'Thresholds saved.', 'ok');
    } catch (e: any) {
      toast(root, e.message, 'err');
    }
  }

  const onChanged = () => void load(true);
  window.addEventListener(CHANGED_EVENT, onChanged);
  // Redraws (D-021): on WebSocket pushes (at most every 2 s) + every 60 s; if the socket is down, REST polling
  // every refreshSeconds (10 s) in realtime and every 60 s for historic ranges, as before.
  const stopRedraw = scheduleRedraw(
    () => st.grid?.refreshAll(),
    () => (st.range && st.range !== 'realtime' ? 60e3 : (tbCtx.settings?.refreshSeconds ?? 10) * 1000),
  );
  (tbCtx as any).__dbbCleanup = () => {
    window.removeEventListener(CHANGED_EVENT, onChanged);
    stopRedraw();
    publishActions(id, null);
    st.grid?.destroy();
  };
  (tbCtx as any).__dbbReload = () => void load();
  void load();
}

/**
 * Most recent telemetry time (max `ts` over the latest values) and `runStatus` of a device.
 * Uses the machine type's catalogue keys (dbb_profile_keys, up to 20) plus runStatus, read through the
 * WebSocket live cache (D-022: normally no REST call; the widgets subscribe the same keys). Machine types
 * without a catalogue fall back to listing the device's keys (2 REST calls).
 */
async function lastTelemetry(ctx: UserContext, deviceId: string, profile: string): Promise<{ lastTs: number | null; runStatus: any }> {
  let keys = (ctx.profileKeys[profile] ?? []).map((k) => k.key).slice(0, 20);
  if (!keys.length) keys = (await api.timeseriesKeys(deviceId).catch(() => [] as string[])).slice(0, 20);
  if (!keys.includes('runStatus')) keys.push('runStatus');
  const l = await api.latest(deviceId, keys).catch(() => ({}) as api.Latest);
  const ts = Object.values(l).map((v) => v?.ts ?? 0);
  return { lastTs: ts.length ? Math.max(...ts) || null : null, runStatus: l.runStatus?.value };
}

/** Widget onStateChanged: reloads for the new state entity (keeps the user context cache). */
export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbReload?.();
}

/** Widget onDestroy: stops the timer, removes listeners, clears this widget's edit actions, destroys the grid. */
export function destroy(tbCtx: any) {
  (tbCtx as any).__dbbCleanup?.();
}
