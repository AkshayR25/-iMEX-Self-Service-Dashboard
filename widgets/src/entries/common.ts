/**
 * Helpers shared by the three ThingsBoard widget entry points (launcher.ts, renderer.ts, listing.ts).
 *
 * Runs in the browser, inside a ThingsBoard dashboard, as part of each widget type's controller script.
 * Remember that each widget type embeds its OWN copy of the bundle (see all.ts), so the module-level
 * state here (the cached user context) is per widget type, not per page. Cross-widget communication
 * therefore goes through `window`:
 *   - CHANGED_EVENT (`imex-dbb:changed`): "dashboards/assignments changed, reload" (fired after the
 *     builder closes with changes, after customise/reset/apply). Renderer and listing reload on it.
 *   - ACTIONS_EVENT (`imex-dbb:actions`) + `window.__imexDbbActions`: the renderer publishes the
 *     machine page's edit actions; the launcher's navbar edit menu shows and runs them (D-020).
 *
 * Exports: userContext, stateEntity, stateParam, currentState, CHANGED_EVENT, notifyChanged,
 * EditAction, EditActions, ACTIONS_EVENT, publishActions, currentActions.
 */
import { bindWidgetContext } from '../core/api';
import { loadUserContext, UserContext } from '../core/scope';

let ctxPromise: Promise<UserContext> | null = null;
let ctxAt = 0;

/**
 * Returns the logged-in user's context (scope nodes, role, isAdmin, profile catalogue; see core/scope.ts).
 *
 * Cached for 5 minutes per library copy (i.e. per widget type on the page); pass `force` to reload,
 * e.g. after CHANGED_EVENT. A failed load clears the cache so the next call retries.
 * Also binds the widget context to the REST client so it can refresh the ThingsBoard JWT.
 *
 * @param tbCtx ThingsBoard widget context (`self.ctx`). `settings.customerId` is used when a tenant
 *   admin opens the app (tenant-admin mode, D-018): that customer's top-level assets become the roots.
 * @param force Bypass the cache.
 * @returns Shared promise of the user context; rejects if the user attributes/hierarchy can't be read.
 */
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

/**
 * Entity of the current dashboard state, as set by `stateController.openState(state, {entityId, ...})`.
 * Accepts `params.entityId` directly or the first nested param object that carries an `entityId`
 * (ThingsBoard nests params per state in some cases).
 * @returns `{id, entityType, name}` or null when the state has no entity or the controller throws.
 */
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

/** One raw parameter of the current dashboard state (e.g. `dbbDashboardId`), or undefined. */
export function stateParam(tbCtx: any, key: string): any {
  try {
    return tbCtx.stateController?.getStateParams?.()?.[key];
  } catch {
    return undefined;
  }
}

/** Window event meaning "stored dashboards or assignments changed"; listeners reload with force. */
export const CHANGED_EVENT = 'imex-dbb:changed';
/** Fires CHANGED_EVENT on `window`, reaching every widget (every library copy) on the page. */
export const notifyChanged = () => window.dispatchEvent(new CustomEvent(CHANGED_EVENT));

/** Current dashboard state {id, params}. Reads the `state` URL parameter (entity state controller) first,
 *  then the widget's state controller. Used by the navbar, which is not always told about state changes. */
export function currentState(tbCtx: any): { id: string; params: any } {
  try {
    const raw = new URLSearchParams(location.search).get('state');
    if (raw) {
      // The entity state controller stores the state stack as URL-safe base64 of UTF-8 JSON.
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

/** One item of the navbar edit menu. `id` is passed back to EditActions.run(). */
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

/** The set of edit actions currently published on `window.__imexDbbActions`. */
export interface EditActions {
  /** Id of the publishing widget instance; only the owner may clear the slot. */
  owner: string;
  /** The widget that published the actions; stale once it leaves the page. */
  el: HTMLElement;
  title: string;
  subtitle?: string;
  items: EditAction[];
  /** Runs the action; called by the launcher with the clicked item's id. */
  run(id: string): void;
}

/** Window event fired whenever `window.__imexDbbActions` is replaced or cleared. */
export const ACTIONS_EVENT = 'imex-dbb:actions';

/**
 * Publishes (or clears, with `a = null`) the edit actions for the navbar's edit menu.
 * Side effects: writes `window.__imexDbbActions` and dispatches ACTIONS_EVENT.
 * Clearing only takes effect if `owner` still owns the slot, so a destroyed widget can't wipe the
 * actions of a newer one. Admin-only filtering is done by the caller (UI only, D-012).
 */
export function publishActions(owner: string, a: Omit<EditActions, 'owner'> | null) {
  const w = window as any;
  if (a) w.__imexDbbActions = { ...a, owner };
  else if (w.__imexDbbActions?.owner === owner) w.__imexDbbActions = null;
  window.dispatchEvent(new CustomEvent(ACTIONS_EVENT));
}

/**
 * Actions currently published for the edit menu, or null. Ignores actions whose publishing element
 * is no longer in the DOM (the widget left the page without clearing them).
 */
export function currentActions(): EditActions | null {
  const a = (window as any).__imexDbbActions as EditActions | null | undefined;
  return a && a.el?.isConnected ? a : null;
}
