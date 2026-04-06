# KanZen

**Kanban without the noise.** Single-HTML-file, local-first Trello alternative. Zero server, zero account, zero board limits.

Boards live on your device — as plain `.kanzen.json` files in a folder you choose. Period.

> *Kanban + Zen (simplicity). Also 完全 (kanzen) — Japanese for "complete" or "perfect."*

## What it is

- One self-contained `index.html` — open the file, it works
- File System Access API as the source of truth — each board is one human-readable JSON file
- IndexedDB fallback for browsers without FS API, or before you grant folder permission
- No build step, no dependencies, no telemetry, no account
- Drop the folder in Dropbox / iCloud / Syncthing / git → multi-device for free

## Features (v1)

- Multiple boards with a switcher
- Columns: create, rename, reorder by drag, delete, collapse, soft WIP limits
- Cards: title, markdown description, due date, priority, labels, members, checklists, file attachments
- Drag-and-drop cards between and within columns
- Global search and filters (label, priority, due bucket, member) — non-matching cards **dim** instead of hiding
- Auto-save every 5 s on changes; immediate save on destructive actions
- Per-board and full-state JSON export / import (merge or replace)
- Dark / light theme
- Keyboard shortcuts: `N` new card, `E` edit, `/` search, arrows to navigate

## Run

Just open `index.html` in a modern browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/
```

The File System Access API requires HTTPS or `localhost`. IndexedDB fallback works from `file://` too.

## Privacy

Nothing leaves your machine. There is no server. The author cannot see your boards.

## Author

[Chirag Patnaik](https://naklitechie.github.io/) — part of the [NakliTechie](https://naklitechie.github.io/) browser-native tools series.
