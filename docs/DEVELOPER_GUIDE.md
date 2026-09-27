# iMEX Dashboard Builder: developer guide

This guide covers moving the POC from demo.thingsboard.io into our own ThingsBoard (dev first, then production). Read it with:

- `README.md`: what the product does, the builder rules and limits, and a map of the code.
- `DECISIONS.md`: every design decision (D-001 to D-020) and the ThingsBoard quirks found so far. The code comments cite these numbers.

Every source file starts with a header comment explaining what it does and how it connects to the rest. Exported functions have JSDoc.

---

## 1. What it is, in one paragraph

Three ThingsBoard **custom widgets** (plain TypeScript, bundled into one script) and one **rule chain**. There is no server of our own.

- **iMEX Navbar / edit menu** (`tenant.imex_dbb_launcher`): the admin-only pencil menu. It also works as a standalone button in our own header.
- **iMEX Machine dashboard** (`tenant.imex_dbb_renderer`): draws the layout that applies to the machine in the dashboard state.
- **iMEX Listing / Map page** (`tenant.imex_dbb_listing`): the stand-in map and listing pages from the POC. **We don't need it**; our app already has these pages.
- **DBB Chat relay** rule chain: calls the Anthropic API for the chat tab of the builder.

Layouts are JSON, stored as ThingsBoard attributes. Admins create them in a full-screen builder (drag and drop or chat) and choose where each one applies.

---

## 2. How it changes our current setup

| Today | With the builder |
|---|---|
| One dashboard with **one state per device type** (Compressor, Dryer, Blower…), each hand-built in the ThingsBoard editor. | One **machine state** holding a single *iMEX Machine dashboard* widget. The layout is data, not dashboard JSON. We can also keep one state per type, each holding only that widget; both work, because the widget reads the device from the state's entity. |
| One template per device type, the same everywhere. | A saved layout per type, **applied customer-wide to the profile** ("All Compressor machines"). That matches today. The builder can also assign a different layout to one site/plant or one machine; decide whether we allow that (see §6). |
| Layout changes need a developer in the TB editor. | Admin users change layouts themselves. Every save is versioned (last 10) and audited. |
| Users are customer users; scope in `selectedNodes`, role in `Role`. | **No change.** The builder reads the same attributes (D-011). `Role` = `Admin`, `Customer Admin` or `Administrator`, or the attribute `dbbAdmin=true`, counts as admin. |
| Alarms on the device profile. | **No change.** Widgets only read alarms. The *Alarm thresholds…* menu item edits `thr_*` server attributes on the device, so it only matters if our profile alarm rules use dynamic thresholds from those attributes (the POC does, D-003). If ours use fixed values, hide that item or move the rules to dynamic thresholds. |
| Rule chains for shifts, derived values, DB writes. | **No change.** Derived values are just more telemetry keys; add them to the property catalogue (below). We add one new rule chain (chat relay), used only as the default rule chain of the new *DashboardStore* asset profile, so it sees none of our device traffic. |
| — | **New per customer:** one *DashboardStore* asset, assigned to the customer. It holds that customer's layouts, the property catalogue and the audit log. |
| — | **New catalogue** `dbb_profile_keys` on each store: for each device profile, the keys with display name, unit, decimals, min/max and optionally `type` (`number`/`boolean`/`string`) and `states` (e.g. `{"0":"Idle","1":"Run","2":"Fault"}`). The builder and the chat use it; keys not listed still work but show raw names. **Update it whenever we add a telemetry key or device type.** |
| Hierarchy via relations. | The builder walks **`Contains`** relations from each `selectedNodes` entry (asset → asset → device). If our hierarchy uses a different relation type, change `childrenOf`/`parentsOf` in `widgets/src/core/api.ts`. |

Since we run **one ThingsBoard tenant per customer**, each tenant gets its own widget bundle and rule chain. Each ThingsBoard *Customer* inside a tenant needs its own DashboardStore, because customer users can only read their own customer's assets. Layouts are not shared between tenants automatically. To reuse a set of templates, export the `dbb_d_*` attributes from one store and write them into another (a small script; see §8).

---

## 3. What to hand over

1. **The repository.** Once pushed: https://github.com/AkshayR25/-iMEX-Self-Service-Dashboard. Until then, the git bundle `imex-selfservice.bundle` (`git clone imex-selfservice.bundle imex-dbb`).
2. **Built widget types**, if they don't want to build: `widgets/dist/widget-types/imex_dbb_launcher.json` and `imex_dbb_renderer.json`. These can be imported into ThingsBoard (Widgets library → Widgets → **+** → *Import widget*).
3. **An Anthropic API key** for the dev tenant (only if chat is wanted; everything else works without it).
4. **A tenant-admin login** on the dev instance, plus the list of our device profiles and their telemetry keys (for the catalogue).
5. This guide, `README.md` and `DECISIONS.md`.

---

## 4. Setting it up on the dev instance

**Requirements:** Node 20+, npm, a tenant-admin account on ThingsBoard CE 4.x (built and tested on CE 4.3.0.3; the REST calls used exist in 3.6+).

```bash
git clone <repo> imex-dbb && cd imex-dbb
npm install
npm test               # 48 unit tests against a fake ThingsBoard
npm run typecheck
npm run build:widgets  # -> widgets/dist/imex-dbb.js, glue.json, widget-types/*.json
```

### Option A: deploy script (recommended; one call per customer)

1. Log in to ThingsBoard as **tenant admin** and open the browser console on any ThingsBoard page.
2. Load the build outputs into the page:
   ```js
   window.__dbbLib  = `<contents of widgets/dist/imex-dbb.js>`;   // or fetch() it from a local static server
   window.__dbbGlue = <contents of widgets/dist/glue.json>;
   ```
3. Paste `widgets/deploy/deploy-browser.js`, then run:
   ```js
   await DBB_DEPLOY({
     customerTitle: 'UCA',                  // existing ThingsBoard customer
     storeName: 'DBB-STORE-UCA',            // one DashboardStore per customer
     appTitle: 'iMEX Builder test app',     // stand-in app (optional to use; safe to delete later)
     bundleTitle: 'iMEX Self-Service',
     profileKeys: {
       Compressor: [{ key: 'dischargePressure', displayName: 'Discharge pressure', unit: 'bar', decimals: 2, min: 0, max: 10 },
                    { key: 'runStatus', displayName: 'Run status', unit: '', decimals: 0, min: 0, max: 1, type: 'boolean', states: { '1': 'Running', '0': 'Stopped' } }],
       Dryer: [/* … */],
     },
     userEmails: [],                        // leave empty; otherwise it sets these users' home dashboard
   });
   ```
   The call is idempotent, so you can re-run it after every build. It **overwrites `dbb_profile_keys`** each time, so keep the catalogue in one place (e.g. a JSON file in the repo).
4. Rule chains → **DBB Chat relay (POC)** → node **Call LLM** → Headers → set `x-api-key`. Re-deploys keep the key.

### Option B: manual import (no console scripting)

1. Import `widgets/dist/widget-types/imex_dbb_launcher.json` and `imex_dbb_renderer.json` into a widget bundle.
2. Create an asset profile **DashboardStore**, an asset of that profile per customer, and assign it to the customer. Add a server attribute `dbb_profile_keys` (JSON, format above).
3. Chat only: create the relay rule chain (copy it from a tenant where Option A ran, via Export/Import rule chain) and set it as the DashboardStore profile's default rule chain.

### Wire it into our app dashboard

1. In our **machine state** (or each device-type state), remove the hand-built widgets and add **iMEX Machine dashboard** filling the state. Settings: `refreshSeconds` (default 10), `chatEnabled`.
2. In our **header state**, add **iMEX Navbar / edit menu**, a small cell with `navbar` off, so it renders only the pencil icon. The icon shows only for admins. Alternatively keep our own header button and call `window.IMEX_DBB.open({ deviceId })`; the launcher widget must still be on the page.
3. Log in as an admin customer user, open a machine, open the pencil menu, then **Dashboard Builder** → Templates, and save. In the *Apply* dialog choose **All <type> machines**. That recreates today's "one template per type".
4. Log in as a normal user and check the page shows no edit controls.

**Tenant-admin mode:** if a tenant admin (not a customer user) needs to use the app, set the widget setting `customerId` to the customer's id (D-018).

---

## 5. Where things are stored (D-013)

Everything is a ThingsBoard **SERVER_SCOPE attribute** holding JSON. Nothing goes in the dashboard JSON or a database of ours.

| Entity | Key | Content |
|---|---|---|
| DashboardStore asset | `dbb_d_<id>` | a layout: widgets, bindings, settings, theme, time range (format: `widgets/src/core/schema.ts`) |
| | `dbb_h_<id>` | last 10 versions |
| | `dbb_vis_<id>` | `shared` / `private` |
| | `dbb_assign_customer` | `{profile: dashboardId}`, customer-wide per device type |
| | `dbb_profile_keys` | property catalogue |
| | `dbb_audit` (time series) | who saved/applied/customised what, when |
| | `dbb_chat_req`, `dbb_chat_resp_<userId>` | chat relay request/response |
| Site / plant / line asset | `dbb_assign` | `{profile: dashboardId}` for machines of that type below it |
| Device | `dbb_assign` | this machine only / copy / customised |
| User | `dbb_personal` | personal views (still read; the UI no longer creates them) |

A machine shows the first match of: personal → device → nearest ancestor location → customer-wide → built-in default layout (`widgets/src/core/store.ts`, `resolveForDevice`).

---

## 6. Decisions to make before production

1. **Security (most important, D-012).** Admin-only editing and node scope are enforced **in the browser only**. ThingsBoard CE lets any customer user read every device of their customer and write server attributes on them. So a user with browser dev-tools can read out-of-scope data or overwrite a layout. That is the same trust level as our current app (scope there is also UI-only), but writes are new. Options: ThingsBoard **PE** (role-based entity permissions); or send saves through a rule chain that checks the user's `Role` before writing; or accept the risk and rely on the audit log.
2. **Which levels admins may assign at** (customer-wide only, or also site/machine). Hiding the other options is a small change in the *Apply* dialog (`builder.ts`, `applyDialog`).
3. **Chat on or off** per customer (`chatEnabled`, `chatEnabledRoles` widget settings), and who pays for the API key.
4. **Hide or keep *Alarm thresholds…*** (see §2, Alarms).
5. **Limits:** 10 widgets per page, 4 properties per widget, 4 machines per widget, 8 lines per chart, time ranges up to 8 h. All in `widgets/src/core/schema.ts`.

---

## 7. Data loading, WebSockets and performance

**Today (POC):** the widgets are ThingsBoard *static* widgets with no data sources, so they fetch data with **REST calls** and **poll**:

- *Realtime:* every 10 s (`refreshSeconds`), each widget re-fetches: about one call per widget, or per machine for multi-machine charts.
- *Historic 1–8 h:* every 60 s.
- Polling pauses while the browser tab is hidden.

Rough call counts for a machine page with 10 widgets, estimated from the code (not measured):

| Moment | REST calls |
|---|---|
| First page load | ~40: user context (~7 + one relations call per asset node in the user's scope, done by **each** widget type on the page) + layout resolution (~6) + header status (3) + widgets (~10) |
| Opening another machine | ~20 (user context is cached for 5 minutes) |
| Every refresh | ~10 per viewer per 10 s in realtime; per 60 s in historic |

Native ThingsBoard widgets instead use **one WebSocket** per browser tab: the server pushes new values, so there is no polling.

**We can and should move to WebSockets.** The refresh entry point is one place: `widgets/src/entries/renderer.ts` (timer) → `Grid.refreshAll()` → each widget's `refresh()` in `widgets/src/render/widgets.ts`. Plan:

1. **Latest values, status, alarms → subscriptions.** Use the widget context's subscription API (`self.ctx.subscriptionApi.createSubscription` with datasources built from the layout's bound devices and keys), or the telemetry WebSocket (`/api/ws`, `ENTITY_DATA` / alarm commands) shared by all widgets on the page. The subscription API is the more robust choice: it handles reconnects and token refresh. Value/KPI/gauge/status/table widgets then redraw on push.
2. **Charts:** load history once by REST (as now), then append pushed points; re-query aggregates only when the time range changes.
3. **Cold-load savings:**
   - Load the library once as a ThingsBoard JS *resource* instead of embedding ~330 KB in each widget type's controller script. That also lets the widgets share one user context.
   - Replace the per-asset relations crawl in `core/scope.ts` with one `/api/relations/query` (or entity data query).
   - Cache the user context in `sessionStorage`.

Rough effort: 3–5 developer days for 1 + 2, 1–2 days for 3.

**Will it slow pages down?** With the POC as it is, a machine page does a few more round trips on first load than our hand-built states (to resolve which layout applies), and each open page polls instead of listening. On a normal server that is a few hundred ms extra on first load and more request load per viewer. The widget/property limits keep it bounded. After the WebSocket and cold-load changes above it should be on par with the current states.

---

## 8. Chat and the LLM

- The chat does **not** need a ThingsBoard MCP server. The builder sends the model:
  - a catalogue: device types, property keys and names, and the hierarchy with **aliased** names (D1, N1…; machines outside the user's scope are never sent);
  - the current draft layout;
  - the user's message.

  The model only returns layout operations (add/update/remove widget, time range, theme…). These are validated in the browser (`core/chat.ts`) before being applied as an undoable change. It never reads telemetry. An MCP server would only be needed if we wanted the chat to answer questions about the data itself.
- The relay is written for the **Anthropic Messages API**. The request is built in the rule chain's *Build LLM request* script node; the reply is parsed in *Parse LLM reply*; see `deploy-browser.js`. Switching to OpenAI means changing those two scripts (tool-call format) and the endpoint/header in *Call LLM*; the browser side stays the same.
- The key sits in the rule chain node header. Tenant admins can see it; customer users can't.
- There's a limit of 30 chat requests per user per hour, enforced in the browser.

---

## 9. Code map and how to change things

See the table in `README.md`. The most common changes:

- **New widget type:** follow the checklist in the header of `widgets/src/render/widgets.ts`. You touch `schema.ts` (type, label, caps, size), `compat.ts` (which property kinds it accepts), the `draw()` branch, builder defaults, icon and chat prompt.
- **New template:** `widgets/src/render/templates.ts`.
- **Limits / time ranges:** `widgets/src/core/schema.ts`.
- **Property kind rules (greyed-out combinations):** `widgets/src/core/compat.ts`.
- **Styling / themes:** `widgets/src/render/theme.ts`; builder CSS in `widgets/src/builder/styles.ts`.
- **Settings forms of the widget types:** `widgets/widget-types.mjs` **and** the copy in `widgets/deploy/deploy-browser.js` (keep both in sync).

After a change: `npm test && npm run typecheck && npm run build:widgets`, then redeploy (Option A re-run, or re-import the JSON).

**Local testing without ThingsBoard:** `widgets/harness/` has a fake ThingsBoard with generated data:

```bash
npx esbuild widgets/harness/harness.ts --bundle --format=iife --target=es2019 --outfile=widgets/harness/harness.js
node widgets/harness/shot.mjs '[{"wait":2000,"shot":"machine"}]' 'index.html'      # screenshot to /tmp/claude-0/
# or serve widgets/harness/ with any static server and open index.html (?page=list / ?page=map)
```

---

## 10. Known issues (found while documenting; all noted in code comments)

- **Concurrent saves:** `saveDashboard` checks the version and then writes in two calls. Two admins saving the same layout at the same moment can both succeed; the last write wins. `apply` has the same issue for assignments. Low risk with few admins; fixing it properly needs a server-side step (rule chain).
- **Deleting a layout** removes assignments only within the deleting admin's scope. Machines elsewhere fall back to the next level (the renderer skips missing layouts), but stale assignment entries remain.
- **Deploy script:** it checks the POC marker only on the DashboardStore profile. It updates the rule chain, bundle, widget types and stand-in dashboard by name without that check, so don't reuse those names for anything else.
- **Custom time ranges** like `3h` are read as 8 h, not rounded.
- **Legacy colour bands:** after editing an old widget's colour bands in the Colours tab, values above the last band get no colour.
- **Unused code:** the non-admin *Save as copy* path in the builder is unreachable since building became admin-only (D-017). `Template.needsSiblings` is not read.
- **Removing POC markers for production:** descriptions contain `[poc=true]` and the store has `poc=true`. They exist so `npm run teardown` can find POC entities; decide whether to keep them.
