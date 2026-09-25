// Node-only: loads .env and builds a tenant-authenticated client.
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TbClient, passwordAuth } from './tb';
import type { SetupResult } from './setup';

export const log = (m: string) => console.log(`${new Date().toISOString()}  ${m}`);

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
export const RESULT_PATH = resolve(here, '../output/setup-result.json');

export function writeResult(r: SetupResult) {
  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, JSON.stringify(r, null, 2));
  log(`wrote ${RESULT_PATH}`);
}

export function readResult(): SetupResult {
  if (!existsSync(RESULT_PATH)) {
    console.error(`${RESULT_PATH} not found; run "npm run setup:tb" first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(RESULT_PATH, 'utf8'));
}

export const deviceIdMap = (r: SetupResult) => Object.fromEntries(Object.entries(r.devices).map(([k, v]) => [k, v.id]));
