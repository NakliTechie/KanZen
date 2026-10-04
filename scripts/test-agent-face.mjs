// End-to-end test of the agent face in headless Chromium. It drives KanZen through its doors
// (window.kanzen, a stand-in for WebMCP's document.modelContext, the cross-tab channel) and does
// the person's part (approve, reject, open the channel) through the real UI.
//   node scripts/test-agent-face.mjs   (first, in scripts/: `npm ci` and `npx playwright install --only-shell chromium`)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' || path === '\\' ? 'index.html' : path);
  try{
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

// WebMCP stand-in, per the 2026-09-30 draft: document.modelContext.registerTool(tool, {signal}).
const fakeModelContext = () => {
  window.__mcTools = new Map();
  const mc = {
    registerTool(tool, options = {}){
      if(window.__mcTools.has(tool.name)) return Promise.reject(new DOMException('duplicate', 'InvalidStateError'));
      window.__mcTools.set(tool.name, tool);
      options.signal?.addEventListener('abort', () => window.__mcTools.delete(tool.name));
      return Promise.resolve();
    },
  };
  Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get(){ return mc; } });
  localStorage.setItem('kanzen.introSeen', '1');
};

let passed = 0;
async function step(name, fn){
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const browser = await chromium.launch();
const failures = [];
try{
  const context = await browser.newContext();
  await context.addInitScript(fakeModelContext);
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(`page error: ${error.message}`));
  page.on('console', msg => { if(msg.type() === 'error') failures.push(`console error: ${msg.text()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.kanzen && document.querySelector('#welcome-modal.open'));
  // the person's first act: their name (person-only)
  await page.fill('#welcome-name', 'Asha');
  await page.click('#welcome-modal .btn-primary');

  // helpers that run inside the page
  const call = (tool, input = {}, caller = 'e2e') => page.evaluate(async ([tool, input, caller]) => {
    try{ return { ok: true, value: await window.kanzen.tools[tool](input, { caller }) }; }
    catch(e){ return { ok: false, code: e.code, message: e.message }; }
  }, [tool, input, caller]);
  const value = async (tool, input, caller) => {
    const r = await call(tool, input, caller);
    assert.ok(r.ok, `${tool} failed: ${r.code} ${r.message}`);
    return r.value;
  };
  const openAgentModal = () => page.evaluate(() => openModal('agent-modal'));
  const clickProposal = async (id, label) => {
    await openAgentModal();
    const row = page.locator('.proposal-row').filter({ has: page.locator(`[data-proposal-id="${id}"]`) });
    await row.getByRole('button', { name: label }).click();
    await page.waitForFunction(id => window.kanzen && [...document.querySelectorAll('[data-proposal-id]')].every(b => b.dataset.proposalId !== id), id);
    await page.evaluate(() => closeModal());
  };

  await step('both doors carry exactly the manifest\'s callable tools', async () => {
    const r = await page.evaluate(() => {
      const manifest = window.kanzen.manifest();
      return {
        manifest: manifest.tools.map(t => t.name).sort(),
        window: Object.keys(window.kanzen.tools).sort(),
        webmcp: [...window.__mcTools.keys()].sort(),
        person: manifest.person_only.map(t => t.name),
        readOnly: [...window.__mcTools.values()].filter(t => t.annotations.readOnlyHint).map(t => t.name).sort(),
        reads: manifest.tools.filter(t => t.kind === 'read').map(t => t.name).sort(),
        consequential: [...window.__mcTools.values()].filter(t => t.annotations.consequentialHint).map(t => t.name).sort(),
        destructive: manifest.tools.filter(t => t.kind === 'destructive').map(t => t.name).sort(),
        schemasAreObjects: manifest.tools.every(t => t.input_schema.type === 'object' && t.input_schema.additionalProperties === false),
        doors: manifest.doors,
      };
    });
    assert.deepEqual(r.window, r.manifest);
    assert.deepEqual(r.webmcp, r.manifest);
    assert.equal(r.manifest.length, 60);
    assert.deepEqual(r.person, ['choose_storage','configure_sync','set_board_sync','set_your_name','install_app','set_agent_channel','approve_proposal','reject_proposal']);
    for(const name of r.person) assert.ok(!r.window.includes(name), `${name} must not be callable`);
    assert.deepEqual(r.readOnly, r.reads);
    assert.deepEqual(r.consequential, r.destructive);
    assert.ok(r.schemasAreObjects);
    assert.equal(r.doors.modelContext, 'registered');
  });

  const board = await value('get_board');
  const todo = board.columns[0].id;
  const done = board.columns[2].id;

  await step('read tools answer at once', async () => {
    const boards = await value('list_boards');
    assert.equal(boards.boards.length, 1);
    assert.equal(boards.current_board_id, board.id);
    assert.deepEqual(board.columns.map(c => c.name), ['To Do','In Progress','Done']);
    assert.equal(board.labels.length, 3);
    const state = await value('get_app_state');
    assert.equal(state.user_name, 'Asha');
    assert.equal(state.agent.pending_proposals, 0);
  });

  let cardId;
  await step('a write waits for approval, then applies with agent attribution', async () => {
    const staged = await value('create_card', { column_id: todo, title: 'Write the brief', priority: 'high', due_date: '2026-10-09' });
    assert.equal(staged.status, 'pending_approval');
    assert.match(staged.summary, /Create card "Write the brief" in "To Do"/);
    assert.equal((await value('get_board')).cards.length, 0, 'nothing changes before approval');
    assert.equal(await page.textContent('#agent-count'), '1');
    assert.ok(await page.isVisible('#agent-indicator'));
    await clickProposal(staged.proposal_id, 'Approve');
    const proposal = await value('get_proposal', { proposal_id: staged.proposal_id });
    assert.equal(proposal.status, 'applied');
    cardId = proposal.result.card_id;
    const card = await value('get_card', { card_id: cardId });
    assert.equal(card.title, 'Write the brief');
    assert.equal(card.priority, 'high');
    assert.equal(card.due_date, '2026-10-09');
    const activity = await value('get_activity', { limit: 1 });
    assert.equal(activity.entries[0].action, 'card_created');
    assert.equal(activity.entries[0].actor, 'agent');
    assert.equal(activity.entries[0].door, 'window');
    assert.equal(activity.entries[0].caller, 'e2e');
    assert.match(activity.entries[0].text, /via agent \(window API, e2e\)/);
    assert.ok(await page.locator('.card', { hasText: 'Write the brief' }).isVisible());
  });

  await step('the WebMCP door stages through the same path; rejecting changes nothing', async () => {
    const r = await page.evaluate(async todo => {
      const tool = window.__mcTools.get('create_card');
      return tool.execute({ column_id: todo, title: 'From WebMCP' }, { signal: new AbortController().signal });
    }, todo);
    assert.equal(r.status, 'pending_approval');
    await clickProposal(r.proposal_id, 'Reject');
    assert.equal((await value('get_proposal', { proposal_id: r.proposal_id })).status, 'rejected');
    assert.equal((await value('get_board')).cards.length, 1);
    const door = await page.evaluate(() => [...document.querySelectorAll('#agent-calls .agent-call-meta')].length);
    assert.ok(door >= 1);
  });

  await step('an agent can withdraw its own pending proposal', async () => {
    const staged = await value('rename_board', { name: 'Never' });
    const withdrawn = await value('withdraw_proposal', { proposal_id: staged.proposal_id });
    assert.equal(withdrawn.status, 'withdrawn');
    await page.evaluate(id => approveProposal(id), staged.proposal_id);
    assert.equal((await value('get_board')).name, 'My first board');
  });

  await step('errors are structured', async () => {
    assert.equal((await call('create_card', { column_id: todo })).code, 'invalid_input');
    assert.equal((await call('create_card', { column_id: todo, title: 'x', colour: 'red' })).code, 'invalid_input');
    assert.equal((await call('create_card', { column_id: 'missing', title: 'x' })).code, 'not_found');
    assert.equal((await call('update_card', { card_id: cardId, due_date: '2026-02-30' })).code, 'invalid_input');
    const unknown = await page.evaluate(async () => { try{ await window.kanzen.call('fly', {}); }catch(e){ return e.code; } });
    assert.equal(unknown, 'unknown_tool');
    const person = await page.evaluate(async () => { try{ await window.kanzen.call('approve_proposal', {}); }catch(e){ return e.message; } });
    assert.match(person, /person-only/);
    assert.equal((await value('list_proposals', { status: 'pending' })).proposals.length, 0);
  });

  await step('session tools change the view at once and stage nothing', async () => {
    await value('set_view', { mode: 'calendar', calendar_month: '2026-10' });
    assert.ok(await page.locator('#board-area.view-calendar').isVisible());
    assert.ok(await page.locator('.cal-card', { hasText: 'Write the brief' }).isVisible());
    await value('set_view', { mode: 'board' });
    await value('set_filter', { priority: 'urgent' });
    assert.equal(await page.inputValue('#filter-priority'), 'urgent');
    assert.ok(await page.locator('.card.dim', { hasText: 'Write the brief' }).isVisible());
    await value('clear_filters');
    assert.equal(await page.inputValue('#filter-priority'), '');
    assert.equal((await value('list_proposals', { status: 'pending' })).proposals.length, 0);
  });

  await step('apply_changes: one proposal, "$name" references, one undo step', async () => {
    const staged = await value('apply_changes', { operations: [
      { tool: 'create_column', input: { name: 'Review' }, as: 'review' },
      { tool: 'create_label', input: { name: 'Agent', color: '#c377e0' }, as: 'agent' },
      { tool: 'create_card', input: { column_id: '$review', title: 'Check the brief', label_ids: ['$agent'] } },
      { tool: 'move_card', input: { card_id: cardId, column_id: '$review' } },
    ] });
    const pending = await value('get_proposal', { proposal_id: staged.proposal_id });
    assert.equal(pending.details.length, 4);
    await clickProposal(staged.proposal_id, 'Approve');
    let b = await value('get_board');
    assert.deepEqual(b.columns.map(c => c.name), ['To Do','In Progress','Done','Review']);
    const review = b.columns[3];
    assert.equal(review.card_ids.length, 2);
    const created = b.cards.find(c => c.title === 'Check the brief');
    assert.deepEqual(created.label_ids, [b.labels.find(l => l.name === 'Agent').id]);
    await page.evaluate(() => undo());
    b = await value('get_board');
    assert.deepEqual(b.columns.map(c => c.name), ['To Do','In Progress','Done']);
    assert.equal(b.labels.length, 3);
    assert.deepEqual(b.cards.map(c => c.title), ['Write the brief']);
  });

  await step('apply_changes refuses bad batches at staging and rolls back at apply', async () => {
    const bad = await call('apply_changes', { operations: [{ tool: 'delete_card', input: { card_id: cardId } }] });
    assert.equal(bad.code, 'invalid_input');
    const dangling = await call('apply_changes', { operations: [{ tool: 'create_card', input: { column_id: '$nowhere', title: 'x' } }] });
    assert.equal(dangling.code, 'invalid_input');
    const staged = await value('apply_changes', { operations: [
      { tool: 'create_card', input: { column_id: todo, title: 'First half' } },
      { tool: 'create_card', input: { column_id: done, title: 'Second half' } },
    ] });
    // the person deletes "Done" before approving, so the second change cannot apply
    await page.evaluate(done => kzUi('delete_column', { column_id: done }), done);
    await clickProposal(staged.proposal_id, 'Approve');
    const proposal = await value('get_proposal', { proposal_id: staged.proposal_id });
    assert.equal(proposal.status, 'failed');
    assert.match(proposal.error.message, /Change 2 \(create_card\) failed: .*Nothing was applied/);
    assert.deepEqual((await value('get_board')).cards.map(c => c.title), ['Write the brief']);
  });

  await step('a destructive approval takes a safety snapshot first', async () => {
    const before = (await value('list_snapshots')).snapshots.length;
    const extra = await value('create_card', { column_id: todo, title: 'Temporary' });
    await page.evaluate(id => approveProposal(id), extra.proposal_id);
    const tempId = (await value('get_proposal', { proposal_id: extra.proposal_id })).result.card_id;
    const staged = await value('delete_card', { card_id: tempId });
    assert.equal((await value('get_proposal', { proposal_id: staged.proposal_id })).kind, 'destructive');
    await clickProposal(staged.proposal_id, 'Approve');
    const snapshots = (await value('list_snapshots')).snapshots;
    assert.equal(snapshots.length, before + 1);
    assert.equal(snapshots[0].kind, 'auto-destructive');
    assert.ok(!(await value('get_board')).cards.some(c => c.id === tempId));
    const compare = await value('compare_snapshots', { a: snapshots[0].filename, b: snapshots[0].filename });
    assert.deepEqual(compare.added, []);
  });

  await step('a proposal applies to the board it was staged on', async () => {
    const created = await value('create_board', { name: 'Side project' });
    await page.evaluate(id => approveProposal(id), created.proposal_id);
    const sideId = (await value('get_proposal', { proposal_id: created.proposal_id })).result.board_id;
    assert.equal((await value('get_app_state')).current_board_id, sideId);
    const staged = await value('rename_board', { board_id: board.id, name: 'Main board' });
    await page.evaluate(id => approveProposal(id), staged.proposal_id);
    assert.equal((await value('get_app_state')).current_board_id, board.id, 'approval opened the staged board');
    assert.equal((await value('get_board')).name, 'Main board');
    await value('switch_board', { board_id: sideId });
    await value('switch_board', { board_id: board.id });
  });

  await step('exports return content instead of downloading', async () => {
    const csv = await value('export_board', { format: 'csv' });
    assert.equal(csv.filename, 'main-board.csv');
    assert.match(csv.content, /^column,title,description/);
    assert.match(csv.content, /Write the brief/);
    const md = await value('export_board', { format: 'markdown' });
    assert.match(md.content, /^# Main board/);
    const share = await value('create_share_link', { stripped: true });
    assert.equal(share.fit, 'messaging');
    assert.match(share.url, /#kz:/);
  });

  await step('the person\'s own UI runs the same commands, unstaged', async () => {
    await page.locator('#board-area .column').first().locator('.add-card-btn').click();
    await page.fill('#kz-input', 'Typed by Asha');
    await page.click('#kz-ok');
    await page.waitForSelector('.card:has-text("Typed by Asha")');
    const entry = (await value('get_activity', { limit: 1 })).entries[0];
    assert.equal(entry.actor, 'person');
    assert.equal(entry.door, 'ui');
    assert.equal(entry.user, 'Asha');
    // card editor: Cancel drops the draft, Save dispatches one update_card
    await page.click('.card:has-text("Typed by Asha")');
    await page.locator('#card-labels-list .label-pill', { hasText: 'Bug' }).click();
    await page.click('#card-modal .modal-footer button:has-text("Cancel")');
    await page.waitForFunction(() => !document.querySelector('#card-modal.open'));
    const typed = (await value('search_cards', { query: 'Typed by Asha' })).cards[0];
    assert.deepEqual(typed.label_ids, []);
    await page.click('.card:has-text("Typed by Asha")');
    await page.locator('#card-labels-list .label-pill', { hasText: 'Bug' }).click();
    await page.fill('#card-title-input', 'Typed and labelled');
    await page.click('#card-modal button:has-text("+ Add item")');
    await page.click('#card-modal .modal-footer .btn-primary');
    await page.waitForFunction(() => !document.querySelector('#card-modal.open'));
    const saved = await value('get_card', { card_id: typed.id });
    assert.equal(saved.title, 'Typed and labelled');
    assert.deepEqual(saved.labels.map(l => l.name), ['Bug']);
    assert.equal(saved.checklist_items.length, 1);
    // settings: one Save is one undo step
    await page.evaluate(() => openModal('settings-modal'));
    await page.fill('#settings-board-name', 'Renamed in settings');
    await page.locator('#settings-columns-list input[type=number]').first().fill('4');
    await page.click('#settings-modal .modal-footer .btn-primary');
    await page.waitForFunction(() => !document.querySelector('#settings-modal.open'));
    let b = await value('get_board');
    assert.equal(b.name, 'Renamed in settings');
    assert.equal(b.columns[0].wip_limit, 4);
    await page.keyboard.press('ControlOrMeta+z');
    b = await value('get_board');
    assert.equal(b.name, 'Main board');
    assert.equal(b.columns[0].wip_limit, 0);
  });

  await step('change events reach window.kanzen.on listeners', async () => {
    const events = await page.evaluate(async () => {
      const seen = [];
      const off = window.kanzen.on('change', e => seen.push(`${e.actor}:${e.tool}`));
      await kzUi('set_view', { mode: 'list' });
      await kzUi('set_view', { mode: 'board' });
      off();
      await kzUi('set_view', { mode: 'list' });
      await kzUi('set_view', { mode: 'board' });
      return seen;
    });
    assert.deepEqual(events, ['person:set_view', 'person:set_view']);
  });

  await step('inside NakliOS, proposals wait in its review one at a time; an older host falls back', async () => {
    await page.evaluate(() => {
      window.__staged = [];
      window.__stageMode = 'accept';
      naklios.capabilities.review = true;
      naklios.review.stage = async (tool, diff) => {
        if(window.__stageMode === 'old') throw new Error('review tool does not match its app');
        if(window.__stageMode === 'poisoned') throw new Error('this change was discarded recently');
        window.__staged.push({ tool, diff });
        return { proposal_id: 'host_' + window.__staged.length };
      };
    });
    const first = await value('create_card', { column_id: todo, title: 'Reviewed in NakliOS' });
    const second = await value('create_card', { column_id: todo, title: 'Discarded in NakliOS' });
    let staged = await page.evaluate(() => window.__staged);
    assert.equal(staged.length, 1, 'one pending change per app frame');
    assert.equal(staged[0].tool, 'kanzen.agent');
    assert.equal(staged[0].diff.kind, 'agent');
    assert.match(staged[0].diff.summary, /Reviewed in NakliOS/);
    assert.equal((await value('get_proposal', { proposal_id: first.proposal_id })).review, 'naklios');
    await page.evaluate(id => approveProposal(id), first.proposal_id);
    assert.equal((await value('get_proposal', { proposal_id: first.proposal_id })).status, 'pending', 'KanZen\'s own approve leaves NakliOS-held proposals alone');
    await openAgentModal();
    assert.equal(await page.locator('.proposal-row .btn-primary').count(), 0, 'no Approve buttons for NakliOS-held proposals');
    assert.equal(await page.locator('.proposal-elsewhere').count(), 2);
    await page.evaluate(() => closeModal());
    assert.deepEqual(await page.evaluate(() => kzHostDecision('commit', 'host_1')), { ok: true });
    assert.equal((await value('get_proposal', { proposal_id: first.proposal_id })).status, 'applied');
    assert.ok((await value('search_cards', { query: 'Reviewed in NakliOS' })).total === 1);
    staged = await page.evaluate(() => window.__staged);
    assert.equal(staged.length, 2, 'the next proposal goes to NakliOS after a decision');
    assert.equal(await page.evaluate(() => kzHostDecision('commit', 'host_unknown')), undefined, 'card moves and unknown ids pass through');
    assert.deepEqual(await page.evaluate(() => kzHostDecision('discard', 'host_2')), { ok: true });
    assert.equal((await value('get_proposal', { proposal_id: second.proposal_id })).status, 'rejected');
    assert.equal((await value('search_cards', { query: 'Discarded in NakliOS' })).total, 0);
    await page.evaluate(() => { window.__stageMode = 'poisoned'; });
    const poisoned = await value('rename_board', { name: 'Same again' });
    assert.equal((await value('get_proposal', { proposal_id: poisoned.proposal_id })).status, 'rejected');
    await page.evaluate(() => { window.__stageMode = 'old'; });
    const fallback = await value('rename_board', { name: 'Old host' });
    const view = await value('get_proposal', { proposal_id: fallback.proposal_id });
    assert.equal(view.review, 'kanzen', 'an older host leaves the proposal in KanZen\'s dialog');
    await clickProposal(fallback.proposal_id, 'Approve');
    assert.equal((await value('get_board')).name, 'Old host');
    await page.evaluate(() => kzUi('rename_board', { name: 'Main board' }));
    await page.evaluate(() => { naklios.capabilities.review = false; KZ_AGENT.hostUnsupported = false; });
  });

  await step('approved changes persist across a reload; proposals do not', async () => {
    const staged = await value('add_comment', { card_id: cardId, text: 'Persist me' });
    await page.evaluate(id => approveProposal(id), staged.proposal_id);
    await page.evaluate(() => flushSave());
    await page.reload();
    await page.waitForFunction(() => window.kanzen && S.currentBoardId);
    const card = await value('get_card', { card_id: cardId });
    assert.equal(card.comment_list.at(-1).text, 'Persist me');
    assert.equal((await call('get_proposal', { proposal_id: staged.proposal_id })).code, 'not_found');
  });

  await step('the cross-tab channel is closed until the person opens it', async () => {
    const other = await context.newPage();
    await other.goto(url + 'blank');   // a same-origin page that is not KanZen
    const ask = (msg, wait = 400) => other.evaluate(([msg, wait]) => new Promise(resolve => {
      const channel = new BroadcastChannel('kanzen-agent');
      const replies = [];
      channel.onmessage = e => { if(e.data.id === msg.id && e.data.type !== 'kanzen:event') replies.push(e.data); };
      channel.postMessage(msg);
      setTimeout(() => { channel.close(); resolve(replies); }, wait);
    }), [msg, wait]);
    assert.deepEqual(await ask({ type: 'kanzen:discover', id: 'd1' }), []);
    await page.evaluate(() => openModal('prefs-modal'));
    await page.check('#prefs-agent-channel');
    await page.evaluate(() => closeModal());
    const tab = await page.evaluate(() => window.kanzen.tab);
    const here = await ask({ type: 'kanzen:discover', id: 'd2' });
    assert.deepEqual(here.map(r => r.tab), [tab]);
    const untargeted = await ask({ type: 'kanzen:call', id: 'c0', tool: 'list_boards', input: {} });
    assert.deepEqual(untargeted, [], 'a call must name its target tab');
    const listed = await ask({ type: 'kanzen:call', id: 'c1', target: tab, tool: 'list_boards', input: {} });
    assert.equal(listed[0].ok, true);
    assert.equal(listed[0].result.boards.length, 2);
    const staged = await ask({ type: 'kanzen:call', id: 'c2', target: tab, tool: 'create_card', input: { column_id: todo, title: 'From another tab' }, caller: 'tab-two' });
    assert.equal(staged[0].result.status, 'pending_approval');
    const refused = await ask({ type: 'kanzen:call', id: 'c3', target: tab, tool: 'set_agent_channel', input: {} });
    assert.equal(refused[0].ok, false);
    assert.equal(refused[0].error.code, 'person_only');
    await page.evaluate(id => approveProposal(id), staged[0].result.proposal_id);
    const entry = (await value('get_activity', { limit: 1 })).entries[0];
    assert.equal(entry.door, 'channel');
    assert.equal(entry.caller, 'tab-two');
    await other.close();
  });

  assert.deepEqual(failures, [], 'no page errors');
  await context.close();
}finally{
  await browser.close();
  server.close();
}
console.log(`KanZen agent face: ${passed} checks passed`);
