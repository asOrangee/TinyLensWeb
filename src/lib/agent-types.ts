export type AgentConnection = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AgentTurnStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';
export type AgentMessage = { id: string; role: 'user' | 'assistant'; text: string; phase?: string; complete?: boolean };
export type AgentActivity = { id: string; type: string; title: string; status: string; detail?: string; output?: string };
export type AgentRequest = { id: string | number; method: string; params: Record<string, unknown>;
  scope?: { rootThreadId: string; rootTurnId: string; threadId: string; turnId: string } };
export type AgentUpdate = { id?: string; at?: string; turnId?: string; kind: 'stage' | 'artifact' | 'note'; stage?: string; status?: string; title?: string; message?: string; path?: string };
export type AgentQuestionAnswer = { optionId?: string; text?: string };
export type AgentQuestion = {
  id: string;
  threadId: string;
  turnId: string;
  sourceCallId: string;
  stage?: string;
  title: string;
  question: string;
  context?: string;
  options: { id: string; label: string; description?: string }[];
  status: 'pending' | 'sending' | 'answered' | 'delivery_unknown' | 'superseded';
  supersedesQuestionId?: string;
  supersededByQuestionId?: string;
  answer?: AgentQuestionAnswer;
  error?: string;
};
export type AgentState = {
  connection: AgentConnection;
  threadId: string | null;
  turnId: string | null;
  remoteActive: boolean;
  status: AgentTurnStatus;
  messages: AgentMessage[];
  activities: AgentActivity[];
  requests: AgentRequest[];
  updates: AgentUpdate[];
  questions: AgentQuestion[];
  error: string | null;
  datasetPath: string;
  workspace: string;
};

export const MOCK_DATASET_PATH = '';
export const INITIAL_AGENT_PROMPT = '';

export const EMPTY_AGENT_STATE: AgentState = {
  connection: 'disconnected', threadId: null, turnId: null, remoteActive: false, status: 'idle',
  messages: [], activities: [], requests: [], updates: [], questions: [], error: null,
  datasetPath: MOCK_DATASET_PATH, workspace: '',
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalText = (value: unknown) => typeof value === 'string' ? value : undefined;
// Preserve the bridge's verified routing metadata for status display only.
// Approval validation and execution remain exclusively on the bridge.
function requestScope(value: unknown): AgentRequest['scope'] {
  if (!record(value) || !['rootThreadId', 'rootTurnId', 'threadId', 'turnId'].every(key => typeof value[key] === 'string')) return undefined;
  return { rootThreadId: value.rootThreadId as string, rootTurnId: value.rootTurnId as string, threadId: value.threadId as string, turnId: value.turnId as string };
}

/** Validate transport data without deriving scientific status from its contents. */
export function parseAgentState(value: unknown): AgentState {
  if (!record(value) || !['disconnected', 'connecting', 'connected', 'error'].includes(String(value.connection)) || !['idle', 'running', 'waiting', 'completed', 'failed', 'interrupted'].includes(String(value.status))) {
    throw new Error('AI 会话接口返回了无法识别的状态。');
  }
  for (const key of ['messages', 'activities', 'requests', 'updates']) {
    if (!Array.isArray(value[key])) throw new Error(`AI 会话接口缺少 ${key} 列表。`);
  }
  return {
    connection: value.connection as AgentConnection,
    status: value.status as AgentTurnStatus,
    threadId: optionalText(value.threadId) ?? null,
    turnId: optionalText(value.turnId) ?? null,
    remoteActive: value.remoteActive === true,
    error: optionalText(value.error) ?? null,
    datasetPath: optionalText(value.datasetPath) ?? MOCK_DATASET_PATH,
    workspace: optionalText(value.workspace) ?? '',
    messages: (value.messages as unknown[]).filter(record).filter(item => typeof item.id === 'string' && ['user', 'assistant'].includes(String(item.role)) && typeof item.text === 'string').map(item => ({ id: item.id as string, role: item.role as 'user' | 'assistant', text: item.text as string, phase: optionalText(item.phase), complete: typeof item.complete === 'boolean' ? item.complete : undefined })),
    activities: (value.activities as unknown[]).filter(record).filter(item => ['id', 'type', 'title', 'status'].every(key => typeof item[key] === 'string')).map(item => ({ id: item.id as string, type: item.type as string, title: item.title as string, status: item.status as string, detail: optionalText(item.detail), output: optionalText(item.output) })),
    requests: (value.requests as unknown[]).filter(record).filter(item => (typeof item.id === 'string' || typeof item.id === 'number') && typeof item.method === 'string' && record(item.params)).map(item => ({ id: item.id as string | number, method: item.method as string, params: item.params as Record<string, unknown>, scope: requestScope(item.scope) })),
    updates: (value.updates as unknown[]).filter(record).filter(item => ['stage', 'artifact', 'note'].includes(String(item.kind))).map(item => ({ id: optionalText(item.id), at: optionalText(item.at), turnId: optionalText(item.turnId), kind: item.kind as AgentUpdate['kind'], stage: optionalText(item.stage), status: optionalText(item.status), title: optionalText(item.title), message: optionalText(item.message), path: optionalText(item.path) })),
    questions: (Array.isArray(value.questions) ? value.questions : []).filter(record).filter(item => ['id', 'threadId', 'turnId', 'sourceCallId', 'title', 'question'].every(key => typeof item[key] === 'string') && ['pending', 'sending', 'answered', 'delivery_unknown', 'superseded'].includes(String(item.status))).map(item => ({
      id: item.id as string, threadId: item.threadId as string, turnId: item.turnId as string, sourceCallId: item.sourceCallId as string,
      title: item.title as string, question: item.question as string, context: optionalText(item.context), stage: optionalText(item.stage),
      options: (Array.isArray(item.options) ? item.options : []).filter(record).filter(option => typeof option.id === 'string' && typeof option.label === 'string').map(option => ({ id: option.id as string, label: option.label as string, description: optionalText(option.description) })),
      status: item.status as AgentQuestion['status'], error: optionalText(item.error),
      supersedesQuestionId: optionalText(item.supersedesQuestionId), supersededByQuestionId: optionalText(item.supersededByQuestionId),
      answer: record(item.answer) ? { optionId: optionalText(item.answer.optionId), text: optionalText(item.answer.text) } : undefined,
    })),
  };
}
