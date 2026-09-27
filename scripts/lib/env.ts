// Node-only: loads .env and builds a tenant-authenticated client.
// Used by the Node entry points (npm run setup:tb / backfill / simulator / teardown); the browser bundle
// (npm run build:browser, D-001) uses externalTokenAuth from tb.ts instead and never imports this file.
// Also reads/writes scripts/output/setup-result.json (IDs only, no credentials; D-008).
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TbClient, passwordAuth } from './tb';
import type { SetupResult } from './setup';

/** Console logger with an ISO timestamp prefix. */
export const log = (m: string) => console.log(`${new Date().toISOString()}  ${m}`);

/**
 * TbClient logged in as the tenant admin from .env (TB_URL, TB_TENANT_USERNAME, TB_TENANT_PASSWORD;
 * optional TB_MIN_DELAY_MS, default 150). Exits the process when a variable is missing.
 */
export function tenantClient(): TbClient {
  const url = process.env.TB_URL;
  const user = process.env.TB_TENANT_USERNAME;
  const pass = process.env.TB_TENANT_PASSWORD;
  if (!url || !user || !pass) {
    console.error('Missing TB_URL / TB_TENANT_USERNAME / TB_TENANT_PASSWORD in .env (copy .env.example).');
    process.exit(1);
  }
  return new TbClient(url, passwordAuth(url, user, pass), {
    minDelayMs: Number(process.env.TB_MIN_DELAY_MS ?? 150),
    log,
  });
}

const here = dirname(fileURLToPath(import.meta.url));
/** scripts/output/setup-result.json, written by setup and read by backfill/simulator. */
export const RESULT_PATH = resolve(here, '../output/setup-result.json');

/** Writes the setup result to RESULT_PATH (creates the folder). */
export function writeResult(r: SetupResult) {
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(r, null, 2));
  log(`wrote ${RESULT_PATH}`);
}

/** Reads RESULT_PATH; exits the process if setup hasn't been run. */
export function readResult(): SetupResult {
  if (!existsSync(RESULT_PATH)) {
    console.error(`${RESULT_PATH} not found; run "npm run setup:tb" first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
}

/** Device name -> ThingsBoard device id, from a setup result. */
export const deviceIdMap = (r: SetupResult) => Object.fromEntries(Object.entries(r.devices).map(([k, v]) => [k, v.id]));
