// Browser runner: lets the Phase 1 scripts run inside a logged-in ThingsBoard page, using that page's
// tenant-admin JWT from localStorage. Same library code as the Node scripts (DECISIONS.md D-001).
import { TbClient, externalTokenAuth } from '../lib/tb';
import { runSetup, SetupResult } from '../lib/setup';
import { runBackfill, BackfillOptions } from '../lib/backfill';
import { Simulator } from '../lib/simulator';
import { planTeardown, executeTeardown, TeardownPlan } from '../lib/teardown';

const logs: string[] = [];
const log = (m: string) => {
  const line = `${new Date().toISOString()}  ${m}`;
  logs.push(line);
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  console.log('[POC] ' + m);
};

const tb = new TbClient(location.origin, externalTokenAuth(() => localStorage.getItem('jwt_token')), { minDelayMs: 150, log });
let sim: Simulator | null = null;

export const state: { result: SetupResult | null } = { result: null };
const ids = () => {
  if (!state.result) throw new Error('run setup() first');
  return Object.fromEntries(Object.entries(state.result.devices).map(([k, v]) => [k, v.id]));
};

export async function setup() {
  state.result = await runSetup(tb, log);
  return state.result;
}
export const backfill = (o?: BackfillOptions) => runBackfill(tb, ids(), log, o);
export async function startSimulator() {
  if (sim?.running) return sim.stats;
  sim = new Simulator(tb, log);
  await sim.init(ids());
  sim.start();
  return sim.stats;
}
export const stopSimulator = () => sim?.stop();
export const simStats = () => (sim ? { running: sim.running, ...sim.stats } : null);
export const teardownPlan = () => planTeardown(tb, log);
export const teardown = (plan: TeardownPlan, confirm: string) => {
  if (confirm !== 'DELETE') throw new Error('pass "DELETE" as the second argument to confirm');
  return executeTeardown(tb, plan, log);
};
export const tail = (n = 30) => logs.slice(-n);
export { tb };
