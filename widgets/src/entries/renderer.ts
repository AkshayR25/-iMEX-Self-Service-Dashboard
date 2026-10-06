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
// Which machine: the entity of the current dashboard state (currentEntity: state URL first, then the state controller; watched every 500 ms), set by the listing via
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
import { normalizeRange } from '../core/schema';
import type { Dashboard } from '../core/schema';
import { Grid, GRID_CSS } from '../render/grid';
import { CSS, ensureCss, esc, STATUS, ago, agoWords, applyTheme } from '../render/theme';
import { defaultWidgets } from '../render/widgets';
import { openBuilder } from '../builder/builder';
import { BUILDER_CSS } from '../builder/styles';
import { modal, confirmModal, toast } from '../builder/ui';
import { audit } from '../core/audit';
import { userContext, currentEntity, currentParam, RSTATE_KEY, CHANGED_EVENT, notifyChanged, publishActions, EditAction, scheduleRedraw } from './common';

const R_CSS = `
.dbb-rend{height:100%;display:flex;flex-direction:column;background:var(--plane);position:relative}
.dbb-rhead{display:flex;align-items:center;gap:10px;padding:7px 16px;min-height:40px;background:var(--surface);border-bottom:1px solid var(--line);flex-wrap:nowrap;min-width:0}
.dbb-crumb-d{color:var(--ink)}
.dbb-rtitle{flex:0 1 auto;font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
.dbb-crumb{font-size:13px;font-weight:500;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dbb-src-chip{font-size:12px;color:var(--ink-2);background:var(--grid);border-radius:999px;padding:4px 11px}
@keyframes dbb-pulse{50%{box-shadow:0 0 0 6px rgba(12,163,12,0)}}
.dbb-status-pill{flex:none;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px 3px 8px;background:color-mix(in srgb,var(--pill) 14%,transparent);color:var(--ink)}
.dbb-status-pill .dbb-dot{width:8px;height:8px;background:var(--pill);box-shadow:0 0 0 3px color-mix(in srgb,var(--pill) 25%,transparent)}
.dbb-tw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 4px 0 11px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12px;white-space:nowrap}
.dbb-tw .k{color:var(--ink-3);font-weight:500;display:inline-flex;align-items:center;gap:5px}
.dbb-tw .k svg{width:14px;height:14px}
.dbb-tw .v{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink);background:var(--grid);border-radius:999px;padding:3px 10px}
.dbb-tw .v.live::before{content:"";width:7px;height:7px;border-radius:50%;background:#0ca30c;box-shadow:0 0 0 3px rgba(12,163,12,.2);animation:dbb-pulse 2s ease-in-out infinite}
.dbb-upd{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-3);white-space:nowrap;font-variant-numeric:tabular-nums;cursor:default}
.dbb-upd b{font-weight:600;color:var(--ink-2)}
.dbb-upd .d{width:7px;height:7px;border-radius:50%;background:var(--ink-3);flex:none}
.dbb-upd.fresh .d{background:#0ca30c}
.dbb-upd.old .d{background:#e8a317}
@media (max-width:720px){.dbb-tw .k span{display:none}}
.dbb-rtools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dbb-rtools select{font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
.dbb-rbody{flex:1;overflow:auto;min-height:0;padding:4px 6px}
`;

/** D-033: time window in words for the header ("Last 8 hours", "Live · last hour"). */
function windowLabel(range: string): string {
  const n = normalizeRange(range);
  if (n === 'realtime') return 'Live · last hour';
  const h = parseInt(n, 10);
  return `Last ${h} hour${h === 1 ? '' : 's'}`;
}
const CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
/** D-033 header items: the dashboard's time window and when its newest data point arrived (filled by the ticker). */
function timeHtml(range: string): string {
  const live = normalizeRange(range) === 'realtime';
  return `<span class="dbb-tw" title="${live ? 'Dashboard time window: live values (updated as they arrive); charts show the last hour' : 'Dashboard time window: charts and summaries cover this period, ending now'}"><span class="k">${CLOCK}<span>Time window</span></span><span class="v ${live ? 'live' : ''}">${esc(windowLabel(range))}</span></span><span class="dbb-upd" aria-live="off"><span class="d"></span><span class="t">Waiting for data…</span></span>`;
}
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
    /** Incremented by every load(); an older load that finishes late must not draw over a newer one. */
    loadSeq?: number;
    range?: string;
    ticks?: number;
  } = {};
  (tbCtx as any).__dbb = st;
  // Remember which dashboard state shows machines, as a fallback for the navbar's Dashboard list when the
  // app has no "Dashboard Overview" state (D-025/D-026). Only recorded while a machine is shown.
  const rememberState = () => {
    try {
      const sid = tbCtx.stateController?.getStateId?.();
      if (sid) localStorage.setItem(RSTATE_KEY(), sid);
    } catch {
      /* ignore */
    }
  };
  host.innerHTML = `<div class="dbb-root dbb-rend" id="${id}"><div class="dbb-rhead"><div class="dbb-ph" style="height:auto">Loading…</div></div><div class="dbb-rbody"><div class="dbb-rgrid"></div></div></div>`;
  const root = host.querySelector('.dbb-rend') as HTMLElement;
  const head = root.querySelector('.dbb-rhead') as HTMLElement;
  const gridHost = root.querySelector('.dbb-rgrid') as HTMLElement;

  // (Re)loads from the dashboard state: a DEVICE entity -> showDevice; else a `dbbDashboardId` state
  // param or settings.dashboardId -> showStandalone; else a placeholder. `force` reloads the user context.
  // Which page to show: the state entity + standalone dashboard id, read URL-first (currentEntity).
  const pageKey = () => {
    const ent = currentEntity(tbCtx);
    const standaloneId = currentParam(tbCtx, 'dbbDashboardId') ?? tbCtx.settings?.dashboardId;
    return { ent, standaloneId, key: `${ent?.id ?? ''}|${standaloneId ?? ''}` };
  };
  const load = async (force = false) => {
    const seq = (st.loadSeq = (st.loadSeq ?? 0) + 1);
    const stale = () => seq !== st.loadSeq;
    const { ent, standaloneId, key } = pageKey();
    if (key !== st.lastKey) {
      st.override = null;
      api.resetDataClock();
    }
    st.lastKey = key;
    try {
      const ctx = await userContext(tbCtx, force);
      if (stale()) return;
      st.ctx = ctx;
      if (ent?.entityType === 'DEVICE') await showDevice(ctx, ent.id, stale);
      else if (standaloneId) await showStandalone(ctx, standaloneId, stale);
      else {
        head.innerHTML = `<div class="dbb-ph" style="height:auto">Open a machine, or pick a dashboard from the Dashboard list in the navbar menu.</div>`;
        st.grid?.render([]);
        publishActions(id, null);
      }
    } catch (e: any) {
      if (stale()) return;
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
  async function showDevice(ctx: UserContext, deviceId: string, stale: () => boolean) {
    st.deviceId = deviceId;
    rememberState();
    const node = ctx.nodes.get(deviceId);
    if (!node) {
      head.innerHTML = `<div class="dbb-banner warn">This machine is outside your access.</div>`;
      st.grid?.render([]);
      publishActions(id, null);
      return;
    }
    const res = await store.resolveForDevice(ctx, deviceId, node.profile);
    if (stale()) return;
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
    // One compact line: machine name (the page's title), then org › site · dashboard name, status, time range.
    // D-038: the title is back. It was left out on 28 Sep 2026 because the app's navbar showed the machine; with
    // the side menu there is no navbar, and nothing on the page said which machine or dashboard is open. An app
    // that still has its navbar (no side menu on the page) keeps the line without the title.
    const where = scope.ancestors(ctx, deviceId).reverse().map((a) => a.label).join(' › ');
    const sideMenu = !!document.querySelector('#imx-menu-root') || document.documentElement.classList.contains('imx-menu-shift');
    head.innerHTML = `
      ${sideMenu ? `<div class="dbb-rtitle" title="${esc(node.label)} (${esc(node.profile)})">${esc(node.label)}</div>` : ''}
      <div class="dbb-crumb" title="${esc(where)}${dash ? ` · Dashboard: ${esc(dash.name)}` : ''}">${esc(where)}${dash ? `<span class="dbb-crumb-d"> · ${esc(dash.name)}</span>` : ''}</div>
      <span class="dbb-status-pill" style="--pill:${STATUS.neutral}"><span class="dbb-dot"></span>…</span>
      ${timeHtml(range)}`;
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
      pill.innerHTML = `<span class="dbb-dot"></span>${status[0]}`;
      pill.title = lastTs ? `Machine last sent data ${ago(lastTs)}` : 'No data from this machine yet';
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
  async function showStandalone(ctx: UserContext, dashboardId: string, stale: () => boolean) {
    st.deviceId = null;
    const d = await store.getDashboard(ctx, dashboardId);
    if (stale()) return;
    if (!d) {
      head.innerHTML = `<div class="dbb-banner warn">Dashboard not found.</div>`;
      return;
    }
    const range = normalizeRange(d.timeRange);
    st.range = range;
    head.innerHTML = `<div class="dbb-rtitle">${esc(d.name)}</div>${timeHtml(range)}`;
    ensureGrid(ctx, null, range, d.theme).render(d.widgets);
    publishActions(
      id,
      ctx.isAdmin
        ? { el: root, title: d.name, subtitle: `Dashboard overview · by ${d.ownerName}`, items: [{ id: 'edit', label: 'Edit this dashboard', hint: `Opens “${d.name}” in the Dashboard Builder`, icon: 'edit' }], run: () => openBuilder({ ctx, dashboardId: d.id, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() }) }
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
  // ThingsBoard does not always call onStateChanged (e.g. an app navbar that switches the machine by
  // changing the state URL), so also watch the page key every 500 ms, like the navbar widget does.
  const watch = setInterval(() => {
    if (pageKey().key !== st.lastKey) void load();
  }, 500);
  // D-033: "Updated x ago" from the newest data point the widgets received (api data clock), every second.
  const tick = () => {
    const el = head.querySelector('.dbb-upd') as HTMLElement | null;
    if (!el) return;
    const ts = api.lastDataTs();
    const t = el.querySelector('.t') as HTMLElement;
    if (!ts) {
      t.textContent = 'Waiting for data…';
      el.className = 'dbb-upd';
      el.removeAttribute('title');
      return;
    }
    const age = Date.now() - ts;
    const txt = agoWords(ts);
    t.innerHTML = `Updated <b>${esc(txt)}</b>`;
    el.className = `dbb-upd ${age < 2 * 60e3 ? 'fresh' : age > 15 * 60e3 ? 'old' : ''}`;
    el.title = `Newest data point on this dashboard: ${new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  };
  const ticker = setInterval(tick, 1000);
  (tbCtx as any).__dbbCleanup = () => {
    clearInterval(watch);
    clearInterval(ticker);
    window.removeEventListener(CHANGED_EVENT, onChanged);
    stopRedraw();
    publishActions(id, null);
    st.grid?.destroy();
  };
  // onStateChanged: reload only if the page key changed (the watch may already have done it).
  (tbCtx as any).__dbbReload = () => {
    if (pageKey().key !== st.lastKey) void load();
  };
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
  const l = await api.latest(deviceId, keys, true).catch(() => ({}) as api.Latest);
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
