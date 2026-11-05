import type { AgentConnection, AgentState, AgentUpdate } from './agent-types';
import type { StageId } from '../data/stages';

export type StageIndicatorState = 'pending' | 'completed' | 'running' | 'blocked' | 'failed';
export type StageIndicator = { state: StageIndicatorState; report?: AgentUpdate; waitingForUser: boolean };
const stageIds: StageId[] = ['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3'];
const running = new Set(['running', 'preparing', 'reviewing', 'retrying']);
const blocked = new Set(['blocked', 'preparation_blocked', 'awaiting_user', 'awaiting_input', 'awaiting_approval', 'waiting', 'human_review', 'awaiting_review', 'queued', 'paused', 'interrupted']);
const completed = new Set(['accepted', 'completed', 'complete']);
const failed = new Set(['failed', 'error', 'rejected']);
const normalizedStatus = (status?: string) => status?.trim().toLowerCase() ?? '';

export function indicatorStage(value?: string): StageId | undefined {
  const id = value?.trim().toLowerCase().replace(/^stage[\s_-]+/, '');
  if (id === 'p') return 'preflight';
  return stageIds.includes(id as StageId) ? id as StageId : undefined;
}

export function reportedStageIndicator(status?: string): StageIndicatorState {
  const value = normalizedStatus(status);
  if (completed.has(value)) return 'completed';
  if (failed.has(value)) return 'failed';
  if (blocked.has(value)) return 'blocked';
  if (running.has(value)) return 'running';
  // Preparation, execution success and artifacts do not establish stage completion.
  return 'pending';
}

export function stageIndicators(state: Pick<AgentState, 'threadId' | 'updates' | 'questions' | 'requests'>): Map<StageId, StageIndicator> {
  const latest = new Map<StageId, AgentUpdate>();
  for (const report of state.updates) {
    const stage = indicatorStage(report.stage);
    if (report.kind === 'stage' && stage) latest.set(stage, report);
  }
  const waiting = new Set<StageId>();
  function waitForTurn(turnId?: string) {
    if (!turnId) return;
    // Only a unique active stage in this verified turn can own an unlabelled request.
    const candidates = [...latest].filter(([, report]) => report.turnId === turnId &&
      (running.has(normalizedStatus(report.status)) || blocked.has(normalizedStatus(report.status)) || normalizedStatus(report.status) === 'prepared'));
    if (candidates.length === 1) waiting.add(candidates[0][0]);
  }
  for (const question of state.questions) {
    if (!['pending', 'sending', 'delivery_unknown'].includes(question.status)) continue;
    if (question.threadId !== state.threadId) continue;
    const stage = indicatorStage(question.stage);
    if (stage) waiting.add(stage);
    else if (!question.stage && question.threadId === state.threadId) waitForTurn(question.turnId);
  }
  for (const request of state.requests) {
    const scope = request.scope;
    const fromRoot = !!state.threadId && request.params.threadId === state.threadId;
    const fromChild = !!scope && !!state.threadId && scope.rootThreadId === state.threadId && scope.threadId === request.params.threadId && scope.turnId === request.params.turnId;
    if (!fromRoot && !fromChild) continue;
    const stage = typeof request.params.stage === 'string' ? indicatorStage(request.params.stage) : undefined;
    if (stage) { waiting.add(stage); continue; }
    if (request.params.stage) continue;
    if (fromChild) waitForTurn(scope!.rootTurnId);
    else if (typeof request.params.turnId === 'string') waitForTurn(request.params.turnId);
  }
  return new Map(stageIds.map(stage => [stage, { report: latest.get(stage), waitingForUser: waiting.has(stage),
    state: waiting.has(stage) ? 'blocked' : reportedStageIndicator(latest.get(stage)?.status) }]));
}

export function serverLinkConnected(connection: AgentConnection, stream: 'connecting' | 'open' | 'retrying'): boolean {
  return connection === 'connected' && stream === 'open';
}

/** Reserve the next reply bubble until its first text arrives in a live AI turn. */
export function replyPending(state: AgentState, stream: 'connecting' | 'open' | 'retrying', visibleMessages = state.messages): boolean {
  if (!serverLinkConnected(state.connection, stream) || state.status !== 'running' || !state.remoteActive) return false;
  if (state.requests.some(request => request.method !== 'item/tool/requestUserInput' || request.params.isBlocking !== false)) return false;
  if (state.questions.some(question => question.threadId === state.threadId && question.turnId === state.turnId && ['pending', 'sending', 'delivery_unknown'].includes(question.status))) return false;
  const latest = visibleMessages.at(-1);
  return !latest || latest.role === 'user' || !latest.text.trim() || latest.complete === true;
}
