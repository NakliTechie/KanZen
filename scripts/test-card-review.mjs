import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists in the shipped app`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let at = brace; at < html.length; at++) {
    if (html[at] === '{') depth++;
    if (html[at] === '}' && --depth === 0) return html.slice(start, at + 1);
  }
  throw new Error(`unterminated ${name}`);
}
const start = html.indexOf('const pendingCardMoves = new Map();');
const end = html.indexOf("document.addEventListener('click'", start);
assert.ok(start > 0 && end > start, 'shipped card-review block exists');

const board = {
  id: 'board-1', name: 'Work',
  columns: [
    { id: 'todo', name: 'To do', cardIds: ['card-1'] },
    { id: 'done', name: 'Done', cardIds: [] },
  ],
  cards: { 'card-1': { id: 'card-1', title: 'Review me' } },
};
const state = { boards: { 'board-1': board }, currentBoardId: 'board-1' };
const staged = [];
const effects = { saved: 0, rendered: 0, activity: 0 };
let decision;
const context = vm.createContext({
  S: state,
  BOARD_RUNTIME_KEYS: new Set(),
  isPlainRecord: value => value !== null && typeof value === 'object' && !Array.isArray(value),
  currentBoard: () => state.boards[state.currentBoardId],
  findColumnByCard: (b, id) => b.columns.find(column => column.cardIds.includes(id)),
  stampCard: () => {},
  logActivity: () => { effects.activity++; },
  scheduleSave: () => { effects.saved++; },
  closeMovePopover: () => {},
  renderBoard: () => { effects.rendered++; },
  toast: () => {},
  naklios: { capabilities: { review: true }, review: {
    stage: async (tool, diff) => {
      assert.equal(tool, 'kanzen.card-move');
      staged.push(diff);
      return { proposal_id: `prop_${staged.length}` };
    },
    onDecision: callback => { decision = callback; },
  } },
});
vm.runInContext(`${extractFunction('boardRevisionSignature')}\n${html.slice(start, end)}\n` +
  'globalThis.cardReview = { stageCardMove, pendingCardMoves };', context);

const { stageCardMove, pendingCardMoves } = context.cardReview;
await stageCardMove('card-1', 'done', 0);
assert.deepEqual(board.columns.map(column => column.cardIds), [['card-1'], []],
  'staging never moves a card');
assert.equal(effects.saved, 0);
assert.equal(staged[0].fromName, 'To do');
assert.equal(staged[0].toName, 'Done');
assert.equal(staged[0].cardTitle, 'Review me');
assert.equal(pendingCardMoves.size, 1);

decision({ type: 'commit', proposal_id: 'prop_1' });
assert.deepEqual(board.columns.map(column => column.cardIds), [[], ['card-1']]);
assert.equal(effects.saved, 1);
assert.equal(effects.activity, 1);
assert.throws(() => decision({ type: 'commit', proposal_id: 'prop_1' }), /no pending/,
  'replayed approval cannot apply a move twice');
assert.equal(effects.saved, 1);

await stageCardMove('card-1', 'todo', 0);
decision({ type: 'discard', proposal_id: 'prop_2' });
assert.deepEqual(board.columns.map(column => column.cardIds), [[], ['card-1']],
  'discard keeps the board unchanged');
assert.equal(effects.saved, 1);

await stageCardMove('card-1', 'todo', 0);
board.cards['card-1'].title = 'Changed since staging';
assert.throws(() => decision({ type: 'commit', proposal_id: 'prop_3' }), /Board changed/,
  'an approved diff cannot mutate a changed board');
assert.deepEqual(board.columns.map(column => column.cardIds), [[], ['card-1']]);
assert.equal(effects.saved, 1);

console.log('KanZen card review: native diff, commit once, discard, and stale-base refusal passed');
