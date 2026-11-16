// Node tests for lib/kz-interop.js. Run: node scripts/test-tasks-interop.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'lib/kz-interop.js'), 'utf8'), { filename: 'kz-interop.js' });
const X = globalThis.KzInterop;

let pass = 0, fail = 0;
async function check(name, fn){
  try{ await fn(); pass++; console.log(`ok   ${name}`); }
  catch(e){ fail++; console.log(`FAIL ${name}\n     ${e && e.message}`); }
}

// Stub for KzTasks.parseRepeat (the real one lives in lib/kz-tasks.js and is not loaded here).
const DAYS = { monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA', sunday: 'SU' };
function parseRepeat(phrase, { today, tz } = {}){
  const p = phrase.trim().toLowerCase();
  const mk = (rrule) => ({ repeat: { rrule, time: null, mode: 'fixed', tz: tz || 'UTC', anchor: today, resetChecklist: false }, start: 0, end: phrase.length });
  let m;
  if((m = /^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.exec(p))) return mk(`FREQ=WEEKLY;BYDAY=${DAYS[m[1]]}`);
  if(p === 'every weekday') return mk('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  if((m = /^every (day|week|month|year)$/.exec(p))) return mk(`FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[1]]}`);
  if((m = /^every (\d+) (day|week|month|year)s$/.exec(p))) return mk(`FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[2]]};INTERVAL=${m[1]}`);
  return null;
}

// ---------- iCalendar ----------
const NOW = Date.UTC(2026, 10, 16, 2, 30, 5);
const longDesc = 'Line one, with a comma; a semicolon and a backslash \\ here.\nLine two has unicode: नमस्ते दुनिया — and enough text to need folding twice over at seventy-five octets.';
const boards = [{
  id: 'b1', name: 'Home Admin',
  labels: [{ id: 'l1', name: 'finance' }, { id: 'l2', name: 'Phone, calls' }],
  columns: [{ id: 'c1', name: 'To do', cardIds: ['k1', 'k2', 'k3', 'k6', 'k7'] }, { id: 'c2', name: 'Done', cardIds: ['k4'] }],
  cards: {
    k1: { id: 'k1', title: 'Pay rent, Nov; ok\\', description: longDesc, priority: 'urgent', dueDate: '2026-11-20', dueTime: '10:00',
      labelIds: ['l1', 'l2'], reminders: [{ id: 'r1', offsetMin: 30 }, { id: 'r2', at: '2026-11-19T07:58' }], createdAt: Date.UTC(2026, 10, 1, 5) },
    k2: { id: 'k2', title: 'Water plants', priority: 'low', dueDate: '2026-11-17',
      repeat: { rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101T000000Z', time: null, mode: 'fixed', tz: 'Asia/Kolkata', anchor: '2026-11-16', resetChecklist: false },
      reminders: [{ id: 'r1', offsetMin: 60 }] },
    k3: { id: 'k3', title: 'Sub task', parentId: 'k1', startDate: '2026-11-18', dueDate: '2026-11-19', priority: 'medium', labelIds: ['l1'] },
    k4: { id: 'k4', title: 'Done thing', dueDate: '2026-11-10', priority: 'high', completedAt: '2026-11-10T08:00:00.000Z', createdAt: '2026-11-02T08:00:00.000Z' },
    k6: { id: 'k6', title: 'No date', priority: 'high' },
    k7: { id: 'k7', title: 'Completed flag', dueDate: '2026-11-21', completedAt: '2026-11-15T08:00:00Z' }
  }
}];
const ics = X.toIcs(boards, { now: NOW, prodId: '-//Test//KanZen//EN' });
const physical = ics.split('\r\n');
const unfolded = ics.replace(/\r\n /g, '').split('\r\n');

await check('ICS: CRLF line endings only, ends with CRLF, VCALENDAR 2.0 header', () => {
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'bare LF found');
  assert.deepEqual(unfolded.slice(0, 4), ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//KanZen//EN', 'CALSCALE:GREGORIAN']);
  assert.equal(unfolded.at(-2), 'END:VCALENDAR');
});
await check('ICS: every physical line is at most 75 octets and folded lines start with a space', () => {
  for(const l of physical) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `too long: ${l}`);
  assert.ok(physical.some(l => l.startsWith(' ')), 'expected at least one folded line');
});
await check('ICS: escaping of , ; \\ and newlines survives folding', () => {
  assert.ok(unfolded.includes('SUMMARY:Pay rent\\, Nov\\; ok\\\\'));
  const d = unfolded.find(l => l.startsWith('DESCRIPTION:Line one'));
  assert.equal(d, 'DESCRIPTION:' + longDesc.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'));
});
await check('ICS: one VTODO per open dated card (done and undated skipped)', () => {
  const uids = unfolded.filter(l => l.startsWith('UID:'));
  assert.deepEqual(uids, ['UID:k1@b1.kanzen', 'UID:k2@b1.kanzen', 'UID:k3@b1.kanzen']);
});
await check('ICS: floating DUE, DATE values, DTSTAMP in UTC, STATUS, PRIORITY', () => {
  assert.ok(unfolded.includes('DUE:20261120T100000'));
  assert.ok(unfolded.includes('DUE;VALUE=DATE:20261117'));
  assert.ok(unfolded.includes('DTSTART;VALUE=DATE:20261118'));
  assert.ok(unfolded.includes('DTSTAMP:20261116T023005Z'));
  assert.ok(!unfolded.some(l => /^(DUE|DTSTART)[:;].*Z$/.test(l) || /TZID/.test(l)));
  assert.equal(unfolded.filter(l => l === 'STATUS:NEEDS-ACTION').length, 3);
  assert.deepEqual(unfolded.filter(l => l.startsWith('PRIORITY:')), ['PRIORITY:1', 'PRIORITY:7', 'PRIORITY:5']);
});
await check('ICS: RRULE with UNTIL as DATE, DTSTART added for a repeating card', () => {
  assert.ok(unfolded.includes('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101'));
  const i = unfolded.indexOf('UID:k2@b1.kanzen');
  assert.ok(unfolded.slice(i, i + 8).includes('DTSTART;VALUE=DATE:20261117'));
});
await check('ICS: RELATED-TO parent and CATEGORIES', () => {
  assert.ok(unfolded.includes('RELATED-TO;RELTYPE=PARENT:k1@b1.kanzen'));
  assert.ok(unfolded.includes('CATEGORIES:finance,Phone\\, calls'));
});
await check('ICS: VALARM triggers (relative to DUE, absolute floating, 09:00 rule)', () => {
  assert.equal(unfolded.filter(l => l === 'BEGIN:VALARM').length, 3);
  assert.equal(unfolded.filter(l => l === 'ACTION:DISPLAY').length, 3);
  assert.ok(unfolded.includes('TRIGGER;RELATED=END:-PT30M'));
  assert.ok(unfolded.includes('TRIGGER;VALUE=DATE-TIME:20261119T075800'));
  assert.ok(unfolded.includes('TRIGGER;VALUE=DATE-TIME:20261117T080000'));
});
await check('ICS: absolute triggers are UTC when the zone converter is given (RFC 5545 3.8.6.3)', () => {
  // Fixed +05:30 converter, as Asia/Kolkata has no DST.
  const localToMs = s => Date.UTC(+s.slice(0,4), +s.slice(5,7) - 1, +s.slice(8,10), +s.slice(11,13), +s.slice(14,16)) - 330 * 60000;
  const u = X.toIcs(boards, { now: NOW, localToMs }).replace(/\r\n[ \t]/g, '').split('\r\n');
  assert.ok(u.includes('TRIGGER;VALUE=DATE-TIME:20261119T022800Z'));
  assert.ok(u.includes('TRIGGER;VALUE=DATE-TIME:20261117T023000Z'));
  assert.ok(!u.some(l => /^TRIGGER;VALUE=DATE-TIME:\d{8}T\d{6}$/.test(l)));
});
await check('ICS: foldLine never splits a multi-byte character', () => {
  const s = 'X:' + 'é'.repeat(100);
  const parts = X.foldLine(s).split('\r\n');
  for(const p of parts) assert.ok(Buffer.byteLength(p) <= 75);
  assert.equal(parts.map((p, i) => i ? p.slice(1) : p).join(''), s);
});

// ---------- todo.txt ----------
await check('todo.txt: primer examples parse', () => {
  const { tasks, warnings } = X.parseTodoTxt([
    '(A) Thank Mom for the meatballs @phone',
    'x 2011-03-02 2011-03-01 Review Tim\'s pull request +TodoTxtTouch @github pri:B',
    '(B) 2011-03-01 Call Mom +Family due:2011-03-05 t:2011-03-02 rec:+1w see https://example.com/x',
    '(D) Bad date due:2011-02-30',
    '',
    'Plain task rec:2d'
  ].join('\n'), { today: '2011-03-01', parseRepeat });
  assert.equal(tasks.length, 5);
  assert.deepEqual([tasks[0].title, tasks[0].priority, tasks[0].contexts], ['Thank Mom for the meatballs', 'urgent', ['phone']]);
  assert.deepEqual([tasks[1].done, tasks[1].completedAt, tasks[1].createdDate, tasks[1].projects, tasks[1].priority], [true, '2011-03-02', '2011-03-01', ['TodoTxtTouch'], 'high']);
  assert.equal(tasks[2].title, 'Call Mom see https://example.com/x');
  assert.deepEqual([tasks[2].dueDate, tasks[2].startDate, tasks[2].createdDate], ['2011-03-05', '2011-03-02', '2011-03-01']);
  assert.deepEqual([tasks[2].repeat.rrule, tasks[2].repeat.mode], ['FREQ=WEEKLY', 'fixed']);
  assert.equal(tasks[3].priority, 'low'); assert.equal(tasks[3].dueDate, null);
  assert.ok(warnings.some(w => w.includes('due:2011-02-30')));
  assert.deepEqual([tasks[4].repeat.rrule, tasks[4].repeat.mode], ['FREQ=DAILY;INTERVAL=2', 'afterCompletion']);
});
await check('todo.txt: rec without parseRepeat warns and keeps the raw value', () => {
  const { tasks, warnings } = X.parseTodoTxt('Task rec:1w', {});
  assert.equal(tasks[0].repeat, null); assert.equal(tasks[0].extras.rec, '1w');
  assert.equal(warnings.length, 1);
});
await check('todo.txt: export then import round trip keeps title, priority, dates, board, labels, done, repeat', () => {
  const txt = X.toTodoTxt(boards, { tz: 'UTC' });
  const lines = txt.trim().split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '(A) 2026-11-01 Pay rent, Nov; ok\\ +Home_Admin @finance @Phone,_calls due:2026-11-20');
  assert.equal(lines[1], '(D) Water plants +Home_Admin due:2026-11-17');
  const { tasks } = X.parseTodoTxt(txt, { parseRepeat, today: '2026-11-16' });
  const cards = boards[0].cards;
  const order = ['k1', 'k2', 'k3', 'k6', 'k7', 'k4'];
  tasks.forEach((t, i) => {
    const c = cards[order[i]];
    assert.equal(t.title, c.title);
    assert.equal(t.priority, c.priority || 'none');
    assert.equal(t.dueDate, c.dueDate || null);
    assert.equal(t.startDate, c.startDate || null);
    assert.deepEqual(t.projects, ['Home_Admin']);
    assert.equal(t.done, !!(c.completedAt || order[i] === 'k4'));
  });
  assert.equal(tasks[5].completedAt, '2026-11-10'); assert.equal(tasks[5].createdDate, '2026-11-02');
  const rb = [{ id: 'b', name: 'R', columns: [{ id: 'c', name: 'Todo', cardIds: ['a', 'b'] }], cards: {
    a: { title: 'Every 2 weeks', dueDate: '2026-11-20', repeat: { rrule: 'FREQ=WEEKLY;INTERVAL=2', mode: 'fixed' } },
    b: { title: 'Weekdays after', dueDate: '2026-11-20', repeat: { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', mode: 'afterCompletion' } } } }];
  const rt = X.parseTodoTxt(X.toTodoTxt(rb), { parseRepeat, today: '2026-11-16' }).tasks;
  assert.deepEqual(rt.map(t => [t.repeat.rrule, t.repeat.mode]), [['FREQ=WEEKLY;INTERVAL=2', 'fixed'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'afterCompletion']]);
});

// ---------- Todoist CSV ----------
const fixture = fs.readFileSync(path.join(root, 'test/fixtures/todoist-sample.csv'), 'utf8');
function expectTodoist(res){
  const { tasks, sections, lost } = res;
  assert.deepEqual(sections.map(s => s.name), ['Errands']);
  assert.deepEqual(tasks.map(t => t.title), ['Water the plants', 'File the tax return', 'Gather receipts', 'Scan the medical receipts', 'Buy groceries', 'Call the plumber', 'Renew passport']);
  const [water, tax, gather, scan, groceries, plumber, passport] = tasks;
  assert.deepEqual([water.contexts, water.priority, water.repeat.rrule, water.dueDate], [['home'], 'none', 'FREQ=WEEKLY;BYDAY=MO', '2026-11-16']);
  assert.equal(tax.description, 'Collect Form 16 first.\nThen the bank statements, both accounts.');
  assert.deepEqual([tax.priority, tax.startDate, tax.dueDate, tax.estimateMin, tax.contexts], ['urgent', '2026-11-20', '2026-11-30', 30, ['finance']]);
  assert.deepEqual([gather.priority, gather.parentId], ['high', tax.importId]);
  assert.deepEqual([scan.priority, scan.parentId], ['medium', tax.importId]);
  assert.deepEqual(scan.comments.map(c => c.text), ['Ask the accountant about 80D.']);
  assert.deepEqual([water.section, tax.section, groceries.section, passport.section], [null, null, 'Errands', 'Errands']);
  assert.deepEqual([groceries.dueDate, groceries.dueTime, groceries.assignee], ['2026-11-18', '17:00', 'Second User (40000002)']);
  assert.equal(plumber.dueDate, null);
  assert.ok(plumber.description.includes('Todoist date: someday soon'));
  assert.deepEqual([passport.repeat.rrule, passport.repeat.mode], ['FREQ=MONTHLY;INTERVAL=3', 'afterCompletion']);
  assert.ok(lost.some(l => /completed tasks/i.test(l)));
  assert.ok(lost.some(l => /start anchors/i.test(l)));
  assert.ok(lost.some(l => /flattened/.test(l) && l.includes('Scan the medical receipts')));
  assert.ok(lost.some(l => l.includes('someday soon')));
}
await check('Todoist CSV (comma): tasks, sections, notes, indents, priorities, repeat, deadline, lost', () => {
  const res = X.parseTodoistCsv(fixture, { today: '2026-11-16', tz: 'Asia/Kolkata', parseRepeat });
  assert.equal(res.delimiter, ',');
  expectTodoist(res);
});
await check('Todoist CSV (semicolon, CRLF): same result', () => {
  const rows = X.parseCsv(fixture, ',');
  const q = (f) => /[";\r\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f;
  const semi = rows.map(r => r.map(q).join(';')).join('\r\n');
  const res = X.parseTodoistCsv(semi, { today: '2026-11-16', tz: 'Asia/Kolkata', parseRepeat });
  assert.equal(res.delimiter, ';');
  expectTodoist(res);
});
await check('Todoist CSV without parseRepeat keeps recurring dates in the description and lost', () => {
  const res = X.parseTodoistCsv(fixture, { today: '2026-11-16' });
  assert.equal(res.tasks[0].repeat, null);
  assert.ok(res.tasks[0].description.includes('every monday'));
  assert.ok(res.lost.some(l => l.includes('every monday')));
});
await check('plain date forms: ISO, today, month-day with time, day-month-year, year roll-over', () => {
  const p = (s) => X.parsePlainDate(s, '2026-11-16');
  assert.deepEqual(p('2026-12-01 14:30'), { day: '2026-12-01', time: '14:30' });
  assert.deepEqual(p('tomorrow at 9am'), { day: '2026-11-17', time: '09:00' });
  assert.deepEqual(p('20 Nov 2027'), { day: '2027-11-20', time: null });
  assert.deepEqual(p('Jan 3'), { day: '2027-01-03', time: null });
  assert.deepEqual(p('November 30 5:15 pm'), { day: '2026-11-30', time: '17:15' });
  assert.equal(p('Feb 30 2027'), null);
  assert.equal(p('next week'), null);
});

// ---------- X8 extra CSV columns ----------
await check('CSV extra columns and values', () => {
  assert.deepEqual(X.csvExtraColumns, ['start date', 'start time', 'due time', 'repeat', 'completed at', 'someday', 'parent']);
  const b = boards[0];
  assert.deepEqual(X.csvExtraValues(b.cards.k3, b), ['2026-11-18', '', '', '', '', '', 'Pay rent, Nov; ok\\']);
  assert.deepEqual(X.csvExtraValues({ startTime: '08:00', dueTime: '10:00', someday: true, completedAt: 'Z', repeat: { rrule: 'FREQ=DAILY', mode: 'afterCompletion' }, parentId: 'zz' }),
    ['', '08:00', '10:00', 'FREQ=DAILY (after completion)', 'Z', 'yes', 'zz']);
  assert.equal(X.csvExtraValues(b.cards.k2, b, { describeRepeat: () => 'Every Monday' })[3], 'Every Monday');
  assert.deepEqual(X.csvExtraValues({}), ['', '', '', '', '', '', '']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
