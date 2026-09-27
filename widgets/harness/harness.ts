// Local visual harness: runs the widgets against the in-memory fake ThingsBoard.
import { ithena, asUser } from '../test/fake-tb';
import * as launcher from '../src/entries/launcher';
import * as renderer from '../src/entries/renderer';
import * as listing from '../src/entries/listing';

const tb = ithena();
const now = Date.now();
const gen = (base: number, amp: number) => Array.from({ length: 300 }, (_, i) => ({ ts: now - (300 - i) * 5 * 60e3, value: +(base + amp * Math.sin(i / 20) + Math.random() * amp * 0.2).toFixed(2) }));
tb.telemetry.set('rc', { dischargePressure: gen(7, 0.3), dischargeTemp: gen(85, 3), powerKw: gen(60, 3), runStatus: [{ ts: now, value: 1 }] });
tb.telemetry.set('pc', { dischargePressure: gen(6.9, 0.3), dischargeTemp: gen(84, 3), runStatus: [{ ts: now, value: 1 }] });
tb.telemetry.set('rd', { dewPoint: gen(3, 0.5) });
tb.telemetry.set('pw', { temperature: gen(29, 4) });
const role = new URLSearchParams(location.search).get('role') ?? 'Admin';
asUser(tb, 'u1', role, [role === 'Viewer' ? 'pun' : role === 'Manager' ? 'ric' : 'root']);
localStorage.setItem('jwt_token', 'x');
(window as any).fetch = tb.fetch;
(window as any).__tb = tb;

let state: any = { entityId: { id: new URLSearchParams(location.search).get('dev') ?? 'pc', entityType: 'DEVICE' } };
const mk = (sel: string, settings: any) => ({
  $container: [document.querySelector(sel)],
  settings,
  stateController: { getStateParams: () => state, openState: (_s: string, p: any) => { state = p; renderer.onStateChanged(rctx); } },
});
const rctx = mk('#body', {});
launcher.init(mk('#nav', { navbar: true, appName: 'iMEX · ITHENA' }));
if (new URLSearchParams(location.search).get('page') === 'list') listing.init(mk('#body', {}));
else renderer.init(rctx);
