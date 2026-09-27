// Glue shared by the ThingsBoard widget entry points.
import { bindWidgetContext } from '../core/api';
import { loadUserContext, UserContext } from '../core/scope';

let ctxPromise: Promise<UserContext> | null = null;
let ctxAt = 0;

/** One user context per page (refreshed every 5 minutes or on demand). */
export function userContext(tbCtx: any, force = false): Promise<UserContext> {
  bindWidgetContext(tbCtx);
  if (!ctxPromise || force || Date.now() - ctxAt > 5 * 60e3) {
    ctxAt = Date.now();
    ctxPromise = loadUserContext({ tenantCustomerId: tbCtx?.settings?.customerId || null }).catch((e) => {
      ctxPromise = null;
      throw e;
    });
  }
  return ctxPromise;
}

/** Device/asset id from the dashboard state (entity state controller) or null. */
export function stateEntity(tbCtx: any): { id: string; entityType: string; name?: string } | null {
  try {
    const p = tbCtx.stateController?.getStateParams?.() ?? {};
    const e = p.entityId ?? p[Object.keys(p).find((k) => p[k]?.entityId) ?? '']?.entityId;
    if (e?.id) return { id: e.id, entityType: e.entityType, name: p.entityName };
  } catch {
    /* ignore */
  }
  return null;
}

export function stateParam(tbCtx: any, key: string): any {
  try {
    return tbCtx.stateController?.getStateParams?.()?.[key];
  } catch {
    return undefined;
  }
}

export const CHANGED_EVENT = 'imex-dbb:changed';
export const notifyChanged = () => window.dispatchEvent(new CustomEvent(CHANGED_EVENT));

/** Current dashboard state {id, params}. Reads the `state` URL parameter (entity state controller) first,
 *  then the widget's state controller. Used by the navbar, which is not always told about state changes. */
export function currentState(tbCtx: any): { id: string; params: any } {
  try {
    const raw = new URLSearchParams(location.search).get('state');
    if (raw) {
      const arr = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))));
      const last = Array.isArray(arr) ? arr[arr.length - 1] : null;
      if (last?.id) return { id: last.id, params: last.params ?? {} };
    }
  } catch {
    /* fall through */
  }
  try {
    return { id: tbCtx.stateController?.getStateId?.() || '', params: tbCtx.stateController?.getStateParams?.() ?? {} };
  } catch {
    return { id: '', params: {} };
  }
}

// ---------- edit actions shown in the navbar's edit menu ----------
// The navbar (launcher widget) and the machine dashboard (renderer widget) are separate ThingsBoard
// widgets, each with its own copy of this library, so they talk through `window` and an event.

export interface EditAction {
  id: string;
  label: string;
  hint?: string;
  /** 'switch' items are listed under "Show dashboard" with a check mark. */
  group?: 'main' | 'switch';
  checked?: boolean;
  danger?: boolean;
  icon?: 'edit' | 'copy' | 'reset' | 'sliders' | 'eye';
}

export interface EditActions {
  owner: string;
  /** The widget that published the actions; stale once it leaves the page. */
  el: HTMLElement;
  title: string;
  subtitle?: string;
  items: EditAction[];
  run(id: string): void;
}

export const ACTIONS_EVENT = 'imex-dbb:actions';

export function publishActions(owner: string, a: Omit<EditActions, 'owner'> | null) {
  const w = window as any;
  if (a) w.__imexDbbActions = { ...a, owner };
  else if (w.__imexDbbActions?.owner === owner) w.__imexDbbActions = null;
  window.dispatchEvent(new CustomEvent(ACTIONS_EVENT));
}

export function currentActions(): EditActions | null {
  const a = (window as any).__imexDbbActions as EditActions | null | undefined;
  return a && a.el?.isConnected ? a : null;
}
