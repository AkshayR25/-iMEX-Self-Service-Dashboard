# DECISIONS

Assumptions, deviations from *iMEX Self-Service Configuration POC — Build Instructions* (25 Sep 2026), and ThingsBoard quirks found.

## Environment

- **ThingsBoard:** `https://demo.thingsboard.io`, **CE 4.3.0.3DEMO** (from `/api/system/info`). Shared public server, so all data is fictional.
- REST paths were checked against `/v3/api-docs` on the instance before use.
- The tenant already contains ThingsBoard's own demo entities (33 devices, customers A/B/C and others). The POC never touches them because everything we create carries `poc=true`.

## Decisions

### D-001 Phase 1 scripts run in the browser, from the same code
The build agent's cloud workspace can't reach demo.thingsboard.io (blocked by the org's network policy), and it can't run commands on the user's PC. So Phase 1 was run inside the logged-in ThingsBoard page:

- `npm run build:browser` bundles `scripts/lib/*` into `scripts/output/poc-browser.js`.
- The bundle uses that page's tenant-admin JWT (`localStorage.jwt_token`), so no password was typed or stored by the agent.

The Node entry points (`npm run setup:tb`, `backfill`, `simulator`, `teardown`) run the same library code with `.env` credentials, and are the intended way to run from Phase 2 on.

A consequence: **the live simulator currently runs inside a browser tab.** It stops if that tab reloads. For anything longer-lived, run `npm run simulator` on a PC.

### D-002 No ThingsBoard customer users (changes section 3 "Users and roles" and 4.1 step 7)
In CE, a customer user can log in to the ThingsBoard UI or REST API directly. From there they see every device assigned to the customer and can act on alarms, which bypasses our node scope, our role permissions and our audit log. That breaks proofs 4 and 5.

So app users live only in the config service's own database (password hashes, roles, scopes), and the service uses the tenant service account for every ThingsBoard call.

- The three sample users are listed in `scripts/lib/model.ts` (`APP_USERS`). They are seeded into SQLite in Phase 2, with local one-time activation links instead of ThingsBoard activation links.
- This also drops "keep the user's ThingsBoard JWT server-side" from 5.1, because there isn't one.

### D-003 Alarm rules: dynamic threshold, clear rule, propagation
- **Create rule:** `key > threshold`. The threshold is a dynamic value from the device's **server attribute** `thr_*` (source `CURRENT_DEVICE`, no inherit), with the spec default used when the attribute is missing.
- **Clear rule (added; missing from the spec):** `key <= same threshold`. Without a clear rule, device-profile alarms never clear.
- **Propagation:** alarms propagate up `Contains` relations, so site and root assets also see them (useful for Map marker colours). Propagation to owner and tenant is off.
- ThingsBoard 4.3 also offers alarm rules as `ALARM` calculated fields. We kept device-profile rules because the root rule chain on this tenant still has the Device Profile node. Revisit if the target production version drops profile alarms.

### D-004 Backfill via the tenant REST API, not the device API
The backfill posts to `POST /api/plugins/telemetry/DEVICE/{id}/timeseries/ANY`, in batches of 200 with a 1 s pause. That endpoint saves directly, without the rule engine, so history doesn't create alarms. The generator also never exceeds thresholds during backfill (covered by unit tests).

- The backfill ends 10 minutes before "now", so live data owns the latest values.
- The live simulator uses the device transport API (`/api/v1/{token}/telemetry`), which goes through the rule engine and profile alarm rules.

### D-005 POC marker on profiles
Asset and device profiles can't hold attributes. They carry `[poc=true]` in their description instead. Setup refuses to reuse a same-named profile without the marker, and teardown only deletes profiles that have it.

### D-006 Setup refuses to adopt non-POC entities
If an asset, device or customer with a POC name exists without `poc=true`, setup stops with an error rather than reusing or modifying it.

### D-007 Thresholds are only defaulted when missing
On rerun, setup writes `thr_*` attributes only if they are absent. Thresholds a customer edited are not reset.

### D-008 `setup-result.json` holds IDs only
It contains no credentials. The simulator reads access tokens from ThingsBoard at start-up.

### D-009 SQLite seeding moves to Phase 2
Spec 4.1 step 8 seeds SQLite during setup. The service schema doesn't exist until Phase 2, so the service will seed itself on first start from `setup-result.json` and `model.ts`.

## ThingsBoard quirks found

- `GET /api/plugins/telemetry/.../values/timeseries` returns **at most 100 points** when `limit` is omitted and `agg` is NONE. The service must always pass `limit` (checked: 2,016 stored, 100 returned without a limit).
- `GET /api/tenant/assets?assetName=`, `/api/tenant/devices?deviceName=` and `/api/tenant/customers?customerTitle=` return **404** when nothing matches (not an empty page).
- `POST /api/relation` behaves as an upsert, so reruns don't duplicate relations.
- Each server-attribute write is a separate call, and the demo server takes about 0.4–0.8 s per call. A full setup run takes about 25 s.
- No HTTP 429s were seen during the 8,064-point backfill at 200 points per request and a 1 s pause.
