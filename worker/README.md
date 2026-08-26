# KanZen sync Worker

This optional Worker lets KanZen installations sync encrypted boards through a Cloudflare account you control. KanZen never deploys it for you, and the board passphrase never leaves the browser.

The Worker uses one SQLite-backed Durable Object as the coordination boundary for one KanZen workspace. Updates carry monotonically increasing revisions and require `If-Match`, so two clients cannot silently overwrite the same remote revision.

## Deploy

Review Cloudflare's current Workers and Durable Objects pricing before deployment. Then, from this directory:

```bash
npm install
npx wrangler login
npx wrangler secret put SYNC_TOKEN
npx wrangler deploy
```

`SYNC_TOKEN` is mandatory. Choose a long random value and give it only to the people/devices that should access this workspace. The deploy creates the `KanZenWorkspace` SQLite Durable Object declared in `wrangler.jsonc`; there is no separate KV namespace to provision.

Wrangler prints a URL such as `https://kanzen-sync.YOURNAME.workers.dev`.

## Connect KanZen

Open KanZen → Preferences → Cloud sync and enter:

| Field | Value |
| --- | --- |
| Worker URL | The URL printed by Wrangler |
| Sync Token | The `SYNC_TOKEN` secret value |
| Sync Passphrase | A strong phrase shared by every device that must decrypt the boards |

Click **Save sync config**. The connection check should say `Connected · revision-safe`. Enable **Sync this board** in a board's settings. Other devices using the same Worker URL, token, and passphrase discover enabled boards during the next pull.

If you lose the sync passphrase, the ciphertext cannot be recovered. It is intentionally never sent to Cloudflare.

## Conflict behavior

- A write based on the current remote revision creates the next revision.
- A stale write receives HTTP `409` and cannot overwrite the newer board.
- KanZen downloads the newer revision and asks which copy to keep when local edits are pending or another user made the edit.
- The version being replaced is snapshotted before either choice is committed.

## Privacy boundary

The Worker stores:

- encrypted/compressed board payloads;
- revision numbers;
- plaintext routing metadata: board name, editor name, edit time, device ID, and encryption flag.

The metadata is not board content, but it is not opaque. Anyone with Cloudflare account access can see it. The `SYNC_TOKEN` controls API access; the separate sync passphrase controls board decryption.

## API

```text
GET    /list
GET    /board/:id
PUT    /board/:id      (requires If-Match: "<revision>")
DELETE /board/:id      (requires If-Match: "<revision>")
```

Every request except CORS preflight requires `X-Sync-Token`. Board responses expose `X-Board-Revision`, `X-Board-Meta`, and an ETag. Payloads above 5 MiB are rejected.

## Maintenance

```bash
npm run check
npx wrangler tail
npx wrangler deploy
```

To stop using Cloud sync, clear the Worker URL in KanZen. Treat Worker deletion and Durable Object lifecycle changes as data-destructive operations; follow the current Cloudflare Durable Object class lifecycle documentation before removing the deployment.
