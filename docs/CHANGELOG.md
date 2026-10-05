# Changelog

Newest first. One row per change; details in `DECISIONS.md`. Rows that also belong in the Claude Doc "New widget instructions" are marked ◆ (paste them there).

| Date | Commit | Change | Where |
|---|---|---|---|
| 2026-10-05 | (D-035) | ◆ Live values: WebSocket scheme follows the page (ws:// on an http ThingsBoard); before, the v2 socket failed there and the legacy fallback put the token in the URL | `widgets/src/core/live.ts:224` |
| 2026-10-05 | (D-035) | ◆ Relation infos work on ThingsBoard 4.3 (path form) and 4.2 (query form), one 404 decides | `widgets/src/core/api.ts:435-447` |
| 2026-10-05 | (D-035) | Deploy: `skipAppDashboard` option; relations saved via `/api/v2/relation` with fallback; Node runner `deploy-node.mjs`, read-only `check-tb.mjs` | `widgets/deploy/deploy-browser.js:367-369, 460`, `widgets/deploy/*.mjs` |
| 2026-10-05 | (D-035) | Copy of the iMEX demo app from iserv-demov2 (read-only) to the local tenant shared with Reports: export, import, verify, diff, smoke scripts | `scripts/mirror/` |
| 2026-10-05 | (D-035) | E2E: pickers opened by the caret (centre can be a chip's ✕); harness ignores the missing WebSocket server | `widgets/e2e/builder.e2e.mjs:48, 86` |
