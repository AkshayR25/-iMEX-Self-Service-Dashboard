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
*Provider choice and key location changed in D-021: the key is now on the tenant-owned asset DBB-LLM-CONFIG, and Claude, OpenAI and Gemini are supported.*

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

### D-018 Three dashboard states, 27 Sep 2026 (user decision)
- The dashboard "iMEX App (POC)" has three real ThingsBoard states: `default` = **Map page** (site cards for Pune and Richmond, plus one button to the listing), `listing` = **Listing page** (clickable hierarchy on the left, machine cards in the centre), and `machine` = **Machine page** (the per-machine dashboard).
- Clicking a site on the Map page opens the Listing page with that site selected. Clicking a machine in the tree or on a card opens the Machine page.
- The navbar shows the current state's name. The navbar widget isn't notified of state changes, so it reads the `state` URL parameter every 500 ms.
- Tenant-admin mode: when a tenant admin opens the dashboard, the widgets use the `customerId` setting and treat the customer's top-level assets as roots, with `isAdmin = true`. This lets the owner view and edit without a customer login. It is UI-only, like D-012.

### D-019 Richer UI, rules, rich text, themes and templates, 27 Sep 2026 (user request)
- **Widgets (19 types):** value, KPI (sparkline + % change), gauge (rule zones), progress/tank, status pill, multi-value, summary (min/avg/max/now), line, area (stackable, smooth), bar (per hour/day or by machine), donut (time-in-state or share by machine), state timeline, heatmap (hour x day), table (rule-coloured cells), alarms, and the content widgets text, image, link/button and embed. Content widgets need no data source. Max 40 per dashboard.
- **Value-based colours ("colour rules"):** per widget, first match wins, optionally scoped to one key. The editor switches on the property type: numbers get >, >=, <, <=, between, =, != with a value box; on/off properties get an "is on / is off" dropdown; text gets equals/contains. Presets: traffic light, running/stopped. Rules can colour the card background + accent bar, the accent only, the value or the icon; they draw gauge zones and chart threshold lines, and colour table cells and status pills. Legacy bands/statusMap are converted automatically.
- **Rich text:** WYSIWYG editor (bold, italic, underline, strike, headings, lists, quote, link, font, size, colour, highlight, alignment) plus `{{key}}` placeholders filled with live values. Output is sanitised with a whitelist (tags, style properties, http(s)/mailto links only) both in the editor and when saved, including chat-generated settings.
- **Per-widget style:** icon (24), title font/size/weight/colour/alignment or hidden, card background or gradient, border, accent bar, radius, shadow, padding, value font/size/colour, description tooltip (ⓘ) and footer. "Copy style to all" and Reset.
- **Dashboard themes:** presets light, dark, slate, ocean, sand; accent, font (6 Google Fonts), background colour or https image, card colour, radius, shadow, density, title alignment. Stored in `Dashboard.theme` (optional, so old saves still load).
- **Templates gallery:** Machine overview, Energy, Alarms & health, Compare machines, Executive (dark). Templates pick keys from the machine's actual properties.
- **Builder:** grouped searchable palette, duplicate/delete on the selected card, Settings / Style / Colours / Chat tabs, Dashboard tab (theme) when nothing is selected.
- **Pages restyled:** gradient navbar with state chip and avatar, hero + stat tiles on the Map page, cards with status stripe on the Listing page.
- Link widgets can open another app page (Map/Listing/Machine) or a website; they're inert while editing.
- Image upload is capped at 150 KB and stored inline as a data URI (schema allows data:image URIs up to 210k characters; web addresses stay capped at 2000). Larger images should use an https address.
- Line/area charts break the line only when the gap is more than max(3x the median sample step, 15 min).

### D-020 Edit menu, alignment, time range, limits, property/widget rules, 27 Sep 2026 (user request)
- **Edit controls moved off the page.** The machine page shows only breadcrumb, machine name, status and a time-range chip. For admins, the navbar shows one edit (pencil) icon; its menu lists *Edit this dashboard*, *Customise for this machine*, *Reset to shared dashboard*, *Alarm thresholds*, *Show dashboard* (switcher, replaces the old dropdown and "From:" chip, which is now the menu subtitle) and *Dashboard Builder*. The renderer publishes its actions on `window.__imexDbbActions` plus an `imex-dbb:actions` event, because each ThingsBoard widget type has its own copy of the library. The menu is appended to `<body>` so the navbar cell doesn't clip it. Still UI-only (D-012).
- **Alignment:** `style.align` (left/centre/right) and new `style.valign` (top/middle/bottom) for value, KPI, level bar, min/avg/max, multi-value (horizontal only) and status; new `style.titlePos` (above/below) for every widget. Style tab → Layout.
- **Time range:** `realtime` or historic `1h`/`2h`/`4h`/`8h`. Realtime = latest values refreshed every 10 s; time-based widgets (charts, KPI trend, min/avg/max, donut, timeline, heatmap, alarms) use a rolling last hour. Historic = fixed window ending now, refreshed every 60 s. Longer stored ranges are read as `8h` (Zod preprocess), so existing saves keep loading; nothing in the store was rewritten. Per-widget overrides take the same values.
- **Knock-on changes from the 8 h cap:** the heatmap is now *machines × time* (5–20 min buckets) instead of hour × day, and bar charts group per 15 min / per hour / by machine (per day is gone; stored `day` draws per hour). The Energy template now uses 8 h.
- **Limits:** 10 widgets per page, 4 properties per widget, 4 machines in a "specific machines" binding, 8 lines per chart (machines × properties; the chart says how many were not drawn). The schema still parses the old limits (40 / 10) so older dashboards open; `checkDashboard` enforces the new ones on save and on chat output. The palette greys out when the page is full.
- **Property kind vs widget type** (`core/compat.ts`, plain rules): kinds are number, on/off, text, coded state (a number with named `states`). Gauge, KPI, level bar, min/avg/max, line, area, bar and heatmap need a number (or coded); status and state timeline need on/off, text or coded; donut needs states for "time in each state" and a number for "share by machine"; value, multi-value and table take anything. The builder greys out unsuitable properties (with the reason on hover), widget types for which the source has no suitable property, and palette tiles for which the machine type has none. Changing a widget's type swaps to a suitable property. Chat gets the kinds in its catalogue and its output is rejected with the reason (the relay retries once). The renderer shows the reason instead of a broken chart for any old mismatch.
- **Checked on the demo before deploying:** all 4 stored dashboards already fit (≤10 widgets, 1 property each, no mismatches). They were saved as 24 h and now read as "Last 8 h".
- **Widget-wise build output:** `widgets/dist/widget-types/imex_dbb_{launcher,renderer,listing}.json` are importable ThingsBoard widget types (library + glue + settings form), generated by `build.mjs` from `widgets/widget-types.mjs`.

### D-021 Multi-provider chat, key on a tenant-owned asset, live values over WebSocket, 27 Sep 2026 (user request)
- **Provider from the key.** The relay accepts a Claude (`sk-ant-…`), OpenAI (other `sk-…`) or Gemini (`AIza…`) key and picks the provider from its format. Chain: *Is chat request* → *Read LLM settings* → *Build LLM request* → *Pick provider* (switch) → *Call Claude* / *Call OpenAI* / *Call Gemini* (one REST node each, so each sends only its own auth header) → *Parse LLM reply* / *Error reply* → *Save reply attribute*. The browser sends the tool in all three formats; Gemini gets a reduced schema (no type arrays; free-form objects as JSON strings, parsed back in `normaliseToolInput`). OpenAI's tool arguments come back as a JSON string (`toolInputJson`), parsed in the widget. Models per provider: `dbb_llm_model_{anthropic,openai,gemini}`; defaults `claude-sonnet-5`, `chat-latest`, `gemini-flash-latest` (set a pinned model for production). All four scripts were run through ThingsBoard's own TBEL engine (`/api/ruleChain/testScript`) with sample requests and replies for each provider and each error case. Then end to end on the demo through the deployed chain with deliberately invalid keys: no key → "No LLM API key is set"; `sk-ant-…` → Claude endpoint, 401 → "anthropic API key … invalid"; `sk-proj-…` → OpenAI endpoint, 401; `AIza…` → Gemini endpoint, 400 (read from `error_body`) → "gemini API key … invalid". So routing, header substitution from the config asset and error mapping work; a successful answer still needs a real key.
- **Verified:** a customer user (Pune viewer token) gets 403 on the DBB-LLM-CONFIG asset and its attributes, and 200 on the store asset's attributes.
- **Key storage.** The user asked for the keys on an org-level asset. They are on **`DBB-LLM-CONFIG`, a tenant-owned asset never assigned to a customer** (attribute `dbb_llm_api_key`), read server-side through the relation `UsesLlmConfig` from each DashboardStore asset. Not on the store, a site or the org root asset: those are assigned to the customer, and every customer user can read their attributes through the REST API (D-012). The deploy script refuses to continue if the config asset is customer-assigned, writes defaults only when missing, and moves a key found in the old *Call LLM* node there.
- **Live values.** `core/live.ts` keeps one WebSocket per page (`/api/ws`, auth command + `TIMESERIES` `LATEST_TELEMETRY` per device; legacy `/api/ws/plugins/telemetry` as fallback). `api.latest` reads its cache; `api.series` appends pushed points to a REST window (AVG/raw, windows ending now; re-fetched every 5 min); other window queries are cached 60 s, alarms 15 s. Redraw on push (≤ every 2 s) plus every 60 s. If the socket is down, REST polling exactly as in D-020. Protocol checked on the demo: first reply ~1 s, pushed update ~0.1 s after a telemetry save, unsubscribe works. First page load is unchanged (35 REST calls measured). **Measured on the demo** (deployed build, RIC-COMP-01 machine page, 74 s): 2 REST calls (alarm refreshes) and live value changes by push; the pre-D-021 code makes about 70 calls in that time.
- **Why not `ctx.subscriptionApi`:** it is tied to one widget's datasources; our widgets build their bindings at runtime from saved layouts and share data across widget types. The raw socket is the same endpoint ThingsBoard's own widgets use.

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
