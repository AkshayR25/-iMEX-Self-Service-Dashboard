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
    ctxPromise = loadUserContext().catch((e) => {
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
