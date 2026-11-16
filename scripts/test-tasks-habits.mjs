// Node test for lib/kz-habits.js (habits logic). Run: node scripts/test-tasks-habits.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'lib', 'kz-habits.js');
vm.runInThisContext(fs.readFileSync(file, 'utf8'), {filename: file});
const H = globalThis.KzHabits;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

const T0 = 1_000_000;
// Build a folded log from [day, op] pairs for habit `id`, at increasing times.
function logOf(id, pairs) {
  return H.fold(pairs.map(([day, op], i) => H.makeLine(id, day, op, T0 + i)));
}
const habit = (schedule, extra = {}) => ({
  id: 'h1', name: 'Read', color: '#2da44e', order: 0, createdAt: '2026-11-01', schedule,
  dayEndHour: 0, reminders: [], paused: null, archived: false, ...extra,
});
const daily = (extra) => habit({type: 'daily'}, extra);

// ---- rollover (H5) ----
check('IST 01:30 with day end 4 counts for yesterday', () =>
  assert.equal(H.dayFor(Date.parse('2026-11-15T20:00:00Z'), 4, 'Asia/Kolkata'), '2026-11-15'));
check('IST 04:00 with day end 4 counts for today', () =>
  assert.equal(H.dayFor(Date.parse('2026-11-15T22:30:00Z'), 4, 'Asia/Kolkata'), '2026-11-16'));
check('IST 01:30 with day end 0 counts for today', () =>
  assert.equal(H.dayFor(Date.parse('2026-11-15T20:00:00Z'), 0, 'Asia/Kolkata'), '2026-11-16'));
check('New York DST start 2026-03-08 01:30 EST -> 2026-03-07', () =>
  assert.equal(H.dayFor(Date.parse('2026-03-08T06:30:00Z'), 4, 'America/New_York'), '2026-03-07'));
check('New York DST start 2026-03-08 03:30 EDT -> 2026-03-07', () =>
  assert.equal(H.dayFor(Date.parse('2026-03-08T07:30:00Z'), 4, 'America/New_York'), '2026-03-07'));
check('New York DST start 2026-03-08 04:00 EDT -> 2026-03-08', () =>
  assert.equal(H.dayFor(Date.parse('2026-03-08T08:00:00Z'), 4, 'America/New_York'), '2026-03-08'));
check('New York DST end 2026-11-01 01:30 EDT and 01:30 EST -> 2026-10-31', () => {
  assert.equal(H.dayFor(Date.parse('2026-11-01T05:30:00Z'), 4, 'America/New_York'), '2026-10-31');
  assert.equal(H.dayFor(Date.parse('2026-11-01T06:30:00Z'), 4, 'America/New_York'), '2026-10-31');
});
check('New York DST end 2026-11-01 04:00 EST -> 2026-11-01', () =>
  assert.equal(H.dayFor(Date.parse('2026-11-01T09:00:00Z'), 4, 'America/New_York'), '2026-11-01'));
check('todayFor uses the habit day end hour', () =>
  assert.equal(H.todayFor(Date.parse('2026-11-15T20:00:00Z'), {dayEndHour: 4}, 'Asia/Kolkata'), '2026-11-15'));

// ---- log (H3) ----
check('backfill a past day marks it done', () => {
  const f = H.fold([H.makeLine('h1', '2026-11-10', 'set', T0)]);
  assert.equal(H.status(daily(), f, '2026-11-10', '2026-11-16'), 'done');
  assert.equal(H.status(daily(), f, '2026-11-11', '2026-11-16'), 'missed');
});
check('clear after set leaves the day missed', () => {
  const f = logOf('h1', [['2026-11-10', 'set'], ['2026-11-10', 'clear']]);
  assert.equal(H.status(daily(), f, '2026-11-10', '2026-11-16'), 'missed');
});
check('latest at wins even when lines arrive out of order', () => {
  const f = H.fold([H.makeLine('h1', '2026-11-10', 'set', 200), H.makeLine('h1', '2026-11-10', 'skip', 100)]);
  assert.equal(f.get('h1').get('2026-11-10').op, 'set');
});
check('equal at goes to the later line', () => {
  const f = H.fold([H.makeLine('h1', '2026-11-10', 'set', 100), H.makeLine('h1', '2026-11-10', 'skip', 100)]);
  assert.equal(f.get('h1').get('2026-11-10').op, 'skip');
});
check('inverse of the only line is clear, timed to win', () => {
  const f = H.fold([H.makeLine('h1', '2026-11-10', 'set', 500)]);
  const inv = H.inverseLine(f, 'h1', '2026-11-10', 100);
  assert.deepEqual(inv, {habitId: 'h1', day: '2026-11-10', value: 0, at: 501, op: 'clear'});
  const f2 = H.fold([H.makeLine('h1', '2026-11-10', 'set', 500), inv]);
  assert.equal(H.status(daily(), f2, '2026-11-10', '2026-11-16'), 'missed');
});
check('inverse restores the prior state by at order (undo)', () => {
  const lines = [H.makeLine('h1', '2026-11-10', 'set', 300), H.makeLine('h1', '2026-11-10', 'skip', 100),
    H.makeLine('h1', '2026-11-10', 'clear', 200)];
  assert.equal(H.inverseLine(H.fold(lines), 'h1', '2026-11-10', 400).op, 'clear');
  const lines2 = [H.makeLine('h1', '2026-11-10', 'skip', 100), H.makeLine('h1', '2026-11-10', 'set', 200)];
  const inv = H.inverseLine(H.fold(lines2), 'h1', '2026-11-10', 400);
  assert.equal(inv.op, 'skip');
  assert.equal(H.status(daily(), H.fold([...lines2, inv]), '2026-11-10', '2026-11-16'), 'skipped');
});
check('inverse of a day with no line is null', () =>
  assert.equal(H.inverseLine(H.fold([]), 'h1', '2026-11-10', 1), null));
check('malformed JSONL lines are skipped and counted', () => {
  const good = H.serializeLine(H.makeLine('h1', '2026-11-10', 'set', 5));
  const text = ['not json', good, '', '{"habitId":"h1","day":"2026-02-30","op":"set","at":1}',
    '{"habitId":"h1","day":"2026-11-11","op":"nope","at":1}'].join('\r\n');
  const lines = H.parseLog(text);
  assert.equal(lines.length, 1);
  assert.equal(lines.skipped, 3);
  assert.deepEqual(lines[0], {habitId: 'h1', day: '2026-11-10', value: 1, at: 5, op: 'set'});
});
check('serializeLine round-trips through parseLog, array input accepted', () => {
  const l = H.makeLine('h1', '2026-11-10', 'skip', 9);
  assert.equal(H.serializeLine(l), '{"habitId":"h1","day":"2026-11-10","value":0,"at":9,"op":"skip"}');
  assert.deepEqual(H.parseLog([H.serializeLine(l), l])[1], l);
});

// ---- streaks (H6) ----
check('skip is neutral for the streak; today open does not break it', () => {
  const f = logOf('h1', [['2026-11-10', 'set'], ['2026-11-11', 'set'], ['2026-11-12', 'skip'],
    ['2026-11-13', 'set'], ['2026-11-14', 'set']]);
  assert.deepEqual(H.streaks(daily({createdAt: '2026-11-10'}), f, '2026-11-15'), {current: 4, best: 4, unit: 'day'});
});
check('pause is neutral from its day on', () => {
  const h = daily({createdAt: '2026-11-10', paused: '2026-11-13'});
  const f = logOf('h1', [['2026-11-10', 'set'], ['2026-11-11', 'set'], ['2026-11-12', 'set']]);
  assert.deepEqual(H.streaks(h, f, '2026-11-16'), {current: 3, best: 3, unit: 'day'});
  assert.equal(H.status(h, f, '2026-11-14', '2026-11-16'), 'paused');
});
check('weekdays schedule: days off never break the streak', () => {
  const h = habit({type: 'weekdays', days: [1, 3, 5]}, {createdAt: '2026-11-02'});
  const f = logOf('h1', ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11', '2026-11-13']
    .map((d) => [d, 'set']));
  assert.deepEqual(H.streaks(h, f, '2026-11-16'), {current: 6, best: 6, unit: 'day'});
  assert.equal(H.status(h, f, '2026-11-07', '2026-11-16'), 'off');
  assert.equal(H.isScheduled(h, '2026-11-07'), false);
});
check('best vs current streak after a missed scheduled day', () => {
  const h = habit({type: 'weekdays', days: [1, 3, 5]}, {createdAt: '2026-11-02'});
  const f = logOf('h1', ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-13', '2026-11-16'].map((d) => [d, 'set']));
  assert.equal(H.status(h, f, '2026-11-11', '2026-11-16'), 'missed');
  assert.deepEqual(H.streaks(h, f, '2026-11-16'), {current: 2, best: 3, unit: 'day'});
});
const dayset = (days) => days.map((d) => [d, 'set']);
check('xPerWeek 3: consecutive met weeks, current week does not break', () => {
  const h = habit({type: 'xPerWeek', n: 3}, {createdAt: '2026-10-26'});
  const f = logOf('h1', dayset(['2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-08',
    '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']));
  assert.deepEqual(H.streaks(h, f, '2026-11-16'), {current: 3, best: 3, unit: 'week'});
  assert.equal(H.status(h, f, '2026-11-04', '2026-11-16'), 'off');
  assert.equal(H.status(h, f, '2026-11-16', '2026-11-16'), 'open');
});
check('xPerWeek 3: a missed week resets; best keeps the longer run', () => {
  const h = habit({type: 'xPerWeek', n: 3}, {createdAt: '2026-10-26'});
  const f = logOf('h1', dayset(['2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-08',
    '2026-11-09', '2026-11-16', '2026-11-17', '2026-11-18']));
  assert.equal(H.status(h, f, '2026-11-11', '2026-11-18'), 'missed');
  assert.deepEqual(H.streaks(h, f, '2026-11-18'), {current: 1, best: 2, unit: 'week'});
});
check('xInDays 2 of 3: covered, missed and open days', () => {
  const h = habit({type: 'xInDays', n: 2, m: 3});
  const f = logOf('h1', dayset(['2026-11-01', '2026-11-03']));
  assert.equal(H.status(h, f, '2026-11-02', '2026-11-08'), 'off');
  assert.equal(H.status(h, f, '2026-11-04', '2026-11-08'), 'missed');
  assert.equal(H.status(h, f, '2026-11-06', '2026-11-08'), 'open');
  assert.deepEqual(H.streaks(h, f, '2026-11-08'), {current: 0, best: 1, unit: 'period'});
  const f2 = logOf('h1', dayset(['2026-11-01', '2026-11-03', '2026-11-07', '2026-11-08']));
  assert.deepEqual(H.streaks(h, f2, '2026-11-08'), {current: 1, best: 1, unit: 'period'});
});

// ---- score (H7), expected values computed here from the formula ----
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
check('daily score matches the hand computation', () => {
  const f = logOf('h1', [['2026-11-01', 'set'], ['2026-11-02', 'set'], ['2026-11-04', 'skip'], ['2026-11-05', 'set']]);
  const m = 0.5 ** (1 / 13);
  let s = 0;
  for (const c of [1, 1, 0, null, 1]) if (c !== null) s = s * m + c * (1 - m);
  near(H.score(daily(), f, '2026-11-05'), s);
});
check('xPerWeek score applies only the shortfall of a missed week', () => {
  const h = habit({type: 'xPerWeek', n: 3}, {createdAt: '2026-11-02'});
  const f = logOf('h1', dayset(['2026-11-02', '2026-11-03', '2026-11-09']));
  const m = 0.5 ** (Math.sqrt(3 / 7) / 13);
  let s = 0;
  for (const c of [1, 1, 0, 1]) s = s * m + c * (1 - m);
  near(H.score(h, f, '2026-11-10'), s);
});
check('score stays 0 with no check-ins and approaches 1 when always done', () => {
  assert.equal(H.score(daily(), H.fold([]), '2026-11-16'), 0);
  const days = Array.from({length: 400}, (_, i) => H.addDays('2025-10-12', i));
  const v = H.score(daily({createdAt: '2025-10-12'}), logOf('h1', dayset(days)), days.at(-1));
  assert.ok(v > 0.99 && v <= 1, String(v));
});

// ---- completion and heatmap (H8) ----
check('completion rate counts done over due days', () => {
  const f = logOf('h1', [['2026-11-01', 'set'], ['2026-11-02', 'set'], ['2026-11-04', 'skip']]);
  assert.equal(H.completionRate(daily(), f, '2026-11-05', 30), 2 / 3);
  assert.equal(H.completionRate(daily(), H.fold([]), '2026-11-01', 7), null);
});
check('heatmap has at most 7*weeks cells, data attributes and an escaped name', () => {
  const f = logOf('h1', [['2026-11-10', 'set']]);
  const svg = H.heatmapSvg(daily({name: '<b>&"'}), f, '2026-11-16', {weeks: 53});
  const cells = svg.match(/<rect /g).length;
  assert.ok(cells <= 7 * 53);
  assert.equal(cells, 52 * 7 + 1);
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;'));
  assert.ok(!svg.includes('<b>'));
  assert.ok(/data-day="2026-11-10" data-status="done" fill="var\(--kz-habit-done, #2da44e\)"/.test(svg));
  assert.ok(svg.includes('data-day="2026-11-16" data-status="open"'));
  assert.ok(svg.includes('<title>2026-11-10: done</title>'));
});
check('heatmap rejects an unsafe colour', () => {
  const svg = H.heatmapSvg(daily({color: 'red" onload="x'}), H.fold([]), '2026-11-16', {weeks: 2});
  assert.ok(!svg.includes('onload'));
});

// ---- reminders helper (H10) and definitions (H1) ----
check('isDue is true while today is open, false once done or archived', () => {
  assert.equal(H.isDue(daily(), H.fold([]), '2026-11-16', '2026-11-16'), true);
  assert.equal(H.isDue(daily(), logOf('h1', [['2026-11-16', 'set']]), '2026-11-16', '2026-11-16'), false);
  assert.equal(H.isDue(daily({archived: true}), H.fold([]), '2026-11-16', '2026-11-16'), false);
});
check('newHabit accepts an injected id and fills defaults', () => {
  const h = H.newHabit({id: 'fixed', name: ' Walk ', schedule: {type: 'xInDays', n: 2, m: 3}}, Date.parse('2026-11-16T03:00:00Z'));
  assert.equal(h.id, 'fixed');
  assert.equal(h.name, 'Walk');
  assert.equal(h.createdAt, '2026-11-16T03:00:00.000Z');
  assert.equal(H.validateHabit(h), true);
  assert.match(H.newHabit({name: 'x'}, 0).id, /^h_[0-9a-f]{18}$/);
});
check('validateHabit rejects bad schedules and fields', () => {
  assert.match(H.validateHabit(daily({schedule: {type: 'weekdays', days: [0]}})), /1\.\.7/);
  assert.match(H.validateHabit(daily({schedule: {type: 'xInDays', n: 4, m: 3}})), /n must/);
  assert.match(H.validateHabit(daily({dayEndHour: 24})), /dayEndHour/);
  assert.match(H.validateHabit(daily({reminders: [{id: 'r', at: '9:00'}]})), /HH:MM/);
  assert.throws(() => H.newHabit({name: ''}, 0));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
