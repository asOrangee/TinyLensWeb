import assert from 'node:assert/strict';
import test from 'node:test';
import { postMessageSubmission } from '../src/lib/message-delivery.ts';
import { questionAnswerControls, restoreQuestionDraft, type QuestionSubmission } from '../src/lib/question-answer.ts';

const id = 'cafefeed-0000-0000-0000-000000000001';

test('a browser failure before the bridge receives an answer leaves the original reply retryable after refresh', async () => {
  const draft = { clientMessageId: id, text: '保留原始输入。', optionId: 'first' };
  const submission: QuestionSubmission = { ...draft, questionId: 'fixture-question', expectedThreadId: 'fixture-thread' };
  const lost: typeof fetch = async () => { throw Error('Mock request never reached the bridge'); };
  const result = await postMessageSubmission('/mock-answer', submission, lost);
  assert.equal(result.delivery, 'unknown');

  const restored = restoreQuestionDraft(JSON.stringify(draft));
  const controls = questionAnswerControls('pending', restored);
  assert.deepEqual(controls, { clientMessageId: id, maySubmit: true, fieldsLocked: true });
  const received: typeof fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(String(options?.body)), submission);
    return Response.json({ messageReceipt: { id, delivery: 'delivered' } });
  };
  assert.equal((await postMessageSubmission('/mock-answer', { ...submission, clientMessageId: controls.clientMessageId! }, received)).delivery, 'delivered');
});

test('bridge receipts release editing only for an explicit rejection, and uncertain remote sends stay locked', () => {
  const draft = { text: 'User draft', optionId: '', clientMessageId: id };
  assert.deepEqual(questionAnswerControls('pending', draft, 'rejected'), { clientMessageId: undefined, maySubmit: true, fieldsLocked: false });
  for (const status of ['sending', 'delivery_unknown', 'answered', 'superseded'] as const) {
    assert.equal(questionAnswerControls(status, draft, 'unknown').maySubmit, false);
    assert.equal(questionAnswerControls(status, draft, 'unknown').fieldsLocked, true);
  }
  assert.equal(questionAnswerControls('pending', draft, 'delivered').maySubmit, false);
});

test('legacy tab-local unknown markers cannot permanently lock a pending question', () => {
  const restored = restoreQuestionDraft(JSON.stringify({ text: 'Original draft', optionId: 'first', delivery: 'unknown' }));
  assert.equal(restored.text, 'Original draft');
  assert.deepEqual(questionAnswerControls('pending', restored), { clientMessageId: undefined, maySubmit: true, fieldsLocked: false });
  assert.equal(questionAnswerControls('delivery_unknown', restored).maySubmit, false);
});
