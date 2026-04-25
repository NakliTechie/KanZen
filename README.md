# KanZen

**Kanban without the noise.** Single-HTML-file, local-first Trello alternative. Zero server, zero account, zero board limits.

> **Live: [kanzen.naklitechie.com](https://kanzen.naklitechie.com/)**

Boards live on your device — as plain `.kanzen.json` files in a folder you choose. Period.

> *Kanban + Zen (simplicity). Also 完全 (kanzen) — Japanese for "complete" or "perfect."*

## What it is

- One self-contained `index.html` — open the file, it works
- File System Access API as the source of truth — each board is one human-readable JSON file
- IndexedDB fallback for browsers without FS API, or before you grant folder permission
- No build step, no dependencies, no telemetry, no account
- Drop the folder in Dropbox / iCloud / Syncthing / git → multi-device for free

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
- 5-second polling for external edits — if you sync via git/Dropbox/iCloud, the other device's changes appear as a "Board updated from disk" toast
- **Team mode** (per-board toggle): splits a board into `_board.json` + `cards/<id>.json` + `_activity.jsonl` so each card edit touches only that one file. Two people editing different cards never produce a merge conflict. Lossless toggle in both directions.
- **Cloud sync** (optional, BYO Cloudflare Worker): deploy a [3-minute Worker](worker/README.md) in your own Cloudflare account, set a passphrase in Preferences, and KanZen syncs boards across devices via your own infrastructure. AES-GCM 256 encrypted client-side — the Worker only ever sees ciphertext. Tier-1 conflict resolution (same user, different device) is automatic; tier-3 (different user) prompts. Pre-conflict snapshots are taken before any overwrite.
- IndexedDB fallback when no folder is connected; "Browser storage only" pill nudges you to wire up a folder
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

## Run

Just visit **[kanzen.naklitechie.com](https://kanzen.naklitechie.com/)** in any modern browser. Or, to host it yourself:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/
```

The File System Access API requires HTTPS or `localhost`. IndexedDB fallback works from `file://` too.

## Privacy

Nothing leaves your machine. There is no server. The author cannot see your boards. Even share URLs encode the board into the hash fragment, which is never sent to any server — not even to Cloudflare Pages, where this site is hosted.

## Author

[Chirag Patnaik](https://naklitechie.github.io/) — part of the [NakliTechie](https://naklitechie.github.io/) browser-native tools series.
