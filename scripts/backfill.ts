import { tenantClient, readResult, deviceIdMap, log } from './lib/env';
import { runBackfill } from './lib/backfill';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
runBackfill(tenantClient(), deviceIdMap(readResult()), log, { only: only.length ? only : undefined })
  .then((w) => log(`backfill done: ${JSON.stringify(w)}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
