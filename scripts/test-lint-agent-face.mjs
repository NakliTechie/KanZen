// The parity lint must fail on each kind of leak it exists to catch. Each case plants one fault in
// a copy of index.html and expects the lint to exit 1 naming it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lint = new URL('./lint-agent-face.mjs', import.meta.url).pathname;
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'kanzen-lint-'));
const run = file => spawnSync(process.execPath, [lint, file], { encoding: 'utf8' });

const clean = run(new URL('../index.html', import.meta.url).pathname);
assert.equal(clean.status, 0, clean.stderr);

const cases = [
  ['a handler that writes state directly',
    s => s.replace('onclick="clearFilters()"', `onclick="S.filter.search=''; renderBoard()"`),
    /inline onclick handler writes S\.filter/],
  ['a save outside a command',
    s => s.replace('function clearActivityFilters(){', 'function sneaky(b){ b.name = "x"; scheduleSave(); }\nfunction clearActivityFilters(){'),
    /sneaky calls scheduleSave\(\) outside a command/],
  ['a dispatch of a command the manifest lacks',
    s => s.replace(`kzUi('set_theme', { theme: t })`, `kzUi('set_colour', { theme: t })`),
    /dispatches unknown command "set_colour"/],
  ['a command missing from the manifest',
    s => s.replace('function cmdClearFilters(){', 'function cmdOrphan(){ return {}; }\nfunction cmdClearFilters(){'),
    /cmdOrphan is a command outside the manifest/],
  ['a person-only act without a reason',
    s => s.replace(`reason:'These are credentials.' },`, '},'),
    /configure_sync: a person-only act must say why/],
  ['a handler that calls an unclassified mutator',
    s => s.replace(`onclick="toggleTheme()"`, `onclick="flushAllBoards()"`),
    /handler calls flushAllBoards, which is neither a dispatcher, UI-only, nor person-only/],
];
try{
  for(const [name, plant, expected] of cases){
    const broken = plant(html);
    assert.notEqual(broken, html, `the fault for "${name}" was planted`);
    const file = join(dir, 'index.html');
    writeFileSync(file, broken);
    const result = run(file);
    assert.equal(result.status, 1, `lint must fail on ${name}`);
    assert.match(result.stderr, expected, `lint names ${name}`);
  }
}finally{
  rmSync(dir, { recursive: true, force: true });
}
console.log(`agent-face lint self-test: clean file passes; ${cases.length} planted faults all caught`);
