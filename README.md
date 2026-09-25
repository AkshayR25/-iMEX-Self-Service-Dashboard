# iMEX Self-Service Configuration POC

A customer-facing configuration app on top of ThingsBoard CE. See the build instructions document, plus `DECISIONS.md` for deviations from it.

## Status

| Phase | State |
|---|---|
| 1. ThingsBoard setup and simulator | done on demo.thingsboard.io (CE 4.3.0.3DEMO) |
| 2. Config service | not started |
| 3–6 | not started |

## Requirements

Node.js 20+ and a ThingsBoard CE tenant admin account.

## Setup

```bash
npm install
cp .env.example .env      # fill TB_URL, TB_TENANT_USERNAME, TB_TENANT_PASSWORD yourself
npm run setup:tb          # idempotent; writes scripts/output/setup-result.json
npm run backfill          # 7 days at 5-min intervals, 2,016 points per device (about 1 min)
npm run simulator         # live telemetry every 10 s; Ctrl+C to stop
npm run teardown          # lists every poc=true entity, deletes after you type DELETE
npm test                  # unit tests
```

Pass device names to backfill only those devices: `npm run backfill -- RIC-DRY-01`.

### Running inside the ThingsBoard page (no Node or .env needed)

`npm run build:browser` produces `scripts/output/poc-browser.js`. Paste it into the browser console of a logged-in ThingsBoard tenant-admin page. That defines `POC`, which you use like this:

```js
await POC.setup();             // same as setup:tb
await POC.backfill();          // same as backfill
await POC.startSimulator();    // runs while this tab stays open
POC.simStats(); POC.tail(20);  // simulator status and recent log lines
POC.stopSimulator();
const plan = await POC.teardownPlan(); await POC.teardown(plan, 'DELETE');
```

## What Phase 1 creates

- **Customer** ITHENA (`poc=true`)
- **Asset profiles:** Organization, Site, Plant, Line
- **Device profiles**, each with an alarm rule that has a dynamic threshold and a clear rule:
  - Compressor: `dischargeTemp > thr_dischargeTemp_high` (default 95), MAJOR
  - Dryer: `dewPoint > thr_dewPoint_high` (default 5), MAJOR
  - Weather Station: `temperature > thr_temperature_high` (default 42), WARNING
- **Hierarchy (relation type Contains):**
  - ITHENA-ROOT → SITE-RICHMOND → RIC-COMP-01, RIC-DRY-01
  - ITHENA-ROOT → SITE-PUNE → PUN-COMP-01, PUN-WS-01
- **No ThingsBoard users.** App users are created in the service DB in Phase 2 (see DECISIONS.md, D-002).

The simulator pushes one random device past its threshold for about a minute, about every 10 minutes (the first time after 1 minute). Compressors occasionally stop for 5–25 minutes.
