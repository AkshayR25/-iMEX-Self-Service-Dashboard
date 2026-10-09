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
//   {subscriptionId, data: {key: [[ts, value]]}}. So Live's cache, history, readiness and fallback logic are
//   unchanged (and stay covered by live.test.ts).
//   D-046: the TIMESERIES commands that arrive together (the same tick: a page that draws many machines, a
//   reconnect that resubscribes everything) become ONE subscriptionApi.createSubscriptionFromInfo('latest', ...)
//   with one entity per device (each with its own keys), instead of one subscription per device. The pushed data is
//   split by device (datasource.entityId) back into one reply per command, and a device whose values did not change
//   gets no reply (no needless redraw). Stopping one device of a group re-creates the group without it in the next
//   tick, together with any new commands.
//
// Also through the same connection (D-046)
//   watchAlarmCounts()  alarm counts pushed by ThingsBoard (alarmCount datasources): api.activeAlarmCounts reads
//                       them instead of a REST query, and api.alarms re-reads its list only when a count changed.
//   watchAttribute()    one attribute of one entity, pushed when it changes (the chat's reply attribute, core/chat.ts).
//
// Providers
//   Every iMEX widget registers its ThingsBoard context as a provider on init and removes it on destroy
//   (registerLiveProvider / unregisterLiveProvider). The newest provider still on the page carries the
//   subscriptions. When it goes (state change), the sockets bound to it close; Live reconnects and resubscribes
//   through the next provider; count watches are made again through the next provider on their next use.
//   Without any provider, or without the subscription API (another platform version), Live opens its own
//   WebSocket exactly as before and the callers of the watches use REST.
import type { WsLike } from './live';

interface Provider {
  ctx: any;
  sockets: Set<TbSocket>;
  /** Count watches made through this provider (marked dead when it goes). */
  watches?: Set<{ dead: boolean }>;
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
  for (const w of p.watches ?? []) w.dead = true;
}

/** One device of a TIMESERIES command (Live's cmdId). */
interface Member {
  cmdId: number;
  deviceId: string;
  keys: string[];
  stopped: boolean;
  /** The last data sent to Live for this command (JSON), null before the first reply. */
  sig: string | null;
  group: Group | null;
}
/** One ThingsBoard subscription carrying several devices. */
interface Group {
  sub: any;
  members: Member[];
  stopped: boolean;
  dirty: boolean;
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
  private members = new Map<number, Member>();
  private pending: Member[] = [];
  private groups = new Set<Group>();
  private queued = false;

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
    for (const id of [...this.members.keys()]) this.stop(id);
    for (const g of [...this.groups]) this.removeGroup(g);
    this.pending = [];
    this.p.sockets.delete(this);
  }

  /** The provider widget is gone: close as a socket would (Live reconnects through the next provider). */
  drop(): void {
    if (this.readyState === 3) return;
    this.close();
    this.onclose?.({});
  }

  /** Number of ThingsBoard subscriptions this socket holds (tests, diagnostics). */
  subscriptionCount(): number {
    return this.groups.size;
  }

  private start(cmdId: number, deviceId: string, keys: string[]) {
    const m: Member = { cmdId, deviceId, keys, stopped: false, sig: null, group: null };
    this.members.set(cmdId, m);
    this.pending.push(m);
    this.schedule();
  }

  private stop(cmdId: number) {
    const m = this.members.get(cmdId);
    if (!m) return;
    m.stopped = true;
    this.members.delete(cmdId);
    const g = m.group;
    if (!g) return;
    if (g.members.every((x) => x.stopped)) this.removeGroup(g);
    else {
      // re-created without this device in the next tick (with any new commands)
      g.dirty = true;
      this.schedule();
    }
  }

  private schedule() {
    if (this.queued) return;
    this.queued = true;
    Promise.resolve().then(() => {
      this.queued = false;
      this.flush();
    });
  }

  private flush() {
    if (this.readyState !== 1) return;
    for (const g of [...this.groups]) {
      if (!g.dirty) continue;
      this.removeGroup(g);
      for (const m of g.members) {
        if (m.stopped) continue;
        m.group = null;
        this.pending.push(m);
      }
    }
    const list = this.pending.filter((m) => !m.stopped && !m.group);
    this.pending = [];
    if (list.length) this.createGroup(list);
  }

  private removeGroup(g: Group) {
    g.stopped = true;
    this.groups.delete(g);
    if (g.sub) {
      try {
        this.p.ctx.subscriptionApi.removeSubscription(g.sub.id);
      } catch {
        /* the widget is gone; ThingsBoard has removed its subscriptions */
      }
    }
  }

  private fail(g: Group, msg: string) {
    if (g.stopped || this.readyState !== 1) return;
    for (const m of g.members) if (!m.stopped) this.onmessage?.({ data: JSON.stringify({ subscriptionId: m.cmdId, errorCode: 1, errorMsg: msg }) });
  }

  private createGroup(list: Member[]) {
    const api = this.p.ctx.subscriptionApi;
    const g: Group = { sub: null, members: list, stopped: false, dirty: false };
    for (const m of list) m.group = g;
    this.groups.add(g);
    const info = list.map((m) => ({ type: 'entity', entityType: 'DEVICE', entityId: m.deviceId, timeseries: m.keys.map((name) => ({ name })) }));
    try {
      api
        .createSubscriptionFromInfo(
          'latest',
          info,
          {
            callbacks: {
              onDataUpdated: (s: any) => this.onData(g, s),
              onDataUpdateError: () => this.fail(g, 'subscription error'),
            },
          },
          false,
          true,
        )
        .subscribe(
          (sub: any) => {
            g.sub = sub;
            if (g.stopped) {
              try {
                api.removeSubscription(sub.id);
              } catch {
                /* gone */
              }
            }
          },
          () => this.fail(g, 'subscription failed'),
        );
    } catch {
      this.fail(g, 'subscription failed');
    }
  }

  /** Splits the group's data by device and replies for every device whose values changed. */
  private onData(g: Group, s: any) {
    if (g.stopped || this.readyState !== 1) return;
    const rows: any[] = s?.data ?? [];
    const byId = new Map(g.members.map((m) => [m.deviceId, m]));
    // without entity ids the rows come in datasource order, one per key
    const order: Member[] = [];
    for (const m of g.members) for (let k = 0; k < m.keys.length; k++) order.push(m);
    const per = new Map<Member, Record<string, any[]>>();
    rows.forEach((d, i) => {
      const k = d?.dataKey?.name;
      if (!k) return;
      const id = d?.datasource?.entityId;
      const m = id ? byId.get(id) : g.members.length === 1 ? g.members[0] : rows.length === order.length ? order[i] : undefined;
      if (!m || m.stopped) return;
      let o = per.get(m);
      if (!o) per.set(m, (o = {}));
      o[k] = (d.data ?? []).filter((p: any) => p && p[0] > 0);
    });
    for (const m of g.members) {
      if (m.stopped) continue;
      const data = per.get(m) ?? {};
      const sig = JSON.stringify(data);
      if (sig === m.sig) continue;
      m.sig = sig;
      this.onmessage?.({ data: JSON.stringify({ subscriptionId: m.cmdId, data }) });
    }
  }
}

// ---------- pushed alarm counts (D-046) ----------

/** One count datasource: a name for the result, an entity filter, the alarm statuses counted ([] = any). */
export interface CountSpec {
  name: string;
  filter: any;
  status: string[];
}

/** Pushed alarm counts of a set of CountSpecs. */
export interface CountWatch {
  /** The counts by spec name once ThingsBoard sent them, else null. */
  counts(): Record<string, number> | null;
  /** Resolves true as soon as counts() has values, false after `timeoutMs` or when the watch failed. */
  waitReady(timeoutMs: number): Promise<boolean>;
  /** True until the provider went or the subscription failed (then make a new one). */
  alive(): boolean;
  stop(): void;
}

function countKey(ctx: any) {
  try {
    if (ctx?.utils?.createKey) return ctx.utils.createKey({ name: 'count' }, 'count');
  } catch {
    /* fall through */
  }
  return { name: 'count', type: 'count', label: 'count', settings: {} };
}

/**
 * Alarm counts pushed by ThingsBoard through the current provider (one subscription with one alarmCount datasource
 * per spec; ThingsBoard pushes a new count about 20 ms after an alarm changes when the datasource has an entity
 * filter, see DECISIONS "ThingsBoard quirks"). Results are matched to the specs by their order (ThingsBoard renames
 * count datasources).
 * @returns null without a provider or without createSubscription (the caller uses REST).
 */
export function watchAlarmCounts(specs: CountSpec[]): CountWatch | null {
  const p = currentProvider();
  const api = p?.ctx?.subscriptionApi;
  if (!p || !api || typeof api.createSubscription !== 'function' || !specs.length) return null;
  const state = { dead: false };
  let values: Record<string, number> | null = null;
  let handle: any = null;
  let stopped = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((f) => f());
  const key = countKey(p.ctx);
  const options: any = {
    type: 'latest',
    datasources: specs.map((s) => ({ type: 'alarmCount', name: s.name, dataKeys: [key], alarmFilterConfig: { statusList: s.status }, entityFilter: s.filter })),
    callbacks: {
      onDataUpdated: (x: any) => {
        if (stopped) return;
        const out: Record<string, number> = {};
        (x?.data ?? []).forEach((d: any, i: number) => {
          const v = d?.data?.[0];
          if (v && specs[i]) out[specs[i].name] = Number(v[1]) || 0;
        });
        if (Object.keys(out).length === specs.length) {
          values = out;
          wake();
        }
      },
      onDataUpdateError: () => {
        state.dead = true;
        wake();
      },
      dataLoading: () => {},
    },
  };
  (p.watches ??= new Set()).add(state);
  try {
    api.createSubscription(options, true).subscribe(
      (s: any) => {
        handle = s;
        if (stopped) api.removeSubscription(s.id);
      },
      () => {
        state.dead = true;
        wake();
      },
    );
  } catch {
    p.watches.delete(state);
    return null;
  }
  return {
    counts: () => (state.dead ? null : values),
    alive: () => !state.dead && !stopped,
    waitReady(timeoutMs) {
      if (values && !state.dead) return Promise.resolve(true);
      if (state.dead || stopped) return Promise.resolve(false);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(!!values && !state.dead), timeoutMs);
        waiters.push(() => {
          clearTimeout(t);
          resolve(!!values && !state.dead);
        });
      });
    },
    stop() {
      stopped = true;
      p.watches?.delete(state);
      wake();
      if (handle) {
        try {
          api.removeSubscription(handle.id);
        } catch {
          /* gone */
        }
      }
      handle = null;
    },
  };
}

/**
 * One attribute of one entity, pushed when it changes (any scope; for the chat's reply attribute, D-046).
 * `onValue` gets the raw value (a JSON string stays a string) every time ThingsBoard sends it, starting with the
 * current one (undefined when the entity has no such attribute yet). `onError` when the subscription fails.
 * @returns stop(), or null without a provider (the caller polls over REST).
 */
export function watchAttribute(entity: { id: string; entityType: string }, key: string, onValue: (v: unknown) => void, onError?: () => void): { stop(): void } | null {
  const p = currentProvider();
  if (!p) return null;
  const api = p.ctx.subscriptionApi;
  let handle: any = null;
  let stopped = false;
  try {
    api
      .createSubscriptionFromInfo(
        'latest',
        [{ type: 'entity', entityType: entity.entityType, entityId: entity.id, attributes: [{ name: key }] }],
        {
          callbacks: {
            onDataUpdated: (s: any) => {
              if (stopped) return;
              const row = (s?.data ?? []).find((d: any) => d?.dataKey?.name === key) ?? s?.data?.[0];
              const v = row?.data?.[0];
              onValue(v && v[0] > 0 ? v[1] : undefined);
            },
            onDataUpdateError: () => {
              if (!stopped) onError?.();
            },
          },
        },
        false,
        true,
      )
      .subscribe(
        (sub: any) => {
          handle = sub;
          if (stopped) api.removeSubscription(sub.id);
        },
        () => {
          if (!stopped) onError?.();
        },
      );
  } catch {
    return null;
  }
  return {
    stop() {
      stopped = true;
      if (handle) {
        try {
          api.removeSubscription(handle.id);
        } catch {
          /* gone */
        }
      }
      handle = null;
    },
  };
}

/** The connect function for Live: through ThingsBoard when a provider is there, else a WebSocket of our own. */
export function connectLive(url: string): WsLike {
  const p = currentProvider();
  if (p) return new TbSocket(p);
  return new WebSocket(url) as unknown as WsLike;
}
