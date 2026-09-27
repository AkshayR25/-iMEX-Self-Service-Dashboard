// Navbar button widget: "Dashboard Builder". Opens the full-screen builder for the machine in the
// current dashboard state (if any). Also exposes window.IMEX_DBB.open() so an existing custom header
// widget can open the builder from its own button.
import { openBuilder } from '../builder/builder';
import { CSS, ensureCss, esc } from '../render/theme';
import { userContext, stateEntity, notifyChanged } from './common';
import * as scope from '../core/scope';

const BTN_CSS = `
.dbb-nav{display:flex;align-items:center;gap:14px;height:100%;padding:0 60px 0 14px;background:#0a2458;color:#fff}
.dbb-nav-app{font-size:17px;font-weight:500;letter-spacing:.02em}
.dbb-nav-link{background:none;border:0;color:#fff;font:500 13px Roboto,Arial,sans-serif;opacity:.85;cursor:pointer;padding:6px 8px;border-radius:6px}
.dbb-nav-link:hover{opacity:1;background:rgba(255,255,255,.1)}
.dbb-nav-crumb{font-size:13px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dbb-nav-user{display:flex;flex-direction:column;font-size:12px;line-height:1.2;text-align:right}
.dbb-nav-user span{opacity:.75}
.dbb-nav .dbb-launch{height:auto;padding:0}
.dbb-launch{display:flex;align-items:center;justify-content:flex-end;height:100%;padding:0 4px}
.dbb-launch button{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:inherit;
  font:500 13px Roboto,Arial,sans-serif;padding:7px 12px;border-radius:6px;cursor:pointer;white-space:nowrap}
.dbb-launch.light button{border-color:#d7d6d1;background:#fff;color:#0b0b0b}
.dbb-launch button:hover{filter:brightness(1.1)}
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
  const chatRoles = roleList(settings.chatEnabledRoles);
  const chatEnabled = settings.chatEnabled !== false && (!chatRoles.length || chatRoles.includes(ctx.role.toLowerCase()));
  const ent = stateEntity(tbCtx);
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
      <button type="button" class="dbb-nav-link" data-home>Home</button><div class="dbb-nav-crumb"></div><div style="flex:1"></div>
      <div class="dbb-launch">${btnHtml}</div><div class="dbb-nav-user"></div></div>`;
    host.querySelector<HTMLElement>('[data-home]')!.onclick = () => {
      try {
        tbCtx.stateController.openState(s.homeState || 'default', {}, false);
      } catch {
        /* ignore */
      }
    };
    const crumb = host.querySelector('.dbb-nav-crumb') as HTMLElement;
    const paint = () =>
      void userContext(tbCtx)
        .then((c) => {
          const ent = stateEntity(tbCtx);
          (host.querySelector('.dbb-nav-user') as HTMLElement).innerHTML = `<b>${esc(c.displayName)}</b><span>${esc(c.role)}</span>`;
          crumb.textContent = ent && c.nodes.has(ent.id) ? scope.pathLabel(c, ent.id) : '';
        })
        .catch(() => undefined);
    (tbCtx as any).__dbbPaint = paint;
    paint();
  } else host.innerHTML = `<div class="dbb-root dbb-launch ${s.lightStyle ? 'light' : ''}">${btnHtml}</div>`;
  const btn = host.querySelector('.dbb-launch-btn') as HTMLButtonElement;
  // hide for roles listed in settings.hideForRoles
  const hide = roleList(s.hideForRoles);
  if (hide.length)
    void userContext(tbCtx)
      .then((c) => {
        if (hide.includes(c.role.toLowerCase())) btn.remove();
      })
      .catch(() => undefined);
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

export function destroy() {
  /* overlay removes itself on close */
}
