// KanZen sync Worker
// ─────────────────────────────────────────────────────────────────────────────
// A Cloudflare Worker that stores AES-GCM-encrypted KanZen board payloads in
// a KV namespace. KanZen never deploys this — you do, in your own Cloudflare
// account, with your own KV namespace and your own access token. KanZen the
// app never sees the encryption key; it derives it client-side from the
// passphrase you set in Preferences.
//
// Endpoints
//   GET     /list             → { boards:[ { id, meta } ] }
//   GET     /board/:id        → encrypted payload (text), meta in X-Board-Meta
//   PUT     /board/:id        → write payload + meta header
//   DELETE  /board/:id        → remove from KV
//   OPTIONS /*                → CORS preflight
//
// Auth
//   If env.SYNC_TOKEN is set, every request must send X-Sync-Token: <value>.
//   If env.SYNC_TOKEN is empty/unset, the Worker is open. Don't run open in
//   production unless you understand the implications.
//
// Privacy
//   The Worker only ever sees ciphertext + an opaque metadata header. It
//   cannot read your boards even if it wanted to.
//
// Deployment: see worker/README.md.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Token,X-Board-Meta',
  'Access-Control-Expose-Headers':'X-Board-Meta',
};

function withCors(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: { ...CORS, ...(init.headers || {}) },
  });
}

function authOk(request, env) {
  if (!env.SYNC_TOKEN) return true; // open mode
  return request.headers.get('X-Sync-Token') === env.SYNC_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return withCors(null, { status: 204 });
    if (!authOk(request, env)) return withCors('Unauthorized', { status: 401 });

    // GET /list  →  metadata for all boards
    if (request.method === 'GET' && url.pathname === '/list') {
      const list = await env.KANZEN_KV.list({ prefix: 'meta:' });
      const boards = [];
      for (const k of list.keys) {
        const meta = await env.KANZEN_KV.get(k.name, 'json');
        if (meta) boards.push({ id: k.name.slice(5), meta });
      }
      return withCors(JSON.stringify({ boards }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const m = url.pathname.match(/^\/board\/([\w-]+)$/);
    if (m) {
      const id = m[1];

      // GET  →  payload + meta
      if (request.method === 'GET') {
        const payload = await env.KANZEN_KV.get('board:' + id);
        if (payload == null) return withCors('Not found', { status: 404 });
        const meta = await env.KANZEN_KV.get('meta:' + id);
        return withCors(payload, {
          headers: {
            'Content-Type': 'text/plain',
            'X-Board-Meta': meta || '{}',
          },
        });
      }

      // PUT  →  write payload + meta
      if (request.method === 'PUT') {
        const payload = await request.text();
        const meta    = request.headers.get('X-Board-Meta') || '{}';
        // tiny sanity guard: 5 MB hard cap so a runaway client can't fill KV
        if (payload.length > 5 * 1024 * 1024) {
          return withCors('Payload too large', { status: 413 });
        }
        await env.KANZEN_KV.put('board:' + id, payload);
        await env.KANZEN_KV.put('meta:'  + id, meta);
        return withCors(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // DELETE  →  remove
      if (request.method === 'DELETE') {
        await env.KANZEN_KV.delete('board:' + id);
        await env.KANZEN_KV.delete('meta:'  + id);
        return withCors(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return withCors('Not found', { status: 404 });
  },
};
