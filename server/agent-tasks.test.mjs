import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentTaskServer } from './agent-tasks.mjs';
import { storeReportedResult } from './agent-results.mjs';
import { WORKSPACE } from './agent-state.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeProcess(threadId) {
  const proc = new EventEmitter();
  Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, sent: [] });
  proc.emitMessage = message => proc.stdout.write(JSON.stringify(message) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); proc.sent.push(message); done();
    queueMicrotask(() => {
      if (message.method === 'initialize') proc.emitMessage({ id: message.id, result: {} });
      if (['thread/start','thread/resume'].includes(message.method)) proc.emitMessage({ id: message.id, result: {
        thread: { id: message.params.threadId ?? threadId, status: { type: 'idle' }, turns: [] }, initialTurnsPage: { data: [] } } });
      if (message.method === 'turn/start') proc.emitMessage({ id: message.id, result: { turn: { id: `turn-${threadId}`, status: 'inProgress' } } });
      if (message.method === 'turn/interrupt') proc.emitMessage({ id: message.id, result: {} });
    });
  } });
  proc.kill = () => { proc.killed = true; proc.emit('exit', 0); proc.stdout.end(); proc.stderr.end(); };
  return proc;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tinylens-tasks-test-'));
  const saved = { threadId: 'legacy-thread', status: 'completed', messages: [{ id: 'old-message', role: 'assistant', text: '原结果保留', complete: true }],
    updates: [{ id: 'legacy-report', kind: 'stage', stage: 'a', status: 'accepted', message: 'Accepted by the AI.' },
      {id:'legacy-summary',threadId:'legacy-thread',kind:'artifact',stage:'a',path:WORKSPACE+'/output/task-test/lens/attempts/a/0/stage-result.json'}] };
  await writeFile(join(directory, 'agent-state.json'), JSON.stringify(saved));
  const cached = {schema:'tinylens.readonly-result.v1',kind:'summary',stage:'a',attempt:0,path:saved.updates[1].path,sha256:'a'.repeat(64)};
  await storeReportedResult(saved,'legacy-summary',cached,{cacheDirectory:join(directory,'result-cache')});
  const processes = [];
  const options = { stateDirectory: directory, rpcTimeoutMs: 1000, logger: { error() {} }, spawnProcess: () => {
    const proc = fakeProcess(`new-thread-${processes.length + 1}`); processes.push(proc); return proc;
  } };
  let bridge = await createAgentTaskServer(options);
  async function listen() { bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening'); }
  await listen();
  async function request(path, method = 'GET', data, extra = {}) {
    const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/api/agent/${path}`, { method,
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  }
  async function restart() { await bridge.close(); bridge = await createAgentTaskServer(options); await listen(); }
  async function events(id) {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/api/agent/events?taskId=${id}`, { signal: abort.signal });
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    const state = JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6));
    abort.abort();
    return state;
  }
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, processes, request, restart, saved, events };
}
test('creating, renaming and reloading tasks preserves the legacy journal without connecting or copying results', async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.directory, 'agent-state.json'), 'utf8');
  assert.equal((await f.request('tasks')).body.tasks[0].name, 'Lens workspace');
  assert.equal((await f.request('result?taskId=default&updateId=legacy-summary')).status,200);
  assert.equal((await f.request('result?updateId=legacy-summary')).status,200);
  assert.equal((await f.request('result?taskId=default&updateId=legacy-summary&unexpected=1')).status,404);
  const a = await f.request('tasks', 'POST', {}), b = await f.request('tasks', 'POST', { name: '另一组数据' });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const id = a.body.task.id;
  assert.notEqual(id, b.body.task.id);
  const empty = (await f.request(`state?taskId=${id}`)).body;
  assert.equal(empty.threadId, null); assert.equal(empty.datasetPath, '');
  for (const key of ['messages','updates','questions','requests']) assert.deepEqual(empty[key], []);
  assert.equal(f.processes.length, 0);
  assert.equal(await readFile(join(f.directory, 'agent-state.json'), 'utf8'), original);
  assert.equal((await f.request(`tasks/${id}`, 'PATCH', { name: '星系组 A' })).status, 200);
  await f.restart();
  const tasks = (await f.request('tasks')).body.tasks;
  assert.equal(tasks.length, 3); assert.equal(tasks.find(task => task.id === id).name, '星系组 A');
  assert.equal(f.processes.length, 0);
  const legacy = (await f.request('state?taskId=default')).body;
  assert.equal(legacy.threadId, f.saved.threadId);
  assert.deepEqual(legacy.messages, f.saved.messages); assert.deepEqual(legacy.updates, f.saved.updates);
});
test('task messages, approvals, streams and result access stay bound to their own independent thread', async t => {
  const f = await fixture(t);
  const id = (await f.request('tasks', 'POST', {})).body.task.id;
  await f.request('connect?taskId=default', 'POST', {});
  await f.request(`connect?taskId=${id}`, 'POST', {});
  assert.equal(f.processes.length, 2);
  assert.ok(f.processes[0].sent.some(message => message.method === 'thread/resume' && message.params.threadId === 'legacy-thread'));
  assert.ok(f.processes[1].sent.some(message => message.method === 'thread/start'));
  const text = '  原样消息\n第二行  ';
  assert.equal((await f.request(`message?taskId=${id}`, 'POST', { text })).status, 200);
  const input = f.processes[1].sent.find(message => message.method === 'turn/start').params;
  assert.deepEqual(input.input, [{ type: 'text', text }]);
  assert.ok(!('developerInstructions' in input) && !('baseInstructions' in input));
  f.processes[1].emitMessage({ id: 17, method: 'item/commandExecution/requestApproval', params: { threadId: 'new-thread-2', turnId: 'turn-new-thread-2', itemId: 'command-1', availableDecisions: ['accept','cancel'] } });
  f.processes[1].emitMessage({ method: 'item/agentMessage/delta', params: { threadId: 'new-thread-2', turnId: 'turn-new-thread-2', itemId: 'reply-1', delta: '只属于新任务' } });
  await tick();
  const other = (await f.request('state?taskId=default')).body;
  assert.deepEqual(other.messages, f.saved.messages); assert.deepEqual(other.requests, []);
  assert.equal((await f.request('reply?taskId=default','POST',{requestId:17,result:{decision:'accept'}})).status, 400);
  assert.ok(!f.processes[1].sent.some(message => message.id === 17));
  const own = (await f.request(`state?taskId=${id}`)).body;
  assert.equal(own.messages[0].text, text); assert.equal(own.messages[1].text, '只属于新任务'); assert.equal(own.requests.length, 1);
  assert.deepEqual((await f.events('default')).messages, f.saved.messages);
  assert.deepEqual((await f.events(id)).messages, own.messages);
  const artifactPath = WORKSPACE+'/output/task-test/new-lens/attempts/a/0/stage-result.json';
  f.processes[1].emitMessage({id:81,method:'item/tool/call',params:{threadId:'new-thread-2',turnId:'turn-new-thread-2',callId:'report-new',tool:'tinylens_ui_report',arguments:{kind:'artifact',stage:'a',path:artifactPath,message:'Existing result'}}});
  await tick();
  const reported=(await f.request(`state?taskId=${id}`)).body;
  const update=reported.updates.find(item=>item.path===artifactPath);
  assert.ok(update);
  await storeReportedResult(reported,update.id,{schema:'tinylens.readonly-result.v1',kind:'summary',stage:'a',attempt:0,path:artifactPath,sha256:'b'.repeat(64)},{cacheDirectory:join(f.directory,'tasks',id,'result-cache')});
  assert.equal((await f.request(`result?taskId=${id}&updateId=${update.id}`)).status,200);
  assert.equal((await f.request(`result?taskId=default&updateId=${update.id}`)).status,404);
  for (const endpoint of ['artifact','result','input','mask','model']) {
    const result = await f.request(`${endpoint}?taskId=${id}&updateId=legacy-report`);
    assert.ok(result.status >= 400, `${endpoint} must not expose another task's report`);
  }
  assert.equal((await f.request(`reply?taskId=${id}`,'POST',{requestId:17,result:{decision:'accept'}})).status, 200);
  assert.deepEqual(f.processes[1].sent.find(message => message.id === 17).result, {decision:'accept'});
  assert.ok(!f.processes[0].sent.some(message => message.id === 17));
  assert.equal((await f.request(`interrupt?taskId=${id}`,'POST',{})).status, 200);
  assert.ok(!f.processes[0].sent.some(message => message.method === 'turn/interrupt'));
  await f.restart();
  const restored = (await f.request(`state?taskId=${id}`)).body;
  assert.equal(restored.threadId, 'new-thread-2'); assert.equal(restored.messages[0].text, text);
  const callsBefore = f.processes.length;
  await f.request('tasks'); assert.equal(f.processes.length, callsBefore);
  await f.request(`connect?taskId=${id}`, 'POST', {});
  assert.ok(f.processes.at(-1).sent.some(message => message.method === 'thread/resume' && message.params.threadId === 'new-thread-2'));
  assert.ok(!f.processes.at(-1).sent.some(message => ['turn/start','turn/steer'].includes(message.method)));
});
test('unknown task ids, duplicate scope and configuration fields cannot fall back to Lens workspace', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('tasks','POST',{name:'x',cwd:'/wrong'})).status, 400);
  assert.equal((await f.request('state?taskId=missing')).status, 404);
  assert.equal((await f.request('message?taskId=missing','POST',{text:'must not send'})).status, 404);
  assert.equal((await f.request('state?taskId=default&taskId=default')).status, 400);
  assert.equal((await f.request('tasks','POST',{}, {Origin:'https://outside.example'})).status, 403);
  assert.equal(f.processes.length, 0);
});
