// core/audit.ts — audit trail for builder actions (DECISIONS D-012).
//
// Each save / apply / restore / delete / chat turn / customise / reset / threshold change is written as one timeseries point, key `dbb_audit`, on the
// customer's DashboardStore asset, so ThingsBoard keeps the full history (who, role, what, when,
// affected machines). Called by the builder and the renderer entry after store operations.
// Best effort: failures are swallowed and never block the user.
//
// Caveat: written from the browser as the user, so it is a convenience log, not tamper-proof
// evidence (a customer user can write telemetry on the store asset directly; D-012).
import * as api from './api';
import type { UserContext } from './scope';

/**
 * Appends one audit entry.
 * Side effect: POST /api/plugins/telemetry/ASSET/<store>/timeseries/ANY with
 * `dbb_audit` = JSON `{user, userId, role, action, ...detail}`, truncated to 8000 characters
 * (so very long detail may produce invalid JSON in the stored string).
 * No-op when the customer has no store asset.
 * @param ctx    current user context (for the store and the user's identity).
 * @param action dotted action name, e.g. 'dashboard.save', 'dashboard.apply', 'chat', 'thresholds.update'.
 * @param detail extra fields merged into the entry (dashboard id, target, affected machines...).
 */
export async function audit(ctx: UserContext, action: string, detail: Record<string, unknown>) {
  if (!ctx.store) return;
  try {
    await api.post(`/api/plugins/telemetry/ASSET/${ctx.store.id}/timeseries/ANY`, {
      ts: Date.now(),
      values: { dbb_audit: JSON.stringify({ user: ctx.email, userId: ctx.userId, role: ctx.role, action, ...detail }).slice(0, 8000) },
    });
  } catch {
    /* ignore */
  }
}
