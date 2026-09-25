import { createInterface } from 'node:readline/promises';
import { tenantClient, log } from './lib/env';
import { planTeardown, executeTeardown } from './lib/teardown';

const tb = tenantClient();
const plan = await planTeardown(tb, log);
for (const [k, list] of Object.entries(plan)) for (const e of list as { name: string }[]) console.log(`  ${k}: ${e.name}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Delete all of the above? Type DELETE to confirm: ');
rl.close();
if (answer.trim() !== 'DELETE') {
  log('aborted, nothing deleted');
  process.exit(0);
}
await executeTeardown(tb, plan, log);
log('teardown complete');
