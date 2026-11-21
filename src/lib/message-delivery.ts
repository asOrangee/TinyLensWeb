export type MessageDelivery = 'pending' | 'unknown' | 'rejected' | 'delivered';

export type MessageSubmission = {
  clientMessageId: string;
  text: string;
  expectedThreadId: string;
  expectedTurnId: string | null;
  seenBatchPlanId?: string;
};

export function messageDelivery(value: unknown): MessageDelivery | undefined {
  if (value === 'pending' || value === 'unknown' || value === 'rejected' || value === 'delivered') return value;
}

export function restoreMessageSubmissions(saved: string | null): Map<string, MessageSubmission> {
  const submissions = new Map<string, MessageSubmission>();
  try {
    const values = JSON.parse(saved ?? '[]');
    if (Array.isArray(values)) for (const value of values) {
      if (typeof value?.clientMessageId === 'string' && typeof value.text === 'string'
          && typeof value.expectedThreadId === 'string' && (value.expectedTurnId === null || typeof value.expectedTurnId === 'string')) {
        submissions.set(value.text, { clientMessageId: value.clientMessageId, text: value.text, expectedThreadId: value.expectedThreadId,
          expectedTurnId: value.expectedTurnId, seenBatchPlanId: typeof value.seenBatchPlanId === 'string' ? value.seenBatchPlanId : undefined });
      }
    }
  } catch { /* An unavailable or invalid browser cache does not change bridge delivery. */ }
  return submissions;
}

export async function postMessageSubmission<T extends { clientMessageId: string }>(url: string, submission: T, send = fetch) {
  try {
    const response = await send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission), signal: AbortSignal.timeout(75_000) });
    const payload = await response.json();
    const delivery = payload?.messageReceipt?.id === submission.clientMessageId && messageDelivery(payload.messageReceipt.delivery);
    if (delivery) return { delivery, error: typeof payload.error === 'string' ? payload.error : undefined, state: response.ok ? payload : undefined };
  } catch { /* A lost response cannot establish whether the bridge received the message. */ }
  return { delivery: 'unknown' as const, error: '暂时无法确认消息是否送达。再次发送这份草稿时会核对原提交。' };
}
