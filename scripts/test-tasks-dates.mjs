#!/usr/bin/env node
// test-tasks-dates.mjs — node tests for lib/vendor/kz-vendor-dates.js and lib/kz-tasks.js (no browser).
//   node scripts/test-tasks-dates.mjs
// Prints one line per passing check and a total; exits 1 on any failure.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const vendorSrc = readFileSync(join(root, 'lib/vendor/kz-vendor-dates.js'), 'utf8');
const tasksSrc = readFileSync(join(root, 'lib/kz-tasks.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('ok    ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, g === w ? undefined : { got, want });
}
function sub(obj, keys) { const o = {}; for (const k of keys) o[k] = obj == null ? undefined : obj[k]; return o; }

// ---------- vendor bundle ----------
const hadTemporal = typeof globalThis.Temporal !== 'undefined';
check('node runtime has no native Temporal, so the polyfill path runs', !hadTemporal);
{
  const sentinel = { sentinel: true };
  const ctx = vm.createContext({ Temporal: sentinel });
  vm.runInContext(vendorSrc, ctx);
  check('bundle leaves an existing globalThis.Temporal alone', ctx.Temporal === sentinel);
  check('bundle still exposes KzVendor beside an existing Temporal', !!(ctx.KzVendor && ctx.KzVendor.chrono && ctx.KzVendor.RRuleTemporal));
}
vm.runInThisContext(vendorSrc, { filename: 'kz-vendor-dates.js' });
check('bundle installs globalThis.Temporal when missing', typeof globalThis.Temporal?.ZonedDateTime === 'function');
check('bundle exposes chrono and RRuleTemporal', typeof KzVendor.chrono.parse === 'function' && typeof KzVendor.RRuleTemporal === 'function');
check('bundle carries the three licence notices', ['chrono-node 2.10.3 (MIT)', 'rrule-temporal 2.2.8 (MIT)', 'temporal-polyfill 1.0.6 (MIT)'].every((s) => vendorSrc.slice(0, 6000).includes(s)));
check('chrono is the English build only (no GB-only or other locale exports)', !('de' in KzVendor.chrono) && !('ja' in KzVendor.chrono) && 'GB' in KzVendor.chrono);

vm.runInThisContext(tasksSrc, { filename: 'kz-tasks.js' });
const K = globalThis.KzTasks;
const contract = ['parseQuickAdd', 'parseRepeat', 'describeRepeat', 'nextOccurrence', 'occurrencesBetween', 'completeCard', 'uncompleteCard', 'skipOccurrence', 'endSeries', 'isDone', 'doneColumn', 'smartView', 'validateRepeat', 'validateTaskFields'];
check('KzTasks exposes every contract function', contract.every((f) => typeof K[f] === 'function'), contract.filter((f) => typeof K[f] !== 'function'));
check('kz-tasks.js has no import/export and no Date.now', !/^\s*(import|export)\s/m.test(tasksSrc) && !/Date\.now\(/.test(tasksSrc));

// ---------- fixtures ----------
// Today is Monday 2026-11-16, 10:00 in Asia/Kolkata.
const TZ = 'Asia/Kolkata';
const TODAY = '2026-11-16';
const NOW = Date.parse('2026-11-16T10:00:00+05:30');
const BOARDS = [
  { id: 'inbox', name: 'Inbox', inbox: true, columns: [{ id: 'i1', name: 'To Do' }, { id: 'i3', name: 'Done' }], labels: [] },
  { id: 'work', name: 'Work', columns: [{ id: 'w1', name: 'To Do' }, { id: 'w2', name: 'In Progress' }, { id: 'w3', name: 'Done' }], labels: [{ id: 'lb', name: 'Bug' }, { id: 'lr', name: 'Research' }] },
  { id: 'pers', name: 'Personal', columns: [{ id: 'p1', name: 'Later' }], labels: [{ id: 'lh', name: 'health' }] },
  { id: 'mp', name: 'My Project', columns: [{ id: 'm1', name: 'Backlog' }], labels: [] },
];
const QA = { now: NOW, today: TODAY, tz: TZ, boards: BOARDS, defaultBoardId: 'inbox' };

// Quick add: [input, expected subset]
const QUICK = [
  ['Buy milk tomorrow 3pm', { title: 'Buy milk', dueDate: '2026-11-17', dueTime: '15:00', boardId: 'inbox' }],
  ['Call Ana next Fri', { title: 'Call Ana', dueDate: '2026-11-27', dueTime: null }],
  ['Call Ana fri', { title: 'Call Ana', dueDate: '2026-11-20' }],
  ['Call Ana this friday', { dueDate: '2026-11-20' }],
  ['Pay rent in 3 days', { title: 'Pay rent', dueDate: '2026-11-19' }],
  ['Dentist Nov 20', { title: 'Dentist', dueDate: '2026-11-20' }],
  ['Report 20/11', { title: 'Report', dueDate: '2026-11-20' }],
  ['Report 11/20', { dueDate: '2026-11-20' }],
  ['Renew passport dec 31', { dueDate: '2026-12-31' }],
  ['Book flights next week', { dueDate: '2026-11-23' }],
  ['Send invoice today at 18:30', { title: 'Send invoice', dueDate: '2026-11-16', dueTime: '18:30' }],
  ['Standup every weekday at 9:30', { title: 'Standup', dueDate: '2026-11-16', dueTime: '09:30', repeat: { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', time: '09:30', mode: 'fixed', anchor: '2026-11-16' } }],
  ['Gym every mon, fri at 7am #Personal p2 @health', { title: 'Gym', boardId: 'pers', priority: 'high', labelIds: ['lh'], dueDate: '2026-11-16', dueTime: '07:00' }],
  ['Draft spec #Work /In Progress @Bug @newtag p1 {Nov 30}', { title: 'Draft spec', boardId: 'work', columnId: 'w2', labelIds: ['lb'], newLabels: ['newtag'], priority: 'urgent', dueDate: '2026-11-30', startDate: null }],
  ['Write blog tomorrow {Dec 5}', { title: 'Write blog', startDate: '2026-11-17', dueDate: '2026-12-05' }],
  ['Learn piano someday', { title: 'Learn piano', someday: true, dueDate: null }],
  ['Water plants every 3 days', { title: 'Water plants', dueDate: '2026-11-16', repeat: { rrule: 'FREQ=DAILY;INTERVAL=3', anchor: '2026-11-16' } }],
  ['Pay card every month on the 3rd', { title: 'Pay card', dueDate: '2026-12-03' }],
  ['Taxes every year on jan 5 at 10am', { title: 'Taxes', dueDate: '2027-01-05', dueTime: '10:00' }],
  ['Review every other week starting Nov 30', { title: 'Review', dueDate: '2026-11-30', repeat: { rrule: 'FREQ=WEEKLY;INTERVAL=2', anchor: '2026-11-30' } }],
  ['Email bob@example.com', { title: 'Email bob@example.com', labelIds: [], newLabels: [] }],
  ['Fix #Unknown thing', { title: 'Fix #Unknown thing', boardId: 'inbox' }],
  ['p5 is not a priority', { title: 'p5 is not a priority', priority: null }],
  ['Plan sprint every 2 weeks on monday until dec 31', { title: 'Plan sprint', repeat: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;UNTIL=20261231' } }],
  ['Meds every day at 8 for 10 times', { title: 'Meds', dueTime: '08:00', repeat: { rrule: 'FREQ=DAILY;COUNT=10', time: '08:00' } }],
  ['Read every! 2 weeks', { title: 'Read', repeat: { rrule: 'FREQ=WEEKLY;INTERVAL=2', mode: 'afterCompletion' } }],
  ['Backup every last day of month at 18:30', { title: 'Backup', dueDate: '2026-11-30', dueTime: '18:30' }],
  ['Call mom every first monday', { title: 'Call mom', dueDate: '2026-12-07' }],
  ['Sync #My_Project notes', { title: 'Sync notes', boardId: 'mp' }],
  ['Weekly review every Friday at 4pm', { title: 'Weekly review', dueDate: '2026-11-20', dueTime: '16:00' }],
];
for (const [input, want] of QUICK) {
  const got = K.parseQuickAdd(input, QA);
  const keys = Object.keys(want);
  const g = {};
  for (const k of keys) g[k] = k === 'repeat' && got.repeat ? sub(got.repeat, Object.keys(want.repeat)) : got[k];
  eq('quick add: ' + input, g, want);
}
{
  const r = K.parseQuickAdd('Buy milk tomorrow 3pm #Work p3', QA);
  const date = r.parts.find((p) => p.kind === 'date');
  eq('quick add parts index the input', r.parts.map((p) => [p.kind, p.text]), [['date', 'tomorrow 3pm'], ['board', '#Work'], ['priority', 'p3']]);
  const cut = 'Buy milk tomorrow 3pm #Work p3'.slice(0, date.start) + 'Buy milk tomorrow 3pm #Work p3'.slice(date.end);
  const again = K.parseQuickAdd(cut, QA);
  check('removing a part and parsing again drops only that part (C5)', again.dueDate === null && again.boardId === 'work' && again.priority === 'medium', again);
}

// Repeat grammar: [phrase, rrule, time, mode, anchor] with today 2026-11-16 (Monday).
const REPEATS = [
  ['every day', 'FREQ=DAILY', null, 'fixed', '2026-11-16'],
  ['daily', 'FREQ=DAILY', null, 'fixed', '2026-11-16'],
  ['every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', null, 'fixed', '2026-11-16'],
  ['every weekend', 'FREQ=WEEKLY;BYDAY=SA,SU', null, 'fixed', '2026-11-21'],
  ['every Monday', 'FREQ=WEEKLY;BYDAY=MO', null, 'fixed', '2026-11-16'],
  ['every Monday at 9', 'FREQ=WEEKLY;BYDAY=MO', '09:00', 'fixed', '2026-11-16'],
  ['every monday at 9am', 'FREQ=WEEKLY;BYDAY=MO', '09:00', 'fixed', '2026-11-16'],
  ['every mon, fri', 'FREQ=WEEKLY;BYDAY=MO,FR', null, 'fixed', '2026-11-16'],
  ['every tue and thu at 18:30', 'FREQ=WEEKLY;BYDAY=TU,TH', '18:30', 'fixed', '2026-11-17'],
  ['every wednesday', 'FREQ=WEEKLY;BYDAY=WE', null, 'fixed', '2026-11-18'],
  ['every 2 weeks', 'FREQ=WEEKLY;INTERVAL=2', null, 'fixed', '2026-11-16'],
  ['every other week', 'FREQ=WEEKLY;INTERVAL=2', null, 'fixed', '2026-11-16'],
  ['every other friday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', null, 'fixed', '2026-11-20'],
  ['every 3 days', 'FREQ=DAILY;INTERVAL=3', null, 'fixed', '2026-11-16'],
  ['every 4 weeks', 'FREQ=WEEKLY;INTERVAL=4', null, 'fixed', '2026-11-16'],
  ['every 6 months', 'FREQ=MONTHLY;INTERVAL=6', null, 'fixed', '2026-11-16'],
  ['every 2 years', 'FREQ=YEARLY;INTERVAL=2', null, 'fixed', '2026-11-16'],
  ['every week', 'FREQ=WEEKLY', null, 'fixed', '2026-11-16'],
  ['weekly', 'FREQ=WEEKLY', null, 'fixed', '2026-11-16'],
  ['every month', 'FREQ=MONTHLY', null, 'fixed', '2026-11-16'],
  ['monthly', 'FREQ=MONTHLY', null, 'fixed', '2026-11-16'],
  ['yearly', 'FREQ=YEARLY', null, 'fixed', '2026-11-16'],
  ['every 3rd of the month', 'FREQ=MONTHLY;BYMONTHDAY=3', null, 'fixed', '2026-12-03'],
  ['every month on the 3rd', 'FREQ=MONTHLY;BYMONTHDAY=3', null, 'fixed', '2026-12-03'],
  ['every 16th', 'FREQ=MONTHLY;BYMONTHDAY=16', null, 'fixed', '2026-11-16'],
  ['every 1st and 15th', 'FREQ=MONTHLY;BYMONTHDAY=1,15', null, 'fixed', '2026-12-01'],
  ['every last day of month', 'FREQ=MONTHLY;BYMONTHDAY=-1', null, 'fixed', '2026-11-30'],
  ['every last day of the month at 17:00', 'FREQ=MONTHLY;BYMONTHDAY=-1', '17:00', 'fixed', '2026-11-30'],
  ['every first Monday', 'FREQ=MONTHLY;BYDAY=1MO', null, 'fixed', '2026-12-07'],
  ['every first monday of the month', 'FREQ=MONTHLY;BYDAY=1MO', null, 'fixed', '2026-12-07'],
  ['every last friday', 'FREQ=MONTHLY;BYDAY=-1FR', null, 'fixed', '2026-11-27'],
  ['every 2nd tuesday of the month', 'FREQ=MONTHLY;BYDAY=2TU', null, 'fixed', '2026-12-08'],
  ['every year on Jan 5', 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=5', null, 'fixed', '2027-01-05'],
  ['every Jan 5', 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=5', null, 'fixed', '2027-01-05'],
  ['every 25 december', 'FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25', null, 'fixed', '2026-12-25'],
  ['every day at 18:30', 'FREQ=DAILY', '18:30', 'fixed', '2026-11-16'],
  ['every day at noon', 'FREQ=DAILY', '12:00', 'fixed', '2026-11-16'],
  ['every day 9pm', 'FREQ=DAILY', '21:00', 'fixed', '2026-11-16'],
  ['every! 3 months', 'FREQ=MONTHLY;INTERVAL=3', null, 'afterCompletion', '2026-11-16'],
  ['every! day', 'FREQ=DAILY', null, 'afterCompletion', '2026-11-16'],
  ['every 10 days after completion', 'FREQ=DAILY;INTERVAL=10', null, 'afterCompletion', '2026-11-16'],
  ['every day until dec 31', 'FREQ=DAILY;UNTIL=20261231', null, 'fixed', '2026-11-16'],
  ['every week until 2027-01-31', 'FREQ=WEEKLY;UNTIL=20270131', null, 'fixed', '2026-11-16'],
  ['every day for 5 times', 'FREQ=DAILY;COUNT=5', null, 'fixed', '2026-11-16'],
  ['every monday at 9 for 3 times', 'FREQ=WEEKLY;BYDAY=MO;COUNT=3', '09:00', 'fixed', '2026-11-16'],
  ['every 2 weeks on monday, thursday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', null, 'fixed', '2026-11-16'],
  ['every 3 months on the 10th', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10', null, 'fixed', '2026-12-10'],
  ['every week starting dec 2', 'FREQ=WEEKLY', null, 'fixed', '2026-12-02'],
  ['biweekly', 'FREQ=WEEKLY;INTERVAL=2', null, 'fixed', '2026-11-16'],
];
for (const [phrase, rrule, time, mode, anchor] of REPEATS) {
  const r = K.parseRepeat(phrase, { today: TODAY, tz: TZ });
  eq('repeat: ' + phrase, r && { rrule: r.repeat.rrule, time: r.repeat.time, mode: r.repeat.mode, anchor: r.repeat.anchor, tz: r.repeat.tz, span: [r.start, r.end] },
    { rrule, time, mode, anchor, tz: TZ, span: [0, phrase.length] });
}
for (const bad of ['every', 'every blah', 'every 0 days', 'once a week', 'buy milk']) {
  check('repeat rejects: ' + bad, K.parseRepeat(bad, { today: TODAY, tz: TZ }) === null);
}
for (const [phrase, rrule, end] of [['every monday at 25', 'FREQ=WEEKLY;BYDAY=MO', 12], ['every day until whenever-ish', 'FREQ=DAILY', 9]]) {
  const r = K.parseRepeat(phrase, { today: TODAY, tz: TZ });
  eq('repeat trims an unreadable tail: ' + phrase, r && [r.repeat.rrule, r.end], [rrule, end]);
}
check('fixture table has at least 50 quick-add and repeat phrases', QUICK.length + REPEATS.length >= 50, QUICK.length + REPEATS.length);
check('repeat grammar does not use rrule.js text parsing', !/fromText|parseText/.test(tasksSrc));

// describeRepeat
const d = (rrule, time, mode) => K.describeRepeat({ rrule, time: time ?? null, mode: mode || 'fixed', tz: TZ, anchor: TODAY });
eq('describe: every Monday at 09:00', d('FREQ=WEEKLY;BYDAY=MO', '09:00'), 'Every Monday at 09:00');
eq('describe: weekday', d('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), 'Every weekday');
eq('describe: monthly nth weekday', d('FREQ=MONTHLY;BYDAY=1MO'), 'Every month on the first Monday');
eq('describe: last day', d('FREQ=MONTHLY;BYMONTHDAY=-1'), 'Every month on the last day');
eq('describe: yearly', d('FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=5'), 'Every year on January 5');
eq('describe: after completion with count', d('FREQ=MONTHLY;INTERVAL=3;COUNT=4', null, 'afterCompletion'), 'Every 3 months, counted from completion, 4 times');
eq('describe: until', d('FREQ=DAILY;UNTIL=20261231'), 'Every day, until 2026-12-31');

// ---------- occurrences and DST (R1, R8) ----------
const R = (rrule, anchor, time, tz, mode) => ({ rrule, time: time ?? null, mode: mode || 'fixed', tz: tz || TZ, anchor, resetChecklist: false });
eq('occurrencesBetween: weekly Monday', K.occurrencesBetween(R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16'), '2026-11-16', '2026-12-07'), ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']);
eq('occurrencesBetween: limit', K.occurrencesBetween(R('FREQ=DAILY', '2026-11-16'), '2026-11-16', '2026-12-31', 3), ['2026-11-16', '2026-11-17', '2026-11-18']);
eq('occurrencesBetween: last day of month across February', K.occurrencesBetween(R('FREQ=MONTHLY;BYMONTHDAY=-1', '2027-01-31'), '2027-01-01', '2027-04-30'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
eq('occurrencesBetween: the 31st skips short months (RFC 5545)', K.occurrencesBetween(R('FREQ=MONTHLY;BYMONTHDAY=31', '2027-01-31'), '2027-01-01', '2027-05-31'), ['2027-01-31', '2027-03-31', '2027-05-31']);
eq('nextOccurrence: strictly after', K.nextOccurrence(R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16'), '2026-11-16'), '2026-11-23');
eq('nextOccurrence: COUNT end', K.nextOccurrence(R('FREQ=DAILY;COUNT=3', '2026-11-16'), '2026-11-18'), null);
eq('nextOccurrence: UNTIL end is inclusive', [K.nextOccurrence(R('FREQ=DAILY;UNTIL=20261118', '2026-11-16'), '2026-11-17'), K.nextOccurrence(R('FREQ=DAILY;UNTIL=20261118', '2026-11-16'), '2026-11-18')], ['2026-11-18', null]);
eq('nextOccurrence: floating UNTIL with time', K.nextOccurrence(R('FREQ=DAILY;UNTIL=20261118T235959', '2026-11-16', '09:00'), '2026-11-17'), '2026-11-18');

const wall = (ms, tz) => { const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz); return z.toPlainDate().toString() + ' ' + z.toPlainTime().toString().slice(0, 5); };
const utcHour = (ms) => new Date(ms).toISOString().slice(11, 16);
const DST = [
  ['America/New_York', '2026-03-08', '2026-03-02', '2026-03-09', '14:00', '13:00'],
  ['America/New_York', '2026-11-01', '2026-10-26', '2026-11-02', '13:00', '14:00'],
  ['Europe/London', '2026-03-29', '2026-03-23', '2026-03-30', '09:00', '08:00'],
  ['Europe/London', '2026-10-25', '2026-10-19', '2026-10-26', '08:00', '09:00'],
  ['Asia/Kolkata', 'no DST', '2026-03-23', '2026-03-30', '03:30', '03:30'],
];
for (const [tz, change, before, after, utcBefore, utcAfter] of DST) {
  const today = addDaysStr(before, -1);
  const pr = K.parseRepeat('every Monday at 9', { today, tz });
  const rep = pr.repeat;
  const days = K.occurrencesBetween(rep, before, after);
  const inst = days.map((dd) => K.occurrenceInstant(rep, dd));
  eq(`R8 ${tz} ${change}: every Monday at 9 stays 09:00 local`, { days, local: inst.map((ms) => wall(ms, tz)), utc: inst.map(utcHour) },
    { days: [before, after], local: [before + ' 09:00', after + ' 09:00'], utc: [utcBefore, utcAfter] });
}
{
  // Spring-forward day itself: a 02:30 daily repeat still lists the day; the instant moves to 03:30 local.
  const rep = R('FREQ=DAILY', '2026-03-07', '02:30', 'America/New_York');
  const days = K.occurrencesBetween(rep, '2026-03-07', '2026-03-09');
  eq('R8 New York 2026-03-08: a time in the DST gap keeps the day and resolves forward', { days, gap: wall(K.occurrenceInstant(rep, '2026-03-08'), 'America/New_York') },
    { days: ['2026-03-07', '2026-03-08', '2026-03-09'], gap: '2026-03-08 03:30' });
  const nowNY = Date.parse('2026-03-08T10:00:00-04:00');
  const q = K.parseQuickAdd('Standup every Monday at 9', { now: nowNY, today: '2026-03-08', tz: 'America/New_York', boards: BOARDS });
  eq('quick add on the New York DST day: first Monday 09:00, zone stored', [q.dueDate, q.dueTime, q.repeat.tz], ['2026-03-09', '09:00', 'America/New_York']);
  const fall = K.parseQuickAdd('Call tomorrow 9am', { now: Date.parse('2026-10-31T12:00:00-04:00'), today: '2026-10-31', tz: 'America/New_York', boards: BOARDS });
  eq('quick add across the New York fall-back night: tomorrow 9am is 2026-11-01 09:00', [fall.dueDate, fall.dueTime], ['2026-11-01', '09:00']);
  const lon = K.parseQuickAdd('Call tomorrow 9am', { now: Date.parse('2026-03-28T12:00:00Z'), today: '2026-03-28', tz: 'Europe/London', boards: BOARDS });
  eq('quick add across the London spring-forward night: tomorrow 9am is 2026-03-29 09:00', [lon.dueDate, lon.dueTime], ['2026-03-29', '09:00']);
}
function addDaysStr(day, n) { return Temporal.PlainDate.from(day).add({ days: n }).toString(); }

// ---------- completion (R2–R6) ----------
function mkBoard(cards, opts = {}) {
  const b = {
    id: opts.id || 'b', name: opts.name || 'B', inbox: opts.inbox || undefined,
    columns: [
      { id: 'todo', name: 'To Do', cardIds: [] },
      { id: 'doing', name: 'In Progress', cardIds: [] },
      { id: 'done', name: opts.doneName || 'Done', cardIds: [], ...(opts.doneFlag ? { done: true } : {}) },
    ],
    cards: {},
  };
  for (const c of cards) { b.cards[c.id] = c; b.columns.find((x) => x.id === (c._col || 'todo')).cardIds.push(c.id); delete c._col; }
  return b;
}
const card = (id, extra = {}) => ({ id, title: id, description: '', labelIds: [], memberIds: [], priority: 'none', dueDate: null, checklist: [], attachments: [], comments: [], ...extra });
const nowAt = (iso) => Date.parse(iso);

{
  // Todoist's worked example: every 3 months from 10 Jan, completed 20 Jan.
  const fixed = mkBoard([card('a', { dueDate: '2026-01-10', repeat: R('FREQ=MONTHLY;INTERVAL=3', '2026-01-10') })]);
  const r1 = K.completeCard(fixed, 'a', { now: nowAt('2026-01-20T10:00:00Z'), today: '2026-01-20' });
  eq('late completion, fixed: next is 2026-04-10', [r1, fixed.cards.a.dueDate], [{ repeating: true, next: '2026-04-10' }, '2026-04-10']);
  const ac = mkBoard([card('a', { dueDate: '2026-01-10', repeat: R('FREQ=MONTHLY;INTERVAL=3', '2026-01-10', null, TZ, 'afterCompletion') })]);
  const r2 = K.completeCard(ac, 'a', { now: nowAt('2026-01-20T10:00:00Z'), today: '2026-01-20' });
  eq('late completion, every!: next is 2026-04-20', [r2.next, ac.cards.a.dueDate], ['2026-04-20', '2026-04-20']);
  eq('completion logs the occurrence with prevDue', sub(fixed.cards.a.doneLog[0], ['occ', 'kind', 'prevDue', 'prevStart', 'at']), { occ: '2026-01-10', kind: 'done', prevDue: '2026-01-10', prevStart: null, at: '2026-01-20T10:00:00.000Z' });
  check('repeating completion stays in its column and has no completedAt', fixed.columns[0].cardIds.includes('a') && !fixed.cards.a.completedAt);
}
{
  // Early completion: weekly Monday due 2026-11-23 completed on Friday 2026-11-20.
  const b = mkBoard([card('a', { dueDate: '2026-11-23', repeat: R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16') })]);
  eq('early completion, fixed: next Monday after the due day', K.completeCard(b, 'a', { now: NOW, today: '2026-11-20' }).next, '2026-11-30');
  const b2 = mkBoard([card('a', { dueDate: '2026-11-23', repeat: R('FREQ=WEEKLY', '2026-11-16', null, TZ, 'afterCompletion') })]);
  eq('early completion, every! week: one week after completion', K.completeCard(b2, 'a', { now: NOW, today: '2026-11-20' }).next, '2026-11-27');
  const b3 = mkBoard([card('a', { dueDate: '2026-11-10', repeat: R('FREQ=DAILY', '2026-11-01') })]);
  eq('late daily completion, fixed: first day strictly after today', K.completeCard(b3, 'a', { now: NOW, today: TODAY }).next, '2026-11-17');
}
{
  // startDate keeps its gap; undo restores both dates and the log.
  const b = mkBoard([card('a', { startDate: '2026-11-21', dueDate: '2026-11-23', repeat: R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16') })]);
  K.completeCard(b, 'a', { now: NOW, today: TODAY });
  eq('completion advances startDate with the same gap', [b.cards.a.startDate, b.cards.a.dueDate], ['2026-11-28', '2026-11-30']);
  const u = K.uncompleteCard(b, 'a');
  eq('uncompleteCard restores log and dates (R4)', [u.undone, b.cards.a.startDate, b.cards.a.dueDate, b.cards.a.doneLog], [true, '2026-11-21', '2026-11-23', undefined]);
}
{
  // Skip one occurrence (R5).
  const b = mkBoard([card('a', { dueDate: '2026-11-23', repeat: R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16') })]);
  const r = K.skipOccurrence(b, 'a', { now: NOW, today: TODAY });
  eq('skip advances one occurrence and logs a skip', [r.next, b.cards.a.dueDate, b.cards.a.doneLog.map((e) => [e.occ, e.kind])], ['2026-11-30', '2026-11-30', [['2026-11-23', 'skip']]]);
  K.uncompleteCard(b, 'a');
  eq('uncompleteCard reverses a skip', [b.cards.a.dueDate, b.cards.a.doneLog], ['2026-11-23', undefined]);
}
{
  // End the series (R5).
  const b = mkBoard([card('a', { dueDate: '2026-11-23', repeat: R('FREQ=WEEKLY;BYDAY=MO', '2026-11-16'), _col: 'doing' })]);
  K.endSeries(b, 'a', { now: NOW });
  check('endSeries closes the card: completedAt, done column, isDone', !!b.cards.a.completedAt && b.columns[2].cardIds.includes('a') && K.isDone(b, 'a'));
  K.uncompleteCard(b, 'a');
  check('uncompleteCard reopens an ended series into its previous column', !b.cards.a.completedAt && b.columns[1].cardIds.includes('a') && !K.isDone(b, 'a') && b.cards.a.dueDate === '2026-11-23');
}
{
  // Reset checklist (R6) and undo restores the ticks.
  const b = mkBoard([card('a', { dueDate: TODAY, repeat: { ...R('FREQ=DAILY', TODAY), resetChecklist: true }, checklist: [{ text: 'x', done: true }, { text: 'y', done: false }, { text: 'z', done: true }] })]);
  K.completeCard(b, 'a', { now: NOW, today: TODAY });
  eq('completion resets the checklist when asked', b.cards.a.checklist.map((i) => i.done), [false, false, false]);
  K.uncompleteCard(b, 'a');
  eq('undo restores the checklist ticks', b.cards.a.checklist.map((i) => i.done), [true, false, true]);
  const b2 = mkBoard([card('a', { dueDate: TODAY, repeat: R('FREQ=DAILY', TODAY), checklist: [{ text: 'x', done: true }] })]);
  K.completeCard(b2, 'a', { now: NOW, today: TODAY });
  eq('checklist is kept when resetChecklist is off', b2.cards.a.checklist[0].done, true);
}
{
  // COUNT and UNTIL end the series on the last completion.
  const b = mkBoard([card('a', { dueDate: TODAY, repeat: R('FREQ=DAILY;COUNT=2', TODAY) })]);
  const r1 = K.completeCard(b, 'a', { now: NOW, today: TODAY });
  const r2 = K.completeCard(b, 'a', { now: NOW + 864e5, today: '2026-11-17' });
  eq('COUNT=2: second completion ends the series', [r1.next, r2.next, K.isDone(b, 'a'), b.columns[2].cardIds.includes('a'), b.cards.a.doneLog.length], ['2026-11-17', null, true, true, 2]);
  K.uncompleteCard(b, 'a');
  eq('undo of the final completion reopens with the last due date', [K.isDone(b, 'a'), b.cards.a.dueDate, b.columns[0].cardIds.includes('a')], [false, '2026-11-17', true]);
  const u = mkBoard([card('a', { dueDate: '2026-11-18', repeat: R('FREQ=DAILY;UNTIL=20261118', TODAY) })]);
  eq('UNTIL: completing the last day ends the series', [K.completeCard(u, 'a', { now: NOW, today: '2026-11-18' }).next, K.isDone(u, 'a')], [null, true]);
  const ac = mkBoard([card('a', { dueDate: TODAY, repeat: R('FREQ=DAILY;COUNT=2', TODAY, null, TZ, 'afterCompletion') })]);
  K.completeCard(ac, 'a', { now: NOW, today: TODAY });
  eq('COUNT in after-completion mode counts completions', K.completeCard(ac, 'a', { now: NOW, today: '2026-11-19' }).next, null);
}
{
  // Non-repeating completion and done column rules.
  const b = mkBoard([card('a', { dueDate: TODAY, _col: 'doing' })]);
  const r = K.completeCard(b, 'a', { now: NOW, today: TODAY });
  eq('non-repeating completion sets completedAt and moves to Done', [r, b.cards.a.completedAt, b.columns[2].cardIds], [{ repeating: false, next: null }, new Date(NOW).toISOString(), ['a']]);
  K.uncompleteCard(b, 'a');
  check('uncompleteCard on a plain card clears completedAt and leaves Done', !b.cards.a.completedAt && !b.columns[2].cardIds.includes('a') && !K.isDone(b, 'a'));
  const flagged = mkBoard([], { doneName: 'Shipped', doneFlag: true });
  flagged.columns[0].name = 'Done';
  eq('doneColumn prefers the done:true flag over a name match', K.doneColumn(flagged).id, 'done');
  eq('doneColumn matches Completed by name', K.doneColumn(mkBoard([], { doneName: 'Completed' })).id, 'done');
  eq('doneColumn is null when no column matches', K.doneColumn(mkBoard([], { doneName: 'Shipped' })), null);
  const nodone = mkBoard([card('a')], { doneName: 'Shipped' });
  K.completeCard(nodone, 'a', { now: NOW, today: TODAY });
  check('completion without a done column sets completedAt in place', K.isDone(nodone, 'a') && nodone.columns[0].cardIds.includes('a'));
}

// ---------- smart views (V1–V4) over three boards ----------
{
  const inbox = mkBoard([card('i1'), card('i2', { dueDate: '2026-11-20' }), card('i3', { _col: 'done', completedAt: '2026-11-15T08:00:00.000Z' })], { id: 'inbox', inbox: true });
  const work = mkBoard([
    card('w1', { dueDate: '2026-11-10' }),                                   // overdue
    card('w2', { dueDate: TODAY, dueTime: '15:00' }),                        // today
    card('w3', { startDate: '2026-11-14', dueDate: '2026-11-25' }),          // started: today
    card('w4', { startDate: '2026-11-18' }),                                 // upcoming by start
    card('w5', { dueDate: TODAY, repeat: R('FREQ=WEEKLY;BYDAY=MO,TH', TODAY) }), // repeat: today + upcoming
    card('w6', { someday: true }),
    card('w7', { someday: true, dueDate: '2026-11-01' }),                    // someday hides it from overdue
    card('w8', { _col: 'done', completedAt: '2026-11-16T03:00:00.000Z', dueDate: '2026-11-12' }),
    card('w9', { dueDate: '2026-12-31' }),                                   // past the 14-day window
  ], { id: 'work' });
  const pers = mkBoard([
    card('p1'),
    card('p2', { dueDate: '2026-11-12', repeat: R('FREQ=DAILY', '2026-11-01'), doneLog: [
      { occ: '2026-11-10', at: '2026-11-10T09:00:00.000Z', kind: 'done', prevDue: '2026-11-10', prevStart: null },
      { occ: '2026-11-11', at: '2026-11-16T04:00:00.000Z', kind: 'skip', prevDue: '2026-11-11', prevStart: null }] }),
    card('p3', { dueDate: '2026-11-17', repeat: R('FREQ=WEEKLY;INTERVAL=2', '2026-11-17', null, TZ, 'afterCompletion') }),
  ], { id: 'pers' });
  const boards = [inbox, work, pers];
  const view = (n) => K.smartView(n, boards, { today: TODAY, now: NOW, tz: TZ }).map((r) => [r.cardId, r.day, r.section]);
  eq('smartView today: overdue section first, then today', view('today'), [
    ['w1', '2026-11-10', 'overdue'], ['p2', '2026-11-12', 'overdue'], ['w2', TODAY, 'today'], ['w3', TODAY, 'today'], ['w5', TODAY, 'today']]);
  eq('smartView overdue', view('overdue'), [['w1', '2026-11-10', 'overdue'], ['p2', '2026-11-12', 'overdue']]);
  const up = view('upcoming');
  eq('smartView upcoming: 14 days, repeat occurrences included, grouped by day', up, expectedUpcoming());
  check('smartView upcoming stays within today+1..today+14', up.every((r) => r[1] > TODAY && r[1] <= '2026-11-30'));
  eq('smartView anytime excludes someday and dated cards', view('anytime'), [['i1', null, 'anytime'], ['p1', null, 'anytime']]);
  eq('smartView someday', view('someday'), [['w6', null, 'someday'], ['w7', '2026-11-01', 'someday']]);
  eq('smartView logbook: done cards and doneLog entries, newest first', view('logbook'), [
    ['p2', '2026-11-11', 'skip'], ['w8', '2026-11-16', 'done'], ['i3', '2026-11-15', 'done'], ['p2', '2026-11-10', 'done']]);
  eq('smartView inbox: open cards on the Inbox board', view('inbox'), [['i1', null, 'inbox'], ['i2', '2026-11-20', 'inbox']]);
  const days7 = K.smartView('upcoming', boards, { today: TODAY, now: NOW, days: 7 });
  check('smartView upcoming honours days', days7.every((r) => r.day <= '2026-11-23') && days7.length > 0);
}
function expectedUpcoming() {
  // p2 daily from its due day (2026-11-12) onward: every day 17..30; w5 Mon/Thu after today; w4 by start; w3 is already started; i2 due 20th; p3 after-completion shows its due day only.
  const rows = [];
  for (let i = 1; i <= 14; i++) {
    const day = addDaysStr(TODAY, i);
    const dow = Temporal.PlainDate.from(day).dayOfWeek;
    if (day === '2026-11-20') rows.push(['i2', day, day]);
    if (day === '2026-11-18') rows.push(['w4', day, day]);
    if (dow === 1 || dow === 4) rows.push(['w5', day, day]);
    rows.push(['p2', day, day]);
    if (day === '2026-11-17') rows.push(['p3', day, day]);
  }
  const order = { i2: 0, w4: 1, w5: 2, p2: 3, p3: 4 };
  return rows.sort((a, b) => (a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : order[a[0]] - order[b[0]]));
}

// ---------- old cards behave as before (S1) ----------
{
  const old = { id: 'o1', title: 'Old', description: '', labelIds: [], memberIds: [], priority: 'none', dueDate: '2026-11-10', checklist: [], attachments: [], comments: [], createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z' };
  const oldDone = { ...old, id: 'o2', dueDate: null };
  const oldPlain = { ...old, id: 'o3', dueDate: null };
  const b = { id: 'ob', name: 'Old board', columns: [{ id: 'c1', name: 'To Do', cardIds: ['o1', 'o3'] }, { id: 'c2', name: 'Done', cardIds: ['o2'] }], cards: { o1: old, o2: oldDone, o3: oldPlain } };
  const snapshot = JSON.stringify(b);
  eq('old card: isDone follows the column', [K.isDone(b, 'o1'), K.isDone(b, 'o2')], [false, true]);
  eq('old card: Today lists a past dueDate as overdue', K.smartView('today', [b], { today: TODAY }).map((r) => [r.cardId, r.section]), [['o1', 'overdue']]);
  eq('old card: Anytime holds the undated open card', K.smartView('anytime', [b], { today: TODAY }).map((r) => r.cardId), ['o3']);
  eq('old card: Logbook uses updatedAt for a card in Done', K.smartView('logbook', [b], { today: TODAY }).map((r) => [r.cardId, r.day]), [['o2', '2025-01-02']]);
  check('old card: views and isDone do not mutate the board', JSON.stringify(b) === snapshot);
  eq('old card: validateTaskFields accepts it', K.validateTaskFields(old), true);
}

// ---------- validation ----------
eq('validateRepeat accepts a parsed repeat', K.validateRepeat(K.parseRepeat('every monday at 9', { today: TODAY, tz: TZ }).repeat), true);
check('validateRepeat rejects RRULE: prefix', typeof K.validateRepeat({ ...R('FREQ=DAILY', TODAY), rrule: 'RRULE:FREQ=DAILY' }) === 'string');
check('validateRepeat rejects a bad mode', typeof K.validateRepeat({ ...R('FREQ=DAILY', TODAY), mode: 'sometimes' }) === 'string');
check('validateRepeat rejects a bad zone', typeof K.validateRepeat({ ...R('FREQ=DAILY', TODAY), tz: 'Mars/Base' }) === 'string');
check('validateRepeat rejects HOURLY', typeof K.validateRepeat(R('FREQ=HOURLY', TODAY)) === 'string');
check('validateTaskFields rejects a bad dueTime', typeof K.validateTaskFields(card('x', { dueDate: TODAY, dueTime: '25:00' })) === 'string');
check('validateTaskFields rejects a reminder with both at and offsetMin', typeof K.validateTaskFields(card('x', { reminders: [{ id: 'r', at: '2026-11-16T09:00', offsetMin: 5 }] })) === 'string');
eq('validateTaskFields accepts the full new field set', K.validateTaskFields(card('x', { dueDate: TODAY, dueTime: '09:00', startDate: '2026-11-15', startTime: '08:00', someday: true, repeat: R('FREQ=DAILY', TODAY), reminders: [{ id: 'r1', at: '2026-11-16T08:30' }, { id: 'r2', offsetMin: 15 }], parentId: 'y', estimateMin: 30, completedAt: '2026-11-16T10:00:00.000Z', doneLog: [{ occ: TODAY, at: '2026-11-16T10:00:00.000Z', kind: 'done', prevDue: TODAY, prevStart: null }] })), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
