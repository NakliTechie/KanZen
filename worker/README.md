# KanZen sync Worker

A tiny Cloudflare Worker that lets two or more KanZen installs sync boards through your own Cloudflare account. **You** deploy it, **you** own the data, **you** hold the encryption passphrase. KanZen the project never deploys or hosts anything on your behalf.

The Worker stores ciphertext only — your sync passphrase never leaves the browser, so even with full Worker access nobody can read your boards.

## What you need

- A Cloudflare account (free tier is fine)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed locally: `npm install -g wrangler`
- One terminal

## Deploy in three minutes

```bash
# 1. From this directory:
cd worker

# 2. Log in to Cloudflare (browser will open):
wrangler login

# 3. Create a KV namespace and copy the id Wrangler prints:
wrangler kv namespace create KANZEN_KV
# → it prints something like:  id = "abcdef0123456789..."

# 4. Open wrangler.toml and paste that id in place of REPLACE_ME.

# 5. (Recommended) Set an access token so randos can't write to your sync:
wrangler secret put SYNC_TOKEN
# Wrangler will prompt — pick a long random string. Paste, hit return.

# 6. Deploy:
wrangler deploy
```

Wrangler prints a URL like `https://kanzen-sync.YOURNAME.workers.dev`. Note it down.

## Hook up KanZen

Open KanZen → 👤 Preferences → **Cloud Sync** section:

| Field            | Value                                              |
|------------------|----------------------------------------------------|
| Worker URL       | `https://kanzen-sync.YOURNAME.workers.dev`         |
| Sync Token       | The string you set in step 5 (or empty if you skipped) |
| Sync Passphrase  | Any phrase you can remember. **Critical:** this is the AES-GCM key. KanZen never sends it to the Worker. If you forget it, your synced boards are unrecoverable. |

Click **Save** → KanZen pings `/list`. A green cloud icon in the header means you're connected.

Per board: open Settings → toggle **Sync this board**. Only sync-enabled boards are pushed.

## Repeat on every device

Same Worker URL, same sync token, same passphrase. KanZen on the second device will pull the board list and show the synced boards with a "cloud" badge — click Download on each one.

## Conflict resolution

KanZen uses `localUser` (your name in Preferences) as a soft identity:

- **Same `localUser` on both devices** → tier 1: auto-resolves with a snapshot of the loser before swap. ("Synced — updated from your other device.")
- **Different `localUser`** → tier 3: shows a "<name> edited this 10 minutes ago" prompt with **Keep theirs / Keep mine / View diff**. The version you replace is auto-snapshotted first.

If two team members happen to use the same `localUser`, the first case fires. That's an acceptable edge case — names are an identity hint, not a security boundary.

## Costs

A KV write is 1c per million. A KV read is 0.5c per million. Free tier covers 100k reads + 1k writes per day. A small team that syncs every 30 seconds will do ~3000 writes per device per day. Comfortably under the free quota for most teams; pennies if you blow past it.

## Privacy guarantees

The Worker only ever sees:
- Encrypted ciphertext (`board:<id>`)
- Opaque metadata (`X-Board-Meta`) containing `lastModifiedBy`, `lastModifiedAt`, `deviceId`, `boardName`, `encrypted` flag

If you set `SYNC_TOKEN` to a random secret, only people with that token can read or write. Combined with the per-board passphrase, even a compromised Worker reveals no plaintext.

## Endpoints

```
GET    /list             → { boards: [ { id, meta } ] }
GET    /board/:id        → ciphertext (text/plain), meta in X-Board-Meta header
PUT    /board/:id        → store ciphertext, meta in X-Board-Meta
DELETE /board/:id        → remove
```

All require `X-Sync-Token: <value>` if `SYNC_TOKEN` is set in env.

## Maintenance

```bash
# View KV contents (encrypted; just for sanity)
wrangler kv key list --binding KANZEN_KV

# Tail live logs
wrangler tail

# Re-deploy after editing the worker
wrangler deploy
```

## Uninstall

```bash
wrangler delete                              # removes the Worker
wrangler kv namespace delete --binding KANZEN_KV   # removes the KV store
```

In KanZen, clear the Worker URL field in Preferences and your boards revert to local-only.
