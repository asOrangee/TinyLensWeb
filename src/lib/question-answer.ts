import type { AgentQuestion, AgentQuestionAnswer } from './agent-types.ts';
import type { MessageDelivery } from './message-delivery.ts';

export type QuestionSubmission = AgentQuestionAnswer & { questionId: string; expectedThreadId: string; clientMessageId: string };
export type QuestionDraft = { optionId: string; text: string; clientMessageId?: string };

export function restoreQuestionDraft(saved: string | null): QuestionDraft {
  try {
    const value: unknown = JSON.parse(saved ?? 'null');
    if (value && typeof value === 'object') {
      const draft = value as Record<string, unknown>;
      return { optionId: typeof draft.optionId === 'string' ? draft.optionId : '', text: typeof draft.text === 'string' ? draft.text : '',
        clientMessageId: typeof draft.clientMessageId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(draft.clientMessageId) ? draft.clientMessageId : undefined };
    }
  } catch { /* Retain an editable empty draft when browser storage is invalid. */ }
  return { optionId: '', text: '' };
}

export function questionAnswerControls(status: AgentQuestion['status'], draft: QuestionDraft, delivery?: MessageDelivery) {
  const clientMessageId = delivery === 'rejected' ? undefined : draft.clientMessageId;
  const maySubmit = status === 'pending' && delivery !== 'delivered';
  return { clientMessageId, maySubmit, fieldsLocked: !maySubmit || !!clientMessageId };
}
