# Changelog

All notable changes to KanZen. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/).

## [Unreleased]

### Added
- **Tasks and habits (v1).** Quick add with natural dates and repeat phrases, task fields on cards (start, times, someday, repeat, reminders, subtasks), one-card repeating tasks with logged completions and one-step undo, Tasks mode (Today, Upcoming, Anytime, Someday, Logbook, Inbox) across every board, reminders while a tab is open with snooze and a missed list, a habits panel with streaks, score and a year heatmap, todo.txt and Todoist CSV import, todo.txt and `.ics` export, and seven NakliOS commands (`task.*`, `habit.*`). Scope and the check behind each item: `docs/specs/kanzen-tasks-parity-001.md`.
- Desktop widgets inside NakliOS: today's tasks and habits.
- Gates: `scripts/test-tasks-{dates,habits,reminders,interop,queue}.mjs` (255 checks) and `scripts/splice-lib.mjs --check`, all in `npm test`.
- **NakliOS commands.** `commands.json` declares six commands (`board.list`, `board.read`, `card.list`, `card.add`, `card.move`, `proposal.status`). Inside NakliOS the voice assistant and Anvil reach them through the host's grant, which opens KanZen minimized when it is closed. They take board, column and card names and run the same tools as the other doors, so `card.add` and `card.move` stay proposals and return a `proposal_id`. Standalone KanZen does not register them.
- Gate: `scripts/test-commands.mjs` checks `commands.json` against the host's rules and its handlers, then runs commands through a stand-in host.

### Changed
- Inside NakliOS, an agent's creates and edits apply at once, with normal undo, even while a review card waits; they return `{status:"applied", ...}`. Only deletions wait in NakliOS review: destructive tools, a write that clears a field holding a value (description, due date, labels, members, checklist items, task dates, repeat, reminders, parent, estimate), clearing or taking back a habit check-in, agent undo and redo, and batches holding any of these. Before, every agent write waited and queued behind the one card NakliOS holds, which stalled agents. Standalone KanZen still asks before every agent write. Rule: `kzHostNeedsReview` in `index.html`. Gate: the NakliOS steps in `scripts/test-agent-face.mjs` and `scripts/test-commands.mjs`.
- Inside NakliOS, the person's own card moves apply at once instead of waiting in NakliOS review. Review now holds agent proposals only, as the NakliOS app contract says. Gate: the NakliOS step in `scripts/test-agent-face.mjs` and `scripts/test-card-review.mjs`.
- The inlined NakliOS SDK is current (canonical ver 2, refreshed 2026-11-16), which brings `experimental_commands` and `experimental_widgets`.
- Inside NakliOS, KanZen follows the desktop theme while its own palette is Default, sets its window title, and saves before NakliOS closes it.
- A new library gets an Inbox board beside the starter board, and an existing library gains one on first open.
- Header buttons fold in a new order so Undo and Redo stay visible longest.

## [1.0.0] — 2026-10-04

The first tagged release. Everything KanZen has shipped since April 2026 is in it.

### Added
- **Agent face.** Every command the UI runs is also a tool: 60 callable tools (16 read, 5 session, 28 write, 11 destructive) declared once in `KZ_TOOLS`. Agents reach them through WebMCP (`document.modelContext`), `window.kanzen`, or a cross-tab `BroadcastChannel` that stays closed until you open it in Preferences.
- **Approval for agent changes.** Write and destructive calls become proposals under 🤖 in the header and apply only when you approve them; destructive approvals take a safety snapshot first. `apply_changes` batches edits into one proposal and one undo step. Inside NakliOS, proposals wait in NakliOS review instead.
- **Attribution.** The activity feed marks each agent change "via agent" with the door and caller.
- **Responsive layout.** The header folds buttons into ⋯ when they do not fit. Phones get two header rows, a Filters panel, one column per screen with snap scrolling, full-screen dialogs, bottom-sheet menus and 40 px touch targets.
- **Touch moves.** A Column picker in the card editor, ‹ › column arrows on touch screens, ↑ ↓ in Board settings, and long-press "Move to".
- Boards as sorted-key `.kanzen.json` files in a folder you choose, with an IndexedDB fallback; team mode (one file per card); BYO Cloudflare Worker sync, encrypted in the browser; encrypted share links; snapshots with diffs; undo/redo; activity feed; list and calendar views; Trello import; CSV and Markdown export; Rangrez palettes; NakliOS hosting with Folder and Crate storage and review of card moves.
- Gates: `scripts/lint-agent-face.mjs` (every change goes through a declared command) and its self-test, `scripts/test-agent-face.mjs` (17 checks), `scripts/test-responsive.mjs` (10 checks), all in CI.
- MIT license, a README in the house shape, a social card for the repo and the app.

### Fixed
- In team mode, new cards and comments were not written to their card files; deleting a column left its card files on disk.
- Deleting a column and restoring a snapshot can be undone.
- Switching boards saves the board being left first.
- The card editor's Cancel discards label, member and checklist edits.
- Deleting a label or member takes it off every card.
- A card move staged for NakliOS review survives the autosave that follows an edit.
- Member avatars no longer clip their initials.

[1.0.0]: https://github.com/NakliTechie/KanZen/commits/v1.0.0
