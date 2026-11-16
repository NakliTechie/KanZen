// Node tests for lib/kz-queue.js. Run: node scripts/test-tasks-queue.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'lib/kz-queue.js'), 'utf8'), { filename: 'kz-queue.js' });
const Q = globalThis.KzQueue;

let pass = 0, fail = 0;
async function check(name, fn){
  try{ await fn(); pass++; console.log(`ok   ${name}`); }
  catch(e){ fail++; console.log(`FAIL ${name}\n     ${e && e.message}`); }
}
const tag = (op) => op.kind === 'board' ? `board:${op.boardId}:${op.json}` : op.kind === 'habits' ? `habits:${op.json}` : `line:${op.line}`;
// An async store, to prove the queue awaits every call.
function asyncStore(map){
  const m = map || new Map();
  const tick = () => new Promise(r => setImmediate(r));
  return { map: m, get: async k => { await tick(); return m.get(k); }, put: async (k, v) => { await tick(); m.set(k, structuredClone(v)); },
    del: async k => { await tick(); m.delete(k); }, keys: async () => { await tick(); return [...m.keys()]; } };
}

await check('board ops coalesce: latest json wins, first position kept; habit lines all kept in order', async () => {
  const q = Q.createQueue(Q.memoryStore());
  await q.enqueue({ kind: 'board', boardId: 'b1', json: 'v1' });
  await q.enqueue({ kind: 'habitLine', line: 'L1' });
  await q.enqueue({ kind: 'board', boardId: 'b2', json: 'w1' });
  await q.enqueue({ kind: 'board', boardId: 'b1', json: 'v2' });
  await q.enqueue({ kind: 'habitLine', line: 'L2' });
  await q.enqueue({ kind: 'habits', json: 'h1' });
  await q.enqueue({ kind: 'habitLine', line: 'L1' });
  await q.enqueue({ kind: 'habits', json: 'h2' });
  assert.deepEqual((await q.pending()).map(tag), ['board:b1:v2', 'line:L1', 'board:b2:w1', 'line:L2', 'habits:h2', 'line:L1']);
});
await check('enqueue rejects a malformed op', async () => {
  const q = Q.createQueue(Q.memoryStore());
  await assert.rejects(q.enqueue({ kind: 'board', json: 'x' }));
  await assert.rejects(q.enqueue({ kind: 'nope' }));
  assert.equal((await q.pending()).length, 0);
});
await check('drain applies in order and empties the queue', async () => {
  const q = Q.createQueue(asyncStore());
  for(const l of ['a', 'b', 'c']) await q.enqueue({ kind: 'habitLine', line: l });
  await q.enqueue({ kind: 'board', boardId: 'b1', json: 'v1' });
  const seen = [];
  const res = await q.drain(async op => { seen.push(tag(op)); });
  assert.deepEqual(seen, ['line:a', 'line:b', 'line:c', 'board:b1:v1']);
  assert.deepEqual(res, { applied: 4, remaining: 0, error: null });
});
await check('failure mid-drain stops and keeps the failed op and later ones', async () => {
  const store = Q.memoryStore();
  const q = Q.createQueue(store);
  for(const l of ['a', 'b', 'c', 'd']) await q.enqueue({ kind: 'habitLine', line: l });
  const seen = [];
  const res = await q.drain(async op => { seen.push(op.line); if(op.line === 'b') throw new Error('permission lapsed'); });
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(res.applied, 1); assert.equal(res.remaining, 3); assert.equal(res.error.message, 'permission lapsed');
  assert.deepEqual((await q.pending()).map(o => o.line), ['b', 'c', 'd']);
  const res2 = await q.drain(async () => {});
  assert.deepEqual([res2.applied, res2.remaining], [3, 0]);
});
await check('reload: a new queue over the same store keeps order and sequence', async () => {
  const map = new Map();
  const q1 = Q.createQueue(asyncStore(map));
  await q1.enqueue({ kind: 'habitLine', line: 'a' });
  await q1.enqueue({ kind: 'board', boardId: 'b1', json: 'v1' });
  await q1.enqueue({ kind: 'habitLine', line: 'b' });
  await q1.drain(async op => { if(op.line === 'b') throw new Error('x'); });
  // q1 applied 'a' and 'b1'; 'b' remains. Reload:
  const q2 = Q.createQueue(asyncStore(map));
  await q2.enqueue({ kind: 'habitLine', line: 'c' });
  await q2.enqueue({ kind: 'board', boardId: 'b1', json: 'v2' });
  assert.deepEqual((await q2.pending()).map(tag), ['line:b', 'line:c', 'board:b1:v2']);
  const keys = [...map.keys()].sort();
  assert.ok(keys.every(k => k.startsWith('kzq:')));
  assert.ok(Number(keys[0].slice(4)) < Number(keys[1].slice(4)));
});
await check('a board write coalesced during its own apply is applied again, not lost', async () => {
  const q = Q.createQueue(Q.memoryStore());
  await q.enqueue({ kind: 'board', boardId: 'b1', json: 'v1' });
  await q.enqueue({ kind: 'habitLine', line: 'a' });
  const seen = [];
  let once = false;
  await q.drain(async op => {
    seen.push(tag(op));
    if(op.json === 'v1' && !once){ once = true; await q.enqueue({ kind: 'board', boardId: 'b1', json: 'v2' }); }
  });
  assert.deepEqual(seen, ['board:b1:v1', 'board:b1:v2', 'line:a']);
  assert.equal((await q.pending()).length, 0);
});
await check('the queue ignores other keys in a shared store', async () => {
  const store = Q.memoryStore(new Map([['habits', { x: 1 }], ['lastBoard', 'b1']]));
  const q = Q.createQueue(store);
  await q.enqueue({ kind: 'habitLine', line: 'a' });
  assert.deepEqual((await q.pending()).map(o => o.line), ['a']);
  await q.drain(async () => {});
  assert.deepEqual([...store.map.keys()].sort(), ['habits', 'lastBoard']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
