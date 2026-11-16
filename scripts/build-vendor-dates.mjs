#!/usr/bin/env node
// build-vendor-dates.mjs — build lib/vendor/kz-vendor-dates.js, the date libraries KanZen's tasks use.
//   cd scripts && npm install && node build-vendor-dates.mjs
// Output: one minified IIFE that sets globalThis.KzVendor = { chrono, RRuleTemporal } and installs
// globalThis.Temporal (temporal-polyfill) only when the runtime has none. chrono-node is the English
// build only. The leading comment carries each package's pinned version and licence text.
// Re-running with the same node_modules gives byte-identical output.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const nm = join(here, 'node_modules');
const out = join(root, 'lib/vendor/kz-vendor-dates.js');

const PACKAGES = [
  ['chrono-node', '2.10.3', 'LICENSE.txt'],
  ['rrule-temporal', '2.2.8', 'LICENSE'],
  ['temporal-polyfill', '1.0.6', 'LICENSE'], // licence only: its code reaches the bundle embedded in rrule-temporal
];

for (const [name, want] of PACKAGES) {
  const got = JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8')).version;
  if (got !== want) { console.error(`${name}: installed ${got}, pinned ${want}. Run npm install in scripts/.`); process.exit(1); }
}

// rrule-temporal's dist already embeds the temporal-polyfill code and reads `globalThis.Temporal ?? <embedded>`.
// Bundling temporal-polyfill again doubled the file, so the build patches that one expression to
// `globalThis.Temporal ??= <embedded>`: the embedded copy fills a missing Temporal and an existing one is left
// alone, and kz-tasks.js and rrule-temporal share one implementation. The build fails if the pattern is not
// found exactly once (a new rrule-temporal release must be checked by hand).
const VIRTUAL = {
  'kz:entry': `
import * as chrono from 'chrono-node/en';
import { RRuleTemporal } from 'rrule-temporal';
globalThis.KzVendor = { chrono, RRuleTemporal };`,
};
const shareTemporal = {
  name: 'kz-share-temporal',
  setup(b) {
    b.onLoad({ filter: /rrule-temporal[\\/]dist[\\/]src-[^\\/]+\.js$/ }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      const hits = src.match(/globalThis\.Temporal\?\?([A-Za-z_$][\w$]*)/g) || [];
      if (hits.length !== 1) throw new Error(`rrule-temporal: expected one "globalThis.Temporal??x", found ${hits.length}`);
      return { contents: src.replace(/globalThis\.Temporal\?\?([A-Za-z_$][\w$]*)/, '(globalThis.Temporal??=$1)'), loader: 'js' };
    });
  },
};
const virtual = {
  name: 'kz-virtual',
  setup(b) {
    b.onResolve({ filter: /^kz:/ }, (a) => ({ path: a.path, namespace: 'kz' }));
    b.onLoad({ filter: /.*/, namespace: 'kz' }, (a) => ({ contents: VIRTUAL[a.path], resolveDir: here, loader: 'js' }));
  },
};

const result = await build({
  entryPoints: ['kz:entry'],
  plugins: [virtual, shareTemporal],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});

const banner = ['/*! kz-vendor-dates.js: built by scripts/build-vendor-dates.mjs (esbuild 0.28.2). Do not edit.',
  ' * Exposes globalThis.KzVendor = { chrono, RRuleTemporal }; installs globalThis.Temporal (temporal-polyfill code embedded in rrule-temporal) only when missing.',
  ' * Bundled packages and their licences follow.'];
for (const [name, version, licFile] of PACKAGES) {
  const lic = readFileSync(join(nm, name, licFile), 'utf8').replace(/\*\//g, '* /').trim();
  banner.push(' *', ` * ${name} ${version} (MIT)`, ' *');
  for (const line of lic.split(/\r?\n/)) banner.push((' * ' + line).trimEnd());
}
banner.push(' */');

const code = result.outputFiles[0].text.trimEnd();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner.join('\n') + '\n' + code + '\n');
console.log(`wrote ${out} (${Buffer.byteLength(code)} bytes of code)`);
