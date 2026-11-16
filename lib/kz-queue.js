/* KzQueue — pending-write queue for when folder permission lapses, replayed on re-grant (S3).
   Contract: docs/specs/kanzen-tasks-contract-001.md (KzQueue). The store is injected:
   { get(key), put(key, value), del(key), keys() }, each sync or returning a promise. */
(function(root){
  'use strict';

  const PREFIX = 'kzq:';
  const keyFor = (seq) => PREFIX + String(seq).padStart(12, '0');
  const seqOf = (key) => Number(String(key).slice(PREFIX.length));

  function validOp(op){
    if(!op || typeof op !== 'object') return false;
    if(op.kind === 'board') return op.boardId != null && op.json != null;
    if(op.kind === 'habits') return op.json != null;
    if(op.kind === 'habitLine') return op.line != null;
    return false;
  }

  // Board ops coalesce (latest json per boardId wins, keeping the first op's position); one 'habits' op
  // coalesces the same way; habit lines are all kept in order. Keys carry a sequence number, so
  // the order survives a reload.
  function createQueue(store){
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

    async function entries(){
      const ks = (await store.keys()).filter(k => typeof k === 'string' && k.startsWith(PREFIX)).sort();
      const out = [];
      for(const k of ks){ const v = await store.get(k); if(v) out.push({ key: k, value: v }); }
      return out;
    }

    function enqueue(op){
      if(!validOp(op)) return Promise.reject(new Error('KzQueue: bad op'));
      return serial(async () => {
        const all = await entries();
        if(op.kind === 'board' || op.kind === 'habits'){
          const same = all.find(e => e.value.op.kind === op.kind && (op.kind === 'habits' || e.value.op.boardId === op.boardId));
          if(same){
            await store.put(same.key, { seq: same.value.seq, rev: (same.value.rev || 0) + 1, op });
            return same.value.seq;
          }
        }
        const seq = all.length ? Math.max(...all.map(e => seqOf(e.key))) + 1 : 1;
        await store.put(keyFor(seq), { seq, rev: 0, op });
        return seq;
      });
    }

    async function pending(){
      return serial(async () => (await entries()).map(e => e.value.op));
    }

    // Applies ops in order; each op is removed only after apply(op) resolves. Stops at the first failure,
    // keeping that op and every later one. → { applied, remaining, error }.
    async function drain(apply){
      const snapshot = await serial(entries);
      let applied = 0;
      for(const { key } of snapshot){
        for(let tries = 0; tries < 5; tries++){
          const cur = await serial(() => store.get(key));
          if(!cur) break;
          try{ await apply(cur.op); }
          catch(error){ return { applied, remaining: (await pending()).length, error }; }
          // A board op re-coalesced during apply has a newer rev: apply it again before deleting.
          const removed = await serial(async () => {
            const now = await store.get(key);
            if(now && now.rev === cur.rev){ await store.del(key); return true; }
            return !now;
          });
          if(removed){ applied++; break; }
        }
      }
      return { applied, remaining: (await pending()).length, error: null };
    }

    return { enqueue, pending, drain };
  }

  // Memory store for tests and for hosts without IndexedDB.
  function memoryStore(map){
    const m = map || new Map();
    return { get: (k) => m.get(k), put: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); }, del: (k) => { m.delete(k); }, keys: () => [...m.keys()], map: m };
  }

  // Adapts one IndexedDB object store. openDb() returns (a promise of) an IDBDatabase. A store with a
  // keyPath (KanZen's 'settings' uses keyPath 'key') holds { [keyPath]: key, value }; a store without
  // one holds the value under an out-of-line key.
  function idbStore(openDb, storeName){
    let dbp = null;
    const db = () => dbp || (dbp = Promise.resolve(openDb()));
    function run(mode, fn){
      return db().then(d => new Promise((resolve, reject) => {
        const tx = d.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error || req.error);
      }));
    }
    return {
      get: (k) => run('readonly', s => s.get(k)).then(row => (row && row.__kzqInline ? row.value : row)),
      put: (k, v) => run('readwrite', s => typeof s.keyPath === 'string' ? s.put({ [s.keyPath]: k, value: v, __kzqInline: true }) : s.put(v, k)).then(() => undefined),
      del: (k) => run('readwrite', s => s.delete(k)).then(() => undefined),
      keys: () => run('readonly', s => s.getAllKeys())
    };
  }

  root.KzQueue = { createQueue, memoryStore, idbStore, PREFIX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
