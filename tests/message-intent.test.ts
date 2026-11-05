import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedStages } from '../src/lib/message-intent.ts';
import { advanceDemoRun, initialRun, lastLensConversationAt } from '../src/lib/workspace.ts';

test('historical stage selections remain ordered and never expand downstream stages', () => {
  assert.throws(() => selectedStages(['bogus' as never]), /Unknown/);
  assert.deepEqual(selectedStages(['m2','m0','m2']), ['m0','m2']);
});
test('demo animation advances only the selected stages and preserves its parent', () => {
  const parent = initialRun('TL-DEMO-001', [1,0]);
  const before = JSON.stringify(parent);
  const run = {...parent, id:'new', parentId:parent.id, from:'m0' as const, requestedStages:['m0','m2'] as ('m0'|'m2')[], finishedStages:[], status:'running' as const, progress:-1};
  const first = advanceDemoRun(run);
  assert.deepEqual(first.finishedStages, ['m0']);
  assert.equal(first.status, 'running');
  const second = advanceDemoRun(first);
  assert.deepEqual(second.finishedStages, ['m0','m2']);
  assert.equal(second.status, 'complete');
  assert.equal(advanceDemoRun(second), second);
  assert.equal(JSON.stringify(parent), before);
});
test('reply conversation timestamps do not create a run or mix lenses', () => {
  const runs = [initialRun('TL-DEMO-001', [])];
  assert.equal(lastLensConversationAt(runs,'TL-DEMO-001'), undefined);
  const messages = [{lensId:'TL-DEMO-001',createdAt:'2026-10-27T04:00:00Z'}, {lensId:'TL-DEMO-002',createdAt:'2026-10-27T06:00:00Z'}];
  assert.equal(lastLensConversationAt(runs,'TL-DEMO-001',messages),'2026-10-27T04:00:00Z');
  assert.equal(runs.length,1);
});
