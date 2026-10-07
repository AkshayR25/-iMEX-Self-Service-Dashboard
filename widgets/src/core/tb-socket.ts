// D-042: the live layer over ThingsBoard's own WebSocket.
//
// Why
//   The live hub (core/live.ts) used to open a WebSocket of its own. Next to it the ThingsBoard dashboard keeps one
//   for its widgets, so a machine page had two connections per browser tab. TbSocket lets the hub send its
//   subscriptions through a ThingsBoard widget's subscription API instead: the dashboard's one connection carries
//   everything, and ThingsBoard does the authentication, reconnects and token refresh.
//
// How
//   TbSocket looks like a WebSocket to Live (the WsLike surface): Live "opens" it, sends its usual commands (v2
//   {authCmd, cmds: [TIMESERIES ...]} or legacy {tsSubCmds}), and gets replies of the usual form
//   {subscriptionId, data: {key: [[ts, value]]}}. Each TIMESERIES command becomes one
//   subscriptionApi.createSubscriptionFromInfo('latest', ...) for that device and keys; unsubscribe removes it.
//   So Live's cache, history, readiness and fallback logic are unchanged (and stay covered by live.test.ts).
//
// Providers
//   Every iMEX widget registers its ThingsBoard context as a provider on init and removes it on destroy
//   (registerLiveProvider / unregisterLiveProvider). The newest provider still on the page carries the
//   subscriptions. When it goes (state change), the sockets bound to it close; Live reconnects and resubscribes
//   through the next provider. Without any provider, or without the subscription API (another platform version),
//   Live opens its own WebSocket exactly as before.
import type { WsLike } from './live';


interface Provider {
  ctx: any;
  sockets: Set<TbSocket>;
}

function providers(): Provider[] {
  // read when needed (not at import): the page-wide list every iMEX bundle shares
  const w: any = typeof window !== 'undefined' ? window : globalThis;
  return (w.__imexDbbLiveProviders ??= []);
}

/** True when `tbCtx` can carry live subscriptions (ThingsBoard's widget subscription API is there). */
export function canCarry(tbCtx: any): boolean {
  const api = tbCtx?.subscriptionApi;
  return !!(api && typeof api.createSubscriptionFromInfo === 'function' && typeof api.removeSubscription === 'function');
}

/** The newest registered provider whose widget is still on the page, or null. */
export function currentProvider(): Provider | null {
  const list = providers();
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const el = p.ctx?.$container?.[0];
    if (el && el.isConnected === false) continue;
    if (canCarry(p.ctx)) return p;
  }
  return null;
}

/** Called by every iMEX widget on init. Returns true when the context can carry live subscriptions. */
export function registerLiveProvider(tbCtx: any): boolean {
  if (!canCarry(tbCtx)) return false;
  const list = providers();
  if (!list.some((p) => p.ctx === tbCtx)) list.push({ ctx: tbCtx, sockets: new Set() });
  return true;
}

/** Called on destroy: the sockets that went through this widget close (Live then reconnects through another). */
export function unregisterLiveProvider(tbCtx: any): void {
  const list = providers();
  const i = list.findIndex((p) => p.ctx === tbCtx);
  if (i < 0) return;
  const [p] = list.splice(i, 1);
  for (const s of [...p.sockets]) s.drop();
}

/** A WsLike that sends Live's commands through a ThingsBoard widget's subscription API. */
export class TbSocket implements WsLike {
  /** Marks a socket that goes through ThingsBoard (Live.throughTb). */
  readonly isTb = true;
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private subs = new Map<number, { sub: any; stopped: boolean }>();

  constructor(private p: Provider) {
    p.sockets.add(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(raw: string): void {
    if (this.readyState !== 1) return;
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const cmds: any[] = [...(m.cmds ?? []), ...(m.tsSubCmds ?? [])];
    for (const c of cmds) {
      if (c.type && c.type !== 'TIMESERIES') continue;
      if (c.unsubscribe) this.stop(c.cmdId);
      else this.start(c.cmdId, c.entityId, String(c.keys ?? '').split(',').filter(Boolean));
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    for (const id of [...this.subs.keys()]) this.stop(id);
    this.p.sockets.delete(this);
  }

  /** The provider widget is gone: close as a socket would (Live reconnects through the next provider). */
  drop(): void {
    if (this.readyState === 3) return;
    this.close();
    this.onclose?.({});
  }

  private start(cmdId: number, deviceId: string, keys: string[]) {
    const api = this.p.ctx.subscriptionApi;
    const entry = { sub: null as any, stopped: false };
    this.subs.set(cmdId, entry);
    const reply = (data: Record<string, any[]>) => this.readyState === 1 && !entry.stopped && this.onmessage?.({ data: JSON.stringify({ subscriptionId: cmdId, data }) });
    try {
      api
        .createSubscriptionFromInfo(
          'latest',
          [{ type: 'entity', entityType: 'DEVICE', entityId: deviceId, timeseries: keys.map((name) => ({ name })) }],
          {
            callbacks: {
              onDataUpdated: (s: any) => {
                const data: Record<string, any[]> = {};
                for (const d of s?.data ?? []) {
                  const k = d?.dataKey?.name;
                  if (k) data[k] = (d.data ?? []).filter((p: any) => p && p[0] > 0);
                }
                reply(data);
              },
              onDataUpdateError: () => !entry.stopped && this.onmessage?.({ data: JSON.stringify({ subscriptionId: cmdId, errorCode: 1, errorMsg: 'subscription error' }) }),
            },
          },
          false,
          true,
        )
        .subscribe(
          (sub: any) => {
            entry.sub = sub;
            if (entry.stopped) api.removeSubscription(sub.id);
          },
          () => !entry.stopped && this.onmessage?.({ data: JSON.stringify({ subscriptionId: cmdId, errorCode: 1, errorMsg: 'subscription failed' }) }),
        );
    } catch {
      this.onmessage?.({ data: JSON.stringify({ subscriptionId: cmdId, errorCode: 1, errorMsg: 'subscription failed' }) });
    }
  }

  private stop(cmdId: number) {
    const e = this.subs.get(cmdId);
    if (!e) return;
    e.stopped = true;
    this.subs.delete(cmdId);
    if (e.sub) {
      try {
        this.p.ctx.subscriptionApi.removeSubscription(e.sub.id);
      } catch {
        /* the widget is gone; ThingsBoard has removed its subscriptions */
      }
    }
  }
}

/** The connect function for Live: through ThingsBoard when a provider is there, else a WebSocket of our own. */
export function connectLive(url: string): WsLike {
  const p = currentProvider();
  if (p) return new TbSocket(p);
  return new WebSocket(url) as unknown as WsLike;
}
