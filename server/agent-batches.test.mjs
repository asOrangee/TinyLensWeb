import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentTaskServer } from './agent-tasks.mjs';
import { connectionConfig } from './connection-config.mjs';
import { dispatchBatchTool, prepareBatchTool } from './agent-batches.mjs';

const batches = 'batches';
const workspace = connectionConfig.workspace;
const source = '/tmp/fixture-lenses';
const outputDir = `${workspace}/output/batch-fixture`;
const names = Array.from({ length: 100 }, (_, index) => `lens-${String(index + 1).padStart(3, '0')}`);
const spec = { inputDir: source, outputDir, selection: { count: 100 }, parallelism: 2, calibration: '请检查来源标定' };
const originalPrompt = `请把 ${source} 里按 ID 排序的前 100 个 lens 分开建模，完成的结果放到 ${outputDir}，并发上限用 2。`;

async function waitFor(read, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(12);
  }
  assert.fail('Batch test state did not settle');
}

async function fixture(t, { withholdFirstReceipt = false } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tinylens-batches-test-'));
  const processes = [];
  const threads = new Map();
  const verified = [];
  let app;
  let firstRunId = null;
  let workerReceiptWithheld = false;
  let toolSequence = 500;
  function spawnProcess() {
    const process = new EventEmitter();
    process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.sent = [];
    process.event = event => process.stdout.write(JSON.stringify(event) + '\n');
    process.kill = () => { process.emit('exit', 0); process.stdout.end(); process.stderr.end(); };
    process.stdin = new Writable({ write(chunk, _encoding, done) {
      const packet = JSON.parse(chunk.toString());
      process.sent.push(packet);
      done();
      const answer = result => queueMicrotask(() => process.event({ id: packet.id, result }));
      if (packet.method === 'initialize') answer({});
      if (packet.method === 'thread/start') {
        const tools = packet.params.dynamicTools.map(tool => tool.name);
        const thread = { id: `test-thread-${threads.size + 1}`, status: { type: 'idle' }, turns: [], tools };
        process.thread = thread; threads.set(thread.id, thread); answer({ thread });
      }
      if (packet.method === 'thread/resume') {
        process.thread = threads.get(packet.params.threadId);
        assert.ok(process.thread);
        answer({ thread: process.thread });
      }
      if (packet.method === 'turn/start') {
        const turn = { id: `test-turn-${process.thread.id}-${process.thread.turns.length + 1}`, status: 'inProgress', items: [] };
        process.thread.turns.push(turn); process.thread.status = { type: 'active' };
        if (withholdFirstReceipt && !workerReceiptWithheld && !process.thread.tools.includes(prepareBatchTool.name)) workerReceiptWithheld = true;
        else answer({ turn });
      }
    } });
    process.finish = () => {
      const turn = process.thread.turns.at(-1);
      turn.status = 'completed'; process.thread.status = { type: 'idle' };
      process.event({ method: 'turn/completed', params: { threadId: process.thread.id, turn } });
    };
    process.tool = (id, tool, argument) => process.event({ id, method: 'item/tool/call', params: {
      threadId: process.thread.id, turnId: process.thread.turns.at(-1).id, tool, callId: String(id), arguments: argument,
    } });
    process.report = (id, argument) => process.tool(id, 'tinylens_ui_report', argument);
    processes.push(process);
    return process;
  }
  async function start() {
    app = await createAgentTaskServer({ stateDirectory, remoteProxyPort: 0, batchPollMs: 10, spawnProcess, rpcTimeoutMs: 300,
      logger: { error() {} }, stageScopeLookup: async (report, _root, options) => { verified.push({ report, options }); },
      batchInventory: async request => ({ inputDir: request.inputDir, outputDir: request.outputDir, python: '/usr/bin/python3',
        targets: (request.selection.ids ?? names.slice(0, request.selection.count)).map((lensId, index) => ({
          lensId, inputPath: `${request.inputDir}/${lensId}`, runId: index === 0 ? firstRunId : null })) }),
    });
    app.server.emit('listening');
  }
  async function request(path, data) {
    const req = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
    req.method = data === undefined ? 'GET' : 'POST'; req.url = `/api/agent/${path}`;
    req.headers = { host: '127.0.0.1:5173', 'content-type': 'application/json' };
    return new Promise(resolve => {
      let status;
      app.server.emit('request', req, { writeHead(value) { status = value; }, end(body) { resolve({ status, body: JSON.parse(body) }); } });
    });
  }
  const detail = async id => (await request(`${batches}/${id}`)).body.batch;
  const dispatches = () => processes.filter(process => !process.thread?.tools.includes(prepareBatchTool.name))
    .flatMap(process => process.sent.filter(packet => packet.method === 'turn/start'));
  const root = () => processes.findLast(process => process.thread?.tools.includes(prepareBatchTool.name));
  async function toolCall(process, name, data) {
    const id = ++toolSequence;
    process.tool(id, name, data);
    const receipt = await waitFor(() => process.sent.find(packet => packet.id === id && packet.result), Boolean);
    const { result } = receipt;
    return { success: result.success, value: result.success ? JSON.parse(result.contentItems[0].text) : result.contentItems[0].text };
  }
  async function user(text, taskId, observedPlanId) {
    const query = taskId ? `?taskId=${taskId}` : '';
    const plan = (await request(`state${query}`)).body.batchPlan;
    const seenBatchPlanId = observedPlanId ?? (plan?.status === 'preview' ? plan.id : undefined);
    const response = await request(`message${query}`, { text, ...(seenBatchPlanId && { seenBatchPlanId }) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  async function prepare(requested = spec) {
    await request('connect', {});
    await user(originalPrompt);
    assert.deepEqual(root().sent.findLast(packet => packet.method === 'turn/start').params.input, [{ type: 'text', text: originalPrompt }]);
    const reply = await toolCall(root(), prepareBatchTool.name, requested);
    assert.equal(reply.success, true, String(reply.value));
    const transport = await request('state');
    assert.equal('batchDraft' in transport.body, false);
    return transport.body.batchPlan;
  }
  await start();
  t.after(async () => { await app?.close(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { request, detail, processes, verified, dispatches, root, prepare, user, toolCall, changeRun: id => { firstRunId = id; },
    async restart() { await app.close(); await start(); } };
}

function stage(lensId, status, stage = 'm3') {
  const run_path = `${outputDir}/${lensId}`;
  return { schema: 'tinylens.stage-report.v1', kind: 'stage', run_id: 'run-fixture', run_path, lens_id: lensId, stage, attempt: 0, status,
    ...(status === 'accepted' && { path: `${run_path}/accepted/${stage}.json` }),
    ...(status === 'human_review' && { path: `${run_path}/attempts/${stage}/0/decision.json` }), message: `fixture ${status}` };
}

test('one confirmed 100-lens plan in the original conversation advances a bounded queue', async t => {
  const f = await fixture(t);
  const preview = await f.prepare();
  assert.deepEqual(preview.targets.map(item => item.lensId), names);
  assert.equal(f.dispatches().length, 0);
  assert.equal((await f.request('tasks')).body.tasks.length, 1);
  assert.equal((await f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id })).success, false);
  assert.equal((await f.request(batches, { id: preview.id })).status, 405);
  f.root().finish();
  await f.restart();
  assert.equal((await f.request('state')).body.batchPlan.id, preview.id);
  await f.request('connect', {});
  await f.user('就按这个名单跑。');
  const submit = () => f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id });
  const responses = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map(response => response.value), Array(2).fill({ id: preview.id, count: 100, status: 'queued' }));
  assert.equal((await f.request('state')).body.batchPlan.status, 'submitted');
  assert.equal(new Set((await f.detail(preview.id)).jobs.map(job => job.taskId)).size, 100);
  await waitFor(f.dispatches, turns => turns.length === 2);
  let view = await waitFor(() => f.detail(preview.id), batch => batch.jobs.filter(job => job.status === 'running').length === 2);
  assert.equal(view.jobs.filter(job => job.status === 'queued').length, 98);
  const early = await f.request(`message?taskId=${view.jobs[2].taskId}`, { text: 'early' });
  assert.equal(early.status, 409);
  const threadFor = lensId => f.processes.find(process => process.sent.some(packet => packet.method === 'turn/start'
    && packet.params.input[0].text.includes(`Input Lens Directory: ${source}/${lensId}\n`)));
  const first = threadFor('lens-001'), second = threadFor('lens-002');
  assert.ok(first && second);
  assert.deepEqual(first.thread.tools, ['tinylens_ui_report']);
  assert.ok(second.sent.find(packet => packet.method === 'turn/start').params.input[0].text.includes('请检查来源标定'));
  first.report(18, stage('lens-002', 'accepted'));
  await waitFor(() => first.sent.find(packet => packet.id === 18 && packet.result), Boolean);
  assert.equal(first.sent.find(packet => packet.id === 18 && packet.result).result.success, false);
  first.report(19, stage('lens-001', 'queued', 'm1'));
  await waitFor(() => f.detail(preview.id), batch => batch.jobs[0].status === 'waiting_gpu');
  second.report(20, stage('lens-002', 'executed'));
  await waitFor(() => second.sent.find(packet => packet.id === 20 && packet.result), Boolean);
  second.finish();
  await waitFor(f.dispatches, turns => turns.length === 3);
  view = await f.detail(preview.id);
  assert.equal(view.jobs[1].status, 'incomplete');

  // A request in one task requires the user and releases an automatic dispatch slot.
  first.event({ id: 21, method: 'item/commandExecution/requestApproval', params: {
    threadId: first.thread.id, turnId: first.thread.turns[0].id, itemId: 'cmd', availableDecisions: ['accept', 'cancel'],
  } });
  await waitFor(f.dispatches, turns => turns.length === 4);
  assert.equal((await f.detail(preview.id)).jobs[0].status, 'waiting_user');
  assert.equal(first.sent.some(packet => packet.id === 21), false);
  await f.request(`${batches}/${preview.id}/dispatch`, { paused: true });
  const third = threadFor('lens-003');
  third.report(22, stage('lens-003', 'human_review'));
  await waitFor(() => f.detail(preview.id), batch => batch.jobs[2].status === 'human_review');
  third.finish();
  await delay(25);
  assert.equal(f.verified.find(entry => entry.report.status === 'human_review').options.verifyHumanReview, true);
  assert.equal(f.dispatches().length, 4);
  const collision = await f.toolCall(f.root(), prepareBatchTool.name, spec);
  assert.equal(collision.success, false);
});

test('a newer correction or a different conversation cannot authorize the proposed plan', async t => {
  const f = await fixture(t);
  const preview = await f.prepare();
  f.root().finish();
  const origin = f.root();
  await f.user('先不要提交，我想换一份名单。');
  assert.equal((await f.toolCall(origin, dispatchBatchTool.name, { id: preview.id })).success, false);
  origin.finish();
  await f.user('确认提交这批', undefined, 'batch-00000000-0000-0000-0000-000000000001');
  assert.equal((await f.toolCall(origin, dispatchBatchTool.name, { id: preview.id })).success, false);
  const taskId = (await f.request('tasks', {})).body.task.id;
  await f.request(`connect?taskId=${taskId}`, {});
  await f.user('确认提交这批', taskId);
  assert.equal((await f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id })).success, false);
  assert.equal(f.dispatches().length, 0);
});

test('batch confirmation rejects changed run identities before creating tasks', async t => {
  const f = await fixture(t);
  const preview = await f.prepare();
  f.changeRun('appeared-after-preview');
  f.root().finish();
  await f.user('确认提交这批');
  const rejected = await f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id });
  assert.equal(rejected.success, false);
  assert.match(rejected.value, /名单或运行已变化/);
  assert.equal(f.dispatches().length, 0);
  assert.equal((await f.request('tasks')).body.tasks.length, 1);
});

test('a restarted queue reconciles ambiguous initial delivery in the same thread and does not replay it', async t => {
  const f = await fixture(t, { withholdFirstReceipt: true });
  const preview = await f.prepare({ ...spec, selection: { ids: names.slice(0, 2) }, parallelism: 1 });
  f.root().finish();
  await f.user('确认提交这批');
  assert.equal((await f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id })).success, true);
  f.root().finish();
  const saved = await f.detail(preview.id);
  await waitFor(f.dispatches, turns => turns.length === 1);
  await f.restart();
  const restored = await waitFor(() => f.detail(preview.id), view => view.jobs[0].status === 'running' && view.jobs[1].status === 'queued');
  assert.deepEqual(restored.jobs.map(job => job.taskId), saved.jobs.map(job => job.taskId));
  assert.equal(f.dispatches().length, 1);
  const connection = f.processes.at(-1);
  assert.equal(connection.sent.find(packet => packet.method === 'thread/resume').params.threadId, f.dispatches()[0].params.threadId);
  connection.report(23, stage('lens-001', 'accepted'));
  await waitFor(() => f.detail(preview.id), view => view.jobs[0].status === 'accepted');
  connection.finish();
  await waitFor(f.dispatches, turns => turns.length === 2);
  assert.ok(f.dispatches()[1].params.input[0].text.includes('新运行预检'));
  assert.notEqual(f.dispatches()[0].params.threadId, f.dispatches()[1].params.threadId);
});
