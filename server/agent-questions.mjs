const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const optionalText = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const onlyKeys = (object, keys) => Object.keys(object).every(key => keys.includes(key));

// Describes a display tool's wire format, not AI behavior or project policy.
export const QUESTION_FORMAT = `For a persistent question card, use kind="note", status="awaiting_user", optional title/stage, and a JSON string in message: {"tinylens_ui_question":1,"id":"stable-id","question":"Question text","context":"Optional context","options":[{"id":"option-id","label":"Option label","description":"Optional explanation"}]}. Empty options allow free text. A changed question needs a new id. Optional supersedesQuestionId references a pending question in the same thread to replace its wording or translation; the old question becomes read-only history. Already answered or in-flight questions cannot be replaced. The new question receives no previous answer or draft. Tool success only confirms display and persistence, never a user answer or approval. Explicit webpage answers arrive as ordinary user messages in the same thread, with the original question and exact submitted text.`;

export function parseQuestionReport(report) {
  let envelope;
  try { envelope = JSON.parse(report.message); }
  catch {
    if (typeof report.message === 'string' && /"tinylens_ui_question"\s*:/.test(report.message)) throw new Error('Malformed structured question JSON');
    return null;
  }
  // The exact marker is the opt-in. A normal note remains a note even when it
  // says awaiting_user; never infer a question from prose or unrelated JSON.
  if (!record(envelope) || !own(envelope, 'tinylens_ui_question')) return null;
  if (report.kind !== 'note' || report.status !== 'awaiting_user') {
    throw new Error('A structured question must use kind note and status awaiting_user');
  }
  if (typeof report.message !== 'string' || report.message.length > 30000
    || (report.title !== undefined && !optionalText(report.title, 4000))
    || (report.stage !== undefined && !optionalText(report.stage, 4000))) throw new Error('Invalid structured question report');
  if (!record(envelope) || envelope.tinylens_ui_question !== 1
    || !onlyKeys(envelope, ['tinylens_ui_question', 'id', 'question', 'context', 'options', 'supersedesQuestionId'])
    || !text(envelope.id, 200) || !text(envelope.question, 12000)
    || (own(envelope, 'supersedesQuestionId') && (!text(envelope.supersedesQuestionId, 200) || envelope.supersedesQuestionId === envelope.id))
    || (own(envelope, 'context') && !optionalText(envelope.context, 12000))
    || !Array.isArray(envelope.options) || envelope.options.length > 20) throw new Error('Invalid structured question');
  for (const option of envelope.options) {
    if (!record(option) || !onlyKeys(option, ['id', 'label', 'description']) || !text(option.id, 200) || !text(option.label, 2000)
      || (own(option, 'description') && !optionalText(option.description, 4000))) throw new Error('Invalid question option');
  }
  if (new Set(envelope.options.map(option => option.id)).size !== envelope.options.length) throw new Error('Question option ids must be unique');
  return { id: envelope.id, title: report.title || 'Pipeline AI question', question: envelope.question,
    ...(report.stage === undefined ? {} : { stage: report.stage }), ...(envelope.context === undefined ? {} : { context: envelope.context }),
    ...(envelope.supersedesQuestionId === undefined ? {} : { supersedesQuestionId: envelope.supersedesQuestionId }),
    options: envelope.options.map(option => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) };
}
function contentKey(question) {
  return JSON.stringify({ threadId: question.threadId, title: question.title, question: question.question, stage: question.stage,
    context: question.context, supersedesQuestionId: question.supersedesQuestionId,
    options: question.options.map(option => ({ id: option.id, label: option.label, description: option.description })) });
}
export function receiveQuestionReport(state, params, report) {
  const parsed = parseQuestionReport(report);
  if (!parsed) return null;
  const incoming = { ...parsed, threadId: params.threadId };
  const existing = state.questions.find(question => question.id === parsed.id);
  if (existing) {
    if (contentKey(existing) !== contentKey(incoming)) throw new Error('This question id already has different content. Publish a new question id.');
    return { question: existing, created: false };
  }
  let superseded;
  if (parsed.supersedesQuestionId !== undefined) {
    superseded = state.questions.find(question => question.id === parsed.supersedesQuestionId);
    if (!superseded || superseded.threadId !== params.threadId) throw new Error('The question to replace does not exist in this thread');
    if (superseded.status !== 'pending') throw new Error('Only a pending question can be replaced');
  }
  const question = { ...incoming, turnId: params.turnId, sourceCallId: params.callId, status: 'pending', createdAt: new Date().toISOString() };
  // Validate both sides before this synchronous mutation. The original record,
  // including any failed-send draft, remains intact; none is copied to the new one.
  state.questions.push(question);
  if (superseded) {
    superseded.status = 'superseded'; superseded.supersededByQuestionId = question.id; superseded.supersededAt = question.createdAt;
  }
  return { question, created: true };
}
export function restoreQuestions(saved, messages = []) {
  if (!Array.isArray(saved)) return [];
  const questions = [];
  for (const value of saved) {
    if (!record(value) || !text(value.id, 200) || !text(value.threadId, 200) || !text(value.turnId, 200) || !text(value.sourceCallId, 200)
      || !['pending', 'sending', 'answered', 'delivery_unknown', 'superseded'].includes(value.status)) continue;
    try {
      parseQuestionReport({ kind: 'note', status: 'awaiting_user', title: value.title, stage: value.stage,
        message: JSON.stringify({ tinylens_ui_question: 1, id: value.id, question: value.question, context: value.context, options: value.options,
          supersedesQuestionId: value.supersedesQuestionId }) });
    } catch { continue; }
    if (questions.some(question => question.id === value.id)) continue;
    const question = structuredClone(value);
    if (question.status === 'sending') {
      const message = messages.find(item => item.id === question.answerMessageId);
      question.status = message?.delivery === 'delivered' ? 'answered' : message?.delivery === 'rejected' ? 'pending' : 'delivery_unknown';
      if (question.status === 'delivery_unknown') question.error = 'Answer delivery was not confirmed before restart. It will not be resent automatically.';
    }
    questions.push(question);
  }
  return questions;
}
export function prepareQuestionAnswer(state, data) {
  if (!record(data) || !onlyKeys(data, ['questionId', 'optionId', 'text']) || !text(data.questionId, 200)) throw new Error('Invalid question answer');
  const question = state.questions.find(item => item.id === data.questionId);
  if (!question || question.threadId !== state.threadId) throw new Error('Question does not belong to the connected thread');
  if (question.status === 'superseded') throw new Error('This question was superseded; answer its replacement in the webpage');
  if (question.status === 'delivery_unknown') throw new Error('Answer delivery is unknown; automatic or repeated submission is disabled');
  if (question.status !== 'pending') throw new Error('This question is already answered or being submitted');
  if (own(data, 'optionId') && !text(data.optionId, 200)) throw new Error('Invalid answer option');
  if (own(data, 'text') && (typeof data.text !== 'string' || data.text.length > 20000)) throw new Error('Answer text must contain at most 20000 characters');
  const option = data.optionId === undefined ? undefined : question.options.find(item => item.id === data.optionId);
  if (data.optionId !== undefined && !option) throw new Error('The selected option is not part of this question');
  const hasText = typeof data.text === 'string' && data.text.trim().length > 0;
  if (!option && !hasText) throw new Error('Choose an option or enter an answer explicitly');
  const answer = { ...(option ? { optionId: option.id } : {}), ...(hasText ? { text: data.text } : {}) };
  const payload = { questionId: question.id, sourceThreadId: question.threadId, sourceTurnId: question.turnId,
    sourceCallId: question.sourceCallId, title: question.title, question: question.question,
    ...(question.stage === undefined ? {} : { stage: question.stage }), ...(question.context === undefined ? {} : { context: question.context }),
    ...(option ? { selectedOption: option } : {}), ...(hasText ? { userText: data.text } : {}) };
  const message = `[User answer submitted in the TinyLens webpage to the pipeline AI's question]\n${JSON.stringify(payload, null, 2)}`;
  if (message.length > 30000) throw new Error('The answer and its question context are too long; shorten the answer');
  return { question, answer, message };
}
