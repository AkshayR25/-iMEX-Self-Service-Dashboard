import { tenantClient, writeResult, log } from './lib/env';
import { runSetup } from './lib/setup';

const tb = tenantClient();
runSetup(tb, log)
  .then((r) => {
    writeResult(r);
    log(`done: ${r.summary.created.length} created, ${r.summary.reused.length} reused`);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
