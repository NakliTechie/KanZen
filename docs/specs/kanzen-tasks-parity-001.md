# KanZen Tasks and Habits — parity matrix

**Doc ID:** kanzen-tasks-parity-001
**Status:** v1 BUILT 2026-11-16 (approved the same day). Commits afac9fe, e3edd31, 3a49705, b4428fb and the docs commit. Every v1 row notes the check that ran; "Not checked" marks what did not. Contract: `kanzen-tasks-contract-001.md`.
**Reference systems:** Todoist (quick add, repeat semantics, filters), Things 3 (start versus deadline, Today / Upcoming / Anytime / Someday), Microsoft To Do (My Day), TickTick (matrix, Pomodoro, habits), Google Tasks and Apple Reminders (defaults); Streaks, Loop Habit Tracker and Habitica for habits.
**Evidence:** the VERIFIED research run `naklios/plan/research/2026-11-16-kanzen-tasks-habits/report.md` (8 sections, all gates pass, claim sample 8 supported, 2 partial, 0 unsupported; 3 items not covered, listed at its end). Rows marked R come from its design and v1 sections.

## How to read this matrix

The feature's core job is one sentence: **capture a task in one line, see what is due today across every board, repeat it on a schedule, get reminded while KanZen is open, and keep daily habits beside the work, all in files on your own disk.**

Each row has one scope value:

- **v1**: in the first release. The Feature batch ends when every v1 row passes its check.
- **v1.x**: wanted, built after v1, in the order listed.
- **Waived**: out of scope by default, because it is outside the core job, needs a server, or the browser cannot do it well. Chirag can un-waive any row.

`Src`: **To** Todoist, **Th** Things 3, **MS** Microsoft To Do, **TT** TickTick, **G** Google Tasks, **Ap** Apple Reminders, **St** Streaks, **Lp** Loop, **Hb** Habitica, **B** most of them, **R** the research report's design.

## Design (from the research, decided here unless Chirag objects)

- **A task is a KanZen card.** Status stays the column. The card gains `startDate`, `someday`, `repeat` (`{rrule, time, mode: fixed | afterCompletion}`), `reminders`, `parentId`, `estimateMin`, `completedAt` and an append-only `doneLog`. A separate task store would duplicate undo, snapshots, team mode, CSV export, sync and the agent proposals.
- **One card per repeating task** (the Vikunja shape): completing it logs the occurrence and advances the next date; undo pops the log entry and restores the date in one step. No pile of copies.
- **Smart views are queries, not boards:** Today = start or due on or before today, not done; Upcoming = start after today; Anytime = no start, not Someday; Someday = flagged; Overdue = due before today; Logbook = done, newest first. They run over an in-memory index of all loaded boards.
- **Inbox is a board** created by default and the target of quick capture.
- **Dates:** repeats stored as an RFC 5545 RRULE with a floating local time plus the zone name, so "every Monday at 9" stays at 9 across travel and daylight saving. `rrule-temporal` (MIT) expands rules on `Temporal`, with the polyfill where `Temporal` is missing; `chrono-node` (MIT, English build) reads dates; a small grammar of our own maps "every …" phrases to RRULEs, because rrule.js text parsing is documented as incomplete.
- **Habits are not cards.** `habits.json` holds definitions (schedule, target, day-end hour); `habit-log.jsonl` holds check-ins, one line per event `{habitId, day, value, at, op}`, latest line per habit and day wins. Append-only, merge-safe in team mode, undoable. Streak and a Loop-style score (exponential moving average, reimplemented from the formula, not from GPL code) are computed on read.
- **Reminders fire while a KanZen window is open:** an in-page scheduler that recomputes from the clock on every wake and on `visibilitychange`, one leader tab through Web Locks, a `Notification` when permitted and an in-app toast otherwise, and a fired-reminder log in the board file so two windows never fire the same reminder. On open, anything that came due while closed shows as "missed". Closed-browser delivery goes through `.ics` export with `VALARM` into the person's own calendar.
- **Lapsed folder permission:** a pending-write queue in IndexedDB holds completions, check-ins and fired-reminder records until access is granted again.

## 1. Capture

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| C1 | Quick-add bar (Q or N from anywhere) that creates a card in the Inbox board | B | v1 | **Checked:** Chrome: Q (real key) opened the bar; Enter created the card in Inbox. |
| C2 | Natural-language dates in quick add: "tomorrow 3pm", "next Fri", "in 3 days" | To TT Th | v1 | chrono-node English build · **Checked:** node: test-tasks-dates (80 phrases); Chrome: "today 6pm", "tomorrow 7pm". |
| C3 | Repeat phrases in quick add: "every Monday at 9", "every 2 weeks", "every weekday", "every 3rd of the month" | To | v1 | Own grammar to RRULE; fixture table of 50 phrases · **Checked:** node: test-tasks-dates phrase table with DST dates; Chrome: "every month on the 1st at 9" gave FREQ=MONTHLY;BYMONTHDAY=1 at 09:00. |
| C4 | Inline tokens: `#board`, `/column`, `@label`, `p1`–`p4`, `{deadline}` | To | v1 | Todoist-compatible where it fits KanZen · **Checked:** node: test-tasks-dates; Chrome: @bills created the label, p1/p2 set priority, {next fri} set the due date. |
| C5 | Live preview of what the bar understood, with each part removable | To | v1 | **Checked:** Chrome: chips for repeat, p1 and @label; removing the p1 chip re-parsed without it. |
| C6 | Capture from another NakliOS app through a command (`task.capture`) | R | v1 | Covered by the agent rows · **Checked:** Hosted stand-in: `task.capture` returned a proposal; once approved, "Buy milk" was due 2026-11-17 19:00. |
| C7 | AI capture of long or vague text into fields (through the NakliOS host model) | To | v1.x | Fills the same fields as the parser; works with AI off |
| C8 | Email-to-task | To Th | Waived | Needs a mail server |
| C9 | Voice capture | TT Ap | v1.x | Through the NakliOS voice assistant once it can call KanZen commands |

## 2. Task fields

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| F1 | Start date (when to begin) separate from due date (deadline) | Th TT G | v1 | `startDate` beside the existing `dueDate` · **Checked:** node: test-tasks-dates; Chrome: editor start date field; todo.txt `t:` imports as start. |
| F2 | Optional time on start and due | B | v1 | Date-only tasks remind at a default 9:00, as Apple and Google do · **Checked:** node: dates and reminders tests (09:00 default); Chrome: due time 18:00 shown and fired. |
| F3 | Someday flag (parked, hidden from Anytime) | Th | v1 | **Checked:** node: smartView; Chrome: "Learn Spanish someday" listed only in Someday. |
| F4 | Subtasks as child cards (one level), beside the existing checklist | To Ap G | v1 | `parentId`; the checklist stays for light steps · **Checked:** node: Todoist INDENT to parentId (interop test). Chrome: editor "Subtask of" picker renders. Not checked: assigning a parent through the editor. |
| F5 | Estimate in minutes | TT To | v1.x | Feeds time blocking |
| F6 | Priority p1–p4 mapped onto KanZen's existing priority | To | v1 | Existing field · **Checked:** node: p1–p4 mapping; Chrome: p2 gave high. |
| F7 | Location reminders | Ap TT | Waived | Browsers have no background geofence |

## 3. Repeating tasks

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| R1 | Repeat on a fixed schedule (daily, weekly on chosen days, monthly by date or weekday, yearly, every N) | B | v1 | RRULE `FREQ`, `INTERVAL`, `BYDAY`, `BYMONTHDAY`, `COUNT`, `UNTIL` · **Checked:** node: test-tasks-dates (FREQ, INTERVAL, BYDAY, BYMONTHDAY, COUNT, UNTIL). |
| R2 | Repeat after completion ("every! 3 months" counts from the day you finish) | To TT Th | v1 | `mode: afterCompletion` · **Checked:** node: Todoist's worked example (fixed 10 Apr, after completion 20 Apr). |
| R3 | Completing advances the next date and logs the occurrence on the card | To | v1 | `doneLog`; one card, no copies · **Checked:** Chrome: completing "Water plants" moved it to 2026-11-17 and logged one entry. |
| R4 | Undo a completion in one step (log entry and date both restored) | To | v1 | **Checked:** Chrome: one Cmd+Z restored the date and removed the log entry. |
| R5 | Skip one occurrence; end the series ("complete forever") | To Th | v1 | **Checked:** node: dates test; Chrome: skip advanced and logged `skip`; end series completed the card; undo restored both. |
| R6 | Reset checklist items when a repeating task comes back | To | v1 | Optional per card · **Checked:** node: test-tasks-dates reset-checklist case. |
| R7 | Edit one occurrence only, or the rule for all future ones | Th | v1.x | Things 3.23's "Make Exception / Update Rule" |
| R8 | Stays at the same local hour across time zones and daylight saving | R | v1 | Floating time plus zone name · **Checked:** node: "every Monday at 9" stays 09:00 in America/New_York, Europe/London and Asia/Kolkata across the 2026 DST dates. |

## 4. Views and planning

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| V1 | Today view across all boards, with an Overdue section and a Reschedule action | To Th MS | v1 | Query over the loaded boards · **Checked:** Chrome: Today with an Overdue section and a Reschedule control; rescheduling checked through `task.defer`, not by clicking the button. |
| V2 | Upcoming view (next 14 days, grouped by day) | To Th | v1 | **Checked:** Chrome: 14 days from 17 to 30 Nov with repeat occurrences. |
| V3 | Anytime and Someday views | Th | v1 | **Checked:** Chrome: Anytime held the undated card; Someday the parked one. |
| V4 | Logbook (done, newest first) | Th | v1 | **Checked:** node: newest first; Chrome: done card listed. |
| V5 | Inbox board as the default capture target, with "process inbox" (assign board, date or someday) | Th To | v1 | **Checked:** Chrome: Inbox created on upgrade and used by quick add. Not checked: the "process" actions by click. |
| V6 | Saved filters with a small query language (`today & @work`, `p1 or overdue`) | To | v1.x | |
| V7 | My Day: pick today's tasks into a list that clears each night, with suggestions | MS | v1.x | |
| V8 | Eisenhower matrix (urgent by date, important by priority) | TT | v1.x | Derived; no new fields |
| V9 | Pomodoro timer on a card, logging focus time | TT | v1.x | |
| V10 | Time blocking on the calendar view (drag a task onto an hour) | TT | v1.x | Needs F5 |
| V11 | Existing calendar view shows start, due and repeat occurrences | R | v1 | Extends today's month grid · **Checked:** Chrome: calendar shows due cards and dashed repeat occurrences; an ended series shows none. |

## 5. Reminders

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| N1 | Reminders at a time or an offset before due | B | v1 | **Checked:** node: test-tasks-reminders (time and offset); Chrome: a time reminder fired at 18:22. |
| N2 | Fire while any KanZen window is open: system notification if permitted, in-app toast otherwise | R | v1 | In-page scheduler, recomputed on wake · **Checked:** Chrome: in-app reminder card. Not checked: the system notification path (permission was not granted on the test origin). |
| N3 | No duplicate reminders across tabs or windows | R | v1 | Web Locks leader plus a fired-reminder log in the board file · **Checked:** node: two-window replay; Chrome: two tabs, the leader fired once, and after closing it the other tab did not fire again (after the localStorage fix in b4428fb). |
| N4 | "Missed while closed" list on open | R | v1 | Same pattern as the NakliOS voice assistant's reminders · **Checked:** Chrome: a reminder due while no scheduler ran showed under "Missed while KanZen was closed" on open. |
| N5 | Snooze (10 min, 1 hour, tomorrow) | B | v1 | **Checked:** Chrome: Snooze 10 min added a one-shot 18:32 reminder; node: snooze tests. |
| N6 | Export tasks with reminders to `.ics` (VTODO plus VALARM) so the calendar app reminds with the browser closed | R | v1 | **Checked:** node: interop ICS checks; Chrome: export has VALARM with UTC triggers. Not checked: import into a calendar app. |
| N7 | Push reminders with the browser closed, through the person's own Cloudflare Worker | R | v1.x | Reuses KanZen's optional sync Worker; off by default |
| N8 | Scheduled OS notifications (Notification Triggers) | R | Waived | Chrome ended the experiment |

## 6. Habits

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| H1 | Habits panel: name, colour, schedule | B | v1 | Not cards; its own panel · **Checked:** Chrome: habits created and listed in the panel. |
| H2 | Schedules: daily, chosen weekdays, N times a week, N times in M days | St Lp | v1 | Loop's fraction model · **Checked:** node: test-tasks-habits (daily, weekdays, N per week, N in M days); Chrome: daily and 3 a week. |
| H3 | One-tap check-in for today; tap a past day to backfill or clear | St Lp TT | v1 | Append-only log, latest line wins · **Checked:** Chrome: real-click check-in; backfill by clicking a heatmap cell then Done. |
| H4 | Skip a day (neutral) and pause a habit | Lp Hb | v1 | **Checked:** node: skip and pause are neutral. Not checked in Chrome: the Skip and Pause buttons. |
| H5 | Day-end hour (a 01:30 check-in counts for yesterday with a 04:00 day end) | Hb | v1 | **Checked:** node: rollover fixtures in Asia/Kolkata and America/New_York DST days. |
| H6 | Current and best streak, scheduled days off never break it | St Hb | v1 | **Checked:** node: streak fixtures; Chrome: streak 4 days after a backfill. |
| H7 | Habit score (forgives isolated misses) | Lp | v1 | Exponential moving average from Loop's published formula · **Checked:** node: hand-computed EMA; Chrome: 19% after 4 days = 1 − 0.5^(4/13). |
| H8 | Year heatmap and completion rate per habit | Lp St TT | v1 | Drawn in SVG · **Checked:** Chrome: 365-cell SVG heatmap, completion rates shown. |
| H9 | Numeric habits with at-least or at-most targets (glasses of water, minutes) | Lp TT | v1.x | |
| H10 | Habit reminders | B | v1 | Same scheduler as tasks · **Checked:** node: habit reminder instances. Not checked: a habit reminder firing in Chrome. |
| H11 | Negative habits ("no sugar") | St Hb | v1.x | |
| H12 | Gamification (health, gold, party) | Hb | Waived | Server-bound and outside the core job |

## 7. Import and export

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| X1 | todo.txt import and export | R | v1 | Plain text; priority, `+project`, `@context`, `due:` · **Checked:** node: round trip; Chrome: export, and import with `rec:` (after b4428fb). |
| X2 | Todoist CSV import | To | v1 | Written against a real exported file; repeat start anchors are lost in Todoist's CSV · **Checked:** node: test/fixtures/todoist-sample.csv; Chrome: 7 tasks imported, lost list shown. |
| X3 | iCalendar VTODO export with VALARM | R | v1 | Same as N6 · **Checked:** Same check as N6. |
| X4 | iCalendar VTODO import | R | v1.x | |
| X5 | TickTick CSV import | TT | v1.x | Detect the header row; columns by name |
| X6 | Loop Habit Tracker CSV import | Lp | v1.x | SQLite import only if CSV is not enough |
| X7 | Things JSON export (hand-off through its URL scheme) | Th | v1.x | |
| X8 | CSV export gains start date, repeat and completed date columns | R | v1 | Existing export · **Checked:** node: interop CSV columns; Chrome: CSV header gained start date, start time, due time, repeat, completed at, someday, parent. |

## 8. Agent door and NakliOS

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| A1 | `task.capture` (one line of text, parsed as in quick add) | R | v1 | Write; host approval as today · **Checked:** Hosted stand-in: `task.capture`; same as C6. |
| A2 | `task.complete`, `task.defer`, `task.snooze` | R | v1 | Write · **Checked:** Hosted stand-in: `task.defer` applied after approval; `task.complete` and `task.snooze` refused an ambiguous name with both matches. Not checked: a successful `task.complete` over the rail (the tool itself passed in Chrome). |
| A3 | `task.query` with the saved views (today, overdue, upcoming, inbox, someday) | R | v1 | Read · **Checked:** Hosted stand-in: `task.query` today returned 4 tasks across 3 boards. |
| A4 | `habit.list` and `habit.checkin` (with an optional date) | R | v1 | **Checked:** Hosted stand-in: `habit.list`; `habit.checkin` applied after approval. |
| A5 | Every new control has a command, checked by `scripts/check-command-parity.mjs` | R | v1 | Existing parity gate · **Checked:** node: test-commands 11, lint-agent-face 82 tools, and commands.json validated with NakliOS `catalog.mjs`, `parseWidgets` and `parseAccepts`. The mirror-side `check-command-parity.mjs` runs when the mirror is updated. |
| A6 | AI breakdown of a task into subtasks, through the NakliOS host model | To | v1.x | Model output validated against a schema; card text never treated as instructions |
| A7 | AI daily plan suggestion from Today and estimates | MS | v1.x | |

## 9. Storage and safety

| # | Capability | Src | Scope | Note |
|---|---|---|---|---|
| S1 | Old boards open unchanged; new fields are optional | R | v1 | Round-trip test on existing boards · **Checked:** Chrome: a board written by the previous release (88a8059) loads byte-identical and is not marked dirty. |
| S2 | Team mode carries the new card fields per card file, and the habit log as its own `.jsonl` | R | v1 | **Checked:** node: test-team-merge passes; card files carry whole cards. Not checked: a team-mode board with the new fields. |
| S3 | Pending-write queue when folder permission lapses, replayed on re-grant | R | v1 | **Checked:** Chrome: simulated NotAllowedError queued 2 writes with the pill showing, replay applied both; node: test-tasks-queue. |
| S4 | Snapshots and undo cover completions and check-ins | R | v1 | **Checked:** Chrome: completion undo and check-in undo (appends a `clear` line). Habits are not in board snapshots; the append-only log keeps every past state. |
| S5 | Old `doneLog` entries archived at snapshot time | R | v1.x | |

## Counts

v1: 52 rows. v1.x: 19 rows. Waived: 4 rows. 75 in all.

## Out of scope by design

Email-to-task, location reminders, scheduled OS notifications, gamified habits and shared assignment beyond today's team mode. Each needs a server, a native background context, or several people at once.
