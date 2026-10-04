# Changelog

All notable changes to KanZen. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org/).

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
