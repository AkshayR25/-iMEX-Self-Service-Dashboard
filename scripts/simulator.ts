import { tenantClient, readResult, deviceIdMap, log } from './lib/env';
import { Simulator } from './lib/simulator';

const sim = new Simulator(tenantClient(), log);
sim
  .init(deviceIdMap(readResult()))
  .then(() => sim.start())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
process.on('SIGINT', () => {
  sim.stop();
  log(`stats ${JSON.stringify(sim.stats)}`);
  process.exit(0);
});
