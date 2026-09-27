# iMEX Self-Service Dashboard Builder (POC)

Customer users build their own machine dashboards **inside ThingsBoard CE**, by drag and drop or by chatting with Claude. There is no external service: the builder, the renderer and the chat relay are ThingsBoard widgets and a rule chain. See `DECISIONS.md` for why and for every deviation from the original build instructions.

## Status

| Part | State |
|---|---|
| ThingsBoard sample data, simulator, teardown (Phase 1) | done on demo.thingsboard.io (CE 4.3.0.3) |
| Dashboard Builder widgets, renderer, stand-in app (Map → Machines → machine) | deployed and tested live as admin and viewer |
| Chat relay rule chain | deployed, tested up to the Anthropic call; **needs your API key** |

## How it works

Everyone is a ThingsBoard customer user. Scope comes from the user attribute `selectedNodes`, role from `Role`.

1. **Map page** (home) → button → **Machines** listing (hierarchy + machine cards) → click a card → **machine page**. The navbar has Map and Machines links and a breadcrumb.
2. **Admins** (`Role` = Admin) also see a **Dashboard Builder** button in the navbar, and an Edit button on the machine page. It opens a full-screen builder.
3. The admin picks a machine and builds by drag and drop, or asks in the Chat tab ("add a 7-day power chart and the site weather station's temperature").
4. **Save.** The admin is then asked where it should show: only this machine, or all machines of the same type. From then on every user of that customer who opens those machines sees it.
5. **Everyone else only views.** No builder, no edit controls.

## One-time setup in your own ThingsBoard

1. **Build:** `npm install && npm run build:widgets` → `widgets/dist/imex-dbb.js` and `glue.json`.
2. **Deploy:** in a logged-in tenant-admin page, set `window.__dbbLib` to the contents of `imex-dbb.js` and `window.__dbbGlue` to `glue.json`, paste `widgets/deploy/deploy-browser.js`, then run:
   ```js
   await DBB_DEPLOY({
     customerTitle: 'UCA',                 // your customer
     storeName: 'DBB-STORE-UCA',           // one DashboardStore asset per customer
     profileKeys: { Compressor: [{ key: 'dischargePressure', displayName: 'Discharge pressure', unit: 'bar', decimals: 2, min: 0, max: 10 }] },
     userEmails: [],                       // leave empty in production (it sets home dashboards)
   });
   ```
   Repeat per customer (it creates a store asset for each). `profileKeys` is the catalogue shown in the builder and given to the LLM; keys not listed are still usable, just without nice names and units.
3. **API key:** Rule chains → **DBB Chat relay (POC)** → node **Call LLM** → Headers → set `x-api-key` to your Anthropic key → Apply → Save. Re-deploys keep it.
4. **Put the button in your real app.** Two options:
   - Add the widget **iMEX Dashboard Builder button** (bundle "iMEX Self-Service (POC)") to your app's header state. It shows only for `Role` = Admin (setting `adminOnly`), or
   - keep your own header button and call `window.IMEX_DBB.open({ deviceId })` from its action. That function is registered by the launcher widget, so the launcher widget must also be on the page (a small cell is enough).
5. **Show the dashboards:** put the **iMEX Machine dashboard** widget in your machine-detail state. It reads the machine from the dashboard state entity, as the stand-in app does.

The stand-in app on the demo is the dashboard **iMEX App (POC)** (home dashboard of the three sample users).

## Sample data (Phase 1)

- Customer **ITHENA**, hierarchy ITHENA-ROOT → SITE-RICHMOND (RIC-COMP-01, RIC-DRY-01) and SITE-PUNE (PUN-COMP-01, PUN-WS-01), all `poc=true`.
- Device profiles Compressor, Dryer, Weather Station, each with a dynamic-threshold alarm and clear rule.
- Three customer users: an admin (whole tree), a Richmond manager and a Pune viewer, with `selectedNodes` and `Role` in the production format.

```bash
cp .env.example .env      # fill TB_URL, TB_TENANT_USERNAME, TB_TENANT_PASSWORD yourself
npm run setup:tb          # idempotent
npm run backfill          # 7 days at 5-min intervals
npm run simulator         # live telemetry every 10 s
npm run teardown          # lists every POC entity (incl. widgets, dashboard, rule chain), deletes after you type DELETE
npm test                  # 30 unit tests (store, scope, chat ops, generator)
npm run typecheck
```

The same scripts can run inside a logged-in ThingsBoard page: `npm run build:browser`, paste `scripts/output/poc-browser.js` into the console, then use `POC.setup()`, `POC.backfill()`, `POC.startSimulator()` and so on.

## Repository layout

```
scripts/            Phase 1: ThingsBoard setup, backfill, simulator, teardown
widgets/src/core    REST client, scope, store (save/apply/resolve), chat ops, audit, schema
widgets/src/render  theme, SVG charts, widget renderers, 12-column grid
widgets/src/builder full-screen builder UI
widgets/src/entries launcher (button/navbar), renderer, listing
widgets/deploy      DBB_DEPLOY for a tenant-admin page
widgets/harness     local harness + Playwright screenshots against a fake ThingsBoard
widgets/test        unit tests with an in-memory fake ThingsBoard
```

## Known limits

- **Scope and admin rights are enforced in the UI only.** In CE, a customer user can read every device of their customer and write server attributes on them through the REST API (DECISIONS D-012).
- The chat needs the API key (above) and allows 30 requests per user per hour.
- One DashboardStore asset per customer must exist before that customer's users can save.
