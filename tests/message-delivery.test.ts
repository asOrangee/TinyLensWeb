import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_AGENT_STATE, parseAgentState } from '../src/lib/agent-types.ts';
import { postMessageSubmission, restoreMessageSubmissions, type MessageSubmission } from '../src/lib/message-delivery.ts';

const fixture: MessageSubmission = {
  clientMessageId: 'cafefeed-0000-0000-0000-000000000001', text: '确认提交这批',
  expectedThreadId: 'fixture-thread', expectedTurnId: null,
  seenBatchPlanId: 'batch-cafefeed-0000-0000-0000-000000000002',
};

test('a lost browser response preserves the same submission ID and original scope on retry after reload', async () => {
  const sent: MessageSubmission[] = [];
  const send: typeof fetch = async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    if (sent.length === 1) throw Error('Mock HTTP response lost after delivery');
    return Response.json({ messageReceipt: { id: fixture.clientMessageId, delivery: 'delivered' } });
  };
  assert.equal((await postMessageSubmission('/example', fixture, send)).delivery, 'unknown');
  const fromStorage = restoreMessageSubmissions(JSON.stringify([fixture])).get(fixture.text)!;
  assert.equal((await postMessageSubmission('/example', fromStorage, send)).delivery, 'delivered');
  assert.deepEqual(sent, [fixture, fixture]);
});

test('only a matching receipt can confirm or definitively reject a submission', async () => {
  const response = (id: string, delivery: string, status: number) => async () => Response.json({
    error: 'Mock response', messageReceipt: { id, delivery },
  }, { status });
  assert.equal((await postMessageSubmission('/example', fixture, response('other', 'delivered', 200))).delivery, 'unknown');
  assert.equal((await postMessageSubmission('/example', fixture, response(fixture.clientMessageId, 'rejected', 400))).delivery, 'rejected');
  assert.equal((await postMessageSubmission('/example', fixture, response(fixture.clientMessageId, 'pending', 409))).delivery, 'pending');
});

test('the UI retains authoritative delivery state from bridge snapshots', () => {
  const state = parseAgentState({ ...EMPTY_AGENT_STATE, messages: [
    { id: fixture.clientMessageId, role: 'user', text: fixture.text, delivery: 'delivered' },
    { id: 'another-id', role: 'user', text: 'another message', delivery: 'unknown' },
  ] });
  assert.deepEqual(state.messages.map(message => message.delivery), ['delivered', 'unknown']);
});
