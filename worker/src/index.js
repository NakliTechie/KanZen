import { DurableObject } from 'cloudflare:workers';

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_META_CHARS = 8192;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function normalizeMeta(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clipped = (input, fallback, limit) => Array.from(String(input || fallback)).slice(0, limit).join('');
  return {
    lastModifiedBy: clipped(source.lastModifiedBy, 'Unknown', 160),
    lastModifiedAt: clipped(source.lastModifiedAt, new Date().toISOString(), 64),
    deviceId: clipped(source.deviceId, '', 160),
    boardName: clipped(source.boardName, 'Untitled board', 240),
    encrypted: source.encrypted !== false,
  };
}

export class KanZenWorkspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS boards (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          meta_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_boards_updated_at ON boards(updated_at DESC);
      `);
    });
  }

  listBoards() {
    return this.ctx.storage.sql
      .exec('SELECT id, meta_json, revision FROM boards ORDER BY updated_at DESC, id ASC')
      .toArray()
      .map((row) => ({ id: row.id, ...JSON.parse(row.meta_json), revision: row.revision }));
  }

  getBoard(id) {
    const rows = this.ctx.storage.sql
      .exec('SELECT payload, meta_json, revision FROM boards WHERE id = ?', id)
      .toArray();
    if (!rows.length) return null;
    const row = rows[0];
    return { payload: row.payload, meta: { ...JSON.parse(row.meta_json), revision: row.revision }, revision: row.revision };
  }

  putBoard(id, payload, meta, expectedRevision) {
    const current = this.ctx.storage.sql
      .exec('SELECT revision FROM boards WHERE id = ?', id)
      .toArray()[0];
    const actualRevision = current ? current.revision : 0;
    if (expectedRevision !== actualRevision) {
      return { conflict: true, revision: actualRevision };
    }
    const revision = actualRevision + 1;
    const cleanMeta = normalizeMeta(meta);
    this.ctx.storage.sql.exec(
      `INSERT INTO boards (id, payload, meta_json, revision, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         meta_json = excluded.meta_json,
         revision = excluded.revision,
         updated_at = excluded.updated_at`,
      id,
      payload,
      JSON.stringify(cleanMeta),
      revision,
      Date.now(),
    );
    return { conflict: false, revision, meta: { ...cleanMeta, revision } };
  }

  deleteBoard(id, expectedRevision) {
    const current = this.ctx.storage.sql
      .exec('SELECT revision FROM boards WHERE id = ?', id)
      .toArray()[0];
    if (!current) return { missing: true, conflict: false };
    if (expectedRevision !== current.revision) {
      return { missing: false, conflict: true, revision: current.revision };
    }
    this.ctx.storage.sql.exec('DELETE FROM boards WHERE id = ?', id);
    return { missing: false, conflict: false, revision: current.revision };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Token,X-Board-Meta,If-Match',
    'Access-Control-Expose-Headers': 'X-Board-Meta,X-Board-Revision,X-Kanzen-Sync-Version,ETag',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Kanzen-Sync-Version': '2',
  };
}

function response(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(body, { ...init, headers });
}

function json(data, status = 200, headers = {}) {
  return response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

async function tokenMatches(provided, expected) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function parseExpectedRevision(request) {
  const raw = request.headers.get('If-Match');
  if (!raw) return null;
  const normalized = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const revision = Number(normalized);
  return Number.isSafeInteger(revision) ? revision : null;
}

async function readTextWithinLimit(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new RangeError('Payload too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RangeError('Payload too large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') return response(null, { status: 204 });
  if (!env.SYNC_TOKEN) return json({ error: 'SYNC_TOKEN is not configured' }, 503);
  if (!await tokenMatches(request.headers.get('X-Sync-Token') || '', env.SYNC_TOKEN)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const workspace = env.KANZEN_WORKSPACE.getByName('kanzen-workspace');

  if (request.method === 'GET' && url.pathname === '/list') {
    return json({ boards: await workspace.listBoards() });
  }

  const match = url.pathname.match(/^\/board\/([A-Za-z0-9_-]{1,80})$/);
  if (!match) return json({ error: 'Not found' }, 404);
  const id = match[1];
  if (!BOARD_ID_RE.test(id)) return json({ error: 'Invalid board ID' }, 400);

  if (request.method === 'GET') {
    const board = await workspace.getBoard(id);
    if (!board) return json({ error: 'Not found' }, 404);
    return response(board.payload, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Board-Meta': encodeURIComponent(JSON.stringify(board.meta)),
        'X-Board-Revision': String(board.revision),
        'ETag': `"${board.revision}"`,
      },
    });
  }

  if (request.method === 'PUT') {
    const expectedRevision = parseExpectedRevision(request);
    if (expectedRevision === null) return json({ error: 'If-Match revision is required' }, 428);
    const rawMeta = request.headers.get('X-Board-Meta') || '%7B%7D';
    if (rawMeta.length > MAX_META_CHARS) return json({ error: 'Metadata too large' }, 431);
    let meta;
    try { meta = normalizeMeta(JSON.parse(decodeURIComponent(rawMeta))); }
    catch (_) { return json({ error: 'Invalid board metadata' }, 400); }
    let payload;
    try { payload = await readTextWithinLimit(request, MAX_PAYLOAD_BYTES); }
    catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 413);
      throw error;
    }
    const result = await workspace.putBoard(id, payload, meta, expectedRevision);
    if (result.conflict) {
      return json({ error: 'Revision conflict', revision: result.revision }, 409, {
        'X-Board-Revision': String(result.revision),
      });
    }
    console.log(JSON.stringify({ message: 'board updated', boardId: id, revision: result.revision }));
    return json({ ok: true, revision: result.revision }, 200, {
      'X-Board-Revision': String(result.revision),
      'ETag': `"${result.revision}"`,
    });
  }

  if (request.method === 'DELETE') {
    const expectedRevision = parseExpectedRevision(request);
    if (expectedRevision === null) return json({ error: 'If-Match revision is required' }, 428);
    const result = await workspace.deleteBoard(id, expectedRevision);
    if (result.missing) return json({ error: 'Not found' }, 404);
    if (result.conflict) {
      return json({ error: 'Revision conflict', revision: result.revision }, 409, {
        'X-Board-Revision': String(result.revision),
      });
    }
    console.log(JSON.stringify({ message: 'board deleted', boardId: id, revision: result.revision }));
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405, { Allow: 'GET,PUT,DELETE,OPTIONS' });
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: 'request failed',
        requestId,
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return json({ error: 'Internal server error', requestId }, 500);
    }
  },
};
