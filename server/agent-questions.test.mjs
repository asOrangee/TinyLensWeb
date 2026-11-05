import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, applyTurn, receiveReport, receiveNotification, restoreThread } from './agent-state.mjs';
import { parseQuestionReport, prepareQuestionAnswer } from './agent-questions.mjs';
import { createAgentServer } from './agent-server.mjs';
const envelope = (patch = {}) => ({ tinylens_ui_question: 1, id: 'input-decision', question: 'Which input treatment do you choose?', context: 'The AI is waiting for a user decision.', options: [{ id: 'first', label: 'First option', description: 'Description supplied by AI' }, { id: 'second', label: 'Second option' }], ...patch });
const questionReport = (patch = {}, outer = {}) => ({ kind: 'note', status: 'awaiting_user', title: 'Input decision', stage: 'preparation', message: JSON.stringify(envelope(patch)), ...outer });
const params = (patch = {}, outer = {}) => ({ threadId: 'thread-1', turnId: 'turn-1', callId: 'question-call', tool: 'tinylens_ui_report', arguments: questionReport(patch, outer) });
function questionState() {
  const state = initialState({ threadId: 'thread-1' }); applyTurn(state, { id: 'turn-1', status: 'inProgress' }); receiveReport(state, params()); return state;
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Local protocol fixture did not settle');
}
function fakeProcess(handler) {
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.sent = []; proc.killed = false;
  proc.emitMessage = message => proc.stdout.write(JSON.stringify(message) + '\n');
  proc.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); proc.sent.push(message); done(); queueMicrotask(() => handler(message, proc));
  } });
  proc.kill = () => { if (proc.killed) return; proc.killed = true; proc.emit('exit', 0); proc.stdout.end(); proc.stderr.end(); };
  return proc;
}
async function fixture(t, handler = () => false, saved) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'tinylens-questions-test-'));
  if (saved) await writeFile(join(stateDirectory, 'agent-state.json'), JSON.stringify(saved));
  const processes = [];
  const bridge = await createAgentServer({ stateDirectory, rpcTimeoutMs: 35, logger: { error() {} }, spawnProcess: () => {
    const proc = fakeProcess((message, child) => {
      if (handler(message, child)) return;
      if (message.method === 'initialize') child.emitMessage({ id: message.id, result: {} });
      if (message.method === 'thread/start' || message.method === 'thread/resume') child.emitMessage({ id: message.id, result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] }, initialTurnsPage: { data: [] } } });
    }); processes.push(proc); return proc;
  } });
  t.after(async () => { await bridge.close(); await rm(stateDirectory, { recursive: true, force: true }); });
  return { bridge, processes, stateDirectory };
}
async function publishQuestion(bridge, proc) {
  proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
  proc.emitMessage({ id: 901, method: 'item/tool/call', params: params() });
  await waitFor(() => proc.sent.some(message => message.id === 901));
  proc.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(bridge.state.questions[0].status, 'pending');
}

test('only the explicit versioned report creates a question; malformed envelopes fail strictly', () => {
  assert.equal(parseQuestionReport({ kind: 'note', message: 'Which option do you prefer?' }), null);
  assert.equal(parseQuestionReport({ kind: 'note', status: 'awaiting_user', message: 'Which option do you prefer?' }), null);
  assert.equal(parseQuestionReport({ kind: 'note', status: 'awaiting_user', message: '{"question":"ordinary JSON report"}' }), null);
  assert.throws(() => parseQuestionReport({ kind: 'note', status: 'checking', message: JSON.stringify(envelope()) }), /status awaiting_user/);
  for (const report of [questionReport({}, { message: '{"tinylens_ui_question":' }), questionReport({ tinylens_ui_question: '1' }), questionReport({ tinylens_ui_question: 2 }), questionReport({ extra: true }), questionReport({ options: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }), questionReport({ options: [{ id: 'one', label: 'A', selected: true }] }), questionReport({ options: null }), questionReport({ question: ' ' })]) assert.throws(() => parseQuestionReport(report));
  const parsed = parseQuestionReport(questionReport({ options: [] })); assert.deepEqual(parsed.options, []);
  assert.equal(parseQuestionReport(questionReport({ context: '', options: [{ id: 'one', label: 'Choice', description: '' }] })).context, '');
  const state = initialState({ threadId: 'thread-1' }); applyTurn(state, { id: 'turn-1', status: 'inProgress' });
  receiveReport(state, params({}, { message: 'A normal note while awaiting the user.' }));
  assert.equal(state.questions.length, 0); assert.equal(state.updates[0].message, 'A normal note while awaiting the user.');
});

test('questions are durable display state, never RPC approvals or raw JSON updates', () => {
  const state = questionState();
  assert.equal(state.questions.length, 1); assert.deepEqual(state.requests, []); assert.deepEqual(state.updates, []);
  const question = state.questions[0]; assert.equal(question.sourceCallId, 'question-call'); assert.equal(question.stage, 'preparation');
  receiveNotification(state, 'turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(question.status, 'pending');
  const restored = initialState(state); restoreThread(restored, { id: 'thread-1', status: { type: 'idle' } });
  assert.deepEqual(restored.questions, state.questions);
  assert.equal(restored.requests.length, 0);
});

test('stable ids deduplicate without replacing an answered question; changed content requires a new id', () => {
  const state = questionState(); const question = state.questions[0];
  question.status = 'answered'; question.answer = { optionId: 'first' };
  assert.equal(receiveReport(state, { ...params(), callId: 'a-new-call' }), false);
  assert.equal(state.questions.length, 1); assert.equal(state.questions[0], question); assert.equal(question.status, 'answered');
  for (const payload of [params({ question: 'Different wording' }), params({ options: [{ id: 'third', label: 'Different' }] }), params({}, { title: 'New title' })]) assert.throws(() => receiveReport(state, payload), /different content/);
  assert.deepEqual(question.answer, { optionId: 'first' });
});

test('answers require an explicit valid choice or text and preserve exact user wording', () => {
  const state = questionState();
  for (const data of [{ questionId: 'input-decision' }, { questionId: 'input-decision', text: ' ' }, { questionId: 'input-decision', optionId: 'not-offered' }, { questionId: 'input-decision', optionId: 'first', approveAll: true }]) assert.throws(() => prepareQuestionAnswer(state, data));
  const result = prepareQuestionAnswer(state, { questionId: 'input-decision', optionId: 'second', text: '  我的附加意见\n请保留原始数据。  ' });
  const payload = JSON.parse(result.message.slice(result.message.indexOf('\n') + 1));
  assert.equal(payload.selectedOption.id, 'second'); assert.equal(payload.question, state.questions[0].question);
  assert.equal(payload.userText, '  我的附加意见\n请保留原始数据。  '); assert.equal(payload.sourceThreadId, 'thread-1');
  state.threadId = 'other'; assert.throws(() => prepareQuestionAnswer(state, { questionId: 'input-decision', text: 'answer' }), /connected thread/);
});

test('restart resolves a recorded acknowledged answer and conservatively locks an in-flight answer', () => {
  const state = questionState(); const question = state.questions[0]; question.status = 'sending'; question.answerMessageId = 'answer-message'; question.answer = { text: 'Explicit answer' };
  assert.equal(initialState(state).questions[0].status, 'delivery_unknown');
  state.messages.push({ id: 'answer-message', role: 'user', text: 'Answer', delivery: 'delivered' });
  assert.equal(initialState(state).questions[0].status, 'answered');
  state.messages[0].delivery = 'rejected'; assert.equal(initialState(state).questions[0].status, 'pending');
});

test('question acknowledgement only confirms display; one answer dispatches once on the same thread', async t => {
  let held;
  const { bridge, processes, stateDirectory } = await fixture(t, (message, proc) => {
    if (message.method === 'turn/start') { held = { message, proc }; return true; }
  });
  await bridge.connect(); const proc = processes[0]; await publishQuestion(bridge, proc);
  const acknowledgement = proc.sent.find(message => message.id === 901).result;
  assert.equal(acknowledgement.success, true); assert.match(acknowledgement.contentItems[0].text, /not a user answer or approval/);
  assert.equal(proc.sent.filter(message => message.method === 'turn/start').length, 0);
  const sent = bridge.answerQuestion({ questionId: 'input-decision', optionId: 'first', text: 'My explicit comment.' });
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', optionId: 'second' }), /already answered or being submitted/);
  await waitFor(() => held);
  assert.equal(held.message.params.threadId, 'thread-1');
  assert.match(held.message.params.input[0].text, /My explicit comment/);
  held.proc.emitMessage({ id: held.message.id, result: { turn: { id: 'answer-turn', status: 'inProgress' } } });
  await sent;
  assert.equal(bridge.state.questions[0].status, 'answered');
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', text: 'Again' }), /already answered/);
  assert.equal(proc.sent.filter(message => message.method === 'turn/start').length, 1);
  const stored = JSON.parse(await readFile(join(stateDirectory, 'agent-state.json'), 'utf8'));
  assert.equal(stored.questions[0].status, 'answered'); assert.equal(stored.messages.at(-1).questionId, 'input-decision');
});

test('known RPC rejection permits an explicit retry, while an unknown delivery never resends', async t => {
  let attempt = 0;
  const { bridge, processes } = await fixture(t, (message, proc) => {
    if (message.method !== 'turn/start') return false;
    attempt += 1;
    if (attempt === 1) proc.emitMessage({ id: message.id, error: { message: 'This turn was rejected before execution' } });
    return true;
  });
  await bridge.connect(); await publishQuestion(bridge, processes[0]);
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', text: 'User answer' }), /rejected before execution/);
  assert.equal(bridge.state.questions[0].status, 'pending');
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', text: 'User answer' }), /delivery is unconfirmed/);
  assert.equal(bridge.state.questions[0].status, 'delivery_unknown');
  await bridge.connect();
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', text: 'Do not duplicate' }), /delivery is unknown/);
  assert.equal(attempt, 2); assert.equal(initialState(bridge.state).questions[0].status, 'delivery_unknown');
});

test('active-turn answers use steer, and pending native approvals cannot be bypassed', async t => {
  const { bridge, processes } = await fixture(t, (message, proc) => {
    if (message.method === 'turn/steer') { proc.emitMessage({ id: message.id, result: { turnId: 'turn-1' } }); return true; }
  });
  await bridge.connect(); const proc = processes[0];
  proc.emitMessage({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
  proc.emitMessage({ id: 901, method: 'item/tool/call', params: params() }); await waitFor(() => proc.sent.some(message => message.id === 901));
  proc.emitMessage({ id: 902, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command' } });
  await assert.rejects(bridge.answerQuestion({ questionId: 'input-decision', optionId: 'first' }), /pending AI request/);
  assert.equal(bridge.state.questions[0].status, 'pending'); assert.equal(proc.sent.some(message => message.id === 902), false);
  proc.emitMessage({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 902 } });
  await bridge.answerQuestion({ questionId: 'input-decision', optionId: 'first' });
  const steer = proc.sent.find(message => message.method === 'turn/steer'); assert.equal(steer.params.expectedTurnId, 'turn-1');
  assert.equal(steer.params.threadId, 'thread-1'); assert.equal(proc.sent.some(message => message.method === 'turn/start'), false);
});

test('start and resume never inject instruction or configuration overrides or start a turn', async t => {
  const { bridge, processes } = await fixture(t); await bridge.connect();
  const start = processes[0].sent.find(message => message.method === 'thread/start');
  for (const key of ['developerInstructions', 'baseInstructions', 'config', 'collaborationMode', 'model', 'effort']) assert.equal(key in start.params, false);
  assert.match(start.params.dynamicTools[0].description, /tinylens_ui_question/);
  assert.deepEqual(start.params.dynamicTools[0].inputSchema.properties.kind.enum, ['stage', 'artifact', 'note']);
  processes[0].emit('exit', 255); await bridge.connect();
  const resume = processes[1].sent.find(message => message.method === 'thread/resume');
  for (const key of ['developerInstructions', 'baseInstructions', 'config', 'collaborationMode', 'model', 'effort']) assert.equal(key in resume.params, false);
  assert.equal('dynamicTools' in resume.params, false);
  for (const proc of processes) assert.equal(proc.sent.some(message => ['turn/start', 'turn/steer', 'config/value/write', 'config/batchWrite', 'thread/settings/update', 'turn/settings/update'].includes(message.method)), false);
});

test('POST answer validates and returns durable question state through the real HTTP route with a fake AI', async t => {
  const { bridge, processes } = await fixture(t, (message, proc) => {
    if (message.method === 'turn/start') { proc.emitMessage({ id: message.id, result: { turn: { id: 'fixture-answer-turn', status: 'inProgress' } } }); return true; }
  });
  await bridge.connect(); await publishQuestion(bridge, processes[0]);
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const url = `http://127.0.0.1:${bridge.server.address().port}/api/agent/answer`;
  const post = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const invalid = await post({ questionId: 'input-decision' }); assert.equal(invalid.status, 400); await invalid.json();
  assert.equal(processes[0].sent.some(message => message.method === 'turn/start'), false);
  const response = await post({ questionId: 'input-decision', text: 'Local fixture answer only.' });
  assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.questions[0].status, 'answered');
  assert.equal(state.questions[0].answer.text, 'Local fixture answer only.');
  assert.equal(processes[0].sent.filter(message => message.method === 'turn/start').length, 1);
});

test('a translated replacement atomically supersedes its pending source without inheriting drafts or answers', () => {
  const state = questionState(), old = state.questions[0];
  old.answer = { optionId: 'first', text: 'An earlier unsent draft' }; old.error = 'Earlier send rejected';
  const original = structuredClone(old);
  receiveReport(state, { ...params({ id: 'input-decision-zh', supersedesQuestionId: 'input-decision', question: '请在网页中选择输入处理方式。' }, { title: '输入处理确认' }), callId: 'translated-call' });
  const translated = state.questions[1];
  assert.equal(old.status, 'superseded'); assert.equal(old.supersededByQuestionId, translated.id);
  assert.equal(old.question, original.question); assert.deepEqual(old.options, original.options); assert.deepEqual(old.answer, original.answer);
  assert.equal(translated.status, 'pending'); assert.equal(translated.supersedesQuestionId, old.id);
  assert.equal(translated.title, '输入处理确认'); assert.equal(translated.question, '请在网页中选择输入处理方式。');
  assert.equal(translated.sourceCallId, 'translated-call');
  assert.equal('answer' in translated, false); assert.equal('error' in translated, false);
  assert.throws(() => prepareQuestionAnswer(state, { questionId: old.id, optionId: 'first' }), /superseded/);
  assert.throws(() => prepareQuestionAnswer(state, { questionId: translated.id }), /explicitly/);
});

test('invalid supersession never partially changes either question', () => {
  for (const status of ['answered', 'sending', 'delivery_unknown', 'superseded']) {
    const state = questionState(); state.questions[0].status = status; const before = structuredClone(state);
    assert.throws(() => receiveReport(state, params({ id: 'new-id', supersedesQuestionId: 'input-decision' })), /pending question/);
    assert.deepEqual(state, before);
  }
  for (const target of ['missing', 'foreign']) {
    const state = questionState();
    if (target === 'foreign') state.questions.push({ ...structuredClone(state.questions[0]), id: 'foreign', threadId: 'other-thread' });
    const before = structuredClone(state);
    assert.throws(() => receiveReport(state, params({ id: 'new-id', supersedesQuestionId: target })), /does not exist in this thread/);
    assert.deepEqual(state, before);
  }
  for (const target of ['input-decision', '', null, 123]) {
    const state = questionState(), before = structuredClone(state);
    assert.throws(() => receiveReport(state, params({ supersedesQuestionId: target })), /Invalid structured question/);
    assert.deepEqual(state, before);
  }
});

test('replayed supersession remains idempotent after an answer, and cannot reopen the original', () => {
  const state = questionState();
  const replacement = params({ id: 'new-id', supersedesQuestionId: 'input-decision', question: '中文问题' });
  assert.equal(receiveReport(state, replacement), true);
  state.questions[1].status = 'answered'; state.questions[1].answer = { text: '用户明确回答' };
  const before = structuredClone(state);
  assert.equal(receiveReport(state, { ...replacement, callId: 'replay-call' }), false);
  assert.equal(receiveReport(state, params()), false);
  assert.deepEqual(state, before);
  assert.throws(() => receiveReport(state, params({ id: 'new-id', question: '中文问题' })), /different content/);
  assert.throws(() => receiveReport(state, params({ id: 'third-id', supersedesQuestionId: 'input-decision' })), /pending question/);
  assert.deepEqual(state, before);
});

test('superseded history and replacement links survive restart without turning into consent', () => {
  const state = questionState();
  receiveReport(state, params({ id: 'new-id', supersedesQuestionId: 'input-decision', question: '中文问题' }));
  const restored = initialState(state);
  assert.deepEqual(restored.questions, state.questions);
  assert.equal(restored.questions[0].status, 'superseded'); assert.equal(restored.questions[1].status, 'pending');
  assert.throws(() => prepareQuestionAnswer(restored, { questionId: 'input-decision', text: 'Old answer' }), /superseded/);
  assert.equal(prepareQuestionAnswer(restored, { questionId: 'new-id', text: '新的明确回答' }).answer.text, '新的明确回答');
  assert.deepEqual(restored.requests, []); assert.deepEqual(restored.updates, []);
});
