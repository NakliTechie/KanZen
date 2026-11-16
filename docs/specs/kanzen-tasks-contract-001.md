# KanZen tasks and habits — integration contract

**Doc ID:** kanzen-tasks-contract-001 · companion to `kanzen-tasks-parity-001.md` (the approved v1 scope).
**Purpose:** the shared shapes and function names that let four builders work in parallel. A module may add
functions; it may not change a shape or signature below without updating this file.

## Layout

| Path | Owner | What |
|---|---|---|
| `lib/vendor/kz-vendor-dates.js` | dates builder | IIFE bundle of chrono-node 2.10.3 (English), rrule-temporal 2.2.8 and temporal-polyfill 1.0.6, built by `scripts/build-vendor-dates.mjs` (esbuild 0.28.2, a dev dependency in `scripts/`). Exposes `globalThis.KzVendor = { chrono, RRuleTemporal }` and installs `globalThis.Temporal` only when it is missing. Licence notices sit in the bundle's leading comment. |
| `lib/kz-tasks.js` | dates builder | `globalThis.KzTasks` |
| `lib/kz-habits.js` | habits builder | `globalThis.KzHabits` |
| `lib/kz-reminders.js` | reminders builder | `globalThis.KzReminders` |
| `lib/kz-interop.js` | reminders builder | `globalThis.KzInterop` |
| `lib/kz-queue.js` | reminders builder | `globalThis.KzQueue` |
| `scripts/test-tasks-*.mjs` | each builder its own | node tests, no browser |
| `index.html` | UI builder only | everything else |
| `scripts/splice-lib.mjs` | integrator | copies each `lib/` file into `index.html` between `/* kz-lib:<name>:begin */` and `/* kz-lib:<name>:end */`; `--check` fails on drift |

Module rules:

- Each `lib/` file is a classic script (no `import`/`export`), wrapped as
  `(function(root){ 'use strict'; … root.KzX = api; })(typeof globalThis !== 'undefined' ? globalThis : this);`
  so the browser gets a global and a node test gets it from `await import(pathToFileURL(file))` or `vm`.
- Pure functions. No DOM, no `Date.now()` inside logic: callers pass `now` (ms) and `today` (`YYYY-MM-DD`).
  Browser-only effects (timers, locks, Notification, IndexedDB) are injected as parameters.
- Dates: `YYYY-MM-DD` strings for days, `HH:MM` strings for times, ms numbers for instants, `tz` an IANA zone name
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Days and times are floating local values.
- No GPL code. Loop's score is reimplemented from its formula.

## Card fields (all optional; an old card has none of them and behaves as before)

| Field | Shape | Meaning |
|---|---|---|
| `dueDate` | `YYYY-MM-DD` | existing: the deadline |
| `dueTime` | `HH:MM` | optional time on the due date (F2) |
| `startDate` | `YYYY-MM-DD` | when to begin (F1) |
| `startTime` | `HH:MM` | optional time on the start date |
| `someday` | `true` | parked (F3); absent means false |
| `repeat` | `{ rrule, time, mode, tz, anchor, resetChecklist }` | `rrule`: RFC 5545 body without `RRULE:` and without DTSTART (`FREQ=WEEKLY;BYDAY=MO`); `time`: `HH:MM` or `null`; `mode`: `fixed` or `afterCompletion`; `tz`: zone name at creation; `anchor`: `YYYY-MM-DD` DTSTART day; `resetChecklist`: boolean (R6) |
| `reminders` | `[{ id, at }]` or `[{ id, offsetMin }]` | `at`: floating `YYYY-MM-DDTHH:MM`; `offsetMin`: minutes before the due moment (due date plus `dueTime`, else 09:00). `snooze: true` marks a one-shot reminder created by snooze (N5), removed after it fires |
| `parentId` | card id on the same board | subtask (F4), one level |
| `estimateMin` | integer | stored only (F5 is v1.x) |
| `completedAt` | ISO string | set when a non-repeating card completes |
| `doneLog` | `[{ occ, at, kind, prevDue, prevStart }]` | repeating cards: `occ` the scheduled day completed or skipped, `at` ISO time, `kind` `done` or `skip`, `prevDue`/`prevStart` the dates before advancing |

Board additions: `board.inbox: true` on the Inbox board; `board.reminderLog: { "<key>": "<ISO fired>" }` the
fired-reminder log (N3), pruned to 30 days; a column may carry `done: true` to mark the done column.

**Done rule:** `KzTasks.doneColumn(board)` is the column with `done: true`, else the first column whose name matches
`/^(done|completed?|finished)$/i`, else `null`. A card is done when it sits in the done column or has `completedAt`.

Reminder key: `card:<boardId>:<cardId>:<reminderId>:<fireAt YYYY-MM-DDTHH:MM>` and
`habit:<habitId>:<reminderId>:<day>`.

## Habit store

`habits.json`: `{ "version": 1, "habits": [habit…] }` beside the boards (FS root, NakliOS root, or the IDB
`settings` store under key `habits`).

```
habit = { id, name, color, order, createdAt,
  schedule: {type:'daily'} | {type:'weekdays', days:[1..7]  (ISO, 1 = Monday)} |
            {type:'xPerWeek', n} | {type:'xInDays', n, m},
  dayEndHour: 0..23 (default 0), reminders: [{ id, at:'HH:MM' }], paused: null | 'YYYY-MM-DD', archived: false }
```

`habit-log.jsonl`: one JSON object per line, `{ habitId, day, value, at, op }`, `op` one of `set`, `clear`,
`skip`; `value` 1 for `set`, 0 otherwise; `at` ms. Latest `at` per `habitId + day` wins; a tie goes to the later
line. Lines are only appended. IDB stores the lines as an array under `settings` key `habitLog`.

## Function names

### KzTasks (`lib/kz-tasks.js`)

- `parseQuickAdd(text, { now, today, tz, boards, defaultBoardId })` → `{ title, boardId, columnId, labelIds,
  newLabels, priority, dueDate, dueTime, startDate, startTime, repeat, someday, parts }`. `boards` is
  `[{ id, name, inbox, columns:[{id,name}], labels:[{id,name}] }]`. `parts` is
  `[{ kind, text, start, end, value }]` with `kind` one of `date`, `deadline`, `repeat`, `board`, `column`,
  `label`, `priority`; `start`/`end` index the input so a UI can cut a part out and parse again (C5).
  Tokens: `#board`, `/column`, `@label`, `p1`–`p4` (p1 urgent, p2 high, p3 medium, p4 low), `{phrase}` deadline.
  A plain date phrase sets `dueDate`; when a `{deadline}` is also present, the plain phrase sets `startDate` instead.
- `parseRepeat(phrase, { today, tz })` → `{ repeat, start, end }` or `null` (C3, own grammar).
- `describeRepeat(repeat)` → `"Every Monday at 09:00"`.
- `nextOccurrence(repeat, afterDay)` → first occurrence day strictly after `afterDay`, or `null` when the series ended.
- `occurrencesBetween(repeat, fromDay, toDay, limit)` → days (V2, V11).
- `completeCard(board, cardId, { now, today })` → `{ repeating, next }`. Repeating: logs `done`, advances
  `dueDate` (and `startDate`, keeping the gap), resets the checklist when asked. Non-repeating: sets
  `completedAt` and moves the card to the done column when one exists. Fixed mode: next = first occurrence
  strictly after max(current due, today). After-completion mode: counts from `today`.
- `uncompleteCard(board, cardId)` → reverses the last `completeCard` (agents; the UI uses board undo).
- `skipOccurrence(board, cardId, { now, today })`, `endSeries(board, cardId, { now })` (R5).
- `isDone(board, cardId)`, `doneColumn(board)`.
- `smartView(name, boards, { today, now, days })` with `name` one of `today`, `upcoming`, `anytime`,
  `someday`, `logbook`, `inbox`, `overdue` → `[{ boardId, cardId, day, section }]`. Today returns sections
  `overdue` and `today`; Upcoming returns one row per day for 14 days (repeat occurrences included, `section` =
  day); Logbook returns done cards and `doneLog` entries, newest first.
- `validateRepeat(repeat)` → `true` or an error string; `validateTaskFields(card)` for imports and agents.

### KzHabits (`lib/kz-habits.js`)

- `dayFor(atMs, dayEndHour, tz)` → `YYYY-MM-DD` (H5).
- `parseLog(text)` → lines (bad lines skipped and counted); `serializeLine(line)`.
- `fold(lines)` → `Map(habitId → Map(day → { value, op, at }))`.
- `makeLine(habitId, day, op, nowMs)`; `inverseLine(folded, habitId, day, nowMs)` (undo: restores the prior state).
- `isScheduled(habit, day)`, `status(habit, folded, day)` → `done`, `skipped`, `missed`, `off`, `paused`, `open`.
- `streaks(habit, folded, today)` → `{ current, best, unit }` (H6).
- `score(habit, folded, today)` → 0..1 using `multiplier = 0.5 ** (Math.sqrt(freq) / 13)` (H7).
- `completionRate(habit, folded, today, days)`; `heatmapSvg(habit, folded, today, { weeks })` → SVG string (H8).
- `validateHabit(habit)`; `newHabit(fields, nowMs)`.

### KzReminders (`lib/kz-reminders.js`)

- `instances(boards, habitsDoc, folded, { now, today, tz, horizonDays })` → `[{ key, kind, boardId, cardId,
  habitId, reminderId, title, fireAt, fireAtLocal }]`.
- `split(instances, isFired, { now, graceMs })` → `{ fireNow, missed, later }` (N2, N4).
- `snooze(card, untilLocal)` → adds `{ id, at, snooze:true }` (N5); `snoozeTargets(nowMs)` → 10 min, 1 hour,
  tomorrow 09:00.
- `createScheduler({ getInstances, isFired, markFired, deliver, now, setTimer, clearTimer, locks, onMissed })` →
  `{ start, stop, recompute, isLeader }`; the leader holds `locks.request('kanzen-reminders')`; `recompute` runs on
  start, on each timer and on `visibilitychange` (the caller wires that event).
- `pruneLog(reminderLog, nowMs, days)`.

### KzInterop (`lib/kz-interop.js`)

- `toIcs(boards, { now, prodId })` → VCALENDAR text, one VTODO per open dated card, floating DTSTART/DUE, RRULE,
  VALARM per reminder (N6, X3).
- `parseTodoTxt(text, { today })` → `{ tasks, warnings }`; `toTodoTxt(boards)` (X1). Task draft shape:
  `{ title, description, priority, dueDate, startDate, done, completedAt, projects, contexts, repeat }`.
- `parseTodoistCsv(text, { today, parseRepeat })` → `{ tasks, sections, warnings, lost }` (X2); the delimiter is detected.
- `csvExtraColumns` and `csvExtraValues(card)` → start date, start time, due time, repeat, completed at, someday,
  parent (X8).

### KzQueue (`lib/kz-queue.js`)

- `createQueue(store)` where `store` is `{ get(key), put(key, value), del(key), keys() }` (memory in tests,
  IndexedDB in the app) → `{ enqueue(op), pending(), drain(apply) }`. Ops: `{ kind:'board', boardId, json }`
  (latest per board wins), `{ kind:'habits', json }`, `{ kind:'habitLine', line }` (all kept, in order).
  `drain` applies in order and removes each op only after `apply` resolves (S3).

## UI contract (index.html)

- Quick-add bar: `Q` from anywhere opens it; it writes to the Inbox board (created on first run, `board.inbox`).
- A Tasks mode beside the board switcher with Today, Upcoming, Anytime, Someday, Logbook and Inbox tabs.
- Card editor gains start date and time, due time, someday, repeat (phrase input plus summary), reminders,
  parent, and Complete / Skip / End series buttons.
- Habits panel: list, check-in, backfill on the heatmap, skip, pause, edit schedule, day-end hour.
- Every new control is a `KZ_TOOLS` entry; `commands.json` gains `task.capture`, `task.complete`, `task.defer`,
  `task.snooze`, `task.query`, `habit.list`, `habit.checkin`, each with a `KZ_COMMANDS` handler.
