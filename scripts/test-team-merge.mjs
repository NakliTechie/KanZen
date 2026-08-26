import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

function extractFunction(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`Missing ${name}`);
  const brace=html.indexOf('{',start);
  let depth=0;
  let quote='';
  let escaped=false;
  for(let index=brace;index<html.length;index++){
    const char=html[index];
    if(quote){
      if(escaped) escaped=false;
      else if(char==='\\') escaped=true;
      else if(char===quote) quote='';
      continue;
    }
    if(char==='"'||char==="'"||char==='`'){ quote=char; continue; }
    if(char==='{') depth++;
    else if(char==='}'&&--depth===0) return html.slice(start,index+1);
  }
  throw new Error(`Unterminated ${name}`);
}

const names=[
  'isPlainRecord','isSafeId','tsMs','sortedKeysReplacer','stableJson','cardContentSignature',
  'boardMetaSignature','setBoardRuntime','ensureBoardBaselines','activityKey',
  'ensureFlushedActivityIds','mergeNonOverlappingTeamUpdate',
];
const context=vm.createContext({JSON,Object,Array,Set,Map,Date});
vm.runInContext(`
  const SAFE_ID_RE=/^[A-Za-z0-9_-]{1,80}$/;
  const RESERVED_OBJECT_KEYS=new Set(['__proto__','prototype','constructor']);
  const BOARD_RUNTIME_KEYS=new Set(['_dirtyCards','_deletedCards','_activityFlushed','_flushedActivityIds','_loadedCardSignatures','_loadedBoardMetaSignature']);
  ${names.map(extractFunction).join('\n')}
  globalThis.api={isSafeId,stableJson,setBoardRuntime,ensureBoardBaselines,activityKey,ensureFlushedActivityIds,mergeNonOverlappingTeamUpdate};
`,context);
const {isSafeId,stableJson,setBoardRuntime,ensureBoardBaselines,activityKey,ensureFlushedActivityIds,mergeNonOverlappingTeamUpdate}=context.api;

assert.equal(isSafeId('__proto__'),false,'reserved object keys cannot become board or card IDs');

const card=(id,title)=>({
  id,title,description:'',labelIds:[],memberIds:[],priority:'none',dueDate:null,
  checklist:[],attachments:[],comments:[],updatedAt:'2026-08-01T00:00:00.000Z',
});
const makeBoard=()=>({
  _meta:{boardId:'board-1',teamMode:true,filename:'board-1'},
  id:'board-1',name:'Team board',members:[],labels:[],
  columns:[{id:'todo',name:'To do',cardIds:['card-a','card-b'],wipLimit:0,collapsed:false}],
  cards:{'card-a':card('card-a','A'),'card-b':card('card-b','B')},
  activity:[],
});
const clone=value=>JSON.parse(stableJson(value));

const local=makeBoard();
ensureBoardBaselines(local);
local.cards['card-a'].title='A · local';
local.activity.unshift({id:'local-event',timestamp:'2026-08-01T02:00:00.000Z'});
setBoardRuntime(local,'_dirtyCards',new Set(['card-a']));
setBoardRuntime(local,'_deletedCards',new Set());
local._activityFlushed=0;

const remote=makeBoard();
remote.cards['card-b'].title='B · remote';
remote.activity.unshift({id:'remote-event',timestamp:'2026-08-01T01:00:00.000Z'});
ensureBoardBaselines(remote);
remote._activityFlushed=remote.activity.length;
ensureFlushedActivityIds(remote);

const merged=mergeNonOverlappingTeamUpdate(local,remote);
assert.ok(merged,'different-card edits merge');
assert.equal(merged.cards['card-a'].title,'A · local');
assert.equal(merged.cards['card-b'].title,'B · remote');
assert.deepEqual([...merged._dirtyCards],['card-a']);
assert.equal(JSON.stringify(Array.from(merged.activity,entry=>entry.id)),JSON.stringify(['local-event','remote-event']));

const localConflict=makeBoard();
ensureBoardBaselines(localConflict);
localConflict.cards['card-a'].title='A · local';
setBoardRuntime(localConflict,'_dirtyCards',new Set(['card-a']));
setBoardRuntime(localConflict,'_deletedCards',new Set());
const remoteConflict=makeBoard();
remoteConflict.cards['card-a'].title='A · remote';
ensureBoardBaselines(remoteConflict);
assert.equal(mergeNonOverlappingTeamUpdate(localConflict,remoteConflict),null,'same-card edits require a choice');

const localMeta=makeBoard();
ensureBoardBaselines(localMeta);
localMeta.columns[0].name='Local column';
const remoteMeta=makeBoard();
ensureBoardBaselines(remoteMeta);
remoteMeta.columns[0].name='Remote column';
assert.equal(mergeNonOverlappingTeamUpdate(localMeta,remoteMeta),null,'overlapping board metadata requires a choice');

const localCreate=makeBoard();
ensureBoardBaselines(localCreate);
localCreate.cards['card-c']=card('card-c','C · local');
localCreate.columns[0].cardIds.push('card-c');
setBoardRuntime(localCreate,'_dirtyCards',new Set(['card-c']));
setBoardRuntime(localCreate,'_deletedCards',new Set());
const remoteUnchanged=makeBoard();
ensureBoardBaselines(remoteUnchanged);
const mergedCreate=mergeNonOverlappingTeamUpdate(localCreate,remoteUnchanged);
assert.ok(mergedCreate,'a local card creation merges with unchanged remote metadata');
assert.equal(mergedCreate.cards['card-c'].title,'C · local');
assert.ok(mergedCreate.columns[0].cardIds.includes('card-c'));

const capped=makeBoard();
capped.activity=Array.from({length:500},(_,index)=>({id:`old-${index}`,timestamp:'2026-08-01T00:00:00.000Z'}));
capped._activityFlushed=capped.activity.length;
const cappedFlushed=ensureFlushedActivityIds(capped);
capped.activity.unshift({id:'new-after-cap',timestamp:'2026-08-01T03:00:00.000Z'});
capped.activity.length=500;
assert.deepEqual(
  capped.activity.filter(entry=>!cappedFlushed.has(activityKey(entry))).map(entry=>entry.id),
  ['new-after-cap'],
  'a new activity remains pending after the 500-entry cap rolls over',
);

console.log('KanZen team-mode merge behavior: ok');
