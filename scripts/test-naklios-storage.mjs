import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

assert.equal(scripts.length,1,'KanZen remains a single-file app with one script');
new vm.Script(scripts[0][1],{filename:'index.html'});
assert.match(html,/function installNakliOSSdk\(/,'NakliOS SDK is vendored inline');
assert.match(html,/useBackend:backend=>rpc\('naklios:fs:selectBackend'/,'SDK exposes explicit backend selection');
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
assert.match(html,/debouncedSave\.cancel\(\)/,
  'host-side rebind cancels a delayed old-library save');
assert.match(html,/Object\.assign\(\{backend:capabilities\.fsBackend\},data\)/,
  'filesystem operations carry backend affinity for host-side race rejection');

console.log('KanZen NakliOS storage contracts: ok');
