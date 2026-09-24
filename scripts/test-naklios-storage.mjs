import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const worker=fs.readFileSync(path.join(root,'worker','src','index.js'),'utf8');
const workerConfig=JSON.parse(fs.readFileSync(path.join(root,'worker','wrangler.jsonc'),'utf8'));
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

assert.equal(scripts.length,1,'KanZen remains a single-file app with one script');
new vm.Script(scripts[0][1],{filename:'index.html'});
assert.match(html,/\/\* naklios-sdk:begin ver=\d+ sha256=[0-9a-f]{64}/,'the canonical NakliOS SDK is vendored inline through the marker splice');
assert.match(html,/useBackend: function \(backend\)\s*\{ return rpc\('naklios:fs:selectBackend'/,'SDK exposes explicit backend selection');
assert.match(html,/subscribe: async function \(path, cb\)/,'SDK exposes hosted filesystem subscriptions');
assert.match(html,/autosave: function \(opts\)/,'the vendored SDK carries the autosave primitive');
assert.match(html,/refreshNakliOSLibraryFromStorage/,'hosted storage events reload the selected library');
assert.match(html,/const StorageNakliOS = \{/,'hosted Folder and Crate share a path adapter');
assert.match(html,/if\(S\.storageMode==='naklios'\) return StorageNakliOS\.saveBoard\(b\)/,
  'hosted saves do not mirror into IndexedDB');
assert.match(html,/Each location has its own board library\./,'storage UI explains location isolation');
assert.match(html,/Nothing was copied or deleted\./,'backend switching confirms non-migration');
assert.match(html,/await activateLibrary\('naklios',StorageNakliOS\)/,
  'switching reloads the selected hosted library');
assert.match(html,/await activateLibrary\('idb',StorageIDB\)/,
  'browser storage remains explicitly selectable');
assert.match(html,/if\(!naklios\.capabilities\.hosted\) await tryReuseStoredHandle\(\)/,
  'direct durable handles remain a standalone path');
assert.match(html,/S\.storageMode === 'fs' \|\| S\.storageMode === 'naklios'/,
  'team-mode file layout works through both direct and hosted adapters');
assert.match(html,/S\.storageMode !== 'fs' && S\.storageMode !== 'naklios'/,
  'team-mode toggle accepts hosted Folder and Crate');
assert.match(html,/save: async \(\) => \{ if\(S\.dirty && !\(await flushSave\(\)\)\)/,
  'host-side rebind cancels a delayed old-library save');
assert.match(html,/Object\.assign\(\{ backend: capabilities\.fsBackend \}, data \|\| \{\}\)/,
  'filesystem operations carry backend affinity for host-side race rejection');
assert.match(html,/async function teamDirectorySignature/,
  'standalone polling fingerprints team-mode card directories');
assert.match(html,/validateBoardPayload\(b\)/,
  'JSON imports validate board structure before persistence');
assert.doesNotMatch(html,/(?:onclick|onchange)="[^"]*\$\{/,
  'untrusted identifiers are not interpolated into inline event handlers');
assert.match(worker,/class KanZenWorkspace extends DurableObject/,
  'sync storage is coordinated by a Durable Object');
assert.match(worker,/expectedRevision !== actualRevision/,
  'sync writes reject stale revisions');
assert.match(worker,/If-Match revision is required/,
  'sync mutations require an explicit base revision');
assert.match(worker,/decodeURIComponent\(rawMeta\)/,
  'sync metadata is transported as an ASCII-safe encoded header');
assert.match(worker,/'Cache-Control': 'no-store'/,
  'sync responses are not cacheable');
assert.equal(workerConfig.durable_objects.bindings[0].name,'KANZEN_WORKSPACE');
assert.equal(workerConfig.exports.KanZenWorkspace.storage,'sqlite');
assert.deepEqual(workerConfig.secrets.required,['SYNC_TOKEN']);

// DUR (2026-09-24): the SDK owns save timing. beforeunload cannot await, so app code (outside the
// vendored SDK block) must not try to save there, and both saves ride the SDK's autosave.
const appCode=html.replace(/\/\* naklios-sdk:begin[\s\S]*?naklios-sdk:end \*\//,'');
assert.notEqual(appCode,html,'the vendored SDK block was found and stripped');
assert.doesNotMatch(appCode,/addEventListener\(\s*['"]beforeunload['"]|onbeforeunload/,'no app-level beforeunload handler (a save there cannot complete)');
assert.match(appCode,/function markDirty\(\)\{[\s\S]*?boardSaver\(\)\.markDirty\(\);/,'every edit reaches the board autosave');
assert.match(appCode,/if\(S\._dirtyGen === gen\)\{ S\.dirty = false;/,'an edit made during a save keeps the board dirty');
assert.match(appCode,/syncSaver\(\)\.markDirty\(\)/,'sync pushes ride the SDK timing');
assert.match(appCode,/delay: SYNC_PUSH_DEBOUNCE_MS,\s*guard: false,/,'a sync push never holds a close');
assert.doesNotMatch(appCode,/setInterval\(\(\) => \{ if\(S\.dirty\) flushSave\(\); \}/,'no hand-rolled periodic save tick');
assert.match(appCode,/keepalive: document\.visibilityState==='hidden' && payloadBytes<=SYNC_KEEPALIVE_MAX_BYTES,/,'a push started as the page hides outlives it, within the keepalive body cap');

console.log('KanZen storage, import-safety, and sync contracts: ok');
