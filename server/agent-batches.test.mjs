import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';

async function readerDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tinylens-batch-reader-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runReader(name, request, env = process.env) {
  return spawnSync(python, ['-B', fileURLToPath(new URL(name, import.meta.url)), JSON.stringify(request)], { env, encoding: 'utf8' });
}

async function waitFor(read, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(12);
  }
  assert.fail('Batch test state did not settle');
}

async function fixture(t, { withholdFirstReceipt = false, rejectFirstWorkerStart = false, rejectFirstWorkerThread = false } = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tinylens-batches-test-'));
  const processes = [];
  const threads = new Map();
  const verified = [];
  let app;
  let firstRunId = null;
  let workerReceiptWithheld = false;
  let workerStartRejected = false;
  let workerThreadRejected = false;
  const workerResumeOutcomes = [];
  let toolSequence = 500;
  let threadSequence = 0;
  function spawnProcess() {
    const process = new EventEmitter();
    process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.sent = [];
    process.event = event => process.stdout.write(JSON.stringify(event) + '\n');
    process.kill = () => {
      if (process.killed) return;
      process.killAttempts = (process.killAttempts ?? 0) + 1;
      if (process.failKillOnce) { process.failKillOnce = false; throw Error('Mock transport cleanup failure'); }
      if (process.refuseKillOnce) { process.refuseKillOnce = false; return false; }
      process.killed = true;
      process.emit('exit', 0); process.stdout.end(); process.stderr.end();
    };
    process.stdin = new Writable({ write(chunk, _encoding, done) {
      const packet = JSON.parse(chunk.toString());
      process.sent.push(packet);
      done();
      const answer = result => queueMicrotask(() => process.event({ id: packet.id, result }));
      const reject = (code, message) => queueMicrotask(() => process.event({ id: packet.id, error: { code, message } }));
      if (packet.method === 'initialize') answer({});
      if (packet.method === 'thread/start') {
        const tools = packet.params.dynamicTools.map(tool => tool.name);
        if (rejectFirstWorkerThread && !workerThreadRejected && !tools.includes(prepareBatchTool.name)) {
          workerThreadRejected = true;
          return reject(-32000, 'First worker connection rejected by mock');
        }
        const thread = { id: `test-thread-${++threadSequence}`, status: { type: 'idle' }, turns: [], tools };
        process.thread = thread; threads.set(thread.id, thread); answer({ thread });
      }
      if (packet.method === 'thread/resume') {
        process.thread = threads.get(packet.params.threadId);
        if (!process.thread) return reject(-32600, `no rollout found for thread id ${packet.params.threadId}`);
        if (!process.thread.tools.includes(prepareBatchTool.name)) {
          const outcome = workerResumeOutcomes.shift();
          if (outcome === 'timeout') return;
          if (outcome === 'reject') return reject(-32000, 'Transient mock resume failure');
        }
        answer({ thread: process.thread });
      }
      if (packet.method === 'turn/start') {
        const worker = !process.thread.tools.includes(prepareBatchTool.name);
        if (worker && rejectFirstWorkerStart && !workerStartRejected) {
          workerStartRejected = true;
          return reject(-32602, 'First start explicitly rejected by mock');
        }
        const withhold = worker && withholdFirstReceipt && !workerReceiptWithheld;
        const items = [{ type: 'userMessage', id: packet.params.clientUserMessageId, content: packet.params.input }];
        const turn = { id: `test-turn-${process.thread.id}-${process.thread.turns.length + 1}`, status: 'inProgress', items };
        if (withhold) workerReceiptWithheld = true;
        if (withhold && withholdFirstReceipt === 'without-turn') return;
        process.thread.turns.push(turn); process.thread.status = { type: 'active' };
        if (!withhold) answer({ turn });
      }
    } });
    process.finish = (status = 'completed') => {
      const turn = process.thread.turns.at(-1);
      turn.status = status; process.thread.status = { type: 'idle' };
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
  function openViewer(taskId) {
    const req = Readable.from([]);
    req.method = 'GET'; req.url = `/api/agent/events?taskId=${taskId}`;
    req.headers = { host: '127.0.0.1:5173' };
    return new Promise(resolve => {
      const response = new EventEmitter();
      response.end = () => { response.destroyed = true; response.emit('close'); };
      response.writeHead = code => assert.equal(code, 200);
      response.write = () => { resolve(response.end); };
      app.server.emit('request', req, response);
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
    const state = (await request(`state${query}`)).body;
    const seenBatchPlanId = observedPlanId ?? (state.batchPlan?.status === 'preview' ? state.batchPlan.id : undefined);
    const response = await request(`message${query}`, { text, clientMessageId: randomUUID(),
      expectedThreadId: state.threadId, expectedTurnId: state.turnId, ...(seenBatchPlanId && { seenBatchPlanId }) });
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
  return { request, openViewer, detail, processes, verified, dispatches, root, prepare, user, toolCall, workerResumeOutcomes,
    forgetThread: id => { threads.delete(id); }, changeRun: id => { firstRunId = id; },
    async restart(beforeStart) { await app.close(); await beforeStart?.(stateDirectory); await start(); } };
}

function stage(lensId, status, stage = 'm3', attempt = 0) {
  const run_path = `${outputDir}/${lensId}`;
  return { schema: 'tinylens.stage-report.v1', kind: 'stage', run_id: 'run-fixture', run_path, lens_id: lensId, stage, attempt, status,
    ...(status === 'accepted' && { path: `${run_path}/accepted/${stage}.json` }),
    ...(status === 'human_review' && { path: `${run_path}/attempts/${stage}/${attempt}/decision.json` }), message: `fixture ${status}` };
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

async function dispatchFixtureBatch(f, count = 1) {
  const preview = await f.prepare({ ...spec, selection: { ids: names.slice(0, count) }, parallelism: 1 });
  f.root().finish();
  await f.user('确认提交这批');
  assert.equal((await f.toolCall(f.root(), dispatchBatchTool.name, { id: preview.id })).success, true);
  f.root().finish();
  return preview.id;
}

const resumePackets = (fixture, threadId) => fixture.processes.flatMap(process => process.sent
  .filter(packet => packet.method === 'thread/resume' && packet.params.threadId === threadId));

test('batch releases idle incomplete and failed connections, retrying a transient release failure', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f, 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const incomplete = f.processes.at(-1);
  incomplete.failKillOnce = true;
  incomplete.refuseKillOnce = true;
  incomplete.finish();
  await waitFor(f.dispatches, turns => turns.length === 2);
  const failed = f.processes.at(-1);
  failed.finish('failed');
  await waitFor(() => incomplete.killed && failed.killed, Boolean);
  assert.equal(incomplete.killAttempts, 3);
  assert.deepEqual((await f.detail(id)).jobs.map(job => job.status), ['incomplete', 'attention']);
});

test('idle cleanup retries once the user closes the workbench viewer', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f, 2);
  const view = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const worker = f.processes.at(-1);
  const closeViewer = await f.openViewer(view.jobs[0].taskId);
  worker.finish();
  await waitFor(f.dispatches, turns => turns.length === 2);
  assert.equal(worker.killed, undefined);
  closeViewer();
  await waitFor(() => worker.killed, Boolean);
});

test('an idle structured question reconnects to the original thread while a native approval keeps its live transport', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f, 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const approval = f.processes.at(-1);
  approval.event({ id: 25, method: 'item/commandExecution/requestApproval', params: {
    threadId: approval.thread.id, turnId: approval.thread.turns[0].id, itemId: 'cmd', availableDecisions: ['accept', 'cancel'],
  } });
  await waitFor(f.dispatches, turns => turns.length === 2);
  const question = f.processes.at(-1);
  question.report(26, { kind: 'note', status: 'awaiting_user', message: JSON.stringify({
    tinylens_ui_question: 1, id: 'batch-question', question: 'Choose the next action.', options: [],
  }) });
  await waitFor(() => question.sent.find(packet => packet.id === 26 && packet.result?.success), Boolean);
  question.finish();
  await waitFor(() => question.killed, Boolean);
  assert.equal(approval.killed, undefined);
  assert.equal(approval.sent.some(packet => packet.id === 25), false);
  const view = await f.detail(id);
  assert.deepEqual(view.jobs.map(job => job.status), ['waiting_user', 'waiting_user']);
  const taskId = view.jobs[1].taskId;
  const reopened = await f.request(`connect?taskId=${taskId}`, {});
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.threadId, question.thread.id);
  assert.equal(reopened.body.questions[0].status, 'pending');
  await delay(35);
  assert.equal(f.processes.at(-1).killed, undefined);
  assert.equal(f.dispatches().length, 2);
});

test('idle release of an interrupted turn does not auto-reconnect, including after service restart', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const interrupted = f.processes.at(-1);
  interrupted.finish('interrupted');
  await waitFor(() => interrupted.killed, Boolean);
  await f.restart();
  await delay(35);
  assert.equal(resumePackets(f, interrupted.thread.id).length, 0);
  assert.equal(f.dispatches().length, 1);
});

test('a reported B-only rerun supersedes the prior human review while preserving B acceptance', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f);
  const view = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const taskId = view.jobs[0].taskId;
  const first = f.processes.at(-1);
  first.report(27, stage('lens-001', 'human_review', 'b'));
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'human_review');
  first.finish();
  await waitFor(() => first.killed, Boolean);
  await f.request(`connect?taskId=${taskId}`, {});
  await f.user('只重跑 Stage B', taskId);
  const rerun = f.processes.at(-1);
  assert.equal(rerun.thread.id, first.thread.id);
  rerun.report(28, stage('lens-001', 'running', 'b', 1));
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running' && batch.jobs[0].stageStatus === 'running');
  rerun.report(29, stage('lens-001', 'human_review', 'b'));
  await waitFor(() => rerun.sent.find(packet => packet.id === 29 && packet.result), Boolean);
  assert.equal((await f.detail(id)).jobs[0].status, 'running');
  rerun.report(30, stage('lens-001', 'accepted', 'b', 1));
  await waitFor(() => f.detail(id), batch => batch.jobs[0].stageStatus === 'accepted');
  rerun.finish();
  const updated = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'incomplete');
  assert.equal(updated.jobs[0].stage, 'b');
  assert.equal(updated.jobs[0].stageStatus, 'accepted');
});

test('the stage reader rejects new reports of a B Human Review superseded by the saved selection', async t => {
  const root = await readerDirectory(t);
  const storage = join(root, 'output', 'lens-001');
  const decisionPath = 'attempts/b/0/decision.json';
  const decision = JSON.stringify({ schema_version: 'stage_decision.v1', stage: 'b', attempt: 0, decision: 'human_review' });
  await mkdir(join(storage, 'attempts', 'b', '0'), { recursive: true });
  await writeFile(join(storage, decisionPath), decision);
  await writeFile(join(storage, 'run-manifest.json'), JSON.stringify({ schema_version: 'lens_run_manifest.v1', lens_dir: '/fixture/lens-001', run_id: 'run-1' }));
  const request = { root, storage, lens_id: 'lens-001', stage: 'b', attempt: 0, accepted: false, human_review: true };
  const first = runReader('./read-stage-scope.py', request);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { run_id: 'run-1', attempt: 0 });
  const selectionDirectory = join(storage, 'stage-b-candidates', '1');
  await mkdir(selectionDirectory, { recursive: true });
  await writeFile(join(selectionDirectory, 'selection.json'), JSON.stringify({ schema_version: 'stage_b_candidate_selection.v1',
    stage: 'b', attempt: 1, restart_of: { path: decisionPath, sha256: createHash('sha256').update(decision).digest('hex') } }));
  const restarted = runReader('./read-stage-scope.py', request);
  assert.equal(restarted.status, 1);
  assert.match(restarted.stderr, /superseded by a restart/);
});

test('batch inventory only accepts an existing run compatible with the configured Python runtime', async t => {
  const root = await readerDirectory(t);
  const inputDir = join(root, 'input');
  const workspace = join(root, 'pipeline');
  const outputDir = join(workspace, 'output', 'batch');
  const lens = join(inputDir, 'lens-001');
  const packagePath = join(root, 'python-mock', 'lens_agent');
  await mkdir(lens, { recursive: true });
  await mkdir(join(outputDir, 'lens-001'), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, '__init__.py'), '');
  await writeFile(join(packagePath, 'configuration.py'), 'PIPELINE_RELEASE_ID = "mock-release"\n');
  await writeFile(join(lens, 'lens-001.fits'), 'Synthetic inventory fixture');
  const read = () => runReader('./read-batch-plan.py', { inputDir, outputDir, workspace, selection: { ids: ['lens-001'] } },
    { ...process.env, PYTHONPATH: join(root, 'python-mock') });
  const writeManifest = pipeline_release_id => writeFile(join(outputDir, 'lens-001', 'run-manifest.json'), JSON.stringify({
    schema_version: 'lens_run_manifest.v1', lens_dir: lens, run_id: 'existing', pipeline_release_id,
  }));
  await writeManifest('old-release');
  const incompatible = read();
  assert.equal(incompatible.status, 0, incompatible.stderr);
  assert.match(JSON.parse(incompatible.stdout).error, /版本不兼容/);
  await writeManifest('mock-release');
  const compatible = read();
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.deepEqual(JSON.parse(compatible.stdout).plan.targets, [{ lensId: 'lens-001', inputPath: lens, runId: 'existing' }]);
});

test('a failed resume is retried with a new transport and another disconnect gets its own recovery budget', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f, 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const first = f.processes.at(-1);
  const { id: threadId } = first.thread;
  f.workerResumeOutcomes.push('timeout');
  first.kill();
  await waitFor(() => resumePackets(f, threadId), packets => packets.length === 1);
  assert.equal(f.dispatches().length, 1);
  assert.equal((await f.detail(id)).jobs[1].status, 'queued');
  await waitFor(() => resumePackets(f, threadId), packets => packets.length === 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const recovered = f.processes.at(-1);
  assert.notEqual(recovered, first);
  assert.equal(recovered.thread.id, threadId);
  assert.ok(f.processes[f.processes.indexOf(recovered) - 1].killed);
  f.workerResumeOutcomes.push('reject');
  recovered.kill();
  await waitFor(() => resumePackets(f, threadId), packets => packets.length === 4);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running' && batch.jobs[1].status === 'queued');
  assert.equal(f.dispatches().length, 1);
});

test('recovery stops after bounded attempts and frees dispatch capacity for the next job', async t => {
  const f = await fixture(t);
  const id = await dispatchFixtureBatch(f, 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  const first = f.processes.at(-1);
  const { id: threadId } = first.thread;
  f.workerResumeOutcomes.push('reject', 'reject', 'reject', 'reject');
  first.kill();
  await waitFor(f.dispatches, packets => packets.length === 2);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'attention' && batch.jobs[1].status === 'running');
  await delay(80);
  assert.equal(resumePackets(f, threadId).length, 3);
  assert.equal(f.dispatches().filter(packet => packet.params.threadId === threadId).length, 1);
});

for (const legacy of [false, true]) {
  test(`an explicit first rejection is retryable after restart${legacy ? ' from a legacy submitted record' : ''}`, async t => {
    const f = await fixture(t, { rejectFirstWorkerStart: true });
    const id = await dispatchFixtureBatch(f);
    const before = await waitFor(() => f.detail(id), batch => batch.retryableStartCount === 1);
    const [rejected] = f.dispatches();
    assert.equal(before.jobs[0].delivered, undefined);
    assert.equal(before.jobs[0].status, 'attention');
    assert.equal(f.dispatches().length, 1);
    f.forgetThread(rejected.params.threadId);
    await f.restart(legacy ? async directory => {
      const path = join(directory, 'agent-tasks.json');
      const registry = JSON.parse(await readFile(path, 'utf8'));
      const job = registry.batches[0].jobs[0];
      job.dispatch = 'submitted';
      delete job.startMessageId;
      await writeFile(path, JSON.stringify(registry));
    } : undefined);
    const restored = await f.detail(id);
    assert.equal(restored.retryableStartCount, 1);
    assert.equal(f.dispatches().length, 1);
    const retry = await f.request(`batches/${id}/retry-start`, {});
    assert.equal(retry.status, 200);
    assert.equal(retry.body.requeued, 1);
    const sent = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
    assert.equal(sent.jobs[0].taskId, before.jobs[0].taskId);
    assert.equal(sent.jobs[0].delivered, true);
    const [, accepted] = f.dispatches();
    assert.equal(f.dispatches().length, 2);
    assert.notEqual(accepted.params.clientUserMessageId, rejected.params.clientUserMessageId);
    assert.notEqual(accepted.params.threadId, rejected.params.threadId);
    assert.equal(resumePackets(f, rejected.params.threadId).length, 1);
  });
}

test('a connection failure before sending an explicit retry leaves the job retryable', async t => {
  const f = await fixture(t, { rejectFirstWorkerStart: true });
  const id = await dispatchFixtureBatch(f);
  await waitFor(() => f.detail(id), batch => batch.retryableStartCount === 1);
  await f.restart();
  f.workerResumeOutcomes.push('reject');
  const retry = () => f.request(`batches/${id}/retry-start`, {});
  assert.equal((await retry()).body.requeued, 1);
  await waitFor(() => f.detail(id), batch => batch.retryableStartCount === 1);
  assert.equal(f.dispatches().length, 1);
  assert.equal((await retry()).body.requeued, 1);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  assert.equal(f.dispatches().length, 2);
});

test('a first connection failure persists proof of no submission before publishing a retryable job', async t => {
  const f = await fixture(t, { rejectFirstWorkerThread: true });
  const id = await dispatchFixtureBatch(f);
  const view = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'attention' && batch.retryableStartCount === 1);
  assert.equal(view.retryableStartCount, 1);
  assert.equal(f.dispatches().length, 0);
  await f.restart();
  assert.equal((await f.request(`batches/${id}/retry-start`, {})).body.requeued, 1);
  await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'running');
  assert.equal(f.dispatches().length, 1);
});

test('a missing receipt and absent remote item stays unconfirmed with no retry or replay', async t => {
  const f = await fixture(t, { withholdFirstReceipt: 'without-turn' });
  const id = await dispatchFixtureBatch(f);
  await waitFor(f.dispatches, packets => packets.length === 1);
  const [{ params: { threadId } }] = f.dispatches();
  await waitFor(() => resumePackets(f, threadId), packets => packets.length === 1);
  const pending = await waitFor(() => f.detail(id), batch => batch.jobs[0].status === 'unconfirmed');
  assert.equal(pending.jobs[0].delivered, undefined);
  const retry = await f.request(`batches/${id}/retry-start`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.body.requeued, 0);
  assert.equal(f.dispatches().length, 1);
});
