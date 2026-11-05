import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_AGENT_STATE, parseAgentState, type AgentState, type AgentQuestion } from '../src/lib/agent-types.ts';
import { replyPending } from '../src/lib/workbench-status.ts';

const active = (change: Partial<AgentState> = {}): AgentState => ({ ...EMPTY_AGENT_STATE, connection: 'connected', threadId: 'root', turnId: 'turn', remoteActive: true, status: 'running', ...change });
const question = (change: Partial<AgentQuestion> = {}): AgentQuestion => ({ id: 'q', threadId: 'root', turnId: 'turn', sourceCallId: 'call', title: 'Choice', question: 'Choose', status: 'pending', options: [], ...change });

test('native active state survives parsing, while old and malformed values remain neutral', () => {
  assert.equal(parseAgentState(active()).remoteActive, true);
  for (const value of [false, undefined, 'true', 1]) assert.equal(parseAgentState({ ...active(), remoteActive: value }).remoteActive, false);
  assert.equal(replyPending(active({ turnId: null, remoteActive: true }), 'open'), true);
  assert.equal(replyPending(active({ turnId: null, remoteActive: false }), 'open'), false);
  assert.equal(replyPending(active({ remoteActive: false }), 'open'), false);
  for (const complete of [true, false, undefined, 'true']) {
    const parsed = parseAgentState(active({ messages: [{ id: 'm', role: 'assistant', text: '文字', complete: complete as boolean }] }));
    assert.equal(parsed.messages[0].complete, typeof complete === 'boolean' ? complete : undefined);
  }
});

test('dots follow the connected active turn and disappear on every terminal or human-waiting status', () => {
  assert.equal(replyPending(active(), 'open'), true);
  for (const status of ['idle', 'completed', 'failed', 'interrupted', 'waiting'] as const) assert.equal(replyPending(active({ status }), 'open'), false);
  for (const connection of ['disconnected', 'connecting', 'error'] as const) assert.equal(replyPending(active({ connection }), 'open'), false);
  for (const stream of ['connecting', 'retrying'] as const) assert.equal(replyPending(active(), stream), false);
});

test('blocking native requests and current-turn unanswered questions suppress the dots', () => {
  assert.equal(replyPending(active({ requests: [{ id: 1, method: 'item/commandExecution/requestApproval', params: {} }] }), 'open'), false);
  assert.equal(replyPending(active({ requests: [{ id: 1, method: 'item/tool/requestUserInput', params: { isBlocking: false } }] }), 'open'), true);
  for (const status of ['pending', 'sending', 'delivery_unknown'] as const) assert.equal(replyPending(active({ questions: [question({ status })] }), 'open'), false);
  for (const item of [question({ status: 'answered' }), question({ status: 'superseded' }), question({ turnId: 'old' }), question({ threadId: 'other' })]) assert.equal(replyPending(active({ questions: [item] }), 'open'), true);
});

test('a finished message or scientific stage does not end an active turn, and running science does not start a reply', () => {
  const ongoing = active({ messages: [{ id: 'answer', role: 'assistant', text: '完成。', complete: true }], updates: [{ kind: 'stage', stage: 'm2', status: 'accepted' }] });
  assert.equal(replyPending(ongoing, 'open'), true);
  const ended = active({ status: 'completed', turnId: null, remoteActive: false, updates: [{ kind: 'stage', stage: 'm3', status: 'running' }] });
  assert.equal(replyPending(ended, 'open'), false);
});

test('the pending bubble is replaced by the first actual reply text, rather than trailing a streaming message', () => {
  assert.equal(replyPending(active({ messages: [{ id: 'u', role: 'user', text: '问题' }] }), 'open'), true);
  assert.equal(replyPending(active({ messages: [{ id: 'a', role: 'assistant', text: '', complete: false }] }), 'open'), true);
  for (const complete of [false, undefined]) assert.equal(replyPending(active({ messages: [{ id: 'a', role: 'assistant', text: '正在输出文字', complete }] }), 'open'), false);
  const thought = { id: 'hidden', role: 'assistant' as const, text: 'hidden', phase: 'analysis', complete: false };
  const current = active({ messages: [{ id: 'u', role: 'user', text: '问题' }, thought] });
  assert.equal(replyPending(current, 'open', current.messages.filter(message => message.phase !== 'analysis')), true);
});
