# Changelog

Newest first. One row per change; details in `DECISIONS.md`. Rows that also belong in the Claude Doc "New widget instructions" are marked ◆ (paste them there).

| Date | Commit | Change | Where |
|---|---|---|---|
| 2026-10-06 | (D-038) | Machine title in the page header only when the app side menu is on the page (server with navbar: unchanged line) | `widgets/src/entries/renderer.ts` (`sideMenu`) |
| 2026-10-06 | (D-039) | Fallback font stack starts with DM Sans, the app's new default | `widgets/src/render/theme.ts:114` |
| 2026-10-07 | (D-041) | ◆ Headless API `dashboardPage(host)`: the Dashboard list drawn inside an element as a page (the pop-up stays) | `widgets/src/entries/launcher.ts` (`dashboardList`, `.dbb-dl-inline`) |
| 2026-10-06 | (D-040) | ◆ Read-only dashboards (machine page, Dashboard Overview) switch to 6 columns when a column would be under 58 px: widths halved, packed in reading order; stored layout and editor unchanged | `widgets/src/render/grid.ts` (`compactLayout`, `Grid.layout`) |
| 2026-10-05 | (D-039) | ◆ Chat prompt: never name the platform the app is built on | `widgets/src/core/chat.ts:641` |
| 2026-10-05 | (D-039) | ◆ Default font follows the app's font (`--imx-font`, Inter otherwise); a dashboard's own theme font is marked `data-dbb-font` | `widgets/src/render/theme.ts:117, 171` |
| 2026-10-05 | (D-036) | ◆ Builder opens next to an app side menu: insets from `--imex-app-inset-left/-top` on `<html>`, event `imex-app:insets` | `widgets/src/builder/builder.ts:155, 318` |
| 2026-10-05 | (D-036) | ◆ Navbar widget setting `headless`: draws nothing, provides `window.IMEX_DBB` (open, newDashboard, dashboardList, isEditor, actions) | `widgets/src/entries/launcher.ts:219` |
| 2026-10-05 | (D-035) | ◆ Live values: WebSocket scheme follows the page (ws:// on an http ThingsBoard); before, the v2 socket failed there and the legacy fallback put the token in the URL | `widgets/src/core/live.ts:224` |
| 2026-10-05 | (D-035) | ◆ Relation infos work on ThingsBoard 4.3 (path form) and 4.2 (query form), one 404 decides | `widgets/src/core/api.ts:435-447` |
| 2026-10-05 | (D-035) | Deploy: `skipAppDashboard` option; relations saved via `/api/v2/relation` with fallback; Node runner `deploy-node.mjs`, read-only `check-tb.mjs` | `widgets/deploy/deploy-browser.js:367-369, 460`, `widgets/deploy/*.mjs` |
| 2026-10-05 | (D-035) | Copy of the iMEX demo app from iserv-demov2 (read-only) to the local tenant shared with Reports: export, import, verify, diff, smoke scripts | `scripts/mirror/` |
| 2026-10-05 | (D-035) | E2E: pickers opened by the caret (centre can be a chip's ✕); harness ignores the missing WebSocket server | `widgets/e2e/builder.e2e.mjs:48, 86` |
| 2026-10-05 | (D-037) | ◆ Scope relations kept in sessionStorage for 10 minutes (per user and root set): no relation calls on later pages of a session | `widgets/src/core/scope.ts` (`buildTree`, `REL_CACHE_MS`) |
| 2026-10-05 | (D-038) | ◆ Machine page header starts with the machine name as the title, then org › site · dashboard name | `widgets/src/entries/renderer.ts` |
| 2026-10-05 | (D-035) | Local copy: long-lived local authToken script; read-only screenshots of the server | `scripts/mirror/local-authtoken.mjs`, `scripts/mirror/shots-source.mjs` |
