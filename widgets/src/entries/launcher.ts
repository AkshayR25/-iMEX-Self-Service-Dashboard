// Navbar widget. For admins it shows one edit (pencil) icon; its menu holds every editing option:
// the Dashboard Builder and, on the machine page, edit / customise / reset / thresholds / switch
// dashboard (published by the renderer widget, see common.ts). The page itself shows no edit controls
// (user decision 27 Sep 2026). Also exposes window.IMEX_DBB.open() for an existing custom header widget.
import { openBuilder } from '../builder/builder';
import { CSS, ensureCss, esc } from '../render/theme';
import { userContext, stateEntity, notifyChanged, currentState, currentActions, ACTIONS_EVENT, EditAction } from './common';
import * as scope from '../core/scope';

const MENU_ICONS: Record<string, string> = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  builder: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
};
const svg = (p: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

// The menu is appended to <body> (the navbar widget's own box clips overflow).
const MENU_CSS = `
.dbb-emenu{position:fixed;z-index:10050;min-width:280px;max-width:360px;background:#fff;color:#0b0b0b;border:1px solid #e3e2dd;border-radius:14px;box-shadow:0 12px 32px rgba(16,24,40,.18),0 2px 6px rgba(16,24,40,.08);padding:6px;font:13px Roboto,Inter,Arial,sans-serif;animation:dbb-menu-in .12s ease-out}
@keyframes dbb-menu-in{from{opacity:0;transform:translateY(-4px)}}
.dbb-emenu-h{padding:9px 11px 8px;border-bottom:1px solid #eeede8;margin-bottom:4px}
.dbb-emenu-h b{display:block;font-size:13.5px}
.dbb-emenu-h span{font-size:11.5px;color:#6e6d68}
.dbb-emenu-sec{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#8a8983;padding:8px 11px 3px}
.dbb-emenu button{display:flex;align-items:flex-start;gap:10px;width:100%;border:0;background:none;text-align:left;font:inherit;color:inherit;padding:8px 11px;border-radius:9px;cursor:pointer}
.dbb-emenu button:hover,.dbb-emenu button:focus-visible{background:#f1f5fb;outline:none}
.dbb-emenu button.danger{color:#b42323}
.dbb-emenu button.danger:hover{background:#fdf0f0}
.dbb-emenu button svg{width:17px;height:17px;flex:none;margin-top:1px;color:#2a78d6}
.dbb-emenu button.danger svg{color:#d03b3b}
.dbb-emenu button .t{display:flex;flex-direction:column;gap:1px;min-width:0}
.dbb-emenu button .t small{font-size:11.5px;color:#6e6d68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-emenu button .ck{margin-left:auto;width:16px;height:16px;color:#0ca30c}
.dbb-emenu hr{border:0;border-top:1px solid #eeede8;margin:4px 0}
`;

const BTN_CSS = `
.dbb-nav{display:flex;align-items:center;gap:14px;height:100%;padding:0 60px 0 16px;background:linear-gradient(90deg,#0a2458 0%,#123a7a 60%,#184f95 100%);color:#fff;box-shadow:0 2px 10px rgba(10,36,88,.25)}
.dbb-nav-app{font-size:16px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:9px;white-space:nowrap}
.dbb-nav-app::before{content:"";width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6da7ec,#2a78d6);box-shadow:inset 0 0 0 5px rgba(255,255,255,.18)}
.dbb-nav-link{background:none;border:0;color:#fff;font:500 13px Roboto,Arial,sans-serif;opacity:.8;cursor:pointer;padding:7px 12px;border-radius:999px;white-space:nowrap;transition:background .15s,opacity .15s}
.dbb-nav-link:hover{opacity:1;background:rgba(255,255,255,.1)}
.dbb-nav-link.on{opacity:1;background:rgba(255,255,255,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.dbb-nav-state{font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12);white-space:nowrap;text-transform:uppercase;letter-spacing:.05em}
.dbb-nav-crumb{font-size:13px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-nav-user{display:flex;align-items:center;gap:9px;font-size:12px;line-height:1.2;text-align:right}
.dbb-nav-user .who{display:flex;flex-direction:column}
.dbb-nav-user .who span{opacity:.75}
.dbb-nav-user .av{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#eb6834,#e87ba4);font-weight:600;font-size:12px;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.dbb-nav .dbb-launch{height:auto;padding:0}
.dbb-launch{display:flex;align-items:center;justify-content:flex-end;height:100%;padding:0 4px}
.dbb-launch button{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:inherit;
  font:600 13px Roboto,Arial,sans-serif;padding:8px 14px;border-radius:10px;cursor:pointer;white-space:nowrap;transition:background .15s,transform .1s}
.dbb-nav .dbb-launch button{background:linear-gradient(135deg,#3987e5,#2a78d6);border-color:rgba(255,255,255,.25);box-shadow:0 2px 8px rgba(0,0,0,.2)}
.dbb-launch.light button{border-color:#d7d6d1;background:#fff;color:#0b0b0b}
.dbb-launch button:hover{filter:brightness(1.08)}
.dbb-launch button:active{transform:scale(.98)}
.dbb-launch svg{width:18px;height:18px}
.dbb-launch button.dbb-edit-ic{width:38px;height:38px;padding:0;justify-content:center;border-radius:11px}
.dbb-launch button.dbb-edit-ic[aria-expanded="true"]{background:#fff;color:#123a7a}
`;

function roleList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export async function open(tbCtx: any, opts: { deviceId?: string | null; dashboardId?: string | null } = {}) {
  const ctx = await userContext(tbCtx, true);
  const settings = tbCtx?.settings ?? {};
  if (settings.adminOnly !== false && !ctx.isAdmin) throw new Error('Only admins can build dashboards.');
  const chatRoles = roleList(settings.chatEnabledRoles);
  const chatEnabled = settings.chatEnabled !== false && (!chatRoles.length || chatRoles.includes(ctx.role.toLowerCase()));
  const cp = currentState(tbCtx).params ?? {};
  const ent = cp.entityId?.id ? { id: cp.entityId.id, entityType: cp.entityId.entityType } : stateEntity(tbCtx);
  openBuilder({
    ctx,
    deviceId: opts.deviceId ?? (ent?.entityType === 'DEVICE' ? ent.id : null),
    dashboardId: opts.dashboardId ?? null,
    chatEnabled,
    onClose: (changed) => changed && notifyChanged(),
  });
}

export function init(tbCtx: any) {
  ensureCss('dbb-css-core', CSS);
  ensureCss('dbb-css-launch', BTN_CSS);
  ensureCss('dbb-css-emenu', MENU_CSS);
  const s = tbCtx.settings ?? {};
  const host: HTMLElement = tbCtx.$container[0];
  const btnHtml = `<button type="button" class="dbb-launch-btn dbb-edit-ic" title="${esc(s.label || 'Edit dashboards')}" aria-label="${esc(s.label || 'Edit dashboards')}" aria-haspopup="menu" aria-expanded="false">${svg(MENU_ICONS.edit)}</button>`;
  if (s.navbar) {
    host.innerHTML = `<div class="dbb-root dbb-nav"><div class="dbb-nav-app">${esc(s.appName || 'iMEX')}</div>
      <button type="button" class="dbb-nav-link" data-go="${esc(s.homeState || 'default')}">${esc(s.homeLabel || 'Map page')}</button>
      <button type="button" class="dbb-nav-link" data-go="${esc(s.listingState || 'listing')}">${esc(s.listingLabel || 'Listing page')}</button>
      <div class="dbb-nav-state"></div><div class="dbb-nav-crumb"></div><div style="flex:1"></div>
      <div class="dbb-launch">${btnHtml}</div><div class="dbb-nav-user"></div></div>`;
    host.querySelectorAll<HTMLElement>('[data-go]').forEach(
      (b) =>
        (b.onclick = () => {
          try {
            tbCtx.stateController.openState(b.dataset.go!, {}, false);
          } catch {
            /* ignore */
          }
        }),
    );
    const crumb = host.querySelector('.dbb-nav-crumb') as HTMLElement;
    const stateEl = host.querySelector('.dbb-nav-state') as HTMLElement;
    // Current dashboard state shown in the navbar ("Map page" / "Listing page" / "Machine page").
    const stateTitles: Record<string, string> = Object.assign(
      { [s.homeState || 'default']: s.homeLabel || 'Map page', [s.listingState || 'listing']: s.listingLabel || 'Listing page', [s.machineState || 'machine']: s.machineLabel || 'Machine page' },
      typeof s.stateTitles === 'object' && s.stateTitles ? s.stateTitles : {},
    );
    let lastKey = '';
    const paintState = () => {
      const cur = currentState(tbCtx);
      const id = cur.id || s.homeState || 'default';
      stateEl.textContent = stateTitles[id] ?? id;
      host.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === id));
    };
    const paint = () => {
      paintState();
      void userContext(tbCtx)
        .then((c) => {
          const p = currentState(tbCtx).params ?? {};
          const ent = p.entityId?.id ? { id: p.entityId.id } : stateEntity(tbCtx);
          (host.querySelector('.dbb-nav-user') as HTMLElement).innerHTML = `<div class="who"><b>${esc(c.displayName)}</b><span>${esc(c.role)}</span></div><span class="av">${esc(
            c.displayName
              .split(/\s+/)
              .map((x: string) => x[0] ?? '')
              .join('')
              .slice(0, 2)
              .toUpperCase(),
          )}</span>`;
          crumb.textContent = ent && c.nodes.has(ent.id) ? scope.pathLabel(c, ent.id) : '';
        })
        .catch(() => undefined);
    };
    (tbCtx as any).__dbbPaint = paint;
    paint();
    // The navbar widget stays mounted across states and is not always notified, so watch the state.
    const watch = setInterval(() => {
      const cur = currentState(tbCtx);
      const key = cur.id + '|' + (cur.params?.entityId?.id ?? '');
      if (key !== lastKey) {
        lastKey = key;
        paint();
      }
    }, 500);
    (tbCtx as any).__dbbWatch = watch;
  } else host.innerHTML = `<div class="dbb-root dbb-launch ${s.lightStyle ? 'light' : ''}">${btnHtml}</div>`;
  const btn = host.querySelector('.dbb-launch-btn') as HTMLButtonElement;
  // Admin-only by default (settings.adminOnly=false shows it to everyone). Also hidden for roles in
  // settings.hideForRoles. Hidden until the role is known, so non-admins never see it flash.
  // NB: hiding is UI only; see DECISIONS D-012.
  const hide = roleList(s.hideForRoles);
  btn.style.display = 'none';
  void userContext(tbCtx)
    .then((c) => {
      const allowed = (s.adminOnly === false || c.isAdmin) && !hide.includes(c.role.toLowerCase());
      if (allowed) btn.style.display = '';
      else btn.remove();
    })
    .catch(() => btn.remove());
  const openBuilderFromMenu = async () => {
    btn.disabled = true;
    try {
      await open(tbCtx);
    } catch (e: any) {
      alertInline(host, `Could not open the builder: ${e.message ?? e}`);
    } finally {
      btn.disabled = false;
    }
  };
  let menu: HTMLElement | null = null;
  const closeMenu = () => {
    menu?.remove();
    menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      closeMenu();
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  const item = (a: Pick<EditAction, 'id' | 'label' | 'hint' | 'danger' | 'checked'> & { icon?: string }) =>
    `<button role="menuitem" data-m="${esc(a.id)}" class="${a.danger ? 'danger' : ''}">${svg(MENU_ICONS[a.icon ?? 'edit'] ?? MENU_ICONS.edit)}<span class="t"><span>${esc(a.label)}</span>${a.hint ? `<small title="${esc(a.hint)}">${esc(a.hint)}</small>` : ''}</span>${a.checked ? `<span class="ck">${svg(MENU_ICONS.check)}</span>` : ''}</button>`;
  const openMenu = () => {
    const acts = currentActions();
    const main = acts?.items.filter((x) => x.group !== 'switch') ?? [];
    const sw = acts?.items.filter((x) => x.group === 'switch') ?? [];
    menu = document.createElement('div');
    menu.className = 'dbb-emenu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `${acts ? `<div class="dbb-emenu-h"><b>${esc(acts.title)}</b>${acts.subtitle ? `<span>${esc(acts.subtitle)}</span>` : ''}</div>` : ''}
      ${main.map(item).join('')}
      ${sw.length ? `<div class="dbb-emenu-sec">Show dashboard</div>${sw.map(item).join('')}` : ''}
      ${main.length || sw.length ? '<hr/>' : ''}
      ${item({ id: '__builder', label: 'Dashboard Builder', hint: acts ? 'All dashboards, templates and machines' : 'Build or change dashboards', icon: 'builder' })}`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)))}px`;
    btn.setAttribute('aria-expanded', 'true');
    menu.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.m!;
        closeMenu();
        if (id === '__builder') void openBuilderFromMenu();
        else currentActions()?.run(id);
      }),
    );
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  };
  btn.onclick = () => (menu ? closeMenu() : openMenu());
  // Actions change when the machine page loads or switches; reopen to pick them up.
  const onActs = () => {
    if (menu) {
      closeMenu();
      openMenu();
    }
  };
  window.addEventListener(ACTIONS_EVENT, onActs);
  (tbCtx as any).__dbbMenuCleanup = () => {
    closeMenu();
    window.removeEventListener(ACTIONS_EVENT, onActs);
  };
  (window as any).IMEX_DBB = { open: (o?: any) => open(tbCtx, o) };
}

function alertInline(host: HTMLElement, msg: string) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#8e2222;color:#fff;padding:8px 14px;border-radius:8px;z-index:10001;font:13px Roboto,Arial';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 6000);
  void host;
}

export function onStateChanged(tbCtx: any) {
  (tbCtx as any).__dbbPaint?.();
}

export function destroy(tbCtx?: any) {
  clearInterval(tbCtx?.__dbbWatch);
  tbCtx?.__dbbMenuCleanup?.();
}
