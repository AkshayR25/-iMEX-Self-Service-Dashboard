# iMEX app on the server: tenant "iMEX - AI Features"

Moved on 7 Oct 2026 from the local ThingsBoard to the new tenant **iMEX - AI Features** on
https://iserv-demov2.ithena.app (ThingsBoard CE 4.2.1). The existing tenant ("Self Service Dashboard") was only read,
never changed.

**Open the app:** https://iserv-demov2.ithena.app — sign in as one of the users below; the app opens directly
(home dashboard "Self Service Dashboard", full screen).

## 1. What is there now

| | |
|---|---|
| Customer | **ITHENA** |
| Users | `ar@imex.com`, `pc@imex.com`, `vp@imex.com`, `tl@imex.com` (Role **Admin**), `demo@imex.com` (Role **Viewer**). All see all 5 sites. Password: the value of `TGT_USER_PASSWORD` in the Builder repo's `.env`; ask each person to change it. First names are their initials (AR, PC, …); change them on the Users page. |
| Machines | 15 (Blower 1–4, Compressor 1–3, Dryer 1–4, Weather Station 1–4), live every 10 s from the simulator rule chains |
| History | 90 days at 5-minute steps for the 11 Blower / Compressor / Dryer machines (same model as the live simulators) |
| Locations | ITHENA ORG › Austin, Bangalore, Mumbai, Pune, Richmond |
| Configuration assets | System Configuration (theme, logos, Andon boards and layouts, machine-card values), DBBLLM-CONFIG (models, **no key**), DashboardStore (18 Builder dashboards), CATALOGUE_STORE_ASSET (Reports catalogue), AIML Config (AI settings) |
| Rule chains | Ithena Telemetry Simulation, Blower, Compressor, Dryer, Weather Station, [UCA] Shift Detection RC, DBB Chat relay (POC); the root chain is the tenant's own |
| Widgets | 33, in 4 bundles: iMEX v4.3 (23), AIML (5), iMEX Self-Service (POC) (3), iMEX Reports (2). They load DevExtreme etc. from the server's own folder `assets/ithena/devextreme-23.2.11/` |
| Dashboard | "Self Service Dashboard", 20 pages, assigned to ITHENA |

**Not moved, on purpose:** the Reports demo customers (POC Alpha/Beta/Gamma and their machines and users), local
test alarms, the AI service's stored results (it computes them again on the server), every secret (LLM key, tokens).

**Checked on the server** (`verify-target.mjs`, `smoke-target.mjs`): no local ids left anywhere; all 15 machines
live; every page opens for an admin and for the viewer. Reports and AI Insights wait for their services (section 2).

## 2. Your steps, in this order

### 2.1 LLM key

1. Sign in as the tenant administrator of "iMEX - AI Features".
2. **Assets → DBBLLM-CONFIG → Attributes → Server attributes → +**: key `dbb_llm_api_key`, type String, value your
   Claude key (`sk-ant-…`). The model attributes came from local; `dbb_llm_model_anthropic` reads
   `" claude-sonnet-5"` there, with a leading space. Remove the space while you are on that page.
3. Tell me, or run in the AIML repo:
   `node scripts/on-server.mjs scripts/install-native-ai.mjs`
   It creates the AI model "AIML Claude" (with a copy of the key), the rule chain "AIML Anomaly explain" and the
   asset "AIML Insights".

Used by: Dashboard Builder chat, Reports AI summary, AI Insights explanations. The AI master switch is **off** (as on
local): turn it on in the app under **AI settings** when you want AI explanations to run.

### 2.2 nginx: two paths on the server's domain

The app calls both services through `https://iserv-demov2.ithena.app` itself, so no extra public port and no CORS.
Inside the `server { }` block that serves ThingsBoard (`^~` so these win over ThingsBoard's own rules):

```nginx
location ^~ /reports-api/ {
    proxy_pass         http://127.0.0.1:8090/;   # trailing slash: /reports-api/api/... -> /api/...
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 180s;                      # report generation
    client_max_body_size 4m;
}
location ^~ /aiml-api/ {
    proxy_pass         http://127.0.0.1:8091/;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;                      # first forecasts can take a while
}
```

Use other ports if 8090 / 8091 are taken on that host (section 2.3) and change only `proxy_pass`. Check:
`https://iserv-demov2.ithena.app/reports-api/api/health` and `…/aiml-api/api/health` must answer JSON
`{"status":"ok"…}`. Today they answer the platform's own HTML page (no proxy yet).

### 2.3 Reports container (repo iMEX-InApp-Reports, `docs/DEPLOY.md`)

One Reports service serves one tenant (its service account runs scheduled reports). If a Reports service for the
existing tenant already runs on this host, start a **second** one for the new tenant:

```bash
# .env of this instance (copy .env.example)
TB_URL=https://iserv-demov2.ithena.app            # or the platform's internal address
TB_PUBLIC_URLS=https://iserv-demov2.ithena.app
TB_USERNAME=…                                     # a tenant administrator of "iMEX - AI Features"
TB_PASSWORD=…
CATALOGUE_STORE_ASSET_TYPE=CATALOGUE_STORE_ASSET  # ITHENA's catalogue asset (default "POC Store" does not exist here)
SMTP_HOST=… SMTP_PORT=… SMTP_USER=… SMTP_PASSWORD=… SMTP_FROM=… SMTP_TLS=true
REPORTS_PORT=8090                                 # 8092 if 8090 is taken; nginx proxy_pass to match
REPORTS_HISTORY_URL=                              # after the first start: the Reports page address

docker compose -p imex-reports-ai -f docker-compose.prod.yml up -d --build   # -p: own container and volume
```

Use the Reports code from commit `40f6bc7` (branch phase-1) or later: it shows the catalogue names
(`displayName`, e.g. "Main Motor Power (kW)") instead of raw keys. `CATALOGUE_STORE_ASSET=CATALOGUE_STORE_ASSET` (by name) works
as well as the type setting above.

Reports refuses tenant administrators by design: use ar@ / pc@ / vp@ / tl@ / demo@imex.com. The AI summary reads
the key from this tenant's DBBLLM-CONFIG (2.1).

### 2.4 AI Insights container (repo iMEX AIML)

New in that repo: `docker-compose.server.yml` and `.env.server.example`.

```bash
cp .env.server.example .env.server     # fill in TB_USERNAME / TB_PASSWORD (tenant admin of the new tenant)
                                       # CUSTOMER_TITLE=ITHENA is already set (local is "Ithena Technology")
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

It listens on 127.0.0.1:8091 only. The image is about 4 GB (PyTorch); the first start downloads the TimesFM
weights once (`TIMESFM_ENABLED=false` skips that and forecasts with LightGBM only). The first forecasts, anomaly
scores and health results appear a few minutes after start; it reads the 90 days of history already on the server.

## 3. Changed in the code for the server

| Where | Change |
|---|---|
| Dashboard on the server | Reports widget `serviceUrl` = `/reports-api`; the five AI Insights widgets `serviceUrl` = `/aiml-api` (local stays `http://localhost:8090` / `:8091`) |
| Widgets on the server | Libraries from `assets/ithena/devextreme-23.2.11/` (server folder) instead of the public CDNs used on local |
| AIML repo, `widgets/_shared/aiml.js` | When the service address answers with a web page instead of data, the AI pages now say "The AI Insights service is not reachable (/aiml-api)" instead of a JavaScript message |
| AIML repo | `docker-compose.server.yml`, `.env.server.example`, `scripts/on-server.mjs` (runs a script against the new tenant) |
| Builder repo, `scripts/mirror/` | `migrate-target.mjs` (the migration), `verify-target.mjs`, `smoke-target.mjs`; `clients.mjs` gets the new-tenant client (refuses the existing tenant) |

## 4. Good to know

- **Stored token.** The alert, user-management and listing pages use a tenant-administrator token stored on System
  Configuration (`authToken`), as on the existing tenant. It is a login of the new tenant's admin account, valid
  until **14 Aug 2029**. If that account's password changes or it is disabled, run the migration again (it sets a
  fresh one): `node scripts/mirror/migrate-target.mjs --go`. Every customer user can read this token; that is the
  developers' design and the same on the existing tenant (see the widget review). One visible effect: the menu
  hides the Admin pages from demo@imex.com, but a Viewer who opens the Users page by its address still gets the
  edit, delete and password buttons, because that page acts with the stored token, not the user's own rights.
  Same on local and on the existing tenant; not changed here.
- **Running it again** is safe: `migrate-target.mjs --go` finds everything by name and updates it in place (dashboard,
  widgets, rule chains, attributes, latest values). Use it to bring later local changes to the server. It does not
  touch users that exist, history, or anything you add on the server under other names.
- **Console messages on 4 pages** (Alert history: DevExtreme loaded twice; Alert management: Role read as JSON;
  Analyzer: chart helper; Custom alerts: device profile asked for before a machine is chosen). The same messages
  appear on local; they come from the developers' code on those pages, which still work (local click check 88/88).
- **Builder dashboards** show their authors as saved on local ("Pranali Patil", "imex s"); the six by the local
  service account are now owned by ar@imex.com. Admins can edit all of them.
- **Simulators**: 15 generator nodes write every 10 s on the server (about 1.5 messages/s for the tenant).
- **Noticed on the existing tenant, not changed:** its dashboard's Reports widget points at
  `http://172.67.145.52:8090/`; browsers block plain-http calls from an https page, so Reports cannot load there.
- **4.2.1 vs 4.3.1.5:** everything used is available on 4.2.1 (rule nodes, REST endpoints, live updates). The app was
  built and fully tested on 4.3.1.5; on the server all pages were opened and checked, not every click.
