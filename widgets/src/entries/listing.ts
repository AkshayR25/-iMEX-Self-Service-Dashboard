// Stand-in for the production listing page: scoped hierarchy tree + cards. Clicking a machine opens the
// 'machine' dashboard state, where the renderer widget shows its resolved dashboard.
import * as api from '../core/api';
import * as scope from '../core/scope';
import * as store from '../core/store';
import type { UserContext, Node } from '../core/scope';
import { CSS, ensureCss, esc, fmtNum, STATUS } from '../render/theme';
import { keyMeta } from '../render/widgets';
import { userContext, CHANGED_EVENT } from './common';

const L_CSS = `
.dbb-list{display:flex;height:100%;background:#f6f6f4}
.dbb-tree{width:260px;background:#fff;border-right:1px solid var(--line);padding:10px;overflow:auto;flex:none}
.dbb-tree input{width:100%;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;margin-bottom:8px}
.dbb-tn{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-tn:hover{background:#f3f8fe}.dbb-tn.on{background:#e3eefb;color:#184f95;font-weight:500}
.dbb-tn .dbb-muted{margin-left:auto}
.dbb-cards{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}
.dbb-cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.dbb-mc{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px;cursor:pointer;display:flex;flex-direction:column;gap:8px}
.dbb-mc:hover{border-color:var(--accent);box-shadow:0 2px 8px rgba(42,120,214,.12)}
.dbb-mc-h{display:flex;align-items:center;gap:8px}
.dbb-mc-t{font-weight:500;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-kv{display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:12px}
.dbb-kv b{font-weight:500;font-variant-numeric:tabular-nums;text-align:right}
.dbb-h2{font-size:16px;font-weight:500}
`;

interface Card {
  node: Node;
  html: string;
}

export function init(tbCtx: any) {
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-list', L_CSS);
  const host: HTMLElement = tbCtx.$container[0];
  host.innerHTML = `<div class="dbb-root dbb-list"><aside class="dbb-tree"><input placeholder="Search" aria-label="Search the hierarchy"/><div class="dbb-tlist"></div></aside><section class="dbb-cards"><div class="dbb-ph">Loading…</div></section></div>`;
  const treeEl = host.querySelector('.dbb-tlist') as HTMLElement;
  const cardsEl = host.querySelector('.dbb-cards') as HTMLElement;
  const search = host.querySelector('.dbb-tree input') as HTMLInputElement;
  let ctx: UserContext;
  let selected: string | null = null;
  let timer: any;

  const openMachine = (n: Node) =>
    tbCtx.stateController.openState(tbCtx.settings?.machineState || 'machine', { entityId: { id: n.id, entityType: 'DEVICE' }, entityName: n.label, entityLabel: n.label }, false);
  const openDash = (id: string, name: string) => tbCtx.stateController.openState(tbCtx.settings?.dashboardState || 'dashboard', { dbbDashboardId: id, entityName: name }, false);

  const drawTree = () => {
    const f = search.value.trim().toLowerCase();
    const rows: string[] = [];
    const walk = (id: string, depth: number) => {
      const n = ctx.nodes.get(id);
      if (!n) return;
      const match = !f || n.label.toLowerCase().includes(f) || scope.devicesUnder(ctx, id).some((d) => d.label.toLowerCase().includes(f));
      if (!match && n.entityType === 'ASSET') return;
      if (!match) return;
      const count = n.entityType === 'ASSET' ? scope.devicesUnder(ctx, id).length : 0;
      rows.push(
        `<div class="dbb-tn ${id === selected ? 'on' : ''}" data-id="${id}" style="padding-left:${6 + depth * 14}px">${n.entityType === 'DEVICE' ? '•' : '▸'} ${esc(n.label)}${
          count ? `<span class="dbb-muted">${count}</span>` : ''
        }</div>`,
      );
      if (n.entityType === 'ASSET') n.children.forEach((c) => walk(c, depth + 1));
    };
    ctx.rootIds.forEach((r) => walk(r, 0));
    treeEl.innerHTML = rows.join('') || '<div class="dbb-hint">Nothing matches.</div>';
    treeEl.querySelectorAll<HTMLElement>('.dbb-tn').forEach(
      (r) =>
        (r.onclick = () => {
          const n = ctx.nodes.get(r.dataset.id!)!;
          if (n.entityType === 'DEVICE') return openMachine(n);
          selected = n.id;
          drawTree();
          void drawCards();
        }),
    );
  };

  const deviceCard = async (d: Node): Promise<string> => {
    const metas = (ctx.profileKeys[d.profile] ?? []).filter((k) => !/status|hours/i.test(k.key)).slice(0, 4);
    const [lv, al] = await Promise.all([
      api.latest(d.id, [...metas.map((m) => m.key), 'runStatus']).catch(() => ({}) as api.Latest),
      api.alarms({ id: d.id, entityType: 'DEVICE' }, { status: 'ACTIVE', limit: 50 }).catch(() => []),
    ]);
    const ts = Math.max(0, ...Object.values(lv).map((v) => v?.ts ?? 0));
    const offline = !ts || Date.now() - ts > 5 * 60e3;
    const rs = lv.runStatus?.value;
    const running = !offline && (rs === undefined || rs === null || (rs as any) === '' || Number(rs) === 1);
    const [st, col] = offline ? ['Offline', STATUS.neutral] : running ? ['Running', STATUS.good] : ['Stopped', STATUS.warning];
    return `<div class="dbb-mc" data-dev="${d.id}"><div class="dbb-mc-h"><span class="dbb-mc-t">${esc(d.label)}</span><span class="dbb-chip"><span class="dbb-dot" style="background:${col}"></span>${st}</span></div>
      <div class="dbb-muted">${esc(d.profile)}</div>
      <div class="dbb-kv">${metas
        .map((m) => `<span>${esc(m.displayName)}</span><b>${lv[m.key] ? `${fmtNum(lv[m.key]!.value, m.decimals)} ${esc(m.unit)}` : '—'}</b>`)
        .join('')}</div>
      <div class="dbb-chip">${al.length ? `<span class="dbb-dot" style="background:${STATUS.critical}"></span>${al.length} active alarm${al.length > 1 ? 's' : ''}` : 'No active alarms'}</div></div>`;
  };

  const nodeCard = async (n: Node): Promise<string> => {
    const devs = scope.devicesUnder(ctx, n.id);
    const stats = await Promise.all(
      devs.map(async (d) => {
        const [lv, al] = await Promise.all([
          api.latest(d.id, ['runStatus']).catch(() => ({}) as api.Latest),
          api.alarms({ id: d.id, entityType: 'DEVICE' }, { status: 'ACTIVE', limit: 50 }).catch(() => []),
        ]);
        const ts = await lastTs(d.id);
        const rs = lv.runStatus?.value;
        const online = !!ts && Date.now() - ts < 5 * 60e3;
        return { running: online && (rs === undefined || rs === null || (rs as any) === '' || Number(rs) === 1), alarms: al.length };
      }),
    );
    const run = stats.filter((s) => s.running).length;
    const alarms = stats.reduce((a, s) => a + s.alarms, 0);
    return `<div class="dbb-mc" data-node="${n.id}"><div class="dbb-mc-h"><span class="dbb-mc-t">${esc(n.label)}</span><span class="dbb-muted">${esc(n.profile)}</span></div>
      <div class="dbb-kv"><span>Machines</span><b>${devs.length}</b><span>Running</span><b>${devs.length ? Math.round((run / devs.length) * 100) : 0}%</b><span>Active alarms</span><b>${alarms}</b></div></div>`;
  };

  const drawCards = async () => {
    const n = selected ? ctx.nodes.get(selected) : null;
    const children = n ? n.children.map((c) => ctx.nodes.get(c)!).filter(Boolean) : ctx.rootIds.map((r) => ctx.nodes.get(r)!).filter(Boolean);
    const cards = await Promise.all(children.map(async (c): Promise<Card> => ({ node: c, html: c.entityType === 'DEVICE' ? await deviceCard(c) : await nodeCard(c) })));
    let dashList = '';
    try {
      const ds = (await store.listDashboards(ctx)).filter((d) => d.kind === 'standalone');
      if (ds.length)
        dashList = `<div class="dbb-h2">Dashboards</div><div class="dbb-cgrid">${ds
          .map((d) => `<div class="dbb-mc" data-dash="${d.id}" data-name="${esc(d.name)}"><div class="dbb-mc-t">${esc(d.name)}</div><div class="dbb-muted">${d.widgets.length} widgets · by ${esc(d.ownerName)}</div></div>`)
          .join('')}</div>`;
    } catch {
      /* no store */
    }
    cardsEl.innerHTML = `${ctx.warnings.map((w) => `<div class="dbb-banner warn">${esc(w)}</div>`).join('')}
      <div class="dbb-h2">${esc(n ? scope.pathLabel(ctx, n.id) : 'All locations')}</div>
      <div class="dbb-cgrid">${cards.map((c) => c.html).join('') || '<div class="dbb-hint">Nothing here.</div>'}</div>${dashList}`;
    cardsEl.querySelectorAll<HTMLElement>('[data-dev]').forEach((c) => (c.onclick = () => openMachine(ctx.nodes.get(c.dataset.dev!)!)));
    cardsEl.querySelectorAll<HTMLElement>('[data-node]').forEach(
      (c) =>
        (c.onclick = () => {
          selected = c.dataset.node!;
          drawTree();
          void drawCards();
        }),
    );
    cardsEl.querySelectorAll<HTMLElement>('[data-dash]').forEach((c) => (c.onclick = () => openDash(c.dataset.dash!, c.dataset.name!)));
  };

  const load = async (force = false) => {
    try {
      ctx = await userContext(tbCtx, force);
      if (!selected && ctx.rootIds.length === 1) selected = ctx.rootIds[0];
      drawTree();
      await drawCards();
    } catch (e: any) {
      cardsEl.innerHTML = `<div class="dbb-banner err">Could not load: ${esc(e.message ?? e)}</div>`;
    }
  };
  search.oninput = () => ctx && drawTree();
  const onChanged = () => void load(true);
  window.addEventListener(CHANGED_EVENT, onChanged);
  timer = setInterval(() => !document.hidden && ctx && void drawCards(), 10000);
  (tbCtx as any).__dbbCleanup = () => {
    clearInterval(timer);
    window.removeEventListener(CHANGED_EVENT, onChanged);
  };
  void load();
  void keyMeta;
}

async function lastTs(deviceId: string): Promise<number> {
  const keys = await api.timeseriesKeys(deviceId).catch(() => [] as string[]);
  if (!keys.length) return 0;
  const l = await api.latest(deviceId, keys.slice(0, 20)).catch(() => ({}) as api.Latest);
  return Math.max(0, ...Object.values(l).map((v) => v?.ts ?? 0));
}

export function destroy(tbCtx: any) {
  (tbCtx as any).__dbbCleanup?.();
}
