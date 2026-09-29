// Local visual harness: runs the widgets against the in-memory fake ThingsBoard.
import { ithena, asUser } from '../test/fake-tb';
import * as launcher from '../src/entries/launcher';
import * as renderer from '../src/entries/renderer';
import * as listing from '../src/entries/listing';
import { openBuilder } from '../src/builder/builder';
import { userContext } from '../src/entries/common';

const tb = ithena();
const now = Date.now();
const N = 7 * 24 * 12; // 7 days of 5-minute points
const gen = (base: number, amp: number, seed = 1) =>
  Array.from({ length: N }, (_, i) => {
    const ts = now - (N - i) * 5 * 60e3;
    const h = new Date(ts).getHours();
    const daily = Math.sin(((h - 6) / 24) * Math.PI * 2);
    return { ts, value: +(base + amp * daily + amp * 0.35 * Math.sin(i / (17 + seed)) + (Math.random() - 0.5) * amp * 0.25).toFixed(2) };
  });
const run = () => {
  const out: { ts: number; value: number }[] = [];
  let v = 1;
  for (let i = 0; i < N; i += 1) {
    if (i % 12 === 0 && Math.random() < 0.09) v = v ? 0 : 1;
    out.push({ ts: now - (N - i) * 5 * 60e3, value: v });
  }
  out[out.length - 1].value = 1;
  return out;
};
tb.telemetry.set('rc', { dischargePressure: gen(7, 0.4), dischargeTemp: gen(85, 6), powerKw: gen(60, 8), runStatus: run() });
tb.telemetry.set('pc', { dischargePressure: gen(6.9, 0.4, 3), dischargeTemp: gen(84, 7, 3), powerKw: gen(52, 9, 3), runStatus: run() });
tb.telemetry.set('rd', { dewPoint: gen(3, 0.5) });
tb.telemetry.set('pw', { temperature: gen(29, 4) });
const role = new URLSearchParams(location.search).get('role') ?? 'Admin';
asUser(tb, 'u1', role, [role === 'Viewer' ? 'pun' : role === 'Manager' ? 'ric' : 'root']);
localStorage.setItem('jwt_token', 'x');
// Chat relay stub (E2E): when the builder writes dbb_chat_req, answer with the next scripted tool input
// from window.__chatQueue (or an error string) as the rule chain would, in dbb_chat_resp_<userId>.
(window as any).__chatQueue = [] as any[];
(window as any).__chatReqs = [] as any[];
const baseFetch = tb.fetch;
(window as any).fetch = async (url: string, init: any = {}) => {
  const r = await baseFetch(url, init);
  if ((init.method ?? 'GET').toUpperCase() === 'POST' && /\/attributes\/SERVER_SCOPE$/.test(url) && init.body?.includes('dbb_chat_req')) {
    const req = JSON.parse(init.body).dbb_chat_req;
    (window as any).__chatReqs.push(req);
    const next = (window as any).__chatQueue.shift();
    setTimeout(() => {
      const resp = typeof next === 'string' ? { reqId: req.reqId, ok: false, provider: 'gemini', error: next } : { reqId: req.reqId, ok: true, provider: 'gemini', toolInput: next ?? { reply: 'ok', ops: [] } };
      tb.setAttrs('ASSET', 'store', { [`dbb_chat_resp_${req.userId}`]: resp });
    }, 200);
  }
  return r;
};
(window as any).__tb = tb;

let state: any = { entityId: { id: new URLSearchParams(location.search).get('dev') ?? 'pc', entityType: 'DEVICE' } };
// Simulates an app navbar that switches the machine by rewriting the state URL only (no onStateChanged,
// state controller unchanged): the case reported on 28 Sep 2026.
(window as any).__urlSwitch = (dev: string) => {
  const arr = [{ id: 'machine', params: { entityId: { id: dev, entityType: 'DEVICE' } } }];
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(arr)))).replace(/\+/g, '-').replace(/\//g, '_');
  const u = new URL(location.href);
  u.searchParams.set('state', b64);
  history.replaceState(null, '', u.toString());
};
const mk = (sel: string, settings: any) => ({
  $container: [document.querySelector(sel)],
  settings,
  stateController: { getStateParams: () => state, openState: (_s: string, p: any) => { state = p; renderer.onStateChanged(rctx); } },
});
const rctx = mk('#body', {});
launcher.init(mk('#nav', { navbar: true, appName: 'iMEX · ITHENA' }));
const pg = new URLSearchParams(location.search).get('page');
if (pg === 'builder') {
  // Builder E2E: open the builder directly for ?dev= (or no machine with dev=none); instance on window.__b.
  const dev = new URLSearchParams(location.search).get('dev');
  void userContext(rctx).then((ctx) => {
    (window as any).__closed = null;
    (window as any).__b = openBuilder({ ctx, deviceId: dev === 'none' ? null : dev ?? 'pc', dashboardId: null, chatEnabled: true, onClose: (ch) => ((window as any).__closed = { changed: ch }) });
  });
} else if (pg === 'list') listing.init(mk('#body', {}));
else if (pg === 'map') listing.init(mk('#body', { mode: 'map' }));
else renderer.init(rctx);
