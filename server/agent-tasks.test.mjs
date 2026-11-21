import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentTaskServer } from './agent-tasks.mjs';
import { storeReportedResult } from './agent-results.mjs';
import { WORKSPACE, initialState } from './agent-state.mjs';
import { connectionConfig } from './connection-config.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeProcess(threadId) {
  const proc = new EventEmitter();
  Object.assign(proc, { threadId, stdout: new PassThrough(), stderr: new PassThrough(), killed: false, sent: [] });
  // Escape Unicode line separators on the wire so readline does not split
  // a test payload before the bridge can validate the decoded title.
  proc.emitMessage = message => proc.stdout.write(JSON.stringify(message).replace(/[\u2028\u2029]/g,
    separator => '\\u' + separator.charCodeAt(0).toString(16)) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); proc.sent.push(message); proc.emit('sent', message); done();
    queueMicrotask(() => {
      if (message.method === 'initialize' && !proc.deferInitialize) proc.emitMessage({ id: message.id, result: {} });
      if (['thread/start','thread/resume'].includes(message.method)) proc.emitMessage({ id: message.id, result: {
        thread: { id: message.params.threadId ?? threadId, status: { type: 'idle' }, turns: [] }, initialTurnsPage: { data: [] } } });
      if (message.method === 'turn/start' && !proc.deferTurnStart) {
        proc.emitMessage({ id: message.id, result: { turn: { id: `turn-${threadId}`, status: 'inProgress' } } });
      }
      if (message.method === 'turn/interrupt') proc.emitMessage({ id: message.id, result: {} });
    });
  } });
  proc.kill = () => { proc.killed = true; proc.emit('exit', 0); proc.stdout.end(); proc.stderr.end(); };
  return proc;
}
async function fixture(t, { seed, configureProcess, removeRemoteRuns = async (_mode, candidates) => ({ runs: [],
  retained: candidates.map(item => ({ path: item.path, reason: 'missing' })) }) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tinylens-tasks-test-'));
  const saved = { threadId: 'legacy-thread', status: 'completed', messages: [{ id: 'old-message', role: 'assistant', text: '原结果保留', complete: true }],
    updates: [{ id: 'legacy-report', kind: 'stage', stage: 'a', status: 'accepted', message: 'Accepted by the AI.' },
      {id:'legacy-summary',threadId:'legacy-thread',kind:'artifact',stage:'a',path:WORKSPACE+'/output/task-test/lens/attempts/a/0/stage-result.json'}] };
  await writeFile(join(directory, 'agent-state.json'), JSON.stringify(saved));
  const cached = {schema:'tinylens.readonly-result.v1',kind:'summary',stage:'a',attempt:0,path:saved.updates[1].path,sha256:'a'.repeat(64)};
  await storeReportedResult(saved,'legacy-summary',cached,{cacheDirectory:join(directory,'result-cache')});
  await seed?.(directory);
  const processes = [];
  const options = { stateDirectory: directory, removeRemoteRuns, rpcTimeoutMs: 1000, logger: { error() {} }, stageScopeLookup: async () => undefined, spawnProcess: () => {
    const proc = fakeProcess(`new-thread-${processes.length + 1}`); configureProcess?.(proc); processes.push(proc); return proc;
  } };
  let bridge = await createAgentTaskServer(options);
  async function listen() { bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening'); }
  await listen();
  async function request(path, method = 'GET', data, extra = {}) {
    const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/api/agent/${path}`, { method,
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  }
  async function deleteTask(id) {
    const plan = await request(`tasks/${id}/deletion-plan`);
    return plan.status === 200 ? request(`tasks/${id}`, 'DELETE', { token: plan.body.token }) : plan;
  }
  async function restart(beforeOpen) { await bridge.close(); await beforeOpen?.(); bridge = await createAgentTaskServer(options); await listen(); }
  async function events(id, { name = 'state', afterOpen } = {}) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 3000);
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.server.address().port}/api/agent/events?taskId=${id}`, { signal: abort.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      await afterOpen?.();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw Error(`Missing fixture event: ${name}`);
        text += decoder.decode(value, { stream: true });
        const records = text.split('\n\n');
        text = records.pop();
        const event = records.find(record => record.startsWith(`event: ${name}\n`));
        if (event) return JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6));
      }
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  }
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, processes, request, deleteTask, restart, saved, events };
}

function nextSent(proc, matches, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.off('sent', receive); reject(Error(`Mock protocol receipt timed out: ${label}`)); }, 2000);
    function receive(message) {
      if (!matches(message)) return;
      clearTimeout(timeout);
      proc.off('sent', receive);
      resolve(message);
    }
    proc.on('sent', receive);
  });
}

function suggestName(proc, id, name, overrides = {}) {
  const receipt = nextSent(proc, message => message.id === id && (message.result || message.error), `tool ${id}`);
  proc.emitMessage({ id, method: 'item/tool/call', params: {
    tool: 'tinylens_ui_report', callId: `name-${id}`, threadId: proc.threadId,
    turnId: `turn-${proc.threadId}`, ...overrides.scope,
    arguments: { kind: 'note', stage: 'task_name', status: 'suggested', title: name,
      message: 'Workbench task name', ...overrides.arguments },
  } });
  return receipt.then(message => message.result ?? { success: false, error: message.error });
}

async function seedRetryBatch(directory, journalCases) {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const tasks = [{ id: 'default', name: 'Fixture', createdAt, proxyOffset: 0 }];
  const batch = { id: 'batch-00000000-0000-4000-a000-000000000001', createdAt, workspace: WORKSPACE,
    sshHost: connectionConfig.sshHost, inputDir: '/tmp/fixture-lenses', outputDir: `${WORKSPACE}/output/retry-fixture`,
    python: '/usr/bin/python3', paused: true, parallelism: 2, calibration: 'fixture', jobs: [] };
  const incompatible = { ...batch, id: 'batch-00000000-0000-4000-a000-000000000002',
    workspace: '/tmp/different-workspace', outputDir: '/tmp/different-workspace/output/retry-fixture', jobs: [] };
  for (const [index, entry] of journalCases.entries()) {
    const target = entry.incompatible ? incompatible : batch;
    const lensId = `lens-${index}`, taskId = `task-00000000-0000-4000-a000-${String(index + 1).padStart(12, '0')}`;
    const job = { lensId, taskId, inputPath: `${target.inputDir}/${lensId}`, runId: entry.runId ?? null,
      dispatch: entry.dispatch ?? 'start_failed', error: 'AI connection closed (127).' };
    target.jobs.push(job);
    tasks.push({ id: taskId, name: lensId, batchId: target.id, proxyOffset: index + 1, createdAt });
    if (entry.missing) continue;
    const folder = join(directory, 'tasks', taskId);
    const raw = { ...initialState(), connection: 'error', error: job.error, workspace: target.workspace,
      datasetPath: job.inputPath, ...entry.state };
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'agent-state.json'), entry.malformed ? '{' : JSON.stringify(raw));
    if (entry.pendingWrite) await writeFile(join(folder, 'agent-state.json.tmp'), '{');
  }
  const batches = [batch, ...(incompatible.jobs.length ? [incompatible] : [])];
  await writeFile(join(directory, 'agent-tasks.json'), JSON.stringify({ schema: 'tinylens.tasks.v1', tasks, batches }));
  return { tasks, batch, incompatible };
}

test('explicit batch retry requeues only proven never-sent jobs without replacing the plan or lifting pause', async t => {
  let seeded;
  const f = await fixture(t, { seed: async directory => {
    seeded = await seedRetryBatch(directory, [
      { runId: 'existing-run' },
      { state: { messages: [{ role: 'user', text: 'Uncertain', delivery: 'pending' }] } },
      { state: { threadId: 'previous-thread' } },
      { state: { lastTurnId: 'previous-turn' } },
      { state: { finishedTurnIds: ['previous-turn'] } },
      { state: { requests: [{}] } },
      { state: { remoteActive: true } },
      { state: { needsReconcile: true } },
      { state: { activities: [{}] } },
      { state: { updates: [{}] } },
      { state: { questions: [{}] } },
      { state: { messages: null } },
      { malformed: true }, { missing: true }, { pendingWrite: true },
      { state: { datasetPath: '/tmp/other-lens' } },
      { dispatch: 'queued' },
      { dispatch: 'submitted', state: { threadId: 'delivered-thread', messages: [{ role: 'user', text: 'Dispatched', delivery: 'delivered' }] } },
      { incompatible: true },
    ]);
  } });
  const { batch, incompatible, tasks } = seeded;
  const path = `batches/${batch.id}`;
  const before = (await f.request(path)).body.batch;
  assert.equal(before.retryableStartCount, 1);
  assert.equal(before.jobs.at(-1).delivered, true);
  assert.equal(before.jobs[0].delivered, undefined);
  assert.equal((await f.request(`${path}/retry-start`)).status, 405);
  assert.equal((await f.request(`${path}/retry-start`, 'POST', { reset: true })).status, 400);
  assert.equal((await f.request(`batches/${incompatible.id}/retry-start`, 'POST', {})).status, 409);

  const results = await Promise.all(Array.from({ length: 2 }, () => f.request(`${path}/retry-start`, 'POST', {})));
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.deepEqual(results.map(result => result.body.requeued).sort(), [0, 1]);
  const retried = results.find(result => result.body.requeued).body.batch;
  assert.equal(retried.paused, true);
  assert.equal(retried.retryableStartCount, 0);
  assert.equal(retried.jobs[0].status, 'queued');
  assert.equal(retried.jobs[0].runPath, before.jobs[0].runPath);
  assert.deepEqual(retried.jobs.slice(1), before.jobs.slice(1));
  const registryPath = join(f.directory, 'agent-tasks.json');
  const committed = JSON.parse(await readFile(registryPath, 'utf8'));
  const { error: _, ...eligible } = batch.jobs[0];
  assert.deepEqual(committed.tasks, tasks);
  assert.deepEqual(committed.batches, [{ ...batch, jobs: [{ ...eligible, dispatch: 'queued' }, ...batch.jobs.slice(1)] }, incompatible]);
  await f.restart();
  assert.deepEqual((await f.request(path)).body.batch, retried);
  assert.equal(f.processes.length, 0);
});

test('an in-flight manual connect is excluded from batch retry before any conversation is restored', async t => {
  let seeded;
  const f = await fixture(t, {
    seed: async directory => { seeded = await seedRetryBatch(directory, [{}]); },
    configureProcess: proc => { proc.deferInitialize = true; },
  });
  const { id, jobs } = seeded.batch;
  const connecting = f.request(`connect?taskId=${jobs[0].taskId}`, 'POST', {});
  const deadline = Date.now() + 500;
  while (!f.processes[0]?.sent.length && Date.now() < deadline) await tick();
  const proc = f.processes[0];
  assert.equal(proc?.sent[0]?.method, 'initialize');
  const during = await f.request(`batches/${id}/retry-start`, 'POST', {});
  assert.equal(during.status, 200);
  assert.equal(during.body.requeued, 0);
  assert.equal(during.body.batch.retryableStartCount, 0);
  proc.emitMessage({ id: proc.sent[0].id, result: {} });
  assert.equal((await connecting).status, 200);
  assert.equal((await f.request(`batches/${id}/retry-start`, 'POST', {})).body.requeued, 0);
  assert.equal(proc.sent.some(packet => packet.method === 'turn/start'), false);
});

test('a delivered model request publishes the first task name to its own file and sidebar event', async t => {
  const f = await fixture(t);
  const own = (await f.request('tasks', 'POST', {})).body.task;
  const sibling = (await f.request('tasks', 'POST', {})).body.task;
  const recordPath = join(f.directory, 'tasks', own.id, 'task-name.json');
  await f.request(`connect?taskId=${own.id}`, 'POST', {});
  const proc = f.processes[0];
  proc.deferTurnStart = true;
  const event = await f.events(own.id, { name: 'task-name', afterOpen: async () => {
    const start = nextSent(proc, packet => packet.method === 'turn/start', 'first turn');
    const message = f.request(`message?taskId=${own.id}`, 'POST', { text: '请拟合 SDSSJ0946' });
    const turn = await start;
    const naming = suggestName(proc, 101, 'SDSSJ0946');
    await tick();
    await assert.rejects(access(recordPath), { code: 'ENOENT' });
    proc.emitMessage({ id: turn.id, result: { turn: { id: `turn-${proc.threadId}`, status: 'inProgress' } } });
    assert.equal((await message).status, 200);
    assert.equal((await naming).success, true);
  } });
  assert.deepEqual(event, {});
  const recorded = await readFile(recordPath, 'utf8');
  assert.deepEqual(JSON.parse(recorded), {
    schema: 'tinylens.task-name.v1', task_id: own.id, thread_id: proc.threadId, name: 'SDSSJ0946',
  });
  assert.equal((await suggestName(proc, 102, '另一个名字')).success, true);
  assert.equal(await readFile(recordPath, 'utf8'), recorded);
  assert.deepEqual((await f.request(`state?taskId=${own.id}`)).body.updates, []);

  await f.request(`connect?taskId=${sibling.id}`, 'POST', {});
  await writeFile(join(f.directory, 'tasks', sibling.id, 'task-name.json'), recorded);
  await f.restart();
  let tasks = (await f.request('tasks')).body.tasks;
  assert.equal(tasks.find(task => task.id === own.id).name, 'SDSSJ0946');
  assert.equal(tasks.find(task => task.id === sibling.id).name, sibling.name);
  await f.request(`tasks/${own.id}`, 'PATCH', { name: own.name });
  await f.restart();
  tasks = (await f.request('tasks')).body.tasks;
  assert.equal(tasks.find(task => task.id === own.id).name, own.name);
  assert.equal(await readFile(recordPath, 'utf8'), recorded);
});

test('task name suggestions require the own active turn and leave a manual default label intact', async t => {
  const f = await fixture(t);
  const task = (await f.request('tasks', 'POST', {})).body.task;
  const recordPath = join(f.directory, 'tasks', task.id, 'task-name.json');
  await f.request(`connect?taskId=${task.id}`, 'POST', {});
  const proc = f.processes[0];
  const threadId = proc.threadId, turnId = `turn-${threadId}`;
  proc.emitMessage({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
  assert.equal((await suggestName(proc, 201, '没有指令')).success, false);
  await assert.rejects(access(recordPath), { code: 'ENOENT' });
  proc.emitMessage({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });

  // Supply a new turn ID after the first synthetic turn completed.
  proc.deferTurnStart = true;
  const start = nextSent(proc, packet => packet.method === 'turn/start', 'second turn');
  const message = f.request(`message?taskId=${task.id}`, 'POST', { text: '请建模' });
  const turn = await start;
  const scope = { turnId: `${turnId}-second` };
  proc.emitMessage({ id: turn.id, result: { turn: { id: scope.turnId, status: 'inProgress' } } });
  assert.equal((await message).status, 200);
  assert.equal((await suggestName(proc, 202, '别的线程', { scope: { ...scope, threadId: 'another-thread' } })).success, false);
  assert.equal((await suggestName(proc, 203, '旧回合')).success, false);
  for (const [offset, name] of ['', ' 前置空格', '多\n行', '控\u2028制', '中'.repeat(41)].entries()) {
    assert.equal((await suggestName(proc, 210 + offset, name, { scope })).success, false);
  }
  assert.equal((await suggestName(proc, 216, '文件路径注入', { scope, arguments: { path: '/etc/passwd' } })).success, false);
  await f.request(`tasks/${task.id}`, 'PATCH', { name: task.name });
  assert.equal((await suggestName(proc, 217, '中'.repeat(40), { scope })).success, true);
  await assert.rejects(access(recordPath), { code: 'ENOENT' });
  assert.equal((await f.request('tasks')).body.tasks.find(item => item.id === task.id).name, task.name);
});

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
test('permanent deletion closes only its idle session, removes its cache and survives restart without task id or port reuse', async t => {
  const f = await fixture(t);
  const id = (await f.request('tasks', 'POST', {})).body.task.id;
  const sibling = (await f.request('tasks', 'POST', {})).body.task.id;
  const own = join(f.directory, 'tasks', id), other = join(f.directory, 'tasks', sibling);
  await mkdir(join(own, 'result-cache'), {recursive:true});
  await writeFile(join(own, 'result-cache', 'preview.json'), 'own cache');
  const siblingJournal = await readFile(join(other, 'agent-state.json'), 'utf8');
  const legacyJournal = await readFile(join(f.directory, 'agent-state.json'), 'utf8');
  await f.request(`connect?taskId=${id}`, 'POST', {});
  assert.equal((await f.request(`tasks/${id}`, 'DELETE', undefined, {Origin:'https://outside.example'})).status,403);
  assert.equal((await f.deleteTask(id)).body.threadId,'new-thread-1');
  assert.equal(f.processes[0].killed,true);
  assert.ok(!f.processes[0].sent.some(message=>['turn/start','turn/steer','turn/interrupt'].includes(message.method)));
  await assert.rejects(access(own),{code:'ENOENT'});
  assert.equal(await readFile(join(other,'agent-state.json'),'utf8'),siblingJournal);
  assert.equal(await readFile(join(f.directory,'agent-state.json'),'utf8'),legacyJournal);
  assert.equal((await f.request(`state?taskId=${id}`)).status,404);
  assert.equal((await f.request(`tasks/${id}`,'DELETE')).status,404);
  await f.restart();
  assert.deepEqual((await f.request('tasks')).body.tasks.map(task=>task.id),['default',sibling]);
  // Delete the greatest offset as well; the next creation must not reuse it.
  assert.equal((await f.deleteTask(sibling)).status,200);
  await f.restart();
  const next=(await f.request('tasks','POST',{})).body.task;
  assert.equal(next.name,'新任务 3');
  assert.notEqual(next.id,id); assert.notEqual(next.id,sibling);
});
test('remote cleanup requires the current confirmed plan and retains a shared run', async t => {
  const calls = [];
  const digest = 'b'.repeat(64);
  let failDelete = true;
  const f = await fixture(t, { removeRemoteRuns: async (mode, candidates) => {
    calls.push({ mode, candidates });
    if (mode === 'delete' && failDelete) throw Error('Network disconnected');
    return { runs: candidates.map(({ path }) => ({ path, fingerprint: digest })), retained: [] };
  } });
  const [task, sibling] = await Promise.all([f.request('tasks', 'POST', {}), f.request('tasks', 'POST', {})]);
  const taskId = task.body.task.id, siblingId = sibling.body.task.id;
  const exclusive = WORKSPACE + '/output/task-results/owned-lens';
  const archive = WORKSPACE + '/output/task-results/_archive/owned-lens_old_0';
  const shared = WORKSPACE + '/output/task-results/another-lens';
  const report = (threadId, run, run_id, path = `${run}/preflight/inspection.json`) => ({
    id: path, kind: 'artifact', threadId, schema: 'tinylens.stage-report.v1', path, stage: 'preflight', attempt: null,
    run_path: run, run_id, lens_id: run.split('/').at(-1), message: 'Reported artifact',
  });
  const journal = id => join(f.directory, 'tasks', id, 'agent-state.json');
  await f.restart(async () => {
    await writeFile(journal(taskId), JSON.stringify({ threadId: 'owned-thread', updates: [
      report('owned-thread', exclusive, 'older'), report('owned-thread', exclusive, 'older', `${archive}/run-manifest.json`),
      report('owned-thread', exclusive, 'latest'), report('owned-thread', shared, 'shared'),
    ] }));
    await writeFile(journal(siblingId), JSON.stringify({ threadId: 'other-thread', updates: [report('other-thread', shared, 'shared')] }));
  });
  const path = `tasks/${taskId}`;
  const plan = await f.request(`${path}/deletion-plan`);
  assert.deepEqual(plan.body.runs, [archive, exclusive]);
  assert.deepEqual(plan.body.retained, [shared]);
  assert.deepEqual(calls[0].candidates.map(item => item.runIds), [['older'], ['latest']]);
  assert.equal((await f.request(path, 'DELETE', {token: 'wrong'})).status, 409);
  assert.equal((await f.request(path, 'DELETE', {token: plan.body.token, path: shared})).status, 409);
  assert.equal(calls.length, 1);
  assert.equal((await f.request(path, 'DELETE', {token: plan.body.token})).status, 502);
  assert.equal((await f.request(`state?taskId=${taskId}`)).status, 200);
  assert.equal((await f.request('tasks')).body.tasks.some(task => task.id === taskId), true);
  await f.restart();
  const retry = await f.request(`${path}/deletion-plan`);
  assert.ok(calls.at(-1).candidates.every(item => item.fingerprint === digest));
  assert.notEqual(retry.body.token, plan.body.token);
  failDelete = false;
  assert.equal((await f.request(path, 'DELETE', {token: retry.body.token})).body.deleted, taskId);
  assert.deepEqual(calls.at(-1).candidates.map(item => item.path), [archive, exclusive]);
  await assert.rejects(access(journal(taskId)), {code: 'ENOENT'});
  assert.equal((await f.request(`state?taskId=${siblingId}`)).status, 200);
});
test('active turns and pending approvals block deletion until the same turn completes', async t => {
  const f=await fixture(t);
  const id=(await f.request('tasks','POST',{})).body.task.id;
  await f.request(`connect?taskId=${id}`,'POST',{});
  await f.request(`message?taskId=${id}`,'POST',{text:'Only the fixture handles this.'});
  const proc=f.processes[0], turnId='turn-new-thread-1';
  assert.equal((await f.deleteTask(id)).status,409);
  assert.equal(proc.killed,false);
  assert.equal((await f.request(`state?taskId=${id}`)).body.turnId,turnId);
  proc.emitMessage({id:18,method:'item/commandExecution/requestApproval',params:{threadId:'new-thread-1',turnId,itemId:'command-1',availableDecisions:['accept','cancel']}});
  await tick();
  assert.equal((await f.deleteTask(id)).status,409);
  assert.ok(!proc.sent.some(message=>message.id===18));
  await f.request(`reply?taskId=${id}`,'POST',{requestId:18,result:{decision:'cancel'}});
  proc.emitMessage({method:'turn/completed',params:{threadId:'new-thread-1',turn:{id:turnId,status:'completed'}}});
  await tick();
  assert.equal((await f.deleteTask(id)).status,200);
});
test('deleting the legacy task preserves sibling files; deleting all tasks does not recreate them after restart', async t => {
  const f=await fixture(t);
  const sibling=(await f.request('tasks','POST',{})).body.task.id;
  await writeFile(join(f.directory,'private-config.json'),'preserve');
  assert.equal((await f.deleteTask('default')).status,200);
  await assert.rejects(access(join(f.directory,'agent-state.json')),{code:'ENOENT'});
  await assert.rejects(access(join(f.directory,'result-cache')),{code:'ENOENT'});
  assert.equal(await readFile(join(f.directory,'private-config.json'),'utf8'),'preserve');
  assert.equal((await f.request(`state?taskId=${sibling}`)).status,200);
  assert.equal((await f.request('state')).status,404);
  await f.restart();
  assert.equal((await f.request('tasks')).body.tasks.length,1);
  await f.deleteTask(sibling);
  await f.restart();
  assert.deepEqual((await f.request('tasks')).body.tasks,[]);
  assert.equal(f.processes.length,0);
  assert.equal((await f.request('tasks','POST',{})).body.task.name,'新任务 2');
});
test('startup completes a durably recorded deletion without reconnecting or removing another task', async t => {
  const f=await fixture(t);
  const id=(await f.request('tasks','POST',{})).body.task.id;
  const path=join(f.directory,'agent-tasks.json');
  const saved=JSON.parse(await readFile(path,'utf8'));
  saved.tasks=saved.tasks.filter(task=>task.id!==id);
  saved.pendingDeletions=[id];
  await writeFile(path,JSON.stringify(saved));
  await f.restart();
  await assert.rejects(access(join(f.directory,'tasks',id)),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).pendingDeletions,[]);
  assert.equal((await f.request('state')).body.threadId,'legacy-thread');
  assert.equal(f.processes.length,0);
});
