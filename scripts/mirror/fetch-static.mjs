// Read-only: downloads the files the server's widgets load from its web UI (assets/ithena/...), which a stock
// ThingsBoard does not serve, to mirror-data/static/ (same relative paths).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sourceClient } from './clients.mjs';
const c = await sourceClient();
const text = readFileSync('mirror-data/source/widget-types.json', 'utf8') + readFileSync('mirror-data/source/dashboards.json', 'utf8');
const paths = [...new Set(text.match(/assets\/ithena\/[^"' )]+/g) || [])];
for (const p of paths) {
  const buf = await c.api('GET', '/' + p, undefined, { raw: true, allow404: true }).catch((e) => (console.log(p, e.message), null));
  if (!buf) { console.log(`${p}: missing`); continue; }
  mkdirSync(dirname(`mirror-data/static/${p}`), { recursive: true });
  writeFileSync(`mirror-data/static/${p}`, buf);
  console.log(`${p}: ${(buf.length / 1024).toFixed(0)} KB, starts "${buf.subarray(0, 40).toString().replace(/\s+/g, ' ')}"`);
}
