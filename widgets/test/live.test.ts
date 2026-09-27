// Tests for the WebSocket live layer (core/live.ts) and the multi-provider chat formats (core/chat.ts), D-021.
import { describe, it, expect } from 'vitest';
import { Live, WsLike } from '../src/core/live';
import * as chat from '../src/core/chat';

/** Fake socket: records sent frames; the test drives open/message/close. */
class FakeWs implements WsLike {
  readyState = 0;
  sent: any[] = [];
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  reply(m: any) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function setup() {
  const sockets: FakeWs[] = [];
  const timers: (() => void)[] = [];
  let now = 1_000_000;
  const live = new Live({
    host: 'tb.test',
    token: () => 'jwt',
    connect: (url) => {
      const w = new FakeWs(url);
      sockets.push(w);
      return w;
    },
    now: () => now,
    later: (fn) => timers.push(fn),
  });
  return { live, sockets, timers, tick: (ms: number) => (now += ms), flush: () => new Promise((r) => setTimeout(r, 0)) };
}

describe('live telemetry over WebSocket', () => {
  it('subscribes with auth + TIMESERIES cmd, serves latest values from the cache, ignores nulls', async () => {
    const { live, sockets } = setup();
    live.want('dev1', ['power', 'status']);
    expect(sockets[0].url).toBe('wss://tb.test/api/ws');
    expect(live.get('dev1', ['power'])).toBeNull(); // not open yet -> caller uses REST
    sockets[0].open();
    const first = sockets[0].sent[0];
    expect(first.authCmd).toEqual({ cmdId: 0, token: 'jwt' });
    expect(first.cmds[0]).toMatchObject({ type: 'TIMESERIES', entityType: 'DEVICE', entityId: 'dev1', scope: 'LATEST_TELEMETRY', keys: 'power,status' });
    const cmdId = first.cmds[0].cmdId;
    expect(live.get('dev1', ['power'])).toBeNull(); // no reply yet
    sockets[0].reply({ subscriptionId: cmdId, errorCode: 0, data: { power: [[10, '63.3']], status: [[11, null]] } });
    expect(live.get('dev1', ['power', 'status'])).toEqual({ power: { ts: 10, value: 63.3 } });
    sockets[0].reply({ subscriptionId: cmdId, errorCode: 0, data: { power: [[20, '64']] } });
    expect(live.get('dev1', ['power'])!.power).toEqual({ ts: 20, value: 64 });
    expect(live.get('dev1', ['other'])).toBeNull(); // key not subscribed -> REST
  });

  it('adds keys by resubscribing (unsubscribe old cmd, new cmd with the union)', () => {
    const { live, sockets } = setup();
    live.want('dev1', ['a']);
    sockets[0].open();
    const c1 = sockets[0].sent[0].cmds[0].cmdId;
    live.want('dev1', ['b']);
    const [unsub, sub] = sockets[0].sent.slice(1);
    expect(unsub.cmds[0]).toEqual({ type: 'TIMESERIES', cmdId: c1, unsubscribe: true });
    expect(sub.cmds[0].keys).toBe('a,b');
    live.want('dev1', ['a', 'b']); // nothing new -> no frame
    expect(sockets[0].sent.length).toBe(3);
  });

  it('notifies listeners once per batch and exposes points for chart appends', async () => {
    const { live, sockets, flush } = setup();
    const seen: string[][] = [];
    live.onChange((d) => seen.push(d));
    live.want('dev1', ['p']);
    sockets[0].open();
    const c = sockets[0].sent[0].cmds[0].cmdId;
    sockets[0].reply({ subscriptionId: c, data: { p: [[100, '1']] } });
    sockets[0].reply({ subscriptionId: c, data: { p: [[200, '2']] } });
    await flush();
    expect(seen).toEqual([['dev1']]);
    expect(live.since('dev1', 'p', 100)).toEqual([{ ts: 200, value: 2 }]);
    expect(live.liveSince('dev1', ['p'])).toBe(1_000_000);
  });

  it('falls back to REST while down, switches to the legacy endpoint when v2 closes without a reply, and resubscribes', () => {
    const { live, sockets, timers } = setup();
    live.want('dev1', ['p']);
    sockets[0].close(); // closed before any reply
    expect(live.isLive()).toBe(false);
    expect(live.get('dev1', ['p'])).toBeNull();
    timers.shift()!();
    expect(sockets[1].url).toBe('wss://tb.test/api/ws/plugins/telemetry?token=jwt');
    sockets[1].open();
    expect(sockets[1].sent[0].tsSubCmds[0]).toMatchObject({ entityId: 'dev1', scope: 'LATEST_TELEMETRY', keys: 'p' });
    expect(sockets[1].sent[0].tsSubCmds[0].type).toBeUndefined();
    const c = sockets[1].sent[0].tsSubCmds[0].cmdId;
    sockets[1].reply({ subscriptionId: c, data: { p: [[5, 'x']] } });
    expect(live.get('dev1', ['p'])).toEqual({ p: { ts: 5, value: 'x' } });
  });

  it('marks a device failed on errorCode (REST for that device) and drops unused subscriptions after 3 min', () => {
    const { live, sockets, tick } = setup();
    live.want('dev1', ['p']);
    sockets[0].open();
    const c = sockets[0].sent[0].cmds[0].cmdId;
    sockets[0].reply({ subscriptionId: c, errorCode: 2, errorMsg: 'no access' });
    expect(live.get('dev1', ['p'])).toBeNull();
    tick(4 * 60e3);
    live.want('dev2', ['q']); // gc runs on new subscriptions
    const last = sockets[0].sent[sockets[0].sent.length - 2];
    expect(last.cmds[0]).toEqual({ type: 'TIMESERIES', cmdId: c, unsubscribe: true });
  });
});

describe('chat request formats for Claude, OpenAI and Gemini', () => {
  it('Gemini schema has no type arrays and no free-form objects', () => {
    const g = chat.geminiSchema(chat.TOOL.input_schema);
    const bad: string[] = [];
    (function walk(x: any, p: string) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x.type)) bad.push(p);
      if (x.type === 'object' && !x.properties) bad.push(p);
      for (const [k, v] of Object.entries(x)) walk(v, `${p}.${k}`);
    })(g, '');
    expect(bad).toEqual([]);
    expect(g.properties.clarification.nullable).toBe(true);
    expect(g.properties.ops.items.properties.settings.type).toBe('string');
    // the Claude/OpenAI schema is untouched
    expect((chat.TOOL.input_schema.properties.clarification as any).type).toEqual(['object', 'null']);
  });

  it('OpenAI/Gemini tool blocks force the dashboard_ops tool', () => {
    expect(chat.PROVIDER_TOOLS.openai.tool_choice).toEqual({ type: 'function', function: { name: 'dashboard_ops' } });
    expect(chat.PROVIDER_TOOLS.gemini.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['dashboard_ops'] });
  });

  it('settings/theme sent as JSON strings (Gemini) are parsed back into objects; bad JSON is dropped', () => {
    const out = chat.normaliseToolInput({
      reply: 'ok',
      ops: [
        { op: 'addWidget', type: 'value', keys: ['powerKw'], settings: '{"decimals":1}' },
        { op: 'addWidget', type: 'value', keys: ['powerKw'], settings: 'not json' },
      ],
    });
    expect((out.ops[0] as any).settings).toEqual({ decimals: 1 });
    expect((out.ops[1] as any).settings).toBeUndefined();
  });
});
