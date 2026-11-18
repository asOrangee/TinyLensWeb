import type { StageId } from '../data/stages.ts';
import type { AgentUpdate } from './agent-types.ts';

const stageIds = ['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3'] as const;
export const stageReportSchema = 'tinylens.stage-report.v1';

export function workbenchStage(stage?: string): StageId | undefined {
  const id = stage?.trim().toLowerCase().replace(/^stage[\s_-]+/, '');
  if (id === 'p') return 'preflight';
  return stageIds.includes(id as StageId) ? id as StageId : undefined;
}

export type AttemptIdentity = { key: string; runPath: string; runId?: string; lensId: string; stage: StageId; attempt: number | null };
const finalComponent = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const runKey = (identity: AttemptIdentity) => identity.runId ? JSON.stringify([identity.runPath, identity.runId]) : identity.runPath;

export function isArchiveReport(report: AgentUpdate) {
  if (report.schema !== stageReportSchema || report.kind !== 'artifact' || report.stage !== 'preflight' || !report.run_path) return false;
  const archivePrefix = `${report.run_path.slice(0, report.run_path.lastIndexOf('/'))}/_archive/${report.lens_id}_old_`;
  return report.path?.startsWith(archivePrefix) && /^(0|[1-9]\d*)\/run-manifest\.json$/.test(report.path.slice(archivePrefix.length));
}

export function resultIdentity(update: AgentUpdate): AttemptIdentity | null {
  const stage = workbenchStage(update.stage);
  if (!stage || !['artifact', 'stage'].includes(update.kind) || isArchiveReport(update)) return null;
  if (update.schema === stageReportSchema) {
    const { run_id, run_path, lens_id, attempt } = update;
    if (!run_id || !run_path?.startsWith('/') || !lens_id || finalComponent(run_path) !== lens_id || attempt === undefined
        || (stage === 'preflight' ? attempt !== null : attempt === null || !Number.isSafeInteger(attempt) || attempt < 0)) return null;
    return { key: JSON.stringify([run_path, run_id, stage, attempt]), runPath: run_path, runId: run_id, lensId: lens_id, stage, attempt };
  }
  if (!update.path) return null;
  if (stage === 'preflight') {
    const preflight = update.path.match(/^(.*)\/preflight(?:\/|$)/);
    return preflight ? { key: `${preflight[1]}/preflight`, runPath: preflight[1], lensId: finalComponent(preflight[1]), stage, attempt: null } : null;
  }
  const headPath = `/accepted/${stage}.json`;
  if (update.kind === 'stage' && update.status === 'accepted' && update.path.endsWith(headPath)
      && update.verified_attempt !== undefined && update.verified_attempt >= 0) {
    const runPath = update.path.slice(0, -headPath.length);
    const attempt = update.verified_attempt;
    return { key: `${runPath}/attempts/${stage}/${attempt}`, runPath, lensId: finalComponent(runPath), stage, attempt };
  }
  const match = update.path.match(/^(.*)\/attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*)(?:\/|$)/);
  if (!match || stage !== match[2] || !Number.isSafeInteger(Number(match[3]))) return null;
  return { key: `${match[1]}/attempts/${stage}/${match[3]}`, runPath: match[1], lensId: finalComponent(match[1]), stage, attempt: Number(match[3]) };
}

const aliases: Record<string, string> = { review_pending: 'awaiting_review', pending_review: 'awaiting_review', in_review: 'reviewing',
  complete: 'executed', completed: 'executed', success: 'executed', succeeded: 'executed', error: 'failed' };
export const attemptStatus = (value?: string) => {
  const status = value?.trim().toLowerCase() ?? '';
  return Object.hasOwn(aliases, status) ? aliases[status] : status;
};

export type StageAttempt = { identity: AttemptIdentity; status?: string; report?: AgentUpdate; archived: boolean };

export function stageAttempts(updates: readonly AgentUpdate[]) {
  const attempts = new Map<string, StageAttempt>();
  const archiveKeys = new Set(updates.filter(isArchiveReport).map(report => JSON.stringify([report.run_path, report.run_id])));
  const legacyTurnAttempts = new Map<string, Map<string, AttemptIdentity>>();
  for (const update of updates) {
    let identity = resultIdentity(update);
    const status = update.kind === 'stage' ? attemptStatus(update.status) : undefined;
    const stage = workbenchStage(update.stage);
    const head = !identity && status === 'accepted' && stage && update.path?.endsWith(`/accepted/${stage}.json`)
      ? update.path.slice(0, -`/accepted/${stage}.json`.length) : undefined;
    const turnKey = update.turnId && JSON.stringify([update.threadId, update.turnId, stage, identity?.runPath ?? head]);
    if (turnKey && identity && !identity.runId) {
      const turnAttempts = legacyTurnAttempts.get(turnKey) ?? new Map<string, AttemptIdentity>();
      turnAttempts.set(identity.key, identity);
      legacyTurnAttempts.set(turnKey, turnAttempts);
    }
    // A legacy head report can identify an older attempt only when the same
    // turn and run already reported one exact version for that stage.
    if (turnKey && head) {
      const versions = legacyTurnAttempts.get(turnKey);
      if (versions?.size === 1) identity = [...versions.values()][0];
    }
    if (!identity) continue;
    const archived = archiveKeys.has(runKey(identity)) || (!identity.runId && /\/_archive\/[^/]+_old_\d+$/.test(identity.runPath));
    const current = attempts.get(identity.key) ?? { identity, archived };
    if (status && current.status !== 'accepted') {
      current.status = status;
      current.report = update;
    }
    attempts.set(identity.key, current);
  }
  return [...attempts.values()];
}

export function activeRun(attempts: readonly StageAttempt[]) {
  const runs = new Map<string, AttemptIdentity>();
  const versionedPaths = new Set(attempts.filter(item => item.identity.runId).map(item => item.identity.runPath));
  for (const item of attempts) {
    const { identity } = item;
    if (!item.archived && (identity.runId || !versionedPaths.has(identity.runPath))) runs.set(runKey(identity), identity);
  }
  return [...runs.values()].at(-1);
}

export function currentStageAttempt(attempts: readonly StageAttempt[], stage: StageId) {
  const active = activeRun(attempts);
  return active ? attempts.filter(item => item.identity.stage === stage && runKey(item.identity) === runKey(active))
    .sort((a, b) => (b.identity.attempt ?? 0) - (a.identity.attempt ?? 0))[0] : undefined;
}
