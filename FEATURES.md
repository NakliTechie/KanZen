# KanZen — what shipped

The full feature list. The [README](README.md) is the short version.

## Features

**Boards & cards**
- Multiple boards with a switcher
- Columns: create, rename, reorder by drag, delete, collapse, soft WIP limits
- Cards: title, markdown description, due date, priority, labels, members, checklists, file attachments, comments
- Drag-and-drop cards between and within columns
- Per-board background (gradient / solid / custom colour)

**Views**
- Board (kanban), List (sortable table), Calendar (month grid with drag-to-set-due-date)
- Global search and filters (label, priority, due bucket, member) — non-matching cards **dim** instead of hiding

**History & sharing**
- Snapshots: manual or auto (before destructive actions, optional daily). Compare any two snapshots — card-level diff (added / removed / modified)
- Undo / redo (`Cmd/Ctrl+Z` and `Shift+Z`), 50-deep per board
- Activity feed of every change
- URL sharing: encrypted (AES-GCM 256, PBKDF2 200K) or plain, compressed via the browser-native `CompressionStream` API (no CDN dependency on modern browsers), with size gate and QR code. The hash fragment never leaves the browser. Read-back supports the spec `#e=` format too, so URLs from compatible tools can be imported.

**Storage & interop**
- File System Access API as the source of truth — pretty-printed, sorted-key JSON for clean git diffs
- Stable filenames that survive board renames (no orphaned files on disk)
- Folder handle persisted between sessions where the browser allows it (Chrome)
- 5-second polling for external edits, including team-mode card directories — if you sync via git/Dropbox/iCloud, the other device's changes appear without a reload
- **Team mode** (per-board toggle): splits a board into `_board.json` + `cards/<id>.json` + `_activity.jsonl` so each card edit touches only that one file. Two people editing different cards never produce a merge conflict. Lossless toggle in both directions.
- **Cloud sync** (optional, BYO Cloudflare Worker): deploy the [sync Worker](worker/README.md) in your own Cloudflare account, set a passphrase in Preferences, and KanZen syncs boards across devices via your own infrastructure. AES-GCM 256 encryption happens client-side. Revision checks reject stale writes; pending local edits and edits from another user prompt before overwrite, with snapshots of the displaced version.
- IndexedDB fallback when no folder is connected; "Browser storage only" pill nudges you to wire up a folder
- Inside NakliOS, explicitly switch between this browser, the mounted Folder,
  and encrypted Crate. Each is a separate board library; switching never
  copies, merges, or deletes boards.
- Inside NakliOS, card moves stage a before/after location for host review.
  Commit moves the card once; discard and stale-board rejection leave it in place.
- Auto-save every 5 s on changes; immediate save on destructive actions
- Per-board and full-state JSON export / import (merge or replace)
- CSV and Markdown export
- Trello JSON import (lists, cards, labels, members, checklists)
- Card-level audit trail: every card carries `createdBy/createdAt/lastModifiedBy/lastModifiedAt` and the activity log records every change with structured detail (filterable by user, action, card)
- PWA-lite: inline manifest, installable as an app

**UI**
- Dark / light theme
- Palette picker (🎨 in the header) — switch between Trello-default and curated [Rangrez](https://github.com/NakliTechie/rangrez) palettes (SUMI, KINARI, TADELAKT, SANG, SNÖ, MUMBAI ART DECO). Choice persists per browser.
- Keyboard shortcuts: `N` new card, `E` edit, `/` search, arrows to navigate, `Cmd/Ctrl+Z` undo
- Touch: long-press a card → "Move to" popover
- ARIA roles, `prefers-reduced-motion` and `prefers-contrast` support

## Palette

KanZen ships with seven runtime-switchable palettes. Click the 🎨 icon in the top-right to open the picker:

| | |
| --- | --- |
| **Default Trello** | Atlassian blue gradient — the original chrome |
| **SUMI 墨** | Zen monochrome calligraphy ink — `japan-03` |
| **KINARI 生成り** | Edo merchant ledger, washi paper — `japan-02` |
| **TADELAKT تادلكت** | Polished lime-soap riad wall — `morocco-01` |
| **SANG سنگ** | Persepolis travertine — `iran-01` |
| **SNÖ** | First snowfall, frozen lake — `scandinavia-01` |
| **MUMBAI ART DECO** | Marine Drive at dusk — `india_west-01` |

Palettes come from the [Rangrez](https://github.com/NakliTechie/rangrez) library — 240 palettes with country-specific color stories. Your choice is persisted in `localStorage` (key `kanzen.palette`) and survives reloads.

**Agent face** (2026-10-02)
- Every UI action is a command declared once in `KZ_TOOLS`: 60 callable tools (16 read, 5 session, 28 write, 11 destructive) and 8 person-only acts
- Doors: WebMCP (`document.modelContext` / `navigator.modelContext`), `window.kanzen`, and a cross-tab `BroadcastChannel('kanzen-agent')` that is off until you open it in Preferences
- Write and destructive calls become proposals you approve under 🤖; destructive approvals take a safety snapshot first; `apply_changes` batches edits into one proposal and one undo step
- The activity feed marks every agent change "via agent" with its door and caller

**Responsive layout** (2026-10-04)
- Header folds buttons into ⋯ when they do not fit; phones get two header rows, a Filters panel, one column per screen with snap scrolling, full-screen dialogs and bottom-sheet menus
- Touch: 40px targets, long-press "Move to", ‹ › column reorder, and a Column picker in the card editor
