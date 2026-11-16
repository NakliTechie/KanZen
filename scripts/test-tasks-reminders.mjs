// Node tests for lib/kz-reminders.js. Run: node scripts/test-tasks-reminders.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'lib/kz-reminders.js'), 'utf8'), { filename: 'kz-reminders.js' });
const R = globalThis.KzReminders;

let pass = 0, fail = 0;
async function check(name, fn){
  try{ await fn(); pass++; console.log(`ok   ${name}`); }
  catch(e){ fail++; console.log(`FAIL ${name}\n     ${e && e.message}`); }
}
const NY = 'America/New_York', IST = 'Asia/Kolkata';
const MIN = 60000;

// ---------- time-zone conversion ----------
await check('DST gap: 2026-03-08 02:30 New York moves forward to 03:30 EDT', () => {
  const ms = R.localToMs('2026-03-08T02:30', NY);
  assert.equal(ms, Date.UTC(2026, 2, 8, 7, 30));
  assert.equal(R.msToLocal(ms, NY), '2026-03-08T03:30');
});
await check('DST: 2026-03-08 01:30 is EST, 03:00 is EDT', () => {
  assert.equal(R.localToMs('2026-03-08T01:30', NY), Date.UTC(2026, 2, 8, 6, 30));
  assert.equal(R.localToMs('2026-03-08T03:00', NY), Date.UTC(2026, 2, 8, 7, 0));
});
await check('DST overlap: 2026-11-01 01:30 New York takes the first (EDT) instant', () => {
  assert.equal(R.localToMs('2026-11-01T01:30', NY), Date.UTC(2026, 10, 1, 5, 30));
});
await check('DST: 2026-11-01 00:30 is EDT and 02:00 is EST', () => {
  assert.equal(R.localToMs('2026-11-01T00:30', NY), Date.UTC(2026, 10, 1, 4, 30));
  assert.equal(R.localToMs('2026-11-01T02:00', NY), Date.UTC(2026, 10, 1, 7, 0));
});
await check('IST conversion and round trip', () => {
  const ms = R.localToMs('2026-11-16T09:00', IST);
  assert.equal(ms, Date.UTC(2026, 10, 16, 3, 30));
  assert.equal(R.msToLocal(ms, IST), '2026-11-16T09:00');
});

// ---------- instances ----------
const NOW = R.localToMs('2026-11-16T08:00', IST);
const TODAY = '2026-11-16';
function board(){
  return {
    id: 'b1', name: 'Home',
    columns: [{ id: 'c1', name: 'To do', cardIds: ['k1', 'k2', 'k3', 'k5'] }, { id: 'c2', name: 'Done', cardIds: ['k4'] }],
    cards: {
      k1: { id: 'k1', title: 'Timed due', dueDate: '2026-11-16', dueTime: '10:00', reminders: [{ id: 'r1', offsetMin: 30 }, { id: 'r2', at: '2026-11-16T07:58' }] },
      k2: { id: 'k2', title: 'Date-only due', dueDate: '2026-11-17', reminders: [{ id: 'r1', offsetMin: 60 }] },
      k3: { id: 'k3', title: 'Completed', completedAt: '2026-11-15T10:00:00Z', reminders: [{ id: 'r1', at: '2026-11-16T09:00' }] },
      k4: { id: 'k4', title: 'In done column', reminders: [{ id: 'r1', at: '2026-11-16T09:00' }] },
      k5: { id: 'k5', title: 'Old', reminders: [{ id: 'r1', at: '2026-11-01T09:00' }] }
    }
  };
}
const habitsDoc = { version: 1, habits: [
  { id: 'h1', name: 'Read', schedule: { type: 'daily' }, dayEndHour: 0, reminders: [{ id: 'hr1', at: '20:00' }], paused: null, archived: false },
  { id: 'h2', name: 'Late', schedule: { type: 'daily' }, dayEndHour: 3, reminders: [{ id: 'hr1', at: '01:00' }], paused: null, archived: false },
  { id: 'h3', name: 'Weekdays', schedule: { type: 'weekdays', days: [1] }, dayEndHour: 0, reminders: [{ id: 'hr1', at: '07:00' }], paused: null, archived: false },
  { id: 'h4', name: 'Archived', schedule: { type: 'daily' }, reminders: [{ id: 'x', at: '07:00' }], archived: true }
] };
const doneDays = new Set(['h1|2026-11-16']);
const list = R.instances([board()], habitsDoc, null, { now: NOW, today: TODAY, tz: IST, horizonDays: 2,
  isHabitDone: (id, day) => doneDays.has(`${id}|${day}`) });
const byKey = new Map(list.map(i => [i.key, i]));

await check('offset reminder uses due date plus dueTime', () => {
  const i = byKey.get('card:b1:k1:r1:2026-11-16T09:30');
  assert.ok(i, 'missing instance');
  assert.equal(i.fireAt, R.localToMs('2026-11-16T09:30', IST));
});
await check('offset reminder without dueTime uses 09:00 (F2)', () => {
  assert.ok(byKey.get('card:b1:k2:r1:2026-11-17T08:00'));
});
await check('absolute reminder instance and key format', () => {
  const i = byKey.get('card:b1:k1:r2:2026-11-16T07:58');
  assert.equal(i.kind, 'card'); assert.equal(i.title, 'Timed due'); assert.equal(i.fireAtLocal, '2026-11-16T07:58');
});
await check('done cards (completedAt or Done column) get no instances', () => {
  assert.ok(!list.some(i => i.cardId === 'k3' || i.cardId === 'k4'));
});
await check('reminders older than 7 days are dropped', () => {
  assert.ok(!list.some(i => i.cardId === 'k5'));
});
await check('habit reminder skips a done day and keeps the others', () => {
  assert.ok(!byKey.has('habit:h1:hr1:2026-11-16'));
  assert.ok(byKey.has('habit:h1:hr1:2026-11-17'));
  assert.ok(byKey.has('habit:h1:hr1:2026-11-10'));
});
await check('habit reminder before dayEndHour falls on the next calendar date', () => {
  const i = byKey.get('habit:h2:hr1:2026-11-16');
  assert.equal(i.fireAtLocal, '2026-11-17T01:00');
});
await check('weekday schedule: Monday-only habit fires only on Mondays', () => {
  const days = list.filter(i => i.habitId === 'h3').map(i => i.day);
  // 2026-11-09 07:00 is more than 7 days before now, so only Monday 16 is in the window.
  assert.deepEqual(days, ['2026-11-16']);
  const wide = R.instances([], habitsDoc, null, { now: NOW, today: TODAY, tz: IST, horizonDays: 10 }).filter(i => i.habitId === 'h3').map(i => i.day);
  assert.deepEqual(wide, ['2026-11-16', '2026-11-23']);
});
await check('archived habit has no instances; list sorted by fireAt', () => {
  assert.ok(!list.some(i => i.habitId === 'h4'));
  for(let k = 1; k < list.length; k++) assert.ok(list[k - 1].fireAt <= list[k].fireAt);
});
await check('default isHabitDone reads the folded log', () => {
  const folded = new Map([['h1', new Map([['2026-11-17', { value: 1, op: 'set', at: 1 }]])]]);
  const l2 = R.instances([], habitsDoc, folded, { now: NOW, today: TODAY, tz: IST, horizonDays: 2 });
  assert.ok(!l2.some(i => i.key === 'habit:h1:hr1:2026-11-17'));
  assert.ok(l2.some(i => i.key === 'habit:h1:hr1:2026-11-16'));
});

// ---------- split ----------
await check('split: fireNow within grace, missed older, later in future, fired skipped', () => {
  const fired = new Set(['habit:h1:hr1:2026-11-15']);
  const s = R.split(list, k => fired.has(k), { now: NOW, graceMs: 5 * MIN });
  assert.deepEqual(s.fireNow.map(i => i.key), ['card:b1:k1:r2:2026-11-16T07:58']);
  assert.ok(s.missed.some(i => i.key === 'habit:h1:hr1:2026-11-14'));
  assert.ok(!s.missed.some(i => i.key === 'habit:h1:hr1:2026-11-15'));
  assert.ok(s.later.every(i => i.fireAt > NOW));
  assert.equal(s.later[0].key, 'card:b1:k1:r1:2026-11-16T09:30');
});

// ---------- snooze ----------
await check('snooze adds a one-shot reminder; consumeSnooze removes it', () => {
  const c = { id: 'k', reminders: [{ id: 'r1', offsetMin: 10 }] };
  const r = R.snooze(c, '2026-11-16T10:00');
  assert.deepEqual(r, { id: 'snooze-202611161000', at: '2026-11-16T10:00', snooze: true });
  const r2 = R.snooze(c, '2026-11-16T10:00');
  assert.equal(r2.id, 'snooze-202611161000-2');
  assert.equal(R.consumeSnooze(c, r.id), true);
  assert.equal(R.consumeSnooze(c, 'r1'), false);
  assert.equal(c.reminders.length, 2);
});
await check('snoozeTargets: 10 min, 1 hour, tomorrow 09:00', () => {
  const t = R.snoozeTargets(R.localToMs('2026-11-16T23:30', IST), IST);
  assert.deepEqual(t.map(x => x.at), ['2026-11-16T23:40', '2026-11-17T00:30', '2026-11-17T09:00']);
});
await check('pruneLog keeps the last 30 days', () => {
  const now = Date.UTC(2026, 10, 16);
  const log = { a: new Date(now - 31 * 86400000).toISOString(), b: new Date(now - 2 * 86400000).toISOString(), c: 'bad' };
  assert.deepEqual(Object.keys(R.pruneLog(log, now, 30)), ['b']);
});

// ---------- two-window replay ----------
function fakeEnv(start){
  const env = { clock: start, timers: [], nextId: 1 };
  env.now = () => env.clock;
  env.setTimer = (fn, delay) => { const id = env.nextId++; env.timers.push({ id, at: env.clock + delay, fn, delay }); return id; };
  env.clearTimer = (id) => { env.timers = env.timers.filter(t => t.id !== id); };
  env.advanceTo = async (target) => {
    for(;;){
      env.timers.sort((a, b) => a.at - b.at);
      const t = env.timers[0];
      if(!t || t.at > target) break;
      env.timers.shift();
      env.clock = t.at;
      await t.fn();
    }
    env.clock = target;
  };
  return env;
}
function fakeLocks(){
  const held = new Map(), waiting = new Map();
  const grant = (name, cb) => {
    held.set(name, true);
    Promise.resolve(cb({ name })).then(() => {
      held.delete(name);
      const q = waiting.get(name) || [];
      const next = q.shift();
      if(next) grant(name, next);
    });
  };
  return {
    request(name, opts, cb){
      if(typeof opts === 'function'){ cb = opts; opts = {}; }
      if(held.get(name)){
        if(opts.ifAvailable) return Promise.resolve(cb(null));
        if(!waiting.has(name)) waiting.set(name, []);
        waiting.get(name).push(cb);
        return;
      }
      grant(name, cb);
    }
  };
}
const flush = () => new Promise(r => setImmediate(r));

await check('two windows, one fired log: leader dies, other takes over, each reminder delivered once', async () => {
  const t0 = R.localToMs('2026-11-16T09:00', IST);
  const env = fakeEnv(t0);
  const b = {
    id: 'b1', name: 'Home', columns: [{ id: 'c', name: 'To do', cardIds: ['a', 'b', 'c', 'm'] }],
    cards: {
      a: { id: 'a', title: 'A', reminders: [{ id: 'r', at: '2026-11-16T09:01' }] },
      b: { id: 'b', title: 'B', reminders: [{ id: 'r', at: '2026-11-16T09:03' }] },
      c: { id: 'c', title: 'C', reminders: [{ id: 'r', at: '2026-11-16T09:10' }] },
      m: { id: 'm', title: 'Missed', reminders: [{ id: 'r', at: '2026-11-16T08:00' }] }
    }
  };
  const reminderLog = {};
  const locks = fakeLocks();
  const delivered = [], missedSeen = [], delays = [];
  function win(name){
    return R.createScheduler({
      getInstances: (now) => R.instances([b], null, null, { now, tz: IST, horizonDays: 1 }),
      isFired: (k) => k in reminderLog,
      markFired: (k) => { reminderLog[k] = new Date(env.now()).toISOString(); },
      deliver: (inst) => { delivered.push({ win: name, key: inst.key }); },
      onMissed: (l) => { missedSeen.push({ win: name, keys: l.map(i => i.key) }); },
      now: env.now,
      setTimer: (fn, d) => { delays.push(d); return env.setTimer(fn, d); },
      clearTimer: env.clearTimer,
      locks
    });
  }
  const A = win('A'), B = win('B');
  A.start(); await flush();
  B.start(); await flush();
  assert.equal(A.isLeader(), true); assert.equal(B.isLeader(), false);
  assert.deepEqual(missedSeen, [{ win: 'A', keys: ['card:b1:m:r:2026-11-16T08:00'] }]);
  assert.ok(delays.every(d => d <= 60000), 'timer capped at 60 s');
  await env.advanceTo(t0 + 4 * MIN);
  assert.deepEqual(delivered.map(d => d.win + ':' + d.key.split(':')[2]), ['A:a', 'A:b']);
  A.stop(); await flush();
  assert.equal(B.isLeader(), true);
  await B.recompute(); // a visibilitychange in B runs this as well
  await env.advanceTo(t0 + 20 * MIN);
  assert.deepEqual(delivered.map(d => d.win + ':' + d.key.split(':')[2]), ['A:a', 'A:b', 'B:c']);
  const counts = {};
  for(const d of delivered) counts[d.key] = (counts[d.key] || 0) + 1;
  assert.ok(Object.values(counts).every(n => n === 1));
  assert.equal(missedSeen.length, 1);
  B.stop();
});

await check('two leaders on separate lock domains (standalone tab plus NakliOS mirror) still deliver once', async () => {
  const t0 = R.localToMs('2026-11-16T09:00', IST);
  const env = fakeEnv(t0);
  const b = { id: 'b1', columns: [{ id: 'c', name: 'To do', cardIds: ['a'] }],
    cards: { a: { id: 'a', title: 'A', reminders: [{ id: 'r', at: '2026-11-16T09:02' }, { id: 's', at: '2026-11-16T09:02' }] } } };
  const reminderLog = {};
  const delivered = [];
  const mk = (name) => R.createScheduler({
    getInstances: (now) => R.instances([b], null, null, { now, tz: IST, horizonDays: 1 }),
    isFired: (k) => k in reminderLog, markFired: (k) => { reminderLog[k] = 'x'; },
    deliver: (inst) => delivered.push(name + ':' + inst.reminderId), now: env.now, setTimer: env.setTimer,
    clearTimer: env.clearTimer, locks: fakeLocks()
  });
  const A = mk('A'), B = mk('B');
  A.start(); B.start(); await flush();
  assert.ok(A.isLeader() && B.isLeader());
  await env.advanceTo(t0 + 5 * MIN);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map(d => d.split(':')[1]).sort(), ['r', 's']);
  A.stop(); B.stop();
});

await check('snoozed reminder fires once at its new time through the scheduler', async () => {
  const t0 = R.localToMs('2026-11-16T09:00', IST);
  const env = fakeEnv(t0);
  const card = { id: 'a', title: 'A', reminders: [] };
  const b = { id: 'b1', columns: [{ id: 'c', name: 'To do', cardIds: ['a'] }], cards: { a: card } };
  R.snooze(card, R.snoozeTargets(t0, IST)[0].at);
  const log = {}; const got = [];
  const s = R.createScheduler({ getInstances: (now) => R.instances([b], null, null, { now, tz: IST, horizonDays: 1 }),
    isFired: k => k in log, markFired: k => { log[k] = 1; },
    deliver: inst => { got.push(inst.fireAtLocal); if(inst.snooze) R.consumeSnooze(card, inst.reminderId); },
    now: env.now, setTimer: env.setTimer, clearTimer: env.clearTimer, locks: fakeLocks() });
  s.start(); await flush();
  await env.advanceTo(t0 + 30 * MIN);
  assert.deepEqual(got, ['2026-11-16T09:10']);
  assert.equal(card.reminders.length, 0);
  s.stop();
});

await check('stop() before the lock is granted leaves the scheduler idle', async () => {
  const env = fakeEnv(NOW); const locks = fakeLocks();
  const mk = () => R.createScheduler({ getInstances: () => [], isFired: () => false, markFired: () => {}, deliver: () => {},
    now: env.now, setTimer: env.setTimer, clearTimer: env.clearTimer, locks });
  const A = mk(), B = mk();
  A.start(); B.start(); await flush();
  B.stop(); A.stop(); await flush();
  assert.equal(A.isLeader() || B.isLeader(), false);
  assert.equal(env.timers.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
