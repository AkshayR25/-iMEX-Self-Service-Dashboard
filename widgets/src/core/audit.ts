// Audit trail: each builder action is written as a timeseries point (key dbb_audit) on the store asset,
// so ThingsBoard keeps the full history. Best effort: failures never block the user.
import * as api from './api';
import type { UserContext } from './scope';

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
