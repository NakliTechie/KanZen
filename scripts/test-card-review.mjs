import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// Exercise the actual vendored SDK before testing the app's native reducer.
// A refresh from an older production SDK must not silently remove the review
// capability while the app's reducer fixture still passes with a stubbed SDK.
const sdkMatch = html.match(/\/\* naklios-sdk:begin[^*]*\*\/([\s\S]*?)\/\* naklios-sdk:end \*\//);
assert.ok(sdkMatch, 'the shipped app contains a marked SDK region');
const messages = [];
let sdkListener;
const parent = { postMessage(message) { messages.push(message); } };
const window = {
  parent,
  location: { search: '' },
  addEventListener(type, callback) { if (type === 'message') sdkListener = callback; },
};
vm.runInNewContext(sdkMatch[1], { window, document: {}, URL, URLSearchParams, Set, Map, Promise,
  Object, Error, Date, setTimeout: () => 0, clearTimeout: () => {} });
assert.equal(typeof window.naklios.review?.stage, 'function', 'vendored SDK exposes native review staging');
assert.equal(typeof window.naklios.review?.onDecision, 'function', 'vendored SDK exposes review decisions');
const fromHost = data => sdkListener({ data, source: parent, origin: 'https://naklios.dev' });
fromHost({ type: 'naklios:capabilities', review: true });
assert.equal(window.naklios.capabilities.review, true, 'the actual SDK receives the host review capability');
const sdkStage = window.naklios.review.stage('kanzen.agent', { localId: 'sdk-probe' });
const request = messages.at(-1);
assert.equal(request.type, 'naklios:review:stage', 'the actual SDK sends the staging RPC');
assert.equal(request.tool, 'kanzen.agent');
fromHost({ type: 'naklios:review:reply', requestId: request.requestId, result: { proposal_id: 'sdk-probe' } });
assert.equal((await sdkStage).proposal_id, 'sdk-probe', 'the staging reply reaches the app');

// The app's own code stages exactly one tool with NakliOS review: kanzen.agent, for agent proposals.
// A person's edits (card moves included) apply at once; test-agent-face.mjs drives that end to end.
const appCode = html.replace(sdkMatch[0], '');
const stageCalls = [...appCode.matchAll(/naklios\.review\.stage\(\s*([^,]+),/g)].map(m => m[1].trim());
assert.deepEqual(stageCalls, ['KZ_HOST_TOOL'], 'only agent proposals reach naklios.review.stage');
assert.match(appCode, /const KZ_HOST_TOOL = 'kanzen\.agent';/);
assert.doesNotMatch(appCode, /kanzen\.card-move/, 'no person card-move staging remains');

console.log('KanZen review: vendored SDK stages and replies; the app stages agent proposals only');
