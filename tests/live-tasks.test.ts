import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTaskUrl, liveTaskPreferenceKey, parseLiveTasks } from '../src/lib/live-tasks.ts';
const id = 'task-12345678-1234-1234-1234-123456789abc';
test('task scope applies to state, SSE and report requests while preserving legacy draft keys', () => {
  assert.equal(agentTaskUrl('/api/agent/events',id),`/api/agent/events?taskId=${id}`);
  assert.equal(agentTaskUrl('/api/agent/input?updateId=old','default'),'/api/agent/input?updateId=old');
  assert.equal(agentTaskUrl('/api/agent/input?updateId=report%201',id),`/api/agent/input?updateId=report%201&taskId=${id}`);
  assert.equal(liveTaskPreferenceKey('default'),'tinylens-live-workbench-v1');
  assert.notEqual(liveTaskPreferenceKey(id),liveTaskPreferenceKey('default'));
});
test('task selection accepts only a valid catalog with distinct ids and the retained legacy task', () => {
  const legacy = {id:'default',name:'Lens workspace',createdAt:'2026-11-04T00:00:00Z'};
  assert.equal(parseLiveTasks({tasks:[legacy,{...legacy,id,name:'任务'}]}).length,2);
  for (const tasks of [[],[legacy,legacy],[{...legacy,id:'../../other'}],[{...legacy,id}]]) assert.throws(()=>parseLiveTasks({tasks}));
});
