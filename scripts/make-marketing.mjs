// Builds the README hero and the 1280×640 social card from a seeded demo board.
//   node scripts/make-marketing.mjs   →  marketing/hero.png, marketing/social.png, social.png (served by the app)
// The board is seeded through the agent face, so the pictures show the real app, not a mock.
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' ? 'index.html' : path);
  try{
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'image/png' });
    res.end(body);
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
await mkdir(join(root, 'marketing'), { recursive: true });

const browser = await chromium.launch();
try{
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => localStorage.setItem('kanzen.introSeen', '1'));
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.kanzen && document.querySelector('#welcome-modal.open'));
  await page.fill('#welcome-name', 'Asha');
  await page.click('#welcome-modal .btn-primary');
  // Seed through the person's own command path (kzUi), the same commands an agent would stage.
  await page.evaluate(async () => {
    await kzUi('rename_board', { name: 'Website relaunch' });
    const b = currentBoard();
    const [todo, doing, done] = b.columns.map(c => c.id);
    const label = name => b.labels.find(l => l.name === name).id;
    const design = (await kzUi('create_label', { name: 'Design', color: '#c377e0' })).label_id;
    const asha = (await kzUi('create_member', { name: 'Asha Rao' })).member_id;
    const dev = (await kzUi('create_member', { name: 'Dev Mehta' })).member_id;
    const review = (await kzUi('create_column', { name: 'Review', position: 2 })).column_id;
    const card = async (column_id, title, extra = {}) => (await kzUi('create_card', { column_id, title, ...extra })).card_id;
    await card(todo, 'Write the launch post', { priority: 'medium', due_date: '2026-10-16', member_ids: [asha] });
    await card(todo, 'Pick a hosting plan', { label_ids: [label('Research')] });
    const hero = await card(todo, 'New hero illustration', { label_ids: [design], priority: 'low' });
    await card(todo, 'Cookie banner copy', { label_ids: [label('Idea')] });
    const nav = await card(doing, 'Rebuild the navigation', { label_ids: [design], priority: 'high', due_date: '2026-10-09', member_ids: [dev] });
    await kzUi('add_checklist_items', { card_id: nav, items: ['Mobile menu', 'Keyboard focus', 'Active state'] });
    await kzUi('update_card', { card_id: nav, checklist: currentBoard().cards[nav].checklist.map((item, i) => ({ ...item, done: i < 2 })) });
    await card(doing, 'Fix the broken contact form', { label_ids: [label('Bug')], priority: 'urgent', member_ids: [asha, dev] });
    await card(review, 'Pricing page', { priority: 'medium', member_ids: [asha], due_date: '2026-10-07' });
    await card(done, 'Audit the old site', { label_ids: [label('Research')] });
    await card(done, 'Logo files to SVG', { label_ids: [design] });
    await kzUi('add_comment', { card_id: hero, text: 'Draft is in the shared folder.', author_member_id: asha });
  });
  await page.evaluate(async () => { closeModal(); document.activeElement?.blur(); await flushSave(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'marketing/hero.png'), clip: { x: 0, y: 0, width: 1440, height: 540 } });

  // The social card: the one sentence, the name, and the surface itself, at 1280×640.
  const card = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><head><style>
    body { margin:0; width:1280px; height:640px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
      background:linear-gradient(135deg,#0079bf 0%,#5067c5 100%); color:#fff; }
    .text { position:absolute; left:72px; top:92px; width:520px; }
    .mark { display:inline-flex; align-items:center; justify-content:center; width:64px; height:64px; border-radius:14px; background:#fff;
      color:#0079bf; font-weight:800; font-size:28px; letter-spacing:-1px; }
    h1 { font-size:72px; margin:28px 0 18px; letter-spacing:-1.5px; }
    p { font-size:34px; line-height:1.25; margin:0; font-weight:600; }
    .shot { position:absolute; left:640px; top:96px; width:900px; border-radius:14px; box-shadow:0 24px 60px rgba(0,0,0,0.35); }
  </style></head><body>
    <img class="shot" src="${url}marketing/hero.png">
    <div class="text"><span class="mark">KZ</span><h1>KanZen</h1><p>Kanban boards as plain files in a folder you choose.</p></div>
  </body></html>`);
  await card.waitForFunction(() => document.querySelector('.shot').complete);
  await card.screenshot({ path: join(root, 'marketing/social.png') });
  await copyFile(join(root, 'marketing/social.png'), join(root, 'social.png'));
}finally{
  await browser.close();
  server.close();
}
console.log('wrote marketing/hero.png, marketing/social.png, social.png');
