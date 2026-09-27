// Bundles all widget entry points into one IIFE (global IMEX_DBB) and writes per-widget controller glue.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { settingsSchemas, names, sizes } from './widget-types.mjs';

mkdirSync('widgets/dist', { recursive: true });
const version = new Date().toISOString();
await build({
  entryPoints: ['widgets/src/entries/all.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'IMEX_DBB',
  target: 'es2019',
  minify: true,
  legalComments: 'none',
  define: {},
  outfile: 'widgets/dist/imex-dbb.js',
});
let lib = readFileSync('widgets/dist/imex-dbb.js', 'utf8').replace('__VERSION__', version);
writeFileSync('widgets/dist/imex-dbb.js', lib);

// Controller glue per widget type. The library is embedded in each widget type's controllerScript
// (ThingsBoard evaluates it per widget instance; the IIFE is cheap to re-evaluate).
const glue = (name, extra = '') => `
self.onInit = function () { IMEX_DBB.${name}.init(self.ctx); };
self.onDataUpdated = function () {};
self.onResize = function () {};
${extra}self.onDestroy = function () { if (IMEX_DBB.${name}.destroy) IMEX_DBB.${name}.destroy(self.ctx); };
self.typeParameters = function () { return { dataKeysOptional: true, datasourcesOptional: true, maxDatasources: 0, hasDataPageLink: false, previewWidth: '420px', previewHeight: '320px' }; };
`;
const out = {
  launcher: glue('launcher', 'self.onStateChanged = function () { IMEX_DBB.launcher.onStateChanged(self.ctx); };\n'),
  renderer: glue('renderer', 'self.onStateChanged = function () { IMEX_DBB.renderer.onStateChanged(self.ctx); };\n'),
  listing: glue('listing', 'self.onStateChanged = function () { IMEX_DBB.listing.onStateChanged(self.ctx); };\n'),
};
writeFileSync('widgets/dist/glue.json', JSON.stringify(out, null, 2));
const gz = gzipSync(Buffer.from(lib, 'utf8'), { level: 9 });
writeFileSync('widgets/dist/imex-dbb.js.gz.b64', gz.toString('base64'));
console.log(`lib ${(lib.length / 1024).toFixed(1)} KB, gzip+b64 ${(gz.toString('base64').length / 1024).toFixed(1)} KB, version ${version}`);

// One importable widget type per widget (ThingsBoard: Widgets library > Widgets > + > Import widget).
mkdirSync('widgets/dist/widget-types', { recursive: true });
for (const k of Object.keys(out)) {
  const type = {
    fqn: `imex_dbb_${k}`,
    name: names[k],
    deprecated: false,
    scada: false,
    description: `iMEX Self-Service POC widget [poc=true] built ${version}`,
    descriptor: {
      type: 'static',
      sizeX: sizes[k][0],
      sizeY: sizes[k][1],
      resources: [],
      templateHtml: '',
      templateCss: '',
      controllerScript: lib + '\n' + out[k],
      settingsSchema: JSON.stringify(settingsSchemas[k]),
      dataKeySettingsSchema: '{}',
      defaultConfig: JSON.stringify({ datasources: [], showTitle: false, backgroundColor: 'rgba(0,0,0,0)', color: 'rgba(0,0,0,0.87)', padding: '0px', settings: {}, title: names[k], dropShadow: false, enableFullscreen: false }),
    },
  };
  writeFileSync(`widgets/dist/widget-types/imex_dbb_${k}.json`, JSON.stringify(type, null, 2));
}
console.log('widget types: ' + Object.keys(out).map((k) => `widgets/dist/widget-types/imex_dbb_${k}.json`).join(', '));
