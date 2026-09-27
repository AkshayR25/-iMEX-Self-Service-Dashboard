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

### D-002 No ThingsBoard customer users — SUPERSEDED by D-010
*Kept for history. The user decided against an external service, so app users are ThingsBoard customer users after all (D-010). The risk described here is real and is now handled as described in D-012.*

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

### D-009 SQLite seeding moves to Phase 2 — SUPERSEDED by D-010
*There is no SQLite and no service; all state lives in ThingsBoard attributes.*

Spec 4.1 step 8 seeds SQLite during setup. The service schema doesn't exist until Phase 2, so the service will seed itself on first start from `setup-result.json` and `model.ts`.

### D-010 No external service: everything runs as ThingsBoard widgets (user decision, 26 Sep 2026)
The build instructions describe a Node config service plus a React app. The user asked for no service outside ThingsBoard. So:

- The Dashboard Builder, the machine dashboard renderer and a stand-in app listing are **three custom ThingsBoard widgets** (`tenant.imex_dbb_launcher`, `imex_dbb_renderer`, `imex_dbb_listing`) in the bundle "iMEX Self-Service (POC)".
- They are plain TypeScript + DOM + SVG (no framework), bundled by esbuild into one IIFE (`widgets/dist/imex-dbb.js`, about 190 KB) that is embedded in each widget type's controller script.
- The widgets call the ThingsBoard REST API **with the logged-in user's own JWT**. No tenant credentials exist anywhere in the widgets.
- App users are ordinary ThingsBoard **customer users**. Their scope and role come from their existing user attributes (D-011).

### D-011 Scope and role come from the existing user attributes
Matches the production app's user attributes (screenshots from the user, 26 Sep 2026):

- `selectedNodes`: a JSON list of `{entityId, name, ...}`. `entityId` may be a string or `{id, entityType}`, and the name is used as a fallback. The user's scope is these nodes plus everything below them via `Contains` relations.
- `Role`: `Admin` (also `Customer Admin`, `Administrator`, or the attribute `dbbAdmin=true`) may apply a dashboard to several machines, a location or the whole customer. Any other role may only change their own view or the one machine they are editing, and only if that machine is in scope.
- "Customer-wide" is only offered to admins whose scope nodes are top-level (they have no parent asset). A site-scoped admin gets "all machines under a location" instead.

### D-012 Security model in CE, and what it does not protect
Checked live on demo.thingsboard.io with a real customer user:

| Customer user can | Result |
|---|---|
| Read telemetry and attributes of every device and asset assigned to the customer | yes (so scope is **UI-enforced only**) |
| Write SERVER/SHARED attributes on those devices and assets, and on their own user | yes |
| Write customer attributes | no (403) |
| Create assets or dashboards | no (403) |
| Read or write other users' attributes | no (403) |

Consequences:

- Dashboards are stored as attributes on one **DashboardStore asset per customer**, which is assigned to the customer (customers can't write customer attributes).
- Admin-only actions (apply to many machines) are **enforced in the widget only**. A user with the browser console and REST knowledge could write `dbb_assign` on any device of their customer. This is the same trust boundary as the existing app: CE has no per-user entity permissions. PE's role-based permissions or a rule-chain validator would close it. Out of scope for the POC; call it out before production.
- Every save and apply writes an audit entry (`dbb_audit` timeseries on the store asset: who, what, when, affected machines).

### D-013 Storage model
| Where | Key | Content |
|---|---|---|
| Store asset | `dbb_d_<id>` | dashboard JSON (versioned; optimistic concurrency by `version`) |
| Store asset | `dbb_h_<id>` | last 10 versions, for History/restore |
| Store asset | `dbb_assign_customer` | `{profile: {dashboardId, by, at}}` customer-wide defaults |
| Store asset | `dbb_profile_keys` | per profile: key, display name, unit, decimals (the catalogue for the builder and the LLM) |
| Store asset | `dbb_chat_req`, `dbb_chat_resp_<userId>` | chat relay request and responses |
| Asset (site/plant/line) | `dbb_assign` | `{profile: {dashboardId, by, at}}` for all machines of that type below it |
| Device | `dbb_assign` | `{dashboardId, mode: linked\|copy\|customised}` |
| User | `dbb_personal` | `{deviceId: dashboardId}` personal views |

A machine shows the first match of: personal → device → nearest ancestor location → customer-wide → built-in default layout. The renderer header says which one ("From: All Compressor machines") and offers a switcher between all that apply.

### D-014 Chat goes through a rule chain, not the browser
The browser can't hold the Anthropic API key safely, and there is no service. So:

1. The builder writes `dbb_chat_req` (catalogue, masked entity names, conversation) to the store asset.
2. Rule chain **"DBB Chat relay (POC)"** (default chain of the DashboardStore asset profile) filters that update, builds the Messages API request, calls `https://api.anthropic.com/v1/messages` with the key held in the **"Call LLM" REST node header** `x-api-key`, and writes `dbb_chat_resp_<userId>` back.
3. The widget polls that attribute for up to 30 s.

- The model returns operations through one tool (`dashboard_ops`). They are validated with Zod, retried once with the validation errors, then auto-laid-out. The user sees a summary and can undo.
- Entity names are replaced by aliases (D1, N1…). Machines outside the user's scope are sent as `OUTSIDE_ACCESS` and can't be referenced.
- Limit: 30 chat requests per user per hour (browser-side).
- The API key is **not set by the agent**. Paste it into the "Call LLM" node (Rule chains → DBB Chat relay (POC) → Call LLM → Headers → `x-api-key`). Until then chat answers "The LLM API key … is missing or invalid."

### D-015 Non-admins can't overwrite a shared dashboard
If a non-admin edits a dashboard that is linked to more than one machine, or that comes from a location/customer assignment, Save offers **Save as copy** instead. The copy can then be applied to "only me" or to the one machine being edited.

### D-016 Deployment into ThingsBoard
`widgets/deploy/deploy-browser.js` defines `DBB_DEPLOY()` for a tenant-admin page. It idempotently creates or updates the rule chain (keeping an existing API key), the DashboardStore profile and store asset, the widget bundle and the 3 widget types, and the stand-in dashboard "iMEX App (POC)", and it sets that as the home dashboard of the listed users. Teardown (`scripts/lib/teardown.ts`) now also removes these.

### D-017 Scope alignment, 27 Sep 2026 (user decision): admin-only builder, view-only users
- **Navigation of the stand-in app:** Map page (title + button, placeholder for a real map) → Machines listing (hierarchy tree + machine cards) → machine page. The navbar has Map and Machines links and a breadcrumb.
- **Dashboard Builder button:** only users with `Role` = Admin see it (`adminOnly` setting, on by default). The builder also refuses to open for non-admins. Both checks are UI-level (D-012).
- **Everyone else views only:** no Edit, no source chip, no switcher, no personal views, no Customise/Reset/Thresholds.
- **Save → apply:** after saving, the admin is asked "Only <this machine>" or "All <type> machines" (customer-wide when the admin's scope is the whole customer, otherwise every machine of that type in their scope), or "Don't apply now".
- **"Saved as a state"** means the per-machine layout stored in attributes and shown in the app's single `machine` state. Real ThingsBoard dashboard states can't be written by customer users (403), and writing them from a rule chain would need tenant credentials.
- Personal views (D-013's `dbb_personal`) are still resolved if present, but nothing in the UI creates them any more.

## ThingsBoard quirks found

- `GET /api/plugins/telemetry/.../values/timeseries` returns **at most 100 points** when `limit` is omitted and `agg` is NONE. The service must always pass `limit` (checked: 2,016 stored, 100 returned without a limit).
- `GET /api/tenant/assets?assetName=`, `/api/tenant/devices?deviceName=` and `/api/tenant/customers?customerTitle=` return **404** when nothing matches (not an empty page).
- `POST /api/relation` behaves as an upsert, so reruns don't duplicate relations.
- Each server-attribute write is a separate call, and the demo server takes about 0.4–0.8 s per call. A full setup run takes about 25 s.
- No HTTP 429s were seen during the 8,064-point backfill at 200 points per request and a 1 s pause.
- `GET /api/widgetType?fqn=` needs the `tenant.` prefix for tenant widgets (`fqn=tenant.imex_dbb_launcher`); the response omits `description`, so read `/api/widgetType/{id}` before an update. Dashboards reference them as `typeFullFqn: "tenant.imex_dbb_launcher"`.
- TBEL: a ternary inside a map literal (`{a: x ? 1 : 2}`) is mis-parsed (the `:` is taken as a key separator). Compute into a variable first.
- The "save attributes" node rejects `ATTRIBUTES_UPDATED` messages. A transform that feeds it must return `msgType: "POST_ATTRIBUTES_REQUEST"` and string-only metadata.
- `GET /api/user/{id}/token` lets a tenant admin get a user's token (used only to test as the sample users).
- The demo server is slow: the builder's "affected machines" preview and the renderer's refresh after an apply take 3–10 s there.
