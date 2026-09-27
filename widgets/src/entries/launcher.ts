// Navbar button widget: "Dashboard Builder". Opens the full-screen builder for the machine in the
// current dashboard state (if any). Also exposes window.IMEX_DBB.open() so an existing custom header
// widget can open the builder from its own button.
import { openBuilder } from '../builder/builder';
import { CSS, ensureCss, esc } from '../render/theme';
import { userContext, stateEntity, notifyChanged, currentState } from './common';
import * as scope from '../core/scope';

const BTN_CSS = `
.dbb-nav{display:flex;align-items:center;gap:14px;height:100%;padding:0 60px 0 16px;background:linear-gradient(90deg,#0a2458 0%,#123a7a 60%,#184f95 100%);color:#fff;box-shadow:0 2px 10px rgba(10,36,88,.25)}
.dbb-nav-app{font-size:16px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:9px;white-space:nowrap}
.dbb-nav-app::before{content:"";width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6da7ec,#2a78d6);box-shadow:inset 0 0 0 5px rgba(255,255,255,.18)}
.dbb-nav-link{background:none;border:0;color:#fff;font:500 13px Roboto,Arial,sans-serif;opacity:.8;cursor:pointer;padding:7px 12px;border-radius:999px;transition:background .15s,opacity .15s}
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
  const s = tbCtx.settings ?? {};
  const host: HTMLElement = tbCtx.$container[0];
  const btnHtml = `<button type="button" class="dbb-launch-btn" title="Build or change dashboards">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>
    <span>${esc(s.label || 'Dashboard Builder')}</span></button>`;
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
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await open(tbCtx);
    } catch (e: any) {
      alertInline(host, `Could not open the builder: ${e.message ?? e}`);
    } finally {
      btn.disabled = false;
    }
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
}
