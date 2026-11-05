import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlankTask, parseTasks, patchTask, submitTaskMessage, hideLens, restoreLens, parseDeletedLenses } from '../src/lib/demo-tasks.ts';

test('new tasks are independent and contain no inherited scientific result', () => {
  const first=createBlankTask(),second=createBlankTask();
  assert.notEqual(first.id,second.id);
  assert.deepEqual(Object.keys(first).sort(),['createdAt','draft','id','messages','name']);
  assert.equal(first.name,'');
  assert.equal(first.draft,'');
  assert.deepEqual(first.messages,[]);
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
});
test('task edits leave every other task and their previous objects intact', () => {
  const first=createBlankTask(),second=createBlankTask(),tasks=[first,second],before=JSON.stringify(tasks);
  const edited=patchTask(tasks,first.id,{name:'Lens A',draft:'Use this image'});
  assert.equal(edited[0].name,'Lens A');
  assert.equal(edited[0].draft,'Use this image');
  assert.equal(edited[1],second);
  assert.equal(JSON.stringify(tasks),before);
});
test('submitting a task saves only its user message and clears only its draft', () => {
  const first={...createBlankTask(),draft:'  Model this lens.\nKeep old results.  '};
  const second={...createBlankTask(),draft:'Another draft'};
  const sent=submitTaskMessage([first,second],first.id);
  assert.equal(sent[0].draft,'');
  assert.equal(sent[0].messages.length,1);
  assert.equal(sent[0].messages[0].text,first.draft);
  assert.equal(sent[1],second);
  assert.deepEqual(first.messages,[]);
  assert.equal('run' in sent[0],false);
});
test('empty or unknown submissions do not change any task', () => {
  const tasks=[{...createBlankTask(),draft:' \n '}];
  assert.equal(submitTaskMessage(tasks,tasks[0].id),tasks);
  assert.equal(submitTaskMessage(tasks,'missing'),tasks);
});
test('stored task names, drafts and conversations round trip without adding results', () => {
  const task={...createBlankTask(),name:'HST Lens',draft:'Unsent text'};
  const sent=submitTaskMessage([task],task.id);
  const saved=patchTask(sent,task.id,{draft:'Next message'});
  assert.deepEqual(parseTasks(JSON.stringify(saved)),saved);
  const clean=parseTasks(JSON.stringify([{...task,models:{source:'fake'},accepted:true}]));
  assert.deepEqual(clean,[task]);
});
test('invalid storage and duplicate IDs cannot replace valid tasks', () => {
  const task=createBlankTask();
  assert.deepEqual(parseTasks('broken JSON'),[]);
  assert.deepEqual(parseTasks('{}'),[]);
  assert.deepEqual(parseTasks(JSON.stringify([task,task,{...task,id:'other'},{...task,id:'task-b',createdAt:'bad'},{...task,id:'task-c',messages:[{text:'broken'}]}])),[task]);
});
test('deleting and restoring navigation entries preserves task content and drafts',()=>{
  const task={...createBlankTask(),draft:'Preserve this',messages:[{id:'m',text:'Old message',createdAt:new Date().toISOString()}]},before=JSON.stringify(task);
  let deleted=hideLens([],task.id);assert.deepEqual(hideLens(deleted,task.id),deleted);deleted=hideLens(deleted,'TL-DEMO-001');
  assert.deepEqual(parseDeletedLenses(JSON.stringify([...deleted,...deleted,44,'unknown'])),deleted);
  assert.deepEqual(restoreLens(deleted,task.id),['TL-DEMO-001']);assert.equal(JSON.stringify(task),before);
  assert.deepEqual(parseDeletedLenses('{'),[]);
});
