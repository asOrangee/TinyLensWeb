import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_AGENT_STATE, parseAgentState, type AgentState, type AgentUpdate, type AgentQuestion, type AgentRequest } from '../src/lib/agent-types.ts';
import { reportedStageIndicator, stageIndicators, serverLinkConnected } from '../src/lib/workbench-status.ts';

const state = (change: Partial<AgentState> = {}): AgentState => ({ ...EMPTY_AGENT_STATE, threadId: 'root', ...change });
const report = (stage: string, status: string, turnId = 'turn'): AgentUpdate => ({ kind: 'stage', stage, status, turnId });
const question = (change: Partial<AgentQuestion> = {}): AgentQuestion => ({ id: 'q', threadId: 'root', turnId: 'turn', sourceCallId: 'call', stage: 'm3', title: 'Choice', question: 'Choose', options: [], status: 'pending', ...change });
const request = (change: Partial<AgentRequest> = {}): AgentRequest => ({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'root', turnId: 'turn' }, ...change });

test('stage completion uses only explicit stage reports; artifacts and ended AI turns do not complete stages', () => {
  const current = state({ status: 'completed', updates: [
    { kind: 'artifact', stage: 'a', status: 'accepted', path: '/output/result.png' },
    { kind: 'note', stage: 'b', status: 'completed', message: 'Accepted Stage B' },
    report('m0', 'success'), report('m1', 'prepared'), report('m2', 'accepted'),
  ] });
  const indicators = stageIndicators(current);
  for (const id of ['preflight', 'a', 'b', 'm0', 'm1', 'm3'] as const) assert.equal(indicators.get(id)?.state, 'pending');
  assert.equal(indicators.get('m2')?.state, 'completed');
});

test('the five indicators distinguish active, blocked, failed and neutral unknown reports', () => {
  for (const status of ['accepted', 'complete', 'completed']) assert.equal(reportedStageIndicator(status), 'completed');
  for (const status of ['running', 'preparing', 'reviewing', 'retrying']) assert.equal(reportedStageIndicator(status), 'running');
  for (const status of ['blocked', 'preparation_blocked', 'awaiting_user', 'human_review', 'awaiting_approval', 'queued', 'paused', 'interrupted']) assert.equal(reportedStageIndicator(status), 'blocked');
  for (const status of ['failed', 'error', 'rejected']) assert.equal(reportedStageIndicator(status), 'failed');
  for (const status of ['not_started', 'pending', 'prepared', 'success', 'retry', 'unexpected']) assert.equal(reportedStageIndicator(status), 'pending');
});

test('latest reports and stage aliases are used while old accepted results remain untouched', () => {
  const current = state({ updates: [report('p', 'completed'), report('Stage A', 'accepted', 'old'), report('a', 'preparing', 'new'), report('preparation', 'failed')] });
  const before = JSON.stringify(current);
  const indicators = stageIndicators(current);
  assert.equal(indicators.get('preflight')?.state, 'completed');
  assert.equal(indicators.get('a')?.state, 'running');
  assert.equal(indicators.get('m3')?.state, 'pending');
  assert.equal(JSON.stringify(current), before);
});

test('unresolved scoped questions mark their stage yellow, including unconfirmed delivery', () => {
  for (const status of ['pending', 'sending', 'delivery_unknown'] as const) {
    const indicators = stageIndicators(state({ updates: [report('m3', 'running')], questions: [question({ status })] }));
    assert.equal(indicators.get('m3')?.state, 'blocked');
    assert.equal(indicators.get('a')?.state, 'pending');
  }
  for (const q of [question({ status: 'answered' }), question({ status: 'superseded' }), question({ threadId: 'other' })]) {
    assert.equal(stageIndicators(state({ updates: [report('m3', 'running')], questions: [q] })).get('m3')?.state, 'running');
  }
});

test('native child approvals use only verified routing metadata and a unique active stage', () => {
  const child = request({ params: { threadId: 'child', turnId: 'child-turn', command: 'stage a accepted' },
    scope: { rootThreadId: 'root', rootTurnId: 'turn', threadId: 'child', turnId: 'child-turn' } });
  const current = state({ updates: [report('a', 'accepted'), report('m3', 'prepared')], requests: [child] });
  assert.equal(stageIndicators(parseAgentState(current)).get('m3')?.state, 'blocked');
  assert.equal(stageIndicators(current).get('a')?.state, 'completed');
  for (const invalid of [{ ...child, scope: undefined }, { ...child, scope: { ...child.scope!, rootThreadId: 'other' } }, { ...child, scope: { ...child.scope!, turnId: 'wrong' } }]) {
    assert.equal(stageIndicators({ ...current, requests: [invalid] }).get('m3')?.state, 'pending');
  }
});

test('ambiguous, old-turn and unscoped accepted-stage requests never guess the selected stage', () => {
  const two = state({ updates: [report('a', 'running'), report('m3', 'preparing')], requests: [request()] });
  assert.equal(stageIndicators(two).get('a')?.state, 'running');
  assert.equal(stageIndicators(two).get('m3')?.state, 'running');
  assert.equal(stageIndicators(state({ updates: [report('m3', 'running', 'new')], requests: [request()] })).get('m3')?.state, 'running');
  assert.equal(stageIndicators(state({ updates: [report('m3', 'accepted')], requests: [request()] })).get('m3')?.state, 'completed');
  assert.equal(stageIndicators(state({ updates: [report('m3', 'running')], requests: [request({ params: { threadId: 'root', turnId: 'turn', command: '--stage a' } })] })).get('a')?.state, 'pending');
  assert.equal(stageIndicators(state({ updates: [report('m3', 'running')], questions: [question({ stage: undefined })] })).get('m3')?.state, 'blocked');
});

test('scope parsing preserves display metadata without accepting malformed scope or changing approval params', () => {
  const params = { threadId: 'child', turnId: 'child-turn', command: 'original command', availableDecisions: ['accept', 'decline'] };
  const scope = { rootThreadId: 'root', rootTurnId: 'turn', threadId: 'child', turnId: 'child-turn' };
  const parsed = parseAgentState(state({ requests: [request({ params, scope })] }));
  assert.deepEqual(parsed.requests[0].scope, scope);
  assert.deepEqual(parsed.requests[0].params, params);
  assert.equal(parseAgentState(state({ requests: [request({ params, scope: { rootThreadId: 'root' } as typeof scope })] })).requests[0].scope, undefined);
});

test('green connection requires both the server transport and live event stream', () => {
  for (const connection of ['connected', 'connecting', 'disconnected', 'error'] as const) {
    for (const stream of ['open', 'connecting', 'retrying'] as const) assert.equal(serverLinkConnected(connection, stream), connection === 'connected' && stream === 'open');
  }
});
