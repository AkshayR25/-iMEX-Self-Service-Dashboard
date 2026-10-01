/**
 * Minimal in-page modals and toasts for the Dashboard Builder, used instead of the browser's
 * native alert/confirm/prompt (which block the ThingsBoard page and cannot be styled).
 *
 * Runs in the browser inside a ThingsBoard widget. Elements are appended to a `root` element
 * that the caller passes in (normally the builder overlay), so they pick up its theme CSS
 * variables. Styling lives in `builder/styles.ts` (`.dbb-modal*`, `.dbb-toast*`).
 *
 * Exports:
 * - `modal`: generic dialog with custom HTML body and buttons; returns a handle.
 * - `confirmModal`: yes/no wrapper around `modal`.
 * - `toast`: short, auto-dismissing status message.
 * Used by `builder/builder.ts` (save/apply flow, templates, history, warnings) and by
 * `entries/renderer.ts` for the machine page's edit-menu dialogs (Customise, Reset, thresholds).
 */
import { esc } from '../render/theme';

/** Handle returned by `modal()`. */
export interface ModalHandle {
  /** The dialog body element, for reading inputs or wiring extra events. */
  body: HTMLElement;
  /** Resolves with the key of the button clicked, or 'cancel' (Escape / backdrop click). */
  result: Promise<string>;
  /** Closes the dialog programmatically and resolves `result` with `v`. */
  close(v: string): void;
  /** The footer button with this key, e.g. to disable it until a form is valid. */
  button(key: string): HTMLButtonElement;
}

/**
 * Opens a modal dialog.
 * @param root Element to mount in (the dialog covers it).
 * @param title Header text; escaped.
 * @param html Body markup, inserted as-is: the CALLER must escape any user or telemetry data.
 * @param buttons Footer buttons as `[key, label, extraClass?]`, e.g. `['ok', 'Save', 'primary']`.
 *   Labels are escaped; the key is what `result` resolves with.
 * @param boxClass Extra class on the dialog box, e.g. 'wide' (D-027).
 * @returns A handle; the dialog stays open until a button, Escape, a backdrop click or `close()`.
 * Side effects: adds a capture-phase keydown listener on `document`, removed on close.
 */
export function modal(root: HTMLElement, title: string, html: string, buttons: [string, string, string?][], boxClass = ''): ModalHandle {
  const wrap = document.createElement('div');
  wrap.className = 'dbb-modal';
  wrap.innerHTML = `<div class="dbb-modal-box ${boxClass}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
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
      // Capture phase + stopPropagation: Escape closes only this dialog, not the builder
      // overlay or ThingsBoard's own dialogs listening further down.
      e.stopPropagation();
      close('cancel');
    }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.querySelectorAll<HTMLButtonElement>('[data-mb]').forEach((b) => (b.onclick = () => close(b.dataset.mb!)));
  // Only a press on the dimmed backdrop itself cancels, not one inside the dialog box.
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close('cancel'));
  return { body: wrap.querySelector('.dbb-modal-b') as HTMLElement, result, close, button: (k) => wrap.querySelector(`[data-mb="${k}"]`) as HTMLButtonElement };
}

/**
 * Asks a yes/no question.
 * @param text Plain text (escaped).
 * @param okLabel Label of the confirming button.
 * @param danger Styles the confirm button red, for destructive actions.
 * @returns true only if the confirm button was clicked; Cancel, Escape and backdrop give false.
 */
export async function confirmModal(root: HTMLElement, title: string, text: string, okLabel: string, danger = false): Promise<boolean> {
  const m = modal(root, title, `<div>${esc(text)}</div>`, [
    ['cancel', 'Cancel'],
    ['ok', okLabel, danger ? 'primary danger-fill' : 'primary'],
  ]);
  return (await m.result) === 'ok';
}

/**
 * Shows a short message in a toast stack inside `root` (created on first use, with
 * `role="status"` so screen readers announce it). Errors stay 8 s, others 4 s.
 * @param text Plain text (set via textContent, so no escaping needed).
 * @param kind 'ok' (dark), 'warn' (amber) or 'err' (red).
 */
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
