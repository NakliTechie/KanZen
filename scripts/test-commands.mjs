// NakliOS commands: commands.json against the host's rules and KanZen's handlers, then a stand-in host in headless
// Chromium that registers them and calls them over the real SDK wire, the way sys/host/catalog.mjs does.
//   node scripts/test-commands.mjs   (first, in scripts/: `npm ci` and `npx playwright install --only-shell chromium`)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = await readFile(join(root, 'index.html'), 'utf8');
const { commands } = JSON.parse(await readFile(join(root, 'commands.json'), 'utf8'));

let passed = 0;
async function step(name, fn){
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The handler table, read from the shipped source: its keys and the KZ_TOOLS entries they run.
const tableStart = html.indexOf('const KZ_COMMANDS = {');
const table = html.slice(tableStart, html.indexOf('\n};', tableStart));
const handlerNames = [...table.matchAll(/^ {2}'([a-z.]+)':/gm)].map(match => match[1]);
const toolNames = [...table.matchAll(/kz(?:Command|AgentCall)\('([a-z_]+)'/g)].map(match => match[1]);

await step('commands.json keeps the host catalog\'s rules', async () => {
  const NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/;
  assert.ok(commands.length > 0 && commands.length <= 64);
  assert.equal(new Set(commands.map(c => c.name)).size, commands.length, 'names are unique');
  for(const c of commands){
    assert.match(c.name, NAME);
    assert.ok(['read', 'write', 'destructive'].includes(c.scope), `${c.name} scope`);
    assert.ok(c.description.trim() && /e\.g\. /.test(c.description), `${c.name} has an example phrase`);
    assert.equal(c.input.type, 'object', `${c.name} input`);
    for(const key of c.input.required || []) assert.ok(Object.hasOwn(c.input.properties, key), `${c.name} requires ${key}`);
  }
});
await step('every command has a handler, every handler a command, and each runs a declared tool', async () => {
  assert.deepEqual([...handlerNames].sort(), commands.map(c => c.name).sort());
  for(const tool of toolNames) assert.match(html, new RegExp(`\\{ name:'${tool}',`), `${tool} is in KZ_TOOLS`);
  assert.ok(toolNames.length >= commands.length);
});

const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json' };
// A stand-in for the desktop: it answers the handshake, keeps what the app registers, and takes review staging.
const hostPage = `<!doctype html><iframe id="app" src="/index.html" style="width:1200px;height:800px"></iframe><script>
  const frame = document.getElementById('app');
  const send = message => frame.contentWindow.postMessage(message, '*');
  const waiting = new Map();
  let counter = 0;
  window.host = { registered: null, staged: [], applied: [] };
  addEventListener('message', event => {
    if(event.source !== frame.contentWindow) return;
    const msg = event.data || {};
    if(msg.type === 'naklios:ready' || msg.type === 'naklios:capabilities-request') send({ type:'naklios:capabilities', fs:false, fsBackends:[], review:true });
    if(msg.type === 'naklios:commands:register'){
      window.host.registered = msg.commands;
      send({ type:'naklios:commands:reply', requestId:msg.requestId, result:{ ok:true, registered:msg.commands.map(c => 'kanzen.' + c.name) } });
    }
    if(msg.type === 'naklios:commands:result'){ waiting.get(msg.invokeId)(msg); waiting.delete(msg.invokeId); }
    if(msg.type === 'naklios:review:stage'){
      const proposal_id = 'host_' + (++counter);
      window.host.staged.push({ proposal_id, tool:msg.tool, diff:msg.diff });
      send({ type:'naklios:review:reply', requestId:msg.requestId, result:{ proposal_id } });
    }
    if(msg.type === 'naklios:review:applied') window.host.applied.push(msg);
  });
  window.host.invoke = (name, args = {}) => new Promise(resolve => {
    const invokeId = 'c' + (++counter);
    waiting.set(invokeId, resolve);
    send({ type:'naklios:commands:invoke', invokeId, name, args: structuredClone(args) });
  });
  window.host.commit = proposal_id => send({ type:'naklios:review:commit', proposal_id });
</script>`;
const requests = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  requests.push(pathname);
  if(pathname === '/host.html'){ res.writeHead(200, { 'content-type': types['.html'] }); res.end(hostPage); return; }
  const path = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' || path === '\\' ? 'index.html' : path);
  try{
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const failures = [];
const watch = page => page.on('pageerror', error => failures.push(`page error: ${error.message}`));
const skipIntro = () => { try{ localStorage.setItem('kanzen.introSeen', '1'); }catch(_){} };
try{
  // Standalone first, so a request for commands.json here can only come from the standalone page.
  await step('standalone KanZen neither fetches nor registers commands', async () => {
    const context = await browser.newContext();
    await context.addInitScript(skipIntro);
    const page = await context.newPage();
    watch(page);
    await page.goto(url);
    await page.waitForFunction(() => window.kanzen);
    await page.waitForTimeout(300);
    assert.ok(!requests.includes('/commands.json'), 'no fetch of commands.json');
    const doors = await page.evaluate(() => window.kanzen.manifest().doors);
    assert.deepEqual(Object.keys(doors), ['modelContext', 'window', 'channel']);
    await context.close();
  });

  const context = await browser.newContext();
  await context.addInitScript(skipIntro);
  const page = await context.newPage();
  watch(page);
  await page.goto(url + 'host.html');
  await page.waitForFunction(() => window.host.registered);
  const app = page.frames().find(frame => frame.url().endsWith('/index.html'));
  const invoke = (name, args) => page.evaluate(([name, args]) => window.host.invoke(name, args), [name, args]);
  const result = async (name, args) => {
    const reply = await invoke(name, args);
    assert.equal(reply.error, undefined, `${name} failed: ${reply.error}`);
    return reply.result;
  };

  await step('hosted, the commands register with the channel switch off', async () => {
    const registered = await page.evaluate(() => window.host.registered);
    assert.deepEqual(registered.map(c => c.name), commands.map(c => c.name));
    assert.deepEqual(registered.map(c => c.scope), commands.map(c => c.scope));
    const state = await app.evaluate(() => ({ channel: localStorage.getItem('kanzen.agentChannel'), doors: window.kanzen.manifest().doors }));
    assert.equal(state.channel, null);
    assert.match(state.doors.channel, /closed/);
    assert.equal(state.doors.commands, 'registered with NakliOS');
  });

  const boards = await result('board.list');
  assert.ok(boards.boards.length >= 1);
  const opening = await result('board.read');
  const [first, , last] = opening.columns;

  await step('reads answer by name, and a read result is plain data', async () => {
    assert.equal(opening.id, boards.current_board_id);
    assert.equal((await result('board.read', { board: opening.name.toUpperCase() })).id, opening.id);
    const listed = await result('card.list', { column: first.name });
    assert.equal(listed.total, first.card_count);
    assert.equal(listed.cards.every(card => card.column === first.name), true);
  });

  let proposalId;
  await step('card.add stages a proposal, returns its id, and applies on the host\'s commit', async () => {
    const before = (await result('card.list', { text: 'Call the plumber' })).total;
    const staged = await result('card.add', { title: 'Call the plumber' });
    assert.equal(staged.status, 'pending_approval');
    assert.match(staged.proposal_id, /^prop_/);
    assert.match(staged.message, /proposal\.status/);
    proposalId = staged.proposal_id;
    await page.waitForFunction(() => window.host.staged.length === 1);
    const hostProposal = await page.evaluate(() => window.host.staged[0]);
    assert.equal(hostProposal.tool, 'kanzen.agent');
    assert.equal(hostProposal.diff.door, 'commands');
    assert.equal((await result('card.list', { text: 'Call the plumber' })).total, before, 'nothing changes before approval');
    assert.equal((await result('proposal.status', { proposal_id: proposalId })).status, 'pending');
    assert.deepEqual((await result('proposal.status')).proposals.map(p => p.proposal_id), [proposalId]);
    await page.evaluate(id => window.host.commit(id), hostProposal.proposal_id);
    await page.waitForFunction(() => window.host.applied.length === 1);
    assert.equal((await page.evaluate(() => window.host.applied[0])).ok, true);
    const applied = await result('proposal.status', { proposal_id: proposalId });
    assert.equal(applied.status, 'applied');
    const found = await result('card.list', { text: 'Call the plumber' });
    assert.equal(found.total, before + 1);
    assert.equal(found.cards[0].column, first.name, 'the first column by default');
  });

  await step('card.move finds the card by part of its title and the column by name', async () => {
    const staged = await result('card.move', { card: 'plumber', column: last.name.toLowerCase() });
    assert.equal(staged.status, 'pending_approval');
    await page.waitForFunction(() => window.host.staged.length === 2);
    await page.evaluate(() => window.host.commit(window.host.staged[1].proposal_id));
    await page.waitForFunction(() => window.host.applied.length === 2);
    assert.equal((await result('card.list', { text: 'plumber' })).cards[0].column, last.name);
  });

  await step('a name that fits nothing or several rows is an error, logged on the door', async () => {
    assert.match((await invoke('card.move', { card: 'no such card', column: last.name })).error, /No card on board/);
    const titles = ['Twin alpha', 'Twin beta'];
    for(const title of titles){
      const count = await page.evaluate(() => window.host.staged.length);
      const { proposal_id } = await result('card.add', { title });
      await page.waitForFunction(count => window.host.staged.length === count + 1, count);
      await page.evaluate(() => window.host.commit(window.host.staged.at(-1).proposal_id));
      await page.waitForFunction(count => window.host.applied.length === count + 1, count);
      assert.ok(proposal_id);
    }
    assert.match((await invoke('card.move', { card: 'twin', column: last.name })).error, /More than one card/);
    const log = await app.evaluate(() => KZ_AGENT.calls.filter(call => call.door === 'commands' && call.outcome === 'error').map(call => call.detail));
    assert.equal(log.length, 2);
  });

  await context.close();

  await step('a missing commands.json logs a warning and KanZen still runs', async () => {
    const broken = await browser.newContext();
    await broken.addInitScript(skipIntro);
    await broken.route('**/commands.json', route => route.fulfill({ status: 404, body: 'gone' }));
    const hosted = await broken.newPage();
    watch(hosted);
    const warnings = [];
    hosted.on('console', msg => { if(msg.type() === 'warning') warnings.push(msg.text()); });
    await hosted.goto(url + 'host.html');
    await hosted.waitForFunction(() => document.getElementById('app').contentWindow.kanzen);
    await hosted.waitForTimeout(300);
    assert.ok(warnings.some(text => text.includes('commands could not register')), 'the warning is logged');
    assert.equal(await hosted.evaluate(() => window.host.registered), null);
    await broken.close();
  });

  assert.deepEqual(failures, []);
  console.log(`commands: ${passed} checks passed`);
}finally{
  await browser.close();
  server.close();
}
