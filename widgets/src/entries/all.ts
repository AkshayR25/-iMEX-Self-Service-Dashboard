/**
 * Bundle root: the single esbuild entry point (see widgets/build.mjs).
 *
 * esbuild bundles this file as an IIFE with `globalName: 'IMEX_DBB'`, so at runtime the exports below
 * become `IMEX_DBB.launcher`, `IMEX_DBB.renderer`, `IMEX_DBB.listing` and `IMEX_DBB.version`.
 *
 * The same bundle is embedded in the controller script of each of the three ThingsBoard widget types
 * (tenant.imex_dbb_launcher / imex_dbb_renderer / imex_dbb_listing). Each widget type therefore runs its
 * OWN copy of the library, with its own module state; widgets on one page share nothing except `window`
 * (see common.ts: CHANGED_EVENT, ACTIONS_EVENT, window.__imexDbbActions).
 *
 * The per-widget controller glue (generated in build.mjs) calls, for the widget type named `<k>`:
 *   self.onInit         -> IMEX_DBB.<k>.init(self.ctx)
 *   self.onStateChanged -> IMEX_DBB.<k>.onStateChanged(self.ctx)
 *   self.onDestroy      -> IMEX_DBB.<k>.destroy(self.ctx)
 * so every entry module must export those three functions.
 */
import * as launcher from './launcher';
import * as renderer from './renderer';
import * as listing from './listing';
export { launcher, renderer, listing };
/** Build timestamp; build.mjs replaces the `__VERSION__` placeholder with an ISO date after bundling. */
export const version = '__VERSION__';
