# iMEX on the server: Reports, AI Insights and the LLM key

Everything runs for **one tenant: "iMEX - AI Features"** on https://iserv-demov2.ithena.app (ThingsBoard CE 4.2.1,
tenant admin `ai@imex.com`). Reports for the previous tenant ("Self Service Dashboard") are no longer supported;
that tenant was never changed.

**The app:** https://iserv-demov2.ithena.app. Sign in as `ar@imex.com`, `pc@imex.com`, `vp@imex.com`, `tl@imex.com`
(Admin) or `demo@imex.com` (Viewer). The password is `TGT_USER_PASSWORD` in the Builder repo's `.env`; ask everyone
to change it.

## 1. How it fits together

| From | To | Address | As whom |
|---|---|---|---|
| Browser, Reports page | Reports service | `https://pmiserv-thg.ithena.app` | the signed-in user |
| Browser, the five AI Insights pages | AI Insights (ML) service | `https://pmiserv-thg.ithena.app/aiml-api` | the signed-in user |
| Reports service | ThingsBoard | `https://iserv-demov2.ithena.app` | the user; schedules and AI summary: a tenant admin of the new tenant |
| AI Insights service | ThingsBoard | `https://iserv-demov2.ithena.app` | a tenant admin of the new tenant |
| Builder chat (rule chain on ThingsBoard), Reports AI summary, AI Insights | Claude | `https://api.anthropic.com` | key from asset **DBBLLM-CONFIG** |

Both services run on the pmiserv-thg host, behind its nginx (HTTPS). The browser accepts them because they answer
over HTTPS and allow `https://iserv-demov2.ithena.app` (CORS, setting `TB_PUBLIC_URLS`).

## 2. Steps, in this order

### Step 1: LLM key (you, in ThingsBoard as ai@imex.com)

1. **Entities → Assets → DBBLLM-CONFIG → Attributes → Server attributes → +**: key `dbb_llm_api_key`, type
   String, value the Claude key (`sk-ant-…`).
2. On the same page, edit `dbb_llm_model_anthropic`: it reads `" claude-sonnet-5"` with a leading space. Remove
   the space.

Used by the Builder chat, the Reports AI summary and AI Insights. Nothing else holds the key until step 6.

### Step 2: Reports service (on pmiserv-thg, repo iMEX-InApp-Reports, branch `phase-1`)

Its `.env` (values not listed here stay as they are):

| Setting | Value |
|---|---|
| `TB_URL` | `https://iserv-demov2.ithena.app` |
| `TB_PUBLIC_URLS` | `https://iserv-demov2.ithena.app` |
| `TB_USERNAME` / `TB_PASSWORD` | a tenant admin of "iMEX - AI Features": `ai@imex.com`, or better a dedicated account (see section 3) |
| `CATALOGUE_STORE_ASSET_TYPE` | `CATALOGUE_STORE_ASSET` |
| `REPORTS_HISTORY_URL` | `https://iserv-demov2.ithena.app/dashboard/db4109a0-c279-11f1-9f70-2b66090a5d6c?state=W3siaWQiOiJyZXBvcnRzIiwicGFyYW1zIjp7fX1d` |
| `SMTP_*` | unchanged |

```bash
sh scripts/deploy.sh --pull      # pulls commit 40f6bc7 or later (readable property names), rebuilds, waits until healthy
```

Check: `https://pmiserv-thg.ithena.app/api/health` answers `{"status":"ok"}`.

Reports made by the previous tenant's users stay in the service's database; their schedules now fail and can be
ignored. For a clean start instead (optional; deletes all stored reports and PDFs):

```bash
docker compose -f docker-compose.prod.yml down
docker run --rm -v imex-reports_reports-data:/data -v "$PWD":/backup alpine tar czf /backup/reports-data-backup.tgz /data
docker volume rm imex-reports_reports-data
sh scripts/deploy.sh
```

### Step 3: AI Insights service (on pmiserv-thg)

The AI repo is not on GitHub; everything the server needs is in **`imex-aiml-server.zip`** (68 KB: `service/`,
`docker-compose.server.yml`, `.env.server.example`; on Akshay's PC in `Downloads`).

```bash
unzip imex-aiml-server.zip -d imex-aiml && cd imex-aiml
cp .env.server.example .env.server
```

| Setting in `.env.server` | Value |
|---|---|
| `TB_URL` | `https://iserv-demov2.ithena.app` (preset) |
| `TB_USERNAME` / `TB_PASSWORD` | the same tenant admin as Reports |
| `TB_PUBLIC_URLS` | `https://iserv-demov2.ithena.app` (preset) |
| `CUSTOMER_TITLE` | `ITHENA` (preset) |
| `AIML_PORT` | default `8091`; to change it, uncomment the line (and change step 4 to match) |
| `TIMESFM_ENABLED` | default `true`; uncomment and set `false` to skip the one-time model download (forecasts with LightGBM only) |

```bash
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

The image is about 4 GB; allow 2–4 GB of RAM. It listens on `127.0.0.1:8091` only. Check on the host:
`curl http://127.0.0.1:8091/api/health` answers `{"status":"ok"…}`. Forecasts, anomaly scores and health appear a
few minutes after start (the 90 days of history are already on the server).

### Step 4: nginx on pmiserv-thg (infrastructure, once)

Add inside the `server { }` block that serves `pmiserv-thg.ithena.app`. `^~` makes it win over the Reports
location at `/`:

```nginx
location ^~ /aiml-api/ {
    proxy_pass         http://127.0.0.1:8091/;   # trailing slash: /aiml-api/api/... -> /api/...
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;                      # first forecasts can take a while
}
```

Reload nginx, then check from any PC:

```bash
curl https://pmiserv-thg.ithena.app/aiml-api/api/health                     # {"status":"ok"...}
curl -s -D - -o /dev/null -X OPTIONS https://pmiserv-thg.ithena.app/aiml-api/api/me \
  -H "Origin: https://iserv-demov2.ithena.app" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-authorization"                        # access-control-allow-origin: https://iserv-demov2.ithena.app
```

### Step 5: service addresses in ThingsBoard (you as ai@imex.com, or me on your go-ahead)

Dashboard **Self Service Dashboard → Edit**, choose the page (state) in the state list, edit the page's widget,
setting on its settings tab, **Save** the dashboard:

| Page (state) | Widget | Setting | Value |
|---|---|---|---|
| `reports` | iMEX Reports | Service URL | `https://pmiserv-thg.ithena.app` (remove the leading space it has now) |
| `aiml_forecast`, `aiml_anomalies`, `aiml_maintenance`, `aiml_relations`, `aiml_settings` | AIML Forecast / Anomalies / Predictive maintenance / Relationships / AI settings | AI Insights service URL | `https://pmiserv-thg.ithena.app/aiml-api` |

### Step 6: the platform AI route (me, on your go-ahead, after step 1)

`node scripts/on-server.mjs scripts/install-native-ai.mjs` (AIML repo) creates the AI model **AIML Claude** (it
keeps its own copy of the key), the rule chain **AIML Anomaly explain** and the asset **AIML Insights**. After a
key change, this is run again.

### Step 7: switch AI on (an Admin user, in the app)

**AI settings → AI** on. It is off, as on local; without it, no explanations and no AI review are generated.

### Step 8: check end to end (as ar@imex.com)

| Where | Expected |
|---|---|
| Reports → New report → Blank report → Machines: a compressor → Add figure | Property names like "Main Motor Power (kW)", no `_` |
| Reports → Preview PDF, with "Add an AI summary" ticked | PDF with the summary at the top |
| Reports → a report with a schedule to your e-mail, "Run now" | Mail arrives |
| AI Insights → Forecast | Chart with forecast and band for the chosen machine |
| AI Insights → Anomalies / Predictive maintenance | Episodes and health per machine |
| Dashboards → Dashboard Builder → Chat | Answer from Claude |

## 3. Good to know

- **One service account for both services.** Its password change breaks Reports schedules and AI Insights until
  both `.env` files are updated. A dedicated tenant-admin account (e.g. `svc@imex.com`) keeps that apart from
  people's logins.
- **Stored tenant token.** The alert, user-management and machine-card pages use a tenant-admin token stored on
  System Configuration (`authToken`), as on the previous tenant: a login of `ai@imex.com`, valid until **14 Aug
  2029**. If `ai@imex.com`'s password changes or it is disabled, it has to be set again (ask me). Every customer user
  can read this token; that is the developers' design. Effect: a Viewer who opens the Users page by its address
  gets edit buttons although the menu hides it.
- **Reports refuses tenant admins** by design: use the ITHENA users, not `ai@imex.com`.
- **Outbound HTTPS** to `api.anthropic.com` is needed from the ThingsBoard host (Builder chat) and from pmiserv-thg
  (Reports, AI Insights).
- **Changes from local reach the server only on Akshay's go-ahead.** The server tenant is also edited by hand. The
  migration script (`scripts/mirror/migrate-target.mjs`) stops if anything it would overwrite changed on the
  server since its last run; `restore-from-audit.mjs` put back what the run of 8 Oct 13:22 IST had overwritten.
- **Console messages on 4 pages** (Alert history, Alert management, Analyzer, Custom alerts) come from the
  developers' code and appear on local too; the pages work.
- **Server version 4.2.1** (built and fully tested on 4.3.1.5): every page was opened on the server, not every click.

## 4. What is on the tenant

| | |
|---|---|
| Customer | **ITHENA** (5 users above, all sites) |
| Machines | 15 (Blower 1–4, Compressor 1–3, Dryer 1–4, Weather Station 1–4), live every 10 s from the simulator rule chains; 90 days of history for the 11 Blower / Compressor / Dryer |
| Locations | ITHENA ORG › Austin, Bangalore, Mumbai, Pune, Richmond |
| Configuration assets | System Configuration, DBBLLM-CONFIG, DashboardStore (18 Builder dashboards), CATALOGUE_STORE_ASSET (Reports catalogue), AIML Config |
| Rule chains | Ithena Telemetry Simulation, Blower, Compressor, Dryer, Weather Station, [UCA] Shift Detection RC, DBB Chat relay (POC) |
| Widgets | 33 in 4 bundles: iMEX v4.3 (23), AIML (5), iMEX Self-Service (POC) (3), iMEX Reports (2); libraries from the server folder `assets/ithena/devextreme-23.2.11/` |
| Dashboard | Self Service Dashboard, 20 pages |

Which entity and key each page and process uses: `D:\Claude Code\iMEX App UI\docs\DATA_MAP.xlsx`.
