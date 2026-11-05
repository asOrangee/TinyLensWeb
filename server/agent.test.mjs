import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, receiveNotification, receiveReport, receiveRequest, validateReply, restoreThread, applyTurn, hasBlockingRequest } from './agent-state.mjs';
import { createAgentServer } from './agent-server.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function live() { const state = initialState({ threadId: 'thread-1' }); applyTurn(state, { id: 'turn-1', status: 'inProgress' }); return state; }
const report = (arguments_ = { kind: 'stage', stage: 'a', status: 'accepted', message: 'Canonical accepted head exists.' }) => ({ threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'tinylens_ui_report', arguments: arguments_ });
const approval = (id = 51) => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1' } });
function fakeProcess(handler) {
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.killed = false; proc.sent = [];
  proc.emitMessage = message => proc.stdout.write(JSON.stringify(message) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); proc.sent.push(message); done();
    queueMicrotask(() => handler(message, proc));
  } });
  proc.kill = () => { proc.killed = true; proc.emit('exit', 0); proc.stdout.end(); proc.stderr.end(); };
  return proc;
}
function baseHandler(message, proc) {
  if (message.method === 'initialize') proc.emitMessage({ id: message.id, result: {} });
  if (message.method === 'thread/start') proc.emitMessage({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } } });
  if (message.method === 'thread/resume') proc.emitMessage({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] }, initialTurnsPage: { data: [] } } });
}
async function fixture(t, handler = baseHandler, options = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tinylens-agent-test-'));
  const processes = [];
  if (options.saved) await writeFile(join(stateDirectory, 'agent-state.json'), JSON.stringify(options.saved));
  const bridge = await createAgentServer({ stateDirectory, spawnProcess: () => { const proc = fakeProcess(handler); processes.push(proc); return proc; }, rpcTimeoutMs: 1000, logger: { error() {} }, ...options });
  t.after(async () => { await bridge.close(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { bridge, processes, stateDirectory };
}

test('events and dynamic reports cannot cross thread or active-turn boundaries', () => {
  const state = live(); const before = structuredClone(state);
  for (const threadId of ['different', undefined]) assert.equal(receiveNotification(state, 'turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } }), false);
  assert.throws(() => receiveReport(state, { ...report(), threadId: 'different' }));
  assert.throws(() => receiveReport(state, { ...report(), turnId: 'old-turn' }));
  assert.throws(() => receiveRequest(state, { ...approval(), params: { ...approval().params, turnId: 'old-turn' } }));
  assert.deepEqual(state, before);
});

test('AI completion never invents scientific acceptance, and late start responses cannot resurrect it', () => {
  const state = live();
  receiveNotification(state, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(state.status, 'completed'); assert.deepEqual(state.updates, []);
  assert.equal(applyTurn(state, { id: 'turn-1', status: 'inProgress' }), false);
  assert.equal(state.turnId, null);
  applyTurn(state, { id: 'turn-2', status: 'inProgress' });
  assert.equal(receiveNotification(state, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed' } }), false);
  assert.equal(state.turnId, 'turn-2');
});

test('report tool validates the declared schema, stage/artifact payload, and idempotent call identity', () => {
  const state = live();
  for (const value of [[], { kind: 'note', message: '' }, { kind: 'stage', message: 'missing stage' }, { kind: 'artifact', path: '../secret', message: 'bad' }, { kind: 'note', message: 'x', execute: 'run' }, { kind: 'stage', stage: ' ', status: 'checking', message: 'missing label' }]) assert.throws(() => receiveReport(state, report(value)));
  assert.throws(() => receiveReport(state, { ...report(), namespace: 'other' }));
  assert.equal(receiveReport(state, report()), true); assert.equal(receiveReport(state, report()), false);
  assert.equal(state.updates.length, 1); assert.equal(state.updates[0].stage, 'a');
  assert.equal(state.status, 'running');
});

test('real AI preparation report remains a report and is not rejected or mapped to a scientific stage', () => {
  const state = live();
  const arguments_ = {
    kind: 'stage', stage: 'preparation', status: 'checking',
    message: 'Read-only provenance and input-compatibility checks are in progress. The requested central-lens-light, no-subhalo baseline has been located. No physical stage has run and no scientific result has been accepted.',
  };
  assert.equal(receiveReport(state, report(arguments_)), true);
  assert.equal(state.updates[0].stage, 'preparation');
  assert.equal(state.updates[0].status, 'checking');
  assert.equal(state.updates[0].message, arguments_.message);
  assert.equal(state.status, 'running');
});

test('approval requires an explicit one-time answer; nonblocking user prompts remain nonblocking', () => {
  const state = live(); const request = approval(); receiveRequest(state, request);
  assert.equal(state.status, 'waiting'); assert.equal(hasBlockingRequest(state), true);
  for (const result of [{}, { decision: 'acceptForSession' }, { decision: 'accept', permissions: {} }]) assert.throws(() => validateReply(request, result));
  assert.deepEqual(validateReply(request, { decision: 'accept' }), { decision: 'accept' });
  receiveNotification(state, 'serverRequest/resolved', { threadId: 'thread-1', requestId: 51 });
  receiveRequest(state, { id: 52, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'q', isBlocking: false, questions: [{ id: 'q1' }] } });
  assert.equal(hasBlockingRequest(state), false); assert.equal(state.status, 'running');
  assert.throws(() => receiveRequest(state, { id: 53, method: 'account/login', params: {} }));
});

test('restart clears stale requests while resume reconciles remote completion and preserves user messages/reports', () => {
  const saved = { threadId: 'thread-1', turnId: 'turn-1', status: 'waiting', requests: [approval()], messages: [{ id: 'user-1', role: 'user', text: 'Task', delivery: 'pending' }], updates: [{ kind: 'note', message: 'Evidence' }] };
  const state = initialState(saved);
  assert.equal(state.status, 'interrupted'); assert.deepEqual(state.requests, []); assert.equal(state.messages[0].delivery, 'unknown');
  restoreThread(state, { id: 'thread-1', status: { type: 'idle' } }, [{ id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Done' }] }]);
  assert.equal(state.status, 'completed'); assert.equal(state.needsReconcile, false); assert.equal(state.turnId, null);
  assert.equal(state.messages[0].text, 'Task'); assert.equal(state.updates[0].message, 'Evidence');
  assert.throws(() => restoreThread(state, { id: 'other' }));
  assert.equal(saved.messages[0].delivery, 'pending');
  restoreThread(state, { id: 'thread-1', status: { type: 'active', activeFlags: [] } }, [{ id: 'turn-2', status: 'inProgress', items: [{ id: 'partial', type: 'agentMessage', text: 'First' }] }]);
  receiveNotification(state, 'item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-2', itemId: 'partial', delta: ' next' });
  assert.equal(state.messages.find(message => message.id === 'partial').text, 'First next');
  assert.equal(state.status, 'running');
});

test('connect has no side-effect turn, preserves feedback verbatim, and tolerates fast completion before RPC reply', async t => {
  const { bridge, processes, stateDirectory } = await fixture(t, (message, proc) => {
    baseHandler(message, proc);
    if (message.method === 'turn/start') {
      proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
      proc.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      proc.emitMessage({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    }
  });
  assert.equal(processes.length, 0); await bridge.connect();
  assert.equal(processes[0].sent.filter(message => message.method === 'turn/start').length, 0);
  await bridge.submitMessage({ stage: 'preflight', text: 'Check this input.' });
  const sent = processes[0].sent.find(message => message.method === 'turn/start');
  assert.deepEqual(sent.params.input, [{ type: 'text', text: 'Check this input.' }]);
  assert.equal(bridge.state.status, 'completed'); assert.equal(bridge.state.turnId, null); assert.deepEqual(bridge.state.updates, []);
  const journal = JSON.parse(await readFile(join(stateDirectory, 'agent-state.json'), 'utf8'));
  assert.equal(journal.messages[0].delivery, 'delivered');
});

test('server never auto-approves and rejects duplicate/stale replies and unsupported requests', async t => {
  const { bridge, processes } = await fixture(t); await bridge.connect();
  const proc = processes[0]; proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } }); proc.emitMessage(approval()); await tick();
  assert.equal(proc.sent.some(message => message.id === 51), false);
  await assert.rejects(bridge.submitMessage({ text: 'Do more.' }), /pending AI request/);
  await bridge.reply({ requestId: 51, result: { decision: 'accept' } });
  assert.deepEqual(proc.sent.find(message => message.id === 51).result, { decision: 'accept' });
  await assert.rejects(bridge.reply({ requestId: 51, result: { decision: 'accept' } }), /no longer/);
  proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 51 } }); await tick(); assert.deepEqual(bridge.state.requests, []);
  proc.emitMessage({ id: 55, method: 'account/login', params: {} }); await tick();
  assert.equal(proc.sent.find(message => message.id === 55).error.code, -32602); assert.equal(bridge.state.status, 'running');
  proc.emitMessage(approval(56)); await tick(); proc.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); await tick();
  await assert.rejects(bridge.reply({ requestId: 56, result: { decision: 'accept' } }), /no longer/);
});

test('unknown message delivery is persisted and never automatically resent on reconnect', async t => {
  const { bridge, processes } = await fixture(t, baseHandler, { rpcTimeoutMs: 25 }); await bridge.connect();
  await assert.rejects(bridge.submitMessage({ text: 'Run once.' }), /delivery is unconfirmed/);
  assert.equal(bridge.state.messages[0].delivery, 'unknown'); assert.equal(bridge.state.connection, 'error');
  await bridge.connect();
  assert.equal(processes.length, 1); assert.equal(processes[0].sent.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(processes[0].sent.filter(message => message.method === 'thread/resume').length, 1);
});

test('old transports cannot alter a reconnected thread and paginated resume restores latest remote status', async t => {
  const { bridge, processes } = await fixture(t, (message, proc) => {
    if (message.method !== 'thread/resume') return baseHandler(message, proc);
    proc.emitMessage({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] }, initialTurnsPage: { data: [{ id: 'turn-1', status: 'failed', error: { message: 'Remote failure' }, items: [] }] } } });
  });
  await bridge.connect(); const old = processes[0]; old.emit('exit', 255); await bridge.connect();
  assert.equal(bridge.state.status, 'failed'); assert.equal(bridge.state.error, 'Remote failure');
  old.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'stale', status: 'inProgress' } } }); await tick();
  assert.equal(bridge.state.turnId, null); assert.equal(bridge.state.status, 'failed');
});

test('optional AI networking is loopback-only and never places its ephemeral credential in SSH arguments', async t => {
  const credential = 'http://tinylens:one-time-test-secret@127.0.0.1:51984';
  const captured = { args: null, firstLine: null, factory: 0, closes: 0 };
  const { bridge } = await fixture(t, baseHandler, {
    aiNetwork: true,
    networkProxyFactory: async options => {
      captured.factory += 1;
      assert.deepEqual(options, { upstreamHost: '127.0.0.1', upstreamPort: 7897 });
      return { port: 53555, proxyUrlForRemote: port => { assert.equal(port, 51984); return credential; }, close: async () => { captured.closes += 1; } };
    },
    spawnProcess: (command, args) => {
      assert.equal(command, 'ssh'); captured.args = args;
      const proc = fakeProcess(baseHandler);
      const protocolInput = proc.stdin;
      proc.stdin = new Writable({ write(chunk, encoding, done) {
        if (captured.firstLine === null) { captured.firstLine = chunk.toString(); done(); }
        else protocolInput.write(chunk, encoding, done);
      } });
      return proc;
    }
  });
  await bridge.connect();
  assert.equal(captured.factory, 1);
  assert.equal(captured.firstLine, credential + '\n');
  assert.ok(captured.args.includes('127.0.0.1:51984:127.0.0.1:53555'));
  assert.ok(captured.args.includes('ExitOnForwardFailure=yes'));
  assert.ok(!captured.args.join(' ').includes('one-time-test-secret'));
  assert.match(captured.args.at(-1), /IFS= read -r TINYLENS_AI_PROXY/);
  assert.equal(bridge.state.messages.length, 0);
  await bridge.close();
  assert.ok(captured.closes >= 1);
});

test('ordinary messages never become config overrides or implicit skill calls', async t => {
  const { bridge, processes } = await fixture(t, (message, proc) => {
    baseHandler(message, proc);
    if (message.method === 'turn/start' || message.method === 'turn/steer') proc.emitMessage({ id: message.id, result: message.method === 'turn/start' ? { turn: { id: 'text-turn', status: 'inProgress' } } : { turnId: 'text-turn' } });
  });
  await bridge.connect();
  for (const key of ['developerInstructions', 'baseInstructions', 'config', 'model', 'modelProvider', 'effort', 'sandboxPolicy', 'approvalPolicy', 'collaborationMode', 'input', 'tools', 'skill', 'cwd']) {
    await assert.rejects(bridge.submitMessage({ text: 'Visible user text', [key]: 'not permitted' }), /only accept text/);
  }
  assert.equal(processes[0].sent.some(message => message.method === 'turn/start'), false);
  assert.equal(bridge.state.messages.length, 0);
  const firstText = '  \n请用中文回答；这是一条普通对话。\r\n  保留空格和换行。\t  ';
  await bridge.submitMessage({ text: firstText });
  await bridge.submitMessage({ text: '继续解释这个参数。', stage: 'm0' });
  const messages = processes[0].sent.filter(message => ['turn/start', 'turn/steer'].includes(message.method));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].params.input, [{ type: 'text', text: firstText }]);
  assert.deepEqual(messages[1].params.input.map(item => item.type), ['text']);
  assert.equal(messages[1].params.input[0].text, '继续解释这个参数。');
  assert.deepEqual(bridge.state.messages.map(message => message.text), [firstText, '继续解释这个参数。']);
  for (const message of messages) assert.deepEqual(Object.keys(message.params).sort(), (message.method === 'turn/start'
    ? ['threadId', 'input', 'clientUserMessageId'] : ['threadId', 'input', 'clientUserMessageId', 'expectedTurnId']).sort());
});

test('position constraints travel verbatim as ordinary user text, never as scientific configuration or a file command', async t => {
  const { bridge, processes } = await fixture(t, (message, proc) => {
    baseHandler(message, proc);
    if (message.method === 'turn/start') proc.emitMessage({ id: message.id, result: { turn: { id: 'position-text-turn', status: 'inProgress' } } });
  });
  await bridge.connect();
  const text = '请核对这组用户位置约束。\n' + JSON.stringify({ schema: 'tinylens.position-likelihood-user-input.v1', target: '/test/lens', synthetic: false, coordinate_system: { unit: 'arcsec', origin: 'geometric_image_center', x_axis: 'column', y_axis: 'row', x_direction: 'increasing', y_direction: 'increasing' }, position_likelihood: { positions: [[1.2, -0.7], [-1.1, 0.6]], threshold_arcsec: 0.03, min_log_like: -500 } });
  assert.equal(processes[0].sent.some(message => message.method === 'turn/start'), false);
  await bridge.submitMessage({ stage: 'preflight', text });
  const sent = processes[0].sent.find(message => message.method === 'turn/start');
  assert.deepEqual(sent.params.input, [{ type: 'text', text }]);
  assert.deepEqual(Object.keys(sent.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.equal(bridge.state.messages[0].delivery, 'delivered');
  assert.deepEqual(bridge.state.updates, []);
});

test('HTTP connect/reply ignore extra configuration instead of forwarding it; message rejects it', async t => {
  const { bridge, processes } = await fixture(t);
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const base = `http://127.0.0.1:${bridge.server.address().port}/api/agent/`;
  const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const extra = { developerInstructions: 'Browser override', baseInstructions: 'Browser base', config: { developer_instructions: 'hidden override' }, model: 'browser-model', cwd: '/browser-path' };
  const connect = await post('connect', extra); assert.equal(connect.status, 200); await connect.json();
  const proc = processes[0]; const start = proc.sent.find(message => message.method === 'thread/start');
  for (const key of ['developerInstructions', 'baseInstructions', 'config', 'model']) assert.equal(key in start.params, false);
  assert.notEqual(start.params.cwd, extra.cwd);
  const rejected = await post('message', { text: 'No config change', ...extra }); assert.equal(rejected.status, 400); await rejected.json();
  assert.equal(proc.sent.some(message => message.method === 'turn/start'), false);
  proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
  proc.emitMessage(approval()); await tick();
  const badReply = await post('reply', { requestId: 51, result: { decision: 'accept', config: extra.config } });
  assert.equal(badReply.status, 400); await badReply.json(); assert.equal(proc.sent.some(message => message.id === 51), false);
  const reply = await post('reply', { requestId: 51, result: { decision: 'decline' }, ...extra });
  assert.equal(reply.status, 200); await reply.json();
  assert.deepEqual(proc.sent.find(message => message.id === 51), { id: 51, result: { decision: 'decline' } });
  assert.equal(proc.sent.some(message => /^(config\/|thread\/settings\/|turn\/settings\/)/.test(message.method || '')), false);
});

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Local approval protocol fixture did not settle');
}
const childApproval = (id = 201, threadId = 'child-1', turnId = 'child-turn') => ({
  id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'child-command', command: 'exact-runner', availableDecisions: ['accept', 'decline', 'cancel'] },
});
function childHandler({ parent = 'thread-1', latest = { id: 'child-turn', status: 'inProgress' }, childStatus = 'active', intercept } = {}) {
  const metadata = new Map([['child-1', { id: 'child-1', parentThreadId: parent, status: { type: childStatus } }],
    ['parent-child', { id: 'parent-child', parentThreadId: 'thread-1', status: { type: 'active' } }]]);
  const turns = new Map([['child-1', latest]]);
  const handler = (message, proc) => {
    if (intercept?.(message, proc)) return;
    baseHandler(message, proc);
    if (message.method === 'thread/read') proc.emitMessage({ id: message.id, result: { thread: metadata.get(message.params.threadId) || { id: message.params.threadId, parentThreadId: null, status: { type: 'idle' } } } });
    if (message.method === 'thread/turns/list') proc.emitMessage({ id: message.id, result: { data: [turns.get(message.params.threadId)], nextCursor: null } });
  };
  return { handler, metadata, turns };
}
function startRoot(proc) { proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } }); }

test('verified direct and nested child approvals reach UI and require one-time explicit replies', async t => {
  for (const parent of ['thread-1', 'parent-child']) {
    const protocol = childHandler({ parent });
    const { bridge, processes } = await fixture(t, protocol.handler);
    await bridge.connect(); const proc = processes[0]; startRoot(proc); proc.emitMessage(childApproval());
    await waitFor(() => bridge.state.requests.length === 1);
    assert.equal(bridge.state.status, 'waiting');
    assert.deepEqual(bridge.state.requests[0].scope, { rootThreadId: 'thread-1', rootTurnId: 'turn-1', threadId: 'child-1', turnId: 'child-turn' });
    assert.equal(proc.sent.some(message => message.id === 201), false);
    await assert.rejects(bridge.submitMessage({ text: 'Cannot bypass the native request.' }), /pending AI request/);
    proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'unrelated', requestId: 201 } }); await tick();
    assert.equal(bridge.state.requests.length, 1);
    const readsBefore = proc.sent.filter(message => message.method === 'thread/read').length;
    await bridge.reply({ requestId: 201, result: { decision: 'accept' } });
    assert.equal(proc.sent.filter(message => message.method === 'thread/read').length, readsBefore * 2);
    assert.equal(proc.sent.filter(message => message.method === 'thread/turns/list').length, 2);
    assert.deepEqual(proc.sent.find(message => message.id === 201), { id: 201, result: { decision: 'accept' } });
    assert.equal(proc.sent.some(message => /^(config\/|thread\/settings\/|turn\/settings\/)/.test(message.method || '')), false);
    await assert.rejects(bridge.reply({ requestId: 201, result: { decision: 'accept' } }), /no longer/);
    proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'unrelated', requestId: 201 } }); await tick();
    assert.equal(bridge.state.requests.length, 1);
    proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'child-1', requestId: 201 } }); await tick();
    assert.equal(bridge.state.requests.length, 0); assert.equal(bridge.state.status, 'running');
    assert.equal(bridge.state.turnId, 'turn-1');
  }
});

test('unknown ancestry, inactive children and stale child turns fail closed without exposing command data in diagnostics', async t => {
  const cases = [
    { parent: 'unrelated' }, { parent: 'child-1' }, { childStatus: 'idle' },
    { latest: { id: 'old-turn', status: 'inProgress' } }, { latest: { id: 'child-turn', status: 'completed' } },
  ];
  for (const options of cases) {
    const logs = [];
    const protocol = childHandler(options);
    const { bridge, processes } = await fixture(t, protocol.handler, { logger: { error: (...args) => logs.push(args) } });
    await bridge.connect(); const proc = processes[0]; startRoot(proc);
    const request = childApproval(); request.params.command = 'credential-must-not-be-logged'; request.params.reason = 'private-prompt';
    proc.emitMessage(request); await waitFor(() => proc.sent.some(message => message.id === 201));
    assert.equal(proc.sent.find(message => message.id === 201).error.code, -32602);
    assert.deepEqual(bridge.state.requests, []); assert.equal(bridge.state.turnId, 'turn-1');
    assert.equal(logs.some(args => args[1]?.event === 'rejected'), true);
    assert.doesNotMatch(JSON.stringify(logs), /credential-must-not-be-logged|private-prompt/);
  }
});

test('child approval ancestry proof cannot be supplied by the requesting thread or persisted UI state', () => {
  const state = live(); const request = childApproval();
  request.params.scope = { rootThreadId: 'thread-1', rootTurnId: 'turn-1', threadId: 'child-1', turnId: 'child-turn' };
  assert.throws(() => receiveRequest(state, request), /verified active/);
  assert.equal(initialState({ ...state, requests: [{ ...request, scope: request.params.scope }] }).requests.length, 0);
  assert.throws(() => receiveReport(state, { ...report(), threadId: 'child-1', turnId: 'child-turn', scope: request.params.scope }));
});

test('child reply freshly rejects changed ancestry or changed active turn without sending an approval', async t => {
  for (const mutation of ['ancestry', 'turn']) {
    const protocol = childHandler(); const { bridge, processes } = await fixture(t, protocol.handler);
    await bridge.connect(); const proc = processes[0]; startRoot(proc); proc.emitMessage(childApproval());
    await waitFor(() => bridge.state.requests.length === 1);
    if (mutation === 'ancestry') protocol.metadata.get('child-1').parentThreadId = 'other-root';
    else protocol.turns.set('child-1', { id: 'new-child-turn', status: 'inProgress' });
    await assert.rejects(bridge.reply({ requestId: 201, result: { decision: 'accept' } }));
    assert.equal(proc.sent.some(message => message.id === 201), false);
    assert.equal(bridge.state.requests[0].responded, undefined);
  }
});

test('child and root lifecycle events remove only their pending approval scopes', async t => {
  for (const terminalEvent of [
    { method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } } },
    { method: 'thread/status/changed', params: { threadId: 'child-1', status: { type: 'idle' } } },
    { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
  ]) {
    const { bridge, processes } = await fixture(t, childHandler().handler);
    await bridge.connect(); const proc = processes[0]; startRoot(proc); proc.emitMessage(childApproval());
    await waitFor(() => bridge.state.requests.length === 1);
    proc.emitMessage({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'another-turn', status: 'completed' } } }); await tick();
    assert.equal(bridge.state.requests.length, 1);
    proc.emitMessage(terminalEvent); await tick(); assert.deepEqual(bridge.state.requests, []);
    await assert.rejects(bridge.reply({ requestId: 201, result: { decision: 'accept' } }), /no longer/);
    assert.equal(proc.sent.some(message => message.id === 201), false);
    if (terminalEvent.params.threadId !== 'thread-1') { assert.equal(bridge.state.turnId, 'turn-1'); assert.equal(bridge.state.status, 'running'); }
  }
});

test('a root or child turn ending during asynchronous proof cannot resurrect a pending approval', async t => {
  for (const owner of ['root', 'child', 'resolved', 'inactive']) {
    let held;
    const protocol = childHandler({ intercept: (message, proc) => {
      if (message.method === 'thread/turns/list') { held = { message, proc }; return true; }
    } });
    const { bridge, processes } = await fixture(t, protocol.handler);
    await bridge.connect(); const proc = processes[0]; startRoot(proc); proc.emitMessage(childApproval());
    await waitFor(() => held);
    if (owner === 'inactive') proc.emitMessage({ method: 'thread/status/changed', params: { threadId: 'child-1', status: { type: 'idle' } } });
    else if (owner === 'resolved') proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'child-1', requestId: 201 } });
    else proc.emitMessage({ method: 'turn/completed', params: { threadId: owner === 'root' ? 'thread-1' : 'child-1', turn: { id: owner === 'root' ? 'turn-1' : 'child-turn', status: 'completed' } } });
    held.proc.emitMessage({ id: held.message.id, result: { data: [{ id: 'child-turn', status: 'inProgress' }], nextCursor: null } });
    await waitFor(() => proc.sent.some(message => message.id === 201));
    assert.equal(proc.sent.find(message => message.id === 201).error.code, -32602); assert.deepEqual(bridge.state.requests, []);
  }
});

test('concurrent child reply attempts verify once and send only one decision', async t => {
  let holdReads = false, held;
  const protocol = childHandler({ intercept: (message, proc) => {
    if (holdReads && message.method === 'thread/read') { held = { message, proc }; return true; }
  } });
  const { bridge, processes } = await fixture(t, protocol.handler);
  await bridge.connect(); const proc = processes[0]; startRoot(proc); proc.emitMessage(childApproval());
  await waitFor(() => bridge.state.requests.length === 1); holdReads = true;
  const first = bridge.reply({ requestId: 201, result: { decision: 'accept' } });
  await waitFor(() => held);
  await assert.rejects(bridge.reply({ requestId: 201, result: { decision: 'accept' } }), /no longer/);
  holdReads = false;
  held.proc.emitMessage({ id: held.message.id, result: { thread: protocol.metadata.get('child-1') } });
  await first;
  assert.equal(proc.sent.filter(message => message.id === 201).length, 1);
});


test('one request id cannot replace the command that was displayed for approval', () => {
  const state = live(); const original = approval(); original.params.command = 'command-that-was-reviewed';
  receiveRequest(state, original);
  const replacement = structuredClone(original); replacement.params.command = 'different-command';
  assert.throws(() => receiveRequest(state, replacement), /Conflicting/);
  assert.equal(state.requests[0].params.command, 'command-that-was-reviewed');
});


test('unsupported permission methods remain rejected and are identifiable without logging their payload', async t => {
  const logs = [];
  const { bridge, processes } = await fixture(t, baseHandler, { logger: { error: (...args) => logs.push(args) } });
  await bridge.connect(); const proc = processes[0]; startRoot(proc);
  proc.emitMessage({ id: 250, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', secret: 'payload-must-stay-private' } });
  await waitFor(() => proc.sent.some(message => message.id === 250));
  assert.equal(proc.sent.find(message => message.id === 250).error.code, -32602);
  assert.equal(logs.some(args => args[1]?.method === 'item/permissions/requestApproval' && args[1]?.code === 'unsupported_method'), true);
  assert.doesNotMatch(JSON.stringify(logs), /payload-must-stay-private/);
  assert.deepEqual(bridge.state.requests, []);
});
