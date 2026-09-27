// Machine dashboard widget: shows the dashboard resolved for the machine in the dashboard state
// (personal > machine > location > customer-wide > default layout), with the source, a switcher,
// customise / reset, thresholds, and an Edit button that opens the builder.
// Also renders a standalone dashboard when the state carries `dbbDashboardId`.
import * as api from '../core/api';
import * as scope from '../core/scope';
import * as store from '../core/store';
import type { UserContext } from '../core/scope';
import type { Dashboard } from '../core/schema';
import { Grid, GRID_CSS } from '../render/grid';
import { CSS, ensureCss, esc, STATUS, ago } from '../render/theme';
import { defaultWidgets } from '../render/widgets';
import { openBuilder } from '../builder/builder';
import { BUILDER_CSS } from '../builder/styles';
import { modal, confirmModal, toast } from '../builder/ui';
import { audit } from '../core/audit';
import { userContext, stateEntity, stateParam, CHANGED_EVENT, notifyChanged } from './common';

const R_CSS = `
.dbb-rend{height:100%;display:flex;flex-direction:column;background:#f6f6f4;position:relative}
.dbb-rhead{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#fff;border-bottom:1px solid var(--line);flex-wrap:wrap}
.dbb-rtitle{font-size:18px;font-weight:500}
.dbb-crumb{font-size:12px;color:var(--ink-3)}
.dbb-src-chip{font-size:12px;color:var(--ink-2);background:#f1f0ec;border-radius:12px;padding:3px 10px}
.dbb-rtools{margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dbb-rtools select{font:inherit;font-size:12px;padding:5px 6px;border:1px solid var(--line);border-radius:6px}
.dbb-rbody{flex:1;overflow:auto;min-height:0}
`;

let seq = 0;

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
    timer?: any;
    lastKey?: string;
  } = {};
  (tbCtx as any).__dbb = st;
  host.innerHTML = `<div class="dbb-root dbb-rend" id="${id}"><div class="dbb-rhead"><div class="dbb-ph" style="height:auto">Loading…</div></div><div class="dbb-rbody"><div class="dbb-rgrid"></div></div></div>`;
  const root = host.querySelector('.dbb-rend') as HTMLElement;
  const head = root.querySelector('.dbb-rhead') as HTMLElement;
  const gridHost = root.querySelector('.dbb-rgrid') as HTMLElement;

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
      }
    } catch (e: any) {
      head.innerHTML = `<div class="dbb-banner err">Could not load the dashboard: ${esc(e.message ?? e)}</div>`;
    }
  };

  const ensureGrid = (ctx: UserContext, deviceId: string | null, range: string) => {
    const env = { ctx, deviceId, timeRange: range };
    if (!st.grid) st.grid = new Grid(gridHost, env, { editable: false });
    else st.grid.setEnv(env);
    return st.grid;
  };

  async function showDevice(ctx: UserContext, deviceId: string) {
    st.deviceId = deviceId;
    const node = ctx.nodes.get(deviceId);
    if (!node) {
      head.innerHTML = `<div class="dbb-banner warn">This machine is outside your access.</div>`;
      st.grid?.render([]);
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
    const latest = await api.latest(deviceId, ['runStatus']).catch(() => ({}) as api.Latest);
    const lastTs = await lastTelemetry(deviceId);
    const offline = !lastTs || Date.now() - lastTs > 5 * 60e3;
    const rs = latest.runStatus?.value;
    const running = !offline && (rs === undefined || Number(rs) === 1);
    const status = offline ? ['Offline', STATUS.neutral] : running ? ['Running', STATUS.good] : ['Stopped', STATUS.warning];
    const canCustomise = (level === 'node' || level === 'customer') && (ctx.isAdmin || ctx.role.toLowerCase() === 'manager');
    const canReset = level === 'device' && res.deviceAssignment?.mode === 'customised' && (ctx.isAdmin || ctx.role.toLowerCase() === 'manager');
    const canThresholds = ctx.isAdmin || ctx.role.toLowerCase() === 'manager';
    head.innerHTML = `
      <div>
        <div class="dbb-crumb">${esc(scope.ancestors(ctx, deviceId).reverse().map((a) => a.label).join(' › '))}</div>
        <div class="dbb-rtitle">${esc(node.label)} <span class="dbb-muted" style="font-size:13px">${esc(node.profile)}</span>
          <span class="dbb-chip" style="margin-left:8px"><span class="dbb-dot" style="background:${status[1]}"></span>${status[0]}${lastTs ? ` · ${ago(lastTs)}` : ''}</span></div>
      </div>
      <span class="dbb-src-chip" title="Where this dashboard comes from">From: ${esc(label)}${dash ? ` · ${esc(dash.name)}` : ''}</span>
      <div class="dbb-rtools">
        ${
          res.candidates.length > 1
            ? `<select data-a="switch" title="Switch dashboard (does not change the assignment)">${res.candidates
                .map((c) => `<option value="${c.dashboard.id}" ${c.dashboard.id === st.shownId ? 'selected' : ''}>${esc(c.dashboard.name)} — ${esc(c.sourceLabel)}</option>`)
                .join('')}</select>`
            : ''
        }
        ${level === 'personal' ? `<button class="dbb-btn" data-a="clearp">Clear my view</button>` : ''}
        ${canCustomise && dash ? `<button class="dbb-btn" data-a="cust">Customise for this machine</button>` : ''}
        ${canReset ? `<button class="dbb-btn" data-a="reset">Reset to template</button>` : ''}
        ${canThresholds ? `<button class="dbb-btn" data-a="thr">Thresholds</button>` : ''}
        <button class="dbb-btn primary" data-a="edit">${dash ? 'Edit dashboard' : 'Build a dashboard'}</button>
      </div>`;
    const range = dash?.timeRange ?? '24h';
    const grid = ensureGrid(ctx, deviceId, range);
    grid.render(dash ? dash.widgets : defaultWidgets(ctx, node.profile));
    const q = (a: string) => head.querySelector(`[data-a="${a}"]`) as HTMLElement | null;
    q('switch')?.addEventListener('change', (e) => {
      st.override = (e.target as HTMLSelectElement).value;
      void load();
    });
    q('edit')?.addEventListener('click', () => openBuilder({ ctx, deviceId, dashboardId: dash?.id ?? null, chatEnabled: tbCtx.settings?.chatEnabled !== false, onClose: (ch) => ch && notifyChanged() }));
    q('cust')?.addEventListener('click', async () => {
      if (!(await confirmModal(root, 'Customise for this machine?', `${node.label} gets its own copy of “${dash!.name}”. It will stop receiving updates made to the shared dashboard.`, 'Customise'))) return;
      try {
        const copy = await store.customise(ctx, deviceId, dash!);
        void audit(ctx, 'dashboard.customise', { deviceId, template: dash!.id, copy: copy.id });
        toast(root, 'Customised copy created.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    });
    q('reset')?.addEventListener('click', async () => {
      if (!(await confirmModal(root, 'Reset to template?', `The customised dashboard for ${node.label} will be deleted and it will show the shared dashboard again.`, 'Reset', true))) return;
      try {
        await store.resetDevice(ctx, deviceId);
        void audit(ctx, 'dashboard.reset', { deviceId });
        toast(root, 'Reset to template.', 'ok');
        notifyChanged();
      } catch (e: any) {
        toast(root, e.message, 'err');
      }
    });
    q('clearp')?.addEventListener('click', async () => {
      await store.clearPersonal(ctx, deviceId);
      notifyChanged();
    });
    q('thr')?.addEventListener('click', () => void thresholds(ctx, deviceId, node.label));
  }

  async function showStandalone(ctx: UserContext, dashboardId: string) {
    st.deviceId = null;
    const d = await store.getDashboard(ctx, dashboardId);
    if (!d) {
      head.innerHTML = `<div class="dbb-banner warn">Dashboard not found.</div>`;
      return;
    }
    head.innerHTML = `<div class="dbb-rtitle">${esc(d.name)}</div><span class="dbb-src-chip">By ${esc(d.ownerName)}</span>
      <div class="dbb-rtools"><button class="dbb-btn primary" data-a="edit">Edit dashboard</button></div>`;
    ensureGrid(ctx, null, d.timeRange).render(d.widgets);
    head.querySelector('[data-a="edit"]')?.addEventListener('click', () => openBuilder({ ctx, dashboardId: d.id, onClose: (ch) => ch && notifyChanged() }));
  }

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
  st.timer = setInterval(() => {
    if (document.hidden) return;
    st.grid?.refreshAll();
  }, (tbCtx.settings?.refreshSeconds ?? 10) * 1000);
  (tbCtx as any).__dbbCleanup = () => {
    window.removeEventListener(CHANGED_EVENT, onChanged);
    clearInterval(st.timer);
    st.grid?.destroy();
  };
  (tbCtx as any).__dbbReload = () => void load();
  void load();
}

async function lastTelemetry(deviceId: string): Promise<number | null> {
  const keys = await api.timeseriesKeys(deviceId).catch(() => []);
  if (!keys.length) return null;
  const l = await api.latest(deviceId, keys.slice(0, 20)).catch(() => ({}) as api.Latest);
  const ts = Object.values(l).map((v) => v?.ts ?? 0);
  return ts.length ? Math.max(...ts) : null;
}

export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbReload?.();
}

export function destroy(tbCtx: any) {
  (tbCtx as any).__dbbCleanup?.();
}
