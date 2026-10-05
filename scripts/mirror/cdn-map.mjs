// Public CDN copies for the libraries the server serves from its own web UI (assets/ithena/devextreme-23.2.11/).
// A stock local ThingsBoard has no such folder, so the LOCAL copies of the widget types point here instead.
// Same library and version as the server file (verified by `node scripts/mirror/cdn-map.mjs`; the server folder is
// named 23.2.11 but holds DevExtreme 23.2.6; daterangepicker differs only in the minifier comment).
const B = 'assets/ithena/devextreme-23.2.11/';
export const CDN_MAP = {
  [B + 'dx.all.js']: 'https://cdn3.devexpress.com/jslib/23.2.6/js/dx.all.js',
  [B + 'dx.light.css']: 'https://cdn3.devexpress.com/jslib/23.2.6/css/dx.light.css',
  [B + 'moment.min.js']: 'https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.18.1/moment.min.js',
  [B + 'daterangepicker.min.js']: 'https://cdn.jsdelivr.net/npm/daterangepicker@3.1.0/daterangepicker.min.js',
  [B + 'daterangepicker.css']: 'https://cdn.jsdelivr.net/npm/daterangepicker@3.1.0/daterangepicker.css',
  [B + 'timelines-chart.min.js']: 'https://cdn.jsdelivr.net/npm/timelines-chart@2.14.1/dist/timelines-chart.min.js',
  [B + 'd3.min.js']: 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
  [B + 'rxjs.umd.min.js']: 'https://cdn.jsdelivr.net/npm/rxjs@7.8.1/dist/bundles/rxjs.umd.min.js',
};
/** Replaces every server-hosted library path in a string (widget descriptor JSON) with its CDN copy. */
export const swapAssets = (s) => s.replace(/assets\/ithena\/devextreme-23\.2\.11\/[A-Za-z0-9._-]+/g, (p) => CDN_MAP[p] || p);

// Run directly: compare each server file (mirror-data/static) with the CDN copy.
if (process.argv[1] && process.argv[1].endsWith('cdn-map.mjs')) {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
  const norm = (b) => Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n').trim());
  for (const [p, url] of Object.entries(CDN_MAP)) {
    const local = readFileSync('mirror-data/static/' + p);
    const r = await fetch(url);
    const cdn = Buffer.from(await r.arrayBuffer());
    const same = h(norm(local)) === h(norm(cdn));
    console.log(`${same ? 'SAME' : 'DIFF'} ${r.status} ${p.split('/').pop()} server ${(local.length / 1024).toFixed(0)} KB, cdn ${(cdn.length / 1024).toFixed(0)} KB`);
  }
}
