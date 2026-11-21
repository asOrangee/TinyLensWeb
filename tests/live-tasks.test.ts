import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTaskUrl, clearLiveTaskStorage, liveTaskPreferenceKey, liveTaskSelectionKey, parseLiveTasks, parseTaskDeletionPlan } from '../src/lib/live-tasks.ts';
const id = 'task-12345678-1234-1234-1234-123456789abc';
test('task scope applies to state, SSE and report requests while preserving legacy draft keys', () => {
  assert.equal(agentTaskUrl('/api/agent/events',id),`/api/agent/events?taskId=${id}`);
  assert.equal(agentTaskUrl('/api/agent/input?updateId=old','default'),'/api/agent/input?updateId=old');
  assert.equal(agentTaskUrl('/api/agent/input?updateId=report%201',id),`/api/agent/input?updateId=report%201&taskId=${id}`);
  assert.equal(liveTaskPreferenceKey('default'),'tinylens-live-workbench-v1');
  assert.notEqual(liveTaskPreferenceKey(id),liveTaskPreferenceKey('default'));
});
test('task selection accepts empty catalogs and a permanently removed legacy task, but rejects invalid and duplicate ids', () => {
  const legacy = {id:'default',name:'Lens workspace',createdAt:'2026-11-04T00:00:00Z'};
  assert.equal(parseLiveTasks({tasks:[legacy,{...legacy,id,name:'任务'}]}).length,2);
  assert.deepEqual(parseLiveTasks({tasks:[]}),[]);
  assert.deepEqual(parseLiveTasks({tasks:[{...legacy,id}]}),[{...legacy,id}]);
  for (const tasks of [[legacy,legacy],[{...legacy,id:'../../other'}]]) assert.throws(()=>parseLiveTasks({tasks}));
});
test('permanent deletion clears only the selected task and thread drafts, preserving other tasks and global preferences', () => {
  const thread='thread:1', other='task-87654321-4321-4321-4321-cba987654321';
  const keys=[liveTaskPreferenceKey(id),'tinylens-live-image-scale-v2:'+id,liveTaskSelectionKey,
    'tinylens-mask-draft-v1:'+JSON.stringify([thread,'report']),
    'tinylens-question-draft-v1:'+encodeURIComponent(thread)+':question'];
  const preserved=[liveTaskPreferenceKey('default'),liveTaskPreferenceKey(other),'tinylens-live-image-scale-v2:'+other,
    'tinylens-design-v1','tinylens-live-language-v1','tinylens-mask-draft-v1:'+JSON.stringify([thread+'2','report']),
    'tinylens-question-draft-v1:'+encodeURIComponent(thread+'2')+':question'];
  const values=new Map([...keys,...preserved].map(key=>[key,key===liveTaskSelectionKey?id:'keep']));
  const storage={get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null,
    getItem:(key:string)=>values.get(key)??null,removeItem:(key:string)=>{values.delete(key);}} as Storage;
  clearLiveTaskStorage(storage,id,thread);
  assert.deepEqual([...values.keys()],preserved);
  values.set(liveTaskSelectionKey,other);
  clearLiveTaskStorage(storage,'default');
  assert.equal(values.get(liveTaskSelectionKey),other);
  assert.equal(values.has(liveTaskPreferenceKey('default')),false);
});
test('permanent deletion preview requires a token and both explicit directory lists', () => {
  const plan = { token: 'proof-token', runs: ['/fixture/owned run'], retained: ['/fixture/other run'] };
  assert.deepEqual(parseTaskDeletionPlan(plan), plan);
  assert.deepEqual(parseTaskDeletionPlan({ ...plan, runs: [], retained: [] }), { ...plan, runs: [], retained: [] });
  for (const invalid of [null, { ...plan, token: '' }, { ...plan, runs: [''] },
    { ...plan, retained: [3] }, { token: plan.token, runs: plan.runs }]) {
    assert.throws(() => parseTaskDeletionPlan(invalid));
  }
});
