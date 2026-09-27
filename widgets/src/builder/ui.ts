// Minimal in-page modals and toasts (no native dialogs).
import { esc } from '../render/theme';

export interface ModalHandle {
  body: HTMLElement;
  result: Promise<string>;
  close(v: string): void;
  button(key: string): HTMLButtonElement;
}

export function modal(root: HTMLElement, title: string, html: string, buttons: [string, string, string?][]): ModalHandle {
  const wrap = document.createElement('div');
  wrap.className = 'dbb-modal';
  wrap.innerHTML = `<div class="dbb-modal-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dbb-modal-h">${esc(title)}</div><div class="dbb-modal-b">${html}</div>
    <div class="dbb-modal-f">${buttons.map(([k, l, c]) => `<button class="dbb-btn ${c ?? ''}" data-mb="${k}">${esc(l)}</button>`).join('')}</div></div>`;
  root.appendChild(wrap);
  let resolve!: (v: string) => void;
  const result = new Promise<string>((r) => (resolve = r));
  const close = (v: string) => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    resolve(v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close('cancel');
    }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.querySelectorAll<HTMLButtonElement>('[data-mb]').forEach((b) => (b.onclick = () => close(b.dataset.mb!)));
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close('cancel'));
  return { body: wrap.querySelector('.dbb-modal-b') as HTMLElement, result, close, button: (k) => wrap.querySelector(`[data-mb="${k}"]`) as HTMLButtonElement };
}

export async function confirmModal(root: HTMLElement, title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  const m = modal(root, title, `<div>${esc(text)}</div>`, [
    ['cancel', 'Cancel'],
    ['ok', okLabel, danger ? 'primary danger-fill' : 'primary'],
  ]);
  return (await m.result) === 'ok';
}

export function toast(root: HTMLElement, text: string, kind: 'ok' | 'warn' | 'err' = 'ok') {
  let host = root.querySelector('.dbb-toasts') as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'dbb-toasts';
    host.setAttribute('role', 'status');
    root.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `dbb-toast ${kind}`;
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}
