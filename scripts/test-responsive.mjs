// Layout test at phone, tablet and desktop widths in headless Chromium. Checks that the page never
// scrolls sideways, the header fits, every header action stays reachable (inline or in the ⋯
// menu), and the phone flows work by touch: menu, filter panel, card editor, long-press "Move to".
//   node scripts/test-responsive.mjs   (first, in scripts/: `npm ci` and `npx playwright install --only-shell chromium`)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, path === '/' ? 'index.html' : path);
  try{
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(body);
  }catch{ res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

let passed = 0;
async function step(name, fn){ await fn(); passed++; console.log(`  ok  ${name}`); }

async function open(browser, viewport, mobile){
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(() => localStorage.setItem('kanzen.introSeen', '1'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.kanzen && document.querySelector('#welcome-modal.open'));
  await page.fill('#welcome-name', 'Ravi');
  await page.click('#welcome-modal .btn-primary');
  // two more boards' worth of content so columns and the list have something in them
  await page.evaluate(async () => {
    const b = currentBoard();
    for(const [i, column] of b.columns.entries()) await kzUi('create_card', { column_id: column.id, title: `Card ${i + 1}`, priority: 'high', due_date: '2026-10-09' });
  });
  return { context, page, errors };
}
// Facts about the layout, read in the page.
const layout = async page => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); return page.evaluate(() => {
  const header = document.getElementById('app-header');
  const foldable = [...header.querySelectorAll('[data-fold]')].filter(el => el.style.display !== 'none');
  const visible = foldable.filter(el => getComputedStyle(el).display !== 'none');
  return {
    overflowX: document.documentElement.scrollWidth - innerWidth,
    headerOverflow: header.scrollWidth - header.clientWidth,
    headerHeight: header.offsetHeight,
    chrome: header.offsetHeight + document.getElementById('filter-bar').offsetHeight,
    foldable: foldable.length,
    visible: visible.length,
    moreShown: getComputedStyle(document.getElementById('more-btn')).display !== 'none',
    columnWidth: document.querySelector('#board-area .column')?.offsetWidth ?? 0,
    width: innerWidth,
  };
}); };
async function moreMenuItems(page){
  await page.click('#more-btn');
  await page.waitForSelector('#more-menu.open');
  const items = await page.$$eval('#more-menu .more-item', els => els.map(el => el.textContent.trim()));
  await page.evaluate(() => closeMoreMenu());
  return items;
}

const browser = await chromium.launch();
try{
  for(const [width, height] of [[1280, 800], [1024, 768], [800, 700]]){
    await step(`${width}px: one header row, no sideways scroll, every action reachable`, async () => {
      const { context, page, errors } = await open(browser, { width, height }, false);
      const l = await layout(page);
      assert.equal(l.overflowX, 0);
      assert.ok(l.headerOverflow <= 1, `header overflows by ${l.headerOverflow}px`);
      assert.ok(l.headerHeight < 60, `header is ${l.headerHeight}px tall`);
      const folded = l.foldable - l.visible;
      assert.equal(l.moreShown, folded > 0);
      if(folded) assert.equal((await moreMenuItems(page)).length, folded);
      if(width === 1280) assert.equal(folded, 0, 'nothing folds on a wide screen');
      assert.ok(await page.isVisible('[title^="Undo"]'), 'undo stays in the header');
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  const { context, page, errors } = await open(browser, { width: 375, height: 812 }, true);
  await step('375px phone: compact chrome, one column per screen, no sideways scroll', async () => {
    const l = await layout(page);
    assert.equal(l.overflowX, 0);
    assert.ok(l.chrome <= 150, `header and filters take ${l.chrome}px`);
    assert.ok(l.columnWidth <= l.width - 40 && l.columnWidth >= 260, `column is ${l.columnWidth}px`);
    assert.equal(l.visible, 0, 'every header action folds into ⋯');
    assert.equal(await page.$eval('#board-area', el => getComputedStyle(el).scrollSnapType), 'x mandatory');
    assert.equal(await page.isVisible('.footer-nav'), false);
  });
  await step('375px phone: the ⋯ sheet holds every action and its items work', async () => {
    const items = await moreMenuItems(page);
    const l = await layout(page);
    assert.equal(items.length, l.foldable + 2, 'all header actions plus the two footer links');
    await page.tap('#more-btn');
    await page.locator('#more-menu .more-item', { hasText: 'Board settings' }).tap();
    await page.waitForSelector('#settings-modal.open');
    const box = await page.locator('#settings-modal').boundingBox();
    assert.equal(Math.round(box.width), 375, 'dialogs fill the screen');
    await page.evaluate(() => closeModal());
  });
  await step('375px phone: the filter panel opens and counts active filters', async () => {
    assert.equal(await page.isVisible('#filter-priority'), false);
    await page.tap('#filter-toggle');
    await page.selectOption('#filter-priority', 'high');
    await page.waitForFunction(() => document.getElementById('filter-toggle').textContent === 'Filters (1)');
    await page.tap('.clear-filters');
    await page.tap('#filter-toggle');
    assert.equal(await page.isVisible('#filter-priority'), false);
  });
  await step('375px phone: the card editor moves a card between columns', async () => {
    await page.locator('.card', { hasText: 'Card 1' }).tap();
    await page.waitForSelector('#card-modal.open');
    const done = await page.evaluate(() => currentBoard().columns[2].id);
    await page.selectOption('#card-column', done);
    await page.tap('#card-modal .modal-footer .btn-primary');
    await page.waitForFunction(() => !document.querySelector('#card-modal.open'));
    const where = await page.evaluate(() => findColumnByCard(currentBoard(), Object.values(currentBoard().cards).find(c => c.title === 'Card 1').id).name);
    assert.equal(where, 'Done');
  });
  await step('375px phone: a long-press opens "Move to" without opening the editor', async () => {
    const card = page.locator('.card', { hasText: 'Card 2' });
    const box = await card.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await card.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: x, clientY: y, bubbles: true });
    await page.waitForTimeout(550);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', clientX: x, clientY: y, bubbles: true });
    await card.dispatchEvent('click');
    assert.ok(await page.isVisible('#move-popover.open'));
    assert.equal(await page.isVisible('#card-modal.open'), false);
    await page.locator('#move-popover button', { hasText: 'To Do' }).tap();
    const where = await page.evaluate(() => findColumnByCard(currentBoard(), Object.values(currentBoard().cards).find(c => c.title === 'Card 2').id).name);
    assert.equal(where, 'To Do');
    assert.equal(await page.isVisible('#move-popover.open'), false);
  });
  await step('375px phone: columns reorder by touch, in the header and in settings', async () => {
    const names = () => page.evaluate(() => currentBoard().columns.map(c => c.name));
    assert.deepEqual(await names(), ['To Do','In Progress','Done']);
    assert.equal(await page.isVisible('#board-area .column >> nth=0 >> [data-column-action="left"]'), false);
    await page.locator('#board-area .column').first().locator('[data-column-action="right"]').tap();
    await page.waitForFunction(() => currentBoard().columns[0].name === 'In Progress');
    assert.deepEqual(await names(), ['In Progress','To Do','Done']);
    await page.evaluate(() => openModal('settings-modal'));
    await page.locator('#settings-columns-list > div').nth(2).getByRole('button', { name: 'Move column up' }).tap();
    await page.waitForFunction(() => currentBoard().columns[1].name === 'Done');
    assert.deepEqual(await names(), ['In Progress','Done','To Do']);
    assert.equal(await page.inputValue('#settings-columns-list > div:nth-child(2) input[type=text]'), 'Done', 'settings re-render in the new order');
    await page.evaluate(() => closeModal());
  });
  await step('375px phone: list and calendar fit the screen', async () => {
    for(const mode of ['list', 'calendar']){
      await page.evaluate(mode => kzUi('set_view', { mode }), mode);
      assert.equal((await layout(page)).overflowX, 0, `${mode} scrolls sideways`);
    }
    const selector = '.cal-view';
    assert.equal(await page.$eval(selector, el => el.scrollWidth - el.clientWidth), 0);
  });
  assert.deepEqual(errors, []);
  await context.close();
}finally{
  await browser.close();
  server.close();
}
console.log(`KanZen responsive layout: ${passed} checks passed`);
