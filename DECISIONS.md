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
- **Provider from the key.** The relay accepts a Claude (`sk-ant-…`), OpenAI (other `sk-…`) or Gemini (`AIza…` or the newer `AQ.…`) key and picks the provider from its format. Chain: *Is chat request* → *Read LLM settings* → *Build LLM request* → *Pick provider* (switch) → *Call Claude* / *Call OpenAI* / *Call Gemini* (one REST node each, so each sends only its own auth header) → *Parse LLM reply* / *Error reply* → *Save reply attribute*. The browser sends the tool in all three formats; Gemini gets a reduced schema (no type arrays; free-form objects as JSON strings, parsed back in `normaliseToolInput`). OpenAI's tool arguments come back as a JSON string (`toolInputJson`), parsed in the widget. Models per provider: `dbb_llm_model_{anthropic,openai,gemini}`; defaults `claude-sonnet-5`, `chat-latest`, `gemini-flash-latest` (set a pinned model for production). All four scripts were run through ThingsBoard's own TBEL engine (`/api/ruleChain/testScript`) with sample requests and replies for each provider and each error case. Then end to end on the demo through the deployed chain with deliberately invalid keys: no key → "No LLM API key is set"; `sk-ant-…` → Claude endpoint, 401 → "anthropic API key … invalid"; `sk-proj-…` → OpenAI endpoint, 401; `AIza…` → Gemini endpoint, 400 (read from `error_body`) → "gemini API key … invalid". So routing, header substitution from the config asset and error mapping work; a successful answer still needs a real key.
- **First real call (27 Sep):** Gemini key in the newer AI Studio format `AQ.…` (detection extended; it works with the `x-goog-api-key` header). A full builder request (system prompt, catalogue, Gemini tool schema, 2,424 prompt tokens) returned in 4.9 s with 3 valid ops (gauge, 4 h line chart, status card) that passed `normaliseToolInput` + `applyOps` with no warnings; Gemini sent `settings` as JSON strings, parsed back as designed.
- **Verified:** a customer user (Pune viewer token) gets 403 on the DBB-LLM-CONFIG asset and its attributes, and 200 on the store asset's attributes.
- **Key storage.** The user asked for the keys on an org-level asset. They are on **`DBB-LLM-CONFIG`, a tenant-owned asset never assigned to a customer** (attribute `dbb_llm_api_key`), read server-side through the relation `UsesLlmConfig` from each DashboardStore asset. Not on the store, a site or the org root asset: those are assigned to the customer, and every customer user can read their attributes through the REST API (D-012). The deploy script refuses to continue if the config asset is customer-assigned, writes defaults only when missing, and moves a key found in the old *Call LLM* node there.
- **Live values.** `core/live.ts` keeps one WebSocket per page (`/api/ws`, auth command + `TIMESERIES` `LATEST_TELEMETRY` per device; legacy `/api/ws/plugins/telemetry` as fallback). `api.latest` reads its cache; `api.series` appends pushed points to a REST window (AVG/raw, windows ending now; re-fetched every 5 min); other window queries are cached 60 s, alarms 15 s. Redraw on push (≤ every 2 s) plus every 60 s. If the socket is down, REST polling exactly as in D-020. Protocol checked on the demo: first reply ~1 s, pushed update ~0.1 s after a telemetry save, unsubscribe works. First page load was unchanged here (35 REST calls measured); D-022 reduced it. **Measured on the demo** (deployed build, RIC-COMP-01 machine page, 74 s): 2 REST calls (alarm refreshes) and live value changes by push; the pre-D-021 code makes about 70 calls in that time.
- **Why not `ctx.subscriptionApi`:** it is tied to one widget's datasources; our widgets build their bindings at runtime from saved layouts and share data across widget types. The raw socket is the same endpoint ThingsBoard's own widgets use.

### D-022 First page load in a fixed number of calls; stale-page chat fix, 28 Sep 2026 (user request)
- **Problem.** First load cost 35–50 REST calls and grew with the customer's tree (one relations call per asset, twice: the navbar and the machine widget each loaded the user context, because every widget type has its own copy of the library). Opening a machine walked up the hierarchy one call per level. The Map and Listing pages cost about 4 calls per machine (latest runStatus, active alarms, key list + latest values).
- **Changes.**
  - **One user context per page:** `entries/common.ts` keeps it on `window.__imexDbbCtx` (same build + same logged-in user from the JWT + same `customerId` setting), so the launcher, renderer and listing share it. `force` reloads it for all.
  - **Hierarchy in constant calls:** `core/scope.ts` uses one `POST /api/relations` per root in each direction (whole subtree below; ancestors above) and one Entity Data Query per entity type (`POST /api/entitiesQuery/find`, entityList filter) for names, labels, profiles and `dbb_assign`. A customer user with one scope root: 8 calls in 4 rounds (was about 10 + 1 per asset, twice).
  - **Assignment snapshot:** the context carries `assign` (`dbb_assign` of every node in scope and above the roots, the user's `dbb_personal`, `dbb_assign_customer`, the store's `dbb_assign_rev`). `store.resolveForDevice` builds the candidates from it and does ONE store read (the dashboards + `dbb_assign_rev`). Every assignment write (apply, customise, reset, clear personal, delete) changes `dbb_assign_rev` and marks the snapshot stale, so this page and every other open page reload it (3 calls) on the next resolve. Machines outside the snapshot still use the old walk. `deleteDashboard` uses the snapshot instead of one read per node.
  - **Map / Listing:** `api.latestMany` (live cache, else ONE Entity Data Query with the catalogue keys + runStatus of all machines) and `api.activeAlarmCounts` (ONE `POST /api/alarmsQuery/find`). Online/offline now uses the catalogue keys + runStatus instead of listing every key per machine. The standalone-dashboard list is read on (re)load, not on every live redraw.
  - **Machine page header:** the status pill no longer holds up the widgets (drawn after the grid starts) and reads the catalogue keys through the live cache (no key listing).
  - **Socket grace:** `api.latest` waits up to 1.5 s (`LIVE_WAIT_MS`) for the WebSocket subscription on a cold page instead of making a REST call right away (`Live.waitReady`).
- **Measured on the demo** (tenant admin with the widget setting `customerId`, 4 machines, same harness and same data before and after, simulator traffic excluded): machine page 49 → **17**, Map page 44 → **14**, Listing page 46 → **15**. 4 of the remaining calls are tenant-admin-only (finding the customer's top assets); a customer user saves those. The number no longer grows with the size of the tree; it grows only with the number of widgets that need history (charts, alarm lists). Unit test (`widgets/test/load.test.ts`): 8 calls for the user context with 4 or 304 machines; 1 call to resolve a machine right after load; 5 after another page changed an assignment, then 1 again.
- **Not verified as a customer user:** customer-user tokens can't be obtained from this session. ThingsBoard applies the same customer scoping to `/api/relations`, `/api/entitiesQuery/find` and `/api/alarmsQuery/find` as to the single-entity endpoints; check once as the Pune viewer (`selectedNodes` = Pune) that the Map page shows only Pune.
- **Chat bug found (same day).** The admin's open Chrome tab still ran the builder code from before D-021 (ThingsBoard keeps widget code until the page is reloaded). That code sends no Gemini tool block, so *Build LLM request* failed in TBEL; *Error reply* then wrote a reply without `reqId` (taken from metadata that the failed node never set), so the builder ignored it and showed "did not answer within 30 seconds". Fixed: *Build LLM request* answers `OLD_CLIENT` ("This page is running an older version of the Dashboard Builder. Reload the page (Ctrl+F5)") and *Error reply* takes `reqId`/`userId` from the request itself (tested in TBEL and live: answer in 1.6 s). DBB_DEPLOY now writes the build id to the store attribute `dbb_lib_version`; a page running another build shows "Reload the page" in the builder's banner.
- **Chat re-tested** after the fix, in the real builder with no machine selected: "Overview of Richmond" → Gemini answered in 11 s with 8 valid widgets (two run-status cards, discharge pressure gauge, power and dew point KPIs with 1 h comparison, dryer pressure drop, compressor and dryer trend charts). One weakness: it put pressure (bar) and power (kW) on one chart axis.

### D-023 Builder polish and full E2E test, 28 Sep 2026 (user request)
- **No flicker on updates.** Every refresh replayed a fade-in on each card (`.dbb-card-b>*{animation}`), and image / embedded-page widgets were rebuilt on every refresh (the iframe reloaded every 10 s). The fade now plays on the first draw only (`dbb-first` class, removed after 400 ms), and static content is only replaced when it changes (`setStatic` in render/widgets.ts).
- **Inter font.** The builder (top bar, palette, panels, dialogs), the navbar and its edit menu use Inter, the standard of the other iMEX pages. The dashboard default font (theme font left empty) is now Inter too (`INTER_STACK` in render/theme.ts); a dashboard that explicitly picked another font (including Roboto) keeps it. The builder canvas now really previews the theme font (before, it always showed the overlay's font).
- **Machine page header is one line:** "ORG › Site", status pill, time range. Machine name and type are no longer shown there (the app navbar shows the selected machine); they are in the crumb's tooltip. About 40 px instead of about 70 px.
- **Machine switch in an app navbar.** The renderer read the machine only from the widget's state controller, and only when ThingsBoard called `onStateChanged`. A navbar that switches the machine by changing the state URL left the page on the old dashboard while the edit menu (which reads the URL) already had the new machine. Fixed: the renderer reads the state URL first (`currentEntity` / `currentParam` in entries/common.ts, same as the navbar), watches it every 500 ms, and ignores results of a load that a newer load has overtaken (`loadSeq`).
- **"No machine (standalone dashboard)"** in the builder's Machine list means the dashboard is not tied to a machine or machine type: its widgets use *Specific machines*, it can't be applied to machines, and it is opened from the Dashboards section of the listing (or a link widget / `dbbDashboardId`).
- **Bugs found by the new E2E test and fixed:** (1) Backspace or Delete while typing in a Text widget's editor deleted the whole widget (the key handler skipped inputs but not contenteditable). (2) In the Colours tab the colour picker's invisible input was 60 px wide and covered the rule's ✕, so a rule could not be removed (it opened the colour picker instead). (3) *Open* (another dashboard or *New blank*) and *Restore* in Version history dropped unsaved changes without asking; they now ask.
- **E2E test:** `npm run test:e2e` (widgets/e2e/builder.e2e.mjs) runs 38 scenarios in Chromium against the fake ThingsBoard of widgets/harness: all 19 widget types (add, render in realtime and historic 8 h, delete), palette search / blocking / 10-widget limit, drag-and-drop, move/resize, duplicate/remove, every data-source mode and the 4-property / 4-machine caps, Style / Colours / Dashboard tabs, text / image / link / embed, templates, preview, save / apply (one machine, all machines, replace confirmation) / versions / restore / save as / conflict / open / delete, unsaved-change prompts, Esc, standalone, chat (ops, highlight, discard, clarification, provider error, corrective retry), and the machine page (one-line header, navbar switch, no flicker, edit menu, viewer). Chat is tested with a stub relay, not a real LLM.

### D-024 Chat: role requests, guard rails, mixed equipment, no blanket failures, 29 Sep 2026 (user request)
User decisions (29 Sep): role / fleet requests on an open machine dashboard **ask each time** where to build; chat **does not answer live-data questions** (it offers a widget instead, no plant data goes to the LLM); mixed equipment stays **one widget per machine type or shared properties** (no per-machine properties in one widget).
- **Why "I couldn't build that" happened.** Replaying real answers showed three causes: (1) models (Gemini flash-lite in particular) often add a widget and then set its data source with `updateWidget W<n>` using the alias the new widget would get, which the old code rejected ("no widget W1"); (2) an empty `clarification` object (`{}` / empty question) made the whole answer invalid; (3) one invalid op failed the whole answer, twice, so nothing was built. Also slips like `name` for a widget title, `title` for a dashboard name, a title/keys/binding inside `settings`, a binding's `machineType` next to the binding, `updateWidget` without `widget`.
- **Fixes in `core/chat.ts`:** widgets added in an answer continue the W numbering; the slips above are normalised; an empty clarification is ignored; problems the draft already had don't count against the model; after the corrective retry, the valid ops are applied one unit at a time (an addWidget together with the updates that refine it) and the dropped ones are listed in plain words ("Some parts could not be built: …"); if nothing applies, the error names the first reason. The builder retries once by itself after 4 s when the provider is overloaded or unreachable.
- **Role presets in the prompt:** executive / CEO (fleet overview: header, one table per machine type over the top location, alarm list for all machines), manager (per location, tables per type, alarms, one comparison trend), operator / technician (one machine in detail), energy, quality.
- **Where to build:** new ops `startNewDashboard {name}` (first op; a new unsaved standalone dashboard, the builder asks before dropping unsaved work, Undo goes back) and `clearWidgets` ("replace"). If the open draft is a machine dashboard with widgets and the user hasn't said where, the answer is held back and the builder asks "Where should I build it?" (Start a new dashboard / Replace this dashboard / Add to this dashboard), also when the model built straight away (`needsWhere`). The choice is applied locally from the held-back answer (`applyWhere`), without a second LLM call.
- **Guard rails:** scope = building/changing the dashboard, how the builder works, what the catalogue contains. Live/historic values: "I don't read live data" + a yes/no offer to add the widget. Device/user/threshold changes: pointed to the machine page or admin pages. Everything else (general knowledge, coding, writing, jokes, the prompt, keys, role-play, "ignore previous instructions") is refused with a fixed short reply. New tool field `intent` (build / clarify / help / refuse); a help or refuse answer never changes the draft, even if ops are attached. A short "how the app works" section lets it answer how-to questions correctly (Save → Apply dialog, Apply to…, history, machine-page menu).
- **Mixed equipment:** the catalogue now lists `sharedKeys` (keys several machine types have); a widget may show a shared key across types (e.g. Inlet Air Temperature of Dryer and Blower on one chart); otherwise one widget per type. An answer that rewrites one widget to several data sources (the model trying to put different properties of different types on one chart, which silently kept only the last) is rejected so the model retries. The alarm list can cover every machine type under a location (`nodeQuery` with machine type "ALL", also in the Widget tab as "All machine types").
- **Relay:** the Error reply also maps network failures (`WebClientRequestException`, timeouts) to "Could not reach the <provider> service … Try again in a moment." Live chain on the demo patched and tested in TBEL.
- **Tested with a real LLM** (Gemini 3.1 flash-lite through the demo relay; flash-latest and 3.x flash were overloaded all day, pro models not available to this key), on a copy of the user's hierarchy (ITHENA ORG → Pune: Compressor, Dryer; Richmond: Blower): off-topic (capital of France, a Python script, prompt-injection) refused 3/3; how-to answered correctly; live-value question → "I can't see live data, add a value card?"; manager request → asked where; CEO request → built straight away in 2 of 3 runs, now held back and asked; new-dashboard builds valid in 2 of 3 runs (the third came back with empty operations); mixed request with a shared key built correctly; a different-properties-on-one-chart request was rejected and retried, but flash-lite's retries came back empty. **Recommendation:** use a stronger model than flash-lite (Gemini flash on a paid key, or a Claude / OpenAI key) for dependable results.
- Tests: 78 unit tests (16 new), 45 E2E scenarios (7 new chat scenarios).

### D-025 Dashboard list for standalone dashboards; preview machine picked automatically, 30 Sep 2026 (user request)
- **Problem:** standalone dashboards (not tied to one machine) could only be reached from the listing widget's Dashboards section, which the iMEX app does not use, so there was no way to open them. A dashboard built by chat with "This machine" widgets while the builder had "No machine" selected showed only "Open this dashboard for a machine to see data".
- **Dashboard list** (user decisions 30 Sep: in the pencil menu, for everyone; a click opens it on the page): the navbar menu has "Dashboard list" for every user. Users who can't edit see a list icon (tooltip "Dashboards") instead of the pencil, with only that item; editors keep the edit items and the Dashboard Builder. The list is a centred dialog with the standalone dashboards the user may see (shared + own private), search by name or owner, 8 per page. A row opens the dashboard full-page in the state that holds the machine-dashboard widget (settings.machineState, else the state the renderer last ran in on this ThingsBoard dashboard, remembered in localStorage, else 'machine'), via the state param `dbbDashboardId`. Editors also get Edit (opens the builder). Setting `dashboardList` (default true) on the navbar widget; false restores the admin-only icon.
- **Preview machine:** when the draft has "This machine" widgets and no machine is selected (chat, templates, type changes), the builder picks the first in-scope machine of the draft's type for the preview and says so ("Previewing with …"); the user can pick another at the top.
- Tests: 49 E2E scenarios (4 new).

### D-026 Dashboard Overview state; Dashboard list redesign; design pass for chat-built dashboards, 30 Sep 2026 (user request)
- **Dashboard Overview state.** Standalone dashboards (not tied to one machine) now open in their own state, `dashboard_overview` ("Dashboard Overview"), instead of the machine state. Machine dashboards are unchanged. The navbar setting `overviewState` (default `dashboard_overview`) names it; if the ThingsBoard dashboard has no such state, the list falls back to the machine state as before (and logs a console warning). On that state the navbar's menu keeps all three items: *Edit this dashboard* (opens the shown dashboard in the builder), *Dashboard list*, *Dashboard Builder* (opens the builder on the shown dashboard, not a blank draft). The renderer only remembers the machine state, so the fallback can't pick the overview state. The state must contain the machine-dashboard (renderer) widget; deploy-browser.js creates it.
- **Dashboard list redesign.** Self-contained scoped styles (no reliance on ThingsBoard/Material CSS, which gave unstyled buttons and stray markers): header with icon, title, subtitle and close; search with highlighted matches; sort by name / recently updated; rows with a coloured initials avatar, name, Private badge, widget count, owner, "Updated x ago", Edit and Open buttons; numbered pager and "Showing 1–8 of 11"; empty states; keyboard (Esc, Enter, arrows).
- **Design pass for chat-built dashboards** (core/design.ts). Models pick sensible widgets but lay them out poorly (a one-row text header that cut off its heading, one-machine tables four rows tall stacked on the left, half the page empty) and leave everything grey. Now, deterministically after the model's ops: every table chat adds is sized to its rows (header + one line per machine) and text is at least 2 rows. For a **fresh** dashboard (new, replaced, or built on an empty draft; never when adding to an existing one): ocean theme if none; the short header becomes a gradient banner with the name, machine and location count and live date/time (a banner is created on fleet dashboards without one); Running/Stopped status cards per machine for fleet dashboards without cards (≤ 8 machines, within the 10-widget limit); per machine type an accent bar, icon and icon colour; Running/Stopped colours on run-state columns; KPI sparklines; rows without gaps (banner, cards split evenly, wide charts, bar/donut in pairs, tables in pairs with an odd table next to the alarm list, alarms). Nothing the model styled explicitly is overwritten; if the polished result would fail the dashboard checks, the unpolished one is kept. The executive preset in the prompt now asks for 2–4 headline KPI cards as well.
- Tests: 81 unit tests (3 new), 51 E2E scenarios (navbar/list tests rewritten, 1 new CEO-layout test with screenshot).

### D-027 Builder "Open dashboard" dialog redesign, 30 Sep 2026 (user request)
- The builder's *Open* dialog looked cramped and did not use Inter: it was a plain `<table>`, and ThingsBoard's own table styles overrode our font and size inside the app. It is now built from divs in a CSS grid (`.dbb-od`), with Inter set on every element, so the host page's styles can't change it.
- Wider (up to 1040 px, was 820 px); "+ New blank dashboard" moved to the right, with the count of saved dashboards on the left; 24 px between columns and 18 px row padding; header row sticky; machine type as a pill (standalone in purple); widget count right-aligned; shorter dates ("Sep 30, 2026, 6:12 PM"); rows keyboard-focusable (Enter opens). `modal()` takes an optional box class (`wide`).
- The navbar's *Dashboard list* was already redesigned in D-026 (not yet deployed on iserv-demov2 at the time of the screenshot).
- Tests: the Open-dialog E2E scenario also checks width, Inter on every element, button position and column spacing, and saves a screenshot.

### D-028 Security and performance review, 30 Sep 2026 (user request: no loopholes, 20–25 users, 30–40 machines, 5 tabs)
A full read-only security review of widgets/src and the chat relay, then fixes, then a worst-case load test.

**Security: found and fixed**
- **Stored XSS (high).** Any customer user can write the store attributes directly (known limitation D-012), so every stored string is untrusted. Four paths could run script in another user's browser (including an admin's) and read the ThingsBoard token:
  1. Legacy colour fields `bands[].color` and `statusMap[].color` were plain strings and went into HTML and SVG. They now must be plain colours; an older document with a bad value loads with grey instead of failing (`LegacyColor`). Every rule colour is also checked again when drawn (`cssColor`, `isColor` in render/rules.ts).
  2. Dashboard, widget, device and node ids were free strings and went into HTML attributes (Listing page, Open dialog, builder editors). They are now restricted to letters, digits, `_` and `-` (`Id` in schema.ts) and escaped where used. A dashboard is only listed if its attribute key matches its id.
  3. Version history entries (`dbb_h_<id>`) were used without validation. They are now validated like dashboards.
  4. Chat answers can set the same fields, so the same checks cover the LLM and a forged chat reply.
- **CSS injection (medium).** `titleFont`, `valueFont` and the theme font accepted any text, which went into a style attribute; a newline could add any CSS (full-page overlay, tracking image). Font names are now letters, digits and spaces only, both in the schema and in `fontStack()`.
- **Chat relay (medium).**
  - The reply now goes to the user ThingsBoard reports as the writer (`metadata.userId`), not to an id from the request. A mismatch is refused.
  - The relay only forwards the builder's own tool (`dashboard_ops`) with a fixed tool choice, and refuses oversized requests (system prompt or a message over 60,000 characters, more than 24 messages), so it can't be used as a general LLM proxy on the tenant's key.
  - Tested with ThingsBoard's TBEL test endpoint on the demo (Claude / OpenAI / Gemini bodies, mismatch, bad tool, too big). **Not yet deployed to the live relay.** If ThingsBoard does not put `userId` in the metadata, the relay falls back to the request's id (same as before).
- **Low.**
  - An entity such as `&#x110000;` crashed the rich-text sanitizer and blanked the page; it now decodes to �.
  - The sanitizer is now linear on input with many `<`, and caches its results.
  - `{{placeholders}}` are no longer filled inside HTML attributes.
  - Pages from the ThingsBoard server itself are not framed by the embed widget (the sandbox would not protect them).
  - A telemetry key in one URL is now encoded.
- **Remaining, accepted:**
  - D-012: store attributes are writable by customer users. They can still spoil or delete dashboards, but can no longer run script.
  - Chat requests and replies on the store asset are readable by all customer users of that customer.
  - No server-side chat rate limit: the builder limits each user to 30 requests per hour in the browser. Set a spending limit on the provider key.
  - The legacy WebSocket fallback puts the token in the URL (only used on ThingsBoard versions before 3.6).
- Regression test: E2E "stored XSS" seeds hostile documents (script in every stored string, bad colours, CSS in fonts, bad ids, bad history, a same-origin embed) and checks that nothing runs in the builder (Open dialog, every widget editor, history) or on the machine page. It fails on the D-027 code.

**Performance: measured and improved**
- **Worst-case load test:** `node widgets/e2e/bench.mjs [tabs] [seconds]` (harness `?bench=1`).
  - Setup: 40 machines, a 10-widget dashboard where every widget shows its maximum (4 machines × up to 4 properties, 40 machines on the page), and a fake WebSocket pushing a new value for every subscribed key of every machine every second. The same dashboard is open in 5 tabs, all visible (worse than a real browser, which pauses hidden tabs).
  - Result per tab over 60 s:
    - 5.5–6.7 % main-thread busy;
    - no long task (> 50 ms) after the first load;
    - the first load's longest task is 230–340 ms;
    - heap about 18 MB and flat;
    - no DOM growth;
    - 16 REST calls per minute (heatmap, bar, timeline and aggregate widgets re-read at most every 60 s; everything else comes over the WebSocket).
- **Changes:**
  - Identical GETs in flight are shared (`api.get`).
  - A widget never runs two refreshes at once: a refresh requested while one is running runs once afterwards, so a slow server doesn't pile up requests.
  - Live history is trimmed in batches.
  - A tab that becomes visible again redraws at once (hidden tabs skip redraws).
- **Server estimate for 25 users with 2 tabs each (50 tabs), worst-case dashboards:** 50 WebSocket sessions, at most 40 subscriptions each, and about 800 REST calls per minute (about 13/s). Dashboards of value cards, gauges, tables and charts use almost no REST in steady state. The same dashboard in 5 tabs costs 5×; sharing one connection across tabs (BroadcastChannel) is possible later if needed.
- Tests: 85 unit tests (4 new), 52 E2E scenarios (1 new), plus the load test.

### D-029 Content-fitting chat widgets, New dashboard, chat layout control, start screen, 1 Oct 2026 (user request)
- **Nothing cut off.**
  - Problem: widgets added by chat used fixed default sizes, so tables with many machines, multi-value cards with 4 properties, long text and chart legends were cut off until the user dragged them bigger.
  - Two layers fix it:
    1. `sizeWidget` (core/design.ts) sizes every widget chat adds or changes from its content: tables by machines, multi-value cards by properties, timelines and heatmaps by machines, line/area charts by legend lines, text by length, minimums for gauges, bars, donuts and alarm lists. Lists are sized exactly; other types only grow.
    2. After drawing, the builder measures each new or changed card and grows any whose content still overflows, in height and if needed width, moving the widgets below down (`Builder.fitToContent`). This is part of the same undo step.
- **New dashboard.**
  - There is a **New** button in the builder's top bar, a **New dashboard** item in the navbar's pencil menu (editors), and "+ New dashboard" in the Open dialog and on the start screen.
  - The dialog asks for a name and what the dashboard is for:
    - **One machine type:** shown on the machine page and reused by every machine of that type. The preview uses the open machine if it has that type, else the first one.
    - **Overview:** several machines or locations, not tied to one machine; opens from the Dashboard list.
  - It asks before dropping unsaved changes, and nothing is saved until Save.
- **Chat can arrange the page.**
  - The draft sent to the model now includes each widget's position and size: x is a column (0–11), y a row, w a width (1–12), h a height in rows of 74 px.
  - `addWidget` and `updateWidget` accept x/y/w/h. Values sent as strings are converted, and out-of-range values are clamped. Moved widgets keep their spot and the others move down (`resolveCollisions`).
  - New op `arrangeLayout` tidies the whole page: rows without gaps, cards side by side, lists as tall as their rows (`layoutPass`, the layout step of the D-026 design pass). Afterwards every widget is fitted to its content.
  - The prompt explains the grid with examples: full width, halves, three or four in a row, to the top, swap.
  - New widgets are still placed automatically unless the user asks for a position.
- **What the builder opens on** (`launcher.open`):
  - **Machine page:** that machine, and the dashboard it shows now (personal → machine → location → customer-wide; a blank draft for its type if it only shows the default layout).
  - **Dashboard Overview state:** the overview dashboard shown there.
  - **Any other page** (Map, Listing, …): a start screen with "What would you like to do?", **+ New dashboard**, **Open a dashboard**, chat, and the 5 most recently updated dashboards (one click opens one).
  - **Navbar → New dashboard:** the builder plus the New dashboard dialog.
- **Nothing from an earlier visit.**
  - Only one builder can be open: a second menu click, or Back while it is open, brings back the open one instead of stacking a second overlay.
  - Cached data series and REST answers are cleared when the builder opens, so previews load fresh.
  - The user context is reloaded (as before), and each opening starts with empty chat, undo and selection.
  - After re-importing the widget types, pages that were already open keep the old code until reloaded; the builder shows its "reload" banner when the library version differs (D-022).
- Tests: 88 unit tests (3 new), 56 E2E scenarios (4 new): nothing cut off after a chat build, including deliberately undersized widgets (measured in the browser); chat move, resize and tidy; New dashboard (button, dialog, both kinds, navbar item, single builder); start screen with recent dashboards.

### D-030 Dashboard Builder opens below the app navbar, 1 Oct 2026 (user decision)
- User decision (1 Oct): the builder must start below the iMEX navbar, like the pages do. The app dashboard uses a 150-column layout with no margins; grid rows 1–6 are the navbar and the status line, and pages start at row 7. Before this, the builder covered the whole window (position fixed, inset 0, z-index 10000).
- **New navbar widget setting `builderTop`** ("Dashboard Builder starts below"):
  - `auto` (default) measures the bottom of the navbar: the lowest bottom edge of the dashboard widgets in the same band as the navbar widget, plus a thin (≤ 24 px), full-width strip directly under it (the status line). A widget that is narrower or taller, such as the listing page's sort bar or the hierarchy panel, is page content and stays covered.
  - A number (e.g. `64`) sets the offset in px; `0` or `full` gives full screen as before.
  - The offset is measured when the builder opens and again on every window resize, and is ignored if it is more than 40 % of the window.
- **Below the navbar the builder uses z-index 999**, so the app's own menus (Angular Material overlays, z-index 1000), such as the equipment dropdown, open above it.
- **The navbar stays usable, so the builder follows navigation.** It watches the page (state and its parameters, every 500 ms):
  - With no unsaved changes, it closes and the new page shows.
  - With unsaved changes, it asks "You opened another page": **Keep editing** leaves the builder open (save, then close it), **Discard and go** closes it.
  - Reloading or closing the browser tab still asks first (beforeunload).
- The builder opened directly (harness, `IMEX_DBB.open` without a navbar widget) stays full screen.
- Tests: 58 E2E scenarios (2 new): the builder starts at the navbar bottom, the navbar stays clickable, the pencil menu opens over the builder, navigation closes it or asks, Keep editing and Discard both work; the offset is measured correctly in a ThingsBoard-like grid (navbar band + status line, not the page's sort bar or side panel; px and full-screen settings).

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
