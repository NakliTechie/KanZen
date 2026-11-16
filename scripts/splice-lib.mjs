#!/usr/bin/env node
// splice-lib.mjs — copy the tested lib/ modules into index.html, which stays one file with no build step.
//   node scripts/splice-lib.mjs          write each lib/ file between its markers
//   node scripts/splice-lib.mjs --check  exit 1 when index.html differs from lib/
// Markers sit inside the <script id="kz-lib"> block: /* kz-lib:<name>:begin */ … /* kz-lib:<name>:end */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const MODULES = [
  ['vendor-dates', 'lib/vendor/kz-vendor-dates.js'],
  ['tasks', 'lib/kz-tasks.js'],
  ['habits', 'lib/kz-habits.js'],
  ['reminders', 'lib/kz-reminders.js'],
  ['interop', 'lib/kz-interop.js'],
  ['queue', 'lib/kz-queue.js'],
];
const check = process.argv.includes('--check');
const file = join(root, 'index.html');
let html = readFileSync(file, 'utf8');
let drift = 0;
for (const [name, rel] of MODULES) {
  const begin = `/* kz-lib:${name}:begin */`;
  const end = `/* kz-lib:${name}:end */`;
  const a = html.indexOf(begin);
  const b = html.indexOf(end);
  if (a < 0 || b < a) { console.error(`markers for ${name} missing in index.html`); process.exit(1); }
  const path = join(root, rel);
  if (!existsSync(path)) { console.error(`${rel} missing`); drift++; continue; }
  // A literal </script> inside a module would end the inline block early.
  const src = readFileSync(path, 'utf8').replace(/<\/script/gi, '<\\/script').trimEnd();
  const next = `${begin}\n${src}\n${end}`;
  const current = html.slice(a, b + end.length);
  if (current !== next) {
    drift++;
    if (!check) html = html.slice(0, a) + next + html.slice(b + end.length);
    console.log(`${check ? 'drift' : 'spliced'}  ${name}  (${Buffer.byteLength(src)} bytes)`);
  }
}
if (check) { if (drift) process.exit(1); console.log('lib/ and index.html agree'); }
else { writeFileSync(file, html); console.log(drift ? 'index.html updated' : 'no change'); }
