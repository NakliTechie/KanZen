// Agent-face parity lint. The rule from the build doctrine: the manifest covers the command bus.
// KanZen has no separate bus object, so this lint defines it mechanically and checks it:
//   1. Every change to boards, settings or view state happens in a command (a cmd* function that is
//      the `run` of a KZ_TOOLS entry), in a person-only act, or in named infrastructure below.
//   2. Every UI event handler reaches the app only through dispatchers (functions that call kzUi or
//      kzDispatch), UI-only functions named below, or person-only acts.
//   3. Dispatchers and UI-only functions never change state themselves.
//   4. Every command name the UI dispatches exists in the manifest, every cmd* is in it, and every
//      entry is well formed: callable entries have a cmd* run, person-only entries a reason and UI.
//   5. Both agent doors are built from KZ_TOOLS.
// Exit 0 when clean; otherwise every finding is printed with its line and the exit code is 1.
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { full, simple } from 'acorn-walk';

// An optional path lets the lint's own negative test point it at a deliberately broken copy.
const html = readFileSync(process.argv[2] || new URL('../index.html', import.meta.url), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('index.html has no inline script');
const scriptStart = html.slice(0, scriptMatch.index).split('\n').length - 1;
// Blank the vendored SDK (it is not app code) but keep its lines so locations stay true.
const code = scriptMatch[1].replace(/\/\* naklios-sdk:begin[\s\S]*?naklios-sdk:end \*\//, m => m.replace(/[^\n]/g, ' '));
const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
const lineOf = node => scriptStart + node.loc.start.line;

// Functions allowed to change state outside a command, and why.
const INFRA = {
  scheduleSave: 'marks the open board dirty and pushes undo history', flushSave: 'writes the open board',
  markDirty: 'arms the autosave', pushHistory: 'records an undo step', logActivity: 'appends to board history',
  stampCard: 'stamps last-modified', markCardDirty: 'team-mode write tracking', markCardDeleted: 'team-mode delete tracking',
  flushAllBoards: 'writes every board', takeSnapshot: 'snapshot primitive', takeSnapshotForBoard: 'snapshot primitive',
  maybeAutoSnapshot: 'auto snapshot before destructive commands', maybeDailySnapshot: 'daily auto snapshot at load',
  applyCardMove: 'the commit half of a card move (command and NakliOS review decision)',
  stageCardMove: 'stages a person\'s card move for NakliOS review, or applies it when review is off',
  convertSoloToTeam: 'team-mode file layout conversion', convertTeamToSolo: 'team-mode file layout conversion',
  activateLibrary: 'loads a storage library', tryReuseStoredHandle: 'reconnects a remembered folder at load',
  applyExternalBoardUpdate: 'applies a board edited on disk, in NakliOS or by sync',
  applyExternalBoardRemoval: 'applies a board removed elsewhere', refreshNakliOSLibraryFromStorage: 'NakliOS storage events',
  pollFsChanges: 'folder polling', init: 'startup', markBoardForSync: 'queues a sync push',
  flushSyncPushes: 'sync push', pushBoard: 'sync push', deleteRemoteBoard: 'sync delete', syncPullAll: 'sync pull',
  renderCalendarView: 'defaults an unset calendar month while rendering',
  kzActivateBoard: 'command helper: opens a board after saving the one being left',
  kzStoreImported: 'command helper: stores imported boards', kzHistoryStep: 'command helper: undo and redo',
  kzApplyProposals: 'applies proposals the person approved', kzDecide: 'records a proposal decision',
  restoreBoardState: 'rebuilds a board from serialized state for commands',
  rebuildBoardOrder: 'derives the sorted board list from S.boards', boardSaver: 'autosave wiring', syncSaver: 'sync autosave wiring',
};
// Functions UI handlers may call that are not dispatchers, and why. They must not change state.
const UI_ONLY = {
  closeModal: 'closes dialogs', openModal: 'opens dialogs', onOverlayClick: 'closes dialogs',
  openShareModal: 'opens the share dialog', shareSnapshot: 'opens the share dialog for a snapshot',
  setHelpTab: 'help tabs', togglePalettePopover: 'palette menu', closePalettePopover: 'palette menu',
  closeMovePopover: 'move menu', openMovePopover: 'move menu', setupCardLongPress: 'touch gesture wiring',
  openCardEditor: 'opens the card editor', renderDescPreview: 'markdown preview',
  renderEditorChecklist: 'edits the card draft', renderEditorLabels: 'edits the card draft',
  renderEditorMembers: 'edits the card draft', updateChecklistProgress: 'draft progress bar',
  introDismiss: 'first-run intro', introOpenReadme: 'opens the README', onSyncClick: 'opens preferences',
  copyShareUrl: 'clipboard', renderQrCode: 'QR code', dismissImportBanner: 'hides the share banner',
  toggleSnapshotCompareMode: 'snapshot compare picker', pickSnapshotForCompare: 'snapshot compare picker',
  renderActivityModal: 'activity filters', clearActivityFilters: 'activity filters',
  moveFocus: 'keyboard focus',
  onCardDragStart: 'drag start', onColDragStart: 'drag start', onColDragOver: 'drag hover',
  toggleMoreMenu: 'the ⋯ menu of folded header buttons', closeMoreMenu: 'the ⋯ menu', runMoreItem: 'clicks a folded header button',
  toggleFilterPanel: 'shows the filter panel on phones', scheduleFitHeader: 'refits the header to its width',
  onCardClick: 'opens the card editor unless a long-press just opened "Move to"',
  addChecklistItem: 'edits the card draft', _kzClose: 'in-app prompt and confirm dialog', _kzKey: 'in-app prompt and confirm dialog',
};
const PRIMITIVE_CALLS = new Set([
  'scheduleSave','flushSave','markDirty','pushHistory','logActivity','stampCard','markCardDirty','markCardDeleted',
  'flushAllBoards','takeSnapshot','takeSnapshotForBoard','maybeAutoSnapshot','applyCardMove','convertSoloToTeam',
  'convertTeamToSolo','markBoardForSync','pushBoard','deleteRemoteBoard','kzActivateBoard','kzStoreImported',
  'kzHistoryStep','kzApplyProposals','kzDecide','activateLibrary','syncPullAll','flushSyncPushes',
]);
const STORAGE_OBJECTS = new Set(['storage','StorageFS','StorageIDB','StorageNakliOS']);
const STORAGE_WRITES = /^(save|delete|write|append|remove)/;
const STATE_KEYS = new Set(['boards','boardOrder','currentBoardId','settings','filter','viewMode','listSort','calMonth','storageMode','history','dirty']);
const MUTATING_METHODS = new Set(['push','pop','shift','unshift','splice','sort','reverse','fill','copyWithin']);
const UI_EVENTS = new Set(['click','change','input','drop','keydown','keyup','blur','submit','dragstart','dragover','dragleave','dragend','pointerdown','pointerup','pointermove','pointercancel','focus','dblclick','contextmenu']);
const findings = [];
const fail = (line, message) => findings.push(`index.html:${line}  ${message}`);

/* ---------- inventory ---------- */
const functions = new Map(); // name → FunctionDeclaration
for (const node of ast.body) if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node);

function stateRoot(node) { // S.<key>… → key, else null
  const path = [];
  let cur = node;
  while (cur && cur.type === 'MemberExpression') { path.unshift(cur.property); cur = cur.object; }
  if (cur?.type !== 'Identifier' || cur.name !== 'S' || !path.length) return null;
  const first = path[0];
  const key = first.type === 'Identifier' ? first.name : first.value;
  return STATE_KEYS.has(key) ? key : null;
}
// Calls to app functions and state changes inside a node, nested closures included. Inline
// attribute handlers are parsed on their own, so they pass the line to report.
function effects(node, fixedLine) {
  const calls = new Set();
  const mutations = [];
  const lineOf = child => fixedLine ?? scriptStart + child.loc.start.line;
  full(node, child => {
    if (child.type === 'CallExpression') {
      const callee = child.callee;
      if (callee.type === 'Identifier') {
        calls.add(callee.name);
        if (PRIMITIVE_CALLS.has(callee.name)) mutations.push({ line: lineOf(child), what: `calls ${callee.name}()` });
      } else if (callee.type === 'MemberExpression' && !callee.computed) {
        const method = callee.property.name;
        const object = callee.object;
        if (object.type === 'Identifier' && STORAGE_OBJECTS.has(object.name) && STORAGE_WRITES.test(method)) {
          mutations.push({ line: lineOf(child), what: `calls ${object.name}.${method}()` });
        }
        if (object.type === 'MemberExpression' && object.object.type === 'Identifier' && object.object.name === 'naklios'
            && object.property.name === 'fs' && /^(write|delete|append|useBackend)$/.test(method)) {
          mutations.push({ line: lineOf(child), what: `calls naklios.fs.${method}()` });
        }
        if (MUTATING_METHODS.has(method) && stateRoot(object)) mutations.push({ line: lineOf(child), what: `mutates S.${stateRoot(object)}` });
      }
    } else if (child.type === 'AssignmentExpression' && stateRoot(child.left)) {
      mutations.push({ line: lineOf(child), what: `writes S.${stateRoot(child.left)}` });
    } else if (child.type === 'UpdateExpression' && stateRoot(child.argument)) {
      mutations.push({ line: lineOf(child), what: `writes S.${stateRoot(child.argument)}` });
    } else if (child.type === 'UnaryExpression' && child.operator === 'delete' && stateRoot(child.argument)) {
      mutations.push({ line: lineOf(child), what: `deletes from S.${stateRoot(child.argument)}` });
    }
  });
  return { calls, mutations };
}
const literalOf = node => (node && node.type === 'Literal') ? node.value : undefined;

/* ---------- the manifest ---------- */
let toolsNode = null;
for (const node of ast.body) {
  if (node.type !== 'VariableDeclaration') continue;
  for (const decl of node.declarations) if (decl.id.name === 'KZ_TOOLS') toolsNode = decl.init;
}
if (toolsNode?.type !== 'ArrayExpression') throw new Error('KZ_TOOLS array literal not found');
const KINDS = new Set(['read','session','write','destructive','person']);
const entries = toolsNode.elements.map(element => {
  const props = Object.fromEntries(element.properties.map(p => [p.key.name ?? p.key.value, p.value]));
  return {
    line: lineOf(element), name: literalOf(props.name), kind: literalOf(props.kind),
    run: props.run?.type === 'Identifier' ? props.run.name : null,
    ui: props.ui?.type === 'ArrayExpression' ? props.ui.elements.map(literalOf) : [],
    hasDescription: !!props.description, hasReason: !!props.reason, batch: literalOf(props.batch) === true,
    scope: literalOf(props.scope),
  };
});
const callable = new Set();
const runs = new Set();
const personUi = new Set();
const seen = new Set();
for (const entry of entries) {
  if (typeof entry.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.name)) fail(entry.line, `tool name ${entry.name} is not a valid WebMCP name`);
  if (seen.has(entry.name)) fail(entry.line, `tool ${entry.name} is declared twice`);
  seen.add(entry.name);
  if (!KINDS.has(entry.kind)) fail(entry.line, `${entry.name}: unknown kind ${entry.kind}`);
  if (!entry.hasDescription) fail(entry.line, `${entry.name}: no description`);
  if (entry.kind === 'person') {
    if (!entry.hasReason) fail(entry.line, `${entry.name}: a person-only act must say why`);
    if (!entry.ui.length) fail(entry.line, `${entry.name}: a person-only act must name its UI functions`);
    if (entry.run) fail(entry.line, `${entry.name}: a person-only act has no run`);
    for (const name of entry.ui) {
      if (!functions.has(name)) fail(entry.line, `${entry.name}: UI function ${name} does not exist`);
      personUi.add(name);
    }
  } else {
    callable.add(entry.name);
    if (!entry.run?.startsWith('cmd') || !functions.has(entry.run)) fail(entry.line, `${entry.name}: run must be a cmd* function`);
    else runs.add(entry.run);
    if (entry.batch && entry.scope !== 'board') fail(entry.line, `${entry.name}: batchable tools must be board-scoped`);
  }
}
for (const name of functions.keys()) {
  if (name.startsWith('cmd') && !runs.has(name)) fail(lineOf(functions.get(name)), `${name} is a command outside the manifest`);
}

/* ---------- dispatch names resolve ---------- */
simple(ast, {
  CallExpression(node) {
    if (node.callee.type === 'Identifier' && (node.callee.name === 'kzUi' || node.callee.name === 'kzDispatch')) {
      const name = literalOf(node.arguments[0]);
      if (name !== undefined && !callable.has(name)) fail(lineOf(node), `dispatches unknown command "${name}"`);
    }
  },
  ObjectExpression(node) { // {tool:'x', input:{…}} lists that the UI hands to apply_changes
    if (node === toolsNode || !node.properties.some(p => (p.key?.name ?? p.key?.value) === 'input')) return;
    const toolProp = node.properties.find(p => (p.key?.name ?? p.key?.value) === 'tool');
    const name = literalOf(toolProp?.value);
    if (typeof name === 'string' && !callable.has(name)) fail(lineOf(node), `names unknown command "${name}"`);
  },
});

/* ---------- classify functions ---------- */
const fx = new Map([...functions].map(([name, node]) => [name, effects(node.body)]));
// Dispatchers call kzUi or kzDispatch, or route to another dispatcher (a keyboard router, a drop
// handler, a one-line wrapper). Rule 3 below holds them all to "never change state".
const dispatchers = new Set([...fx].filter(([, e]) => e.calls.has('kzUi') || e.calls.has('kzDispatch')).map(([name]) => name));
for (let grew = true; grew;) {
  grew = false;
  for (const [name, effect] of fx) {
    if (dispatchers.has(name) || name.startsWith('cmd') || name in INFRA || personUi.has(name) || name in UI_ONLY) continue;
    if ([...effect.calls].some(called => dispatchers.has(called))) { dispatchers.add(name); grew = true; }
  }
}
for (const name of [...Object.keys(INFRA), ...Object.keys(UI_ONLY)]) {
  if (!functions.has(name)) fail(scriptStart, `lint list names ${name}, which does not exist`);
}
for (const [name, effect] of fx) {
  const allowed = name.startsWith('cmd') || name in INFRA || personUi.has(name);
  if (allowed || !effect.mutations.length) continue;
  for (const m of effect.mutations) fail(m.line, `${name} ${m.what} outside a command (add a command, or name it infrastructure with a reason)`);
}
for (const name of [...dispatchers, ...Object.keys(UI_ONLY)]) {
  if (name.startsWith('cmd') || name in INFRA || personUi.has(name)) {
    fail(lineOf(functions.get(name)), `${name} is both a UI function and a mutator`);
    continue;
  }
  for (const called of fx.get(name)?.calls || []) {
    if (called.startsWith('cmd')) fail(lineOf(functions.get(name)), `${name} calls ${called} directly instead of dispatching`);
  }
}

/* ---------- UI handlers ---------- */
const allowedTargets = name => dispatchers.has(name) || name in UI_ONLY || personUi.has(name) || !functions.has(name);
function checkHandler(node, line, label, inline=false) {
  const effect = effects(node, inline ? line : undefined);
  for (const m of effect.mutations) fail(m.line, `${label} handler ${m.what}; dispatch a command instead`);
  for (const name of effect.calls) {
    if (!allowedTargets(name)) fail(line, `${label} handler calls ${name}, which is neither a dispatcher, UI-only, nor person-only`);
  }
}
// inline attributes, in markup and in HTML built by scripts
for (const match of html.matchAll(/\son(\w+)="([^"]*)"/g)) {
  const line = html.slice(0, match.index).split('\n').length;
  let expr;
  try { expr = parse(match[2], { ecmaVersion: 'latest' }); } catch { fail(line, `inline on${match[1]} handler does not parse`); continue; }
  checkHandler(expr, line, `inline on${match[1]}`, true);
}
// addEventListener('<ui event>', fn) and el.on<ui event> = fn
full(ast, node => {
  let handler = null, event = null;
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'addEventListener') {
    event = literalOf(node.arguments[0]);
    handler = node.arguments[1];
  } else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && /^on[a-z]+$/.test(node.left.property.name || '')) {
    event = node.left.property.name.slice(2);
    handler = node.right;
  }
  if (!handler || !UI_EVENTS.has(event)) return;
  const line = lineOf(node);
  if (handler.type === 'Identifier') {
    if (!allowedTargets(handler.name)) fail(line, `${event} handler ${handler.name} is neither a dispatcher, UI-only, nor person-only`);
  } else if (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression') {
    checkHandler(handler.body, line, event);
  }
});

/* ---------- both doors read KZ_TOOLS ---------- */
for (const door of ['kzInstallWindowApi', 'kzRegisterModelContext']) {
  const node = functions.get(door);
  if (!node) { fail(scriptStart, `door ${door} is missing`); continue; }
  if (!code.slice(node.start, node.end).includes('of KZ_TOOLS')) fail(lineOf(node), `${door} does not build its tools from KZ_TOOLS`);
}

if (findings.length) {
  console.error(findings.join('\n'));
  console.error(`agent-face lint: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  process.exit(1);
}
const kinds = entries.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] || 0) + 1 }), {});
console.log(`agent-face lint: ok — ${callable.size} callable tools (${Object.entries(kinds).filter(([k]) => k !== 'person').map(([k, n]) => `${n} ${k}`).join(', ')}), ${kinds.person || 0} person-only, ${dispatchers.size} dispatchers`);
