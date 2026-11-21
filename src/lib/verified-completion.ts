import { useEffect, useState } from 'react';
import { stages, type StageId } from '../data/stages';
import type { AgentUpdate } from './agent-types';
import { agentTaskUrl } from './live-tasks';
import { currentStageAttempt, resultIdentity, type StageAttempt } from './stage-attempts';

type PosteriorStage = 'a' | 'm1' | 'm2' | 'm3';
type FinalParameter = { name: string; q16: number; q50: number; q84: number; stage?: PosteriorStage };
type PointParameter = { name: string; value: number; stage: 'm0' };
type StageComments = Record<StageId, string>;
type Completion = { run_id: string; attempt: number; lens_id: string; parameters: FinalParameter[];
  fixed_parameters: Record<string, number>; point_parameters?: PointParameter[]; comment?: string; stage_comments?: StageComments };

const stageIds = new Set<string>(stages.map(stage => stage.id));
const posteriorStages = new Set<PosteriorStage>(['a', 'm1', 'm2', 'm3']);
const maxStageCommentBytes = 2000;
const invalidStageCommentCharacter = /[\u0000\r\n\v\f\u001c-\u001e\u0085\u2028\u2029]/u;

function readStageComments(value: unknown): StageComments | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== stageIds.size) return undefined;
  const normalized: [string, string][] = [];
  const encoder = new TextEncoder();
  for (const [stage, text] of entries) {
    if (!stageIds.has(stage) || typeof text !== 'string' || text.length > maxStageCommentBytes
        || invalidStageCommentCharacter.test(text) || encoder.encode(text).byteLength > maxStageCommentBytes) return undefined;
    const comment = text.trim();
    if (!comment) return undefined;
    normalized.push([stage, comment]);
  }
  return Object.fromEntries(normalized) as StageComments;
}

function readPointParameters(value: unknown): PointParameter[] | undefined {
  if (!Array.isArray(value) || value.some(row => typeof row?.name !== 'string' || !row.name.trim()
    || !Number.isFinite(row.value) || row.stage !== 'm0')) return undefined;
  return value.map(({ name, value, stage }) => ({ name, value, stage }));
}

export function useVerifiedCompletion(taskId: string | undefined, attempts: StageAttempt[], updates: AgentUpdate[]) {
  const current = currentStageAttempt(attempts, 'm3');
  const report = current?.identity.runId && current.status === 'accepted' ? current.report : undefined;
  const comment = report && updates.filter(update => update.kind === 'artifact' && update.id
    && update.path === `${report.run_path}/modeling-comment.json` && resultIdentity(update)?.key === current?.identity.key).at(-1);
  const signature = taskId && report?.id ? JSON.stringify([taskId, current?.identity.key, report.id, comment?.id]) : undefined;
  const [loaded, setLoaded] = useState<{ signature: string; value?: Completion }>();
  useEffect(() => {
    if (!signature || !taskId || !report?.id) return;
    const controller = new AbortController();
    fetch(agentTaskUrl(`/api/agent/completion?updateId=${encodeURIComponent(report.id)}`, taskId), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) return undefined;
        const value: Completion = await response.json();
        if (value.run_id !== report.run_id || value.lens_id !== report.lens_id || value.attempt !== report.attempt
            || !Array.isArray(value.parameters) || value.parameters.some(row => typeof row?.name !== 'string'
              || ![row.q16, row.q50, row.q84].every(Number.isFinite) || row.q16 > row.q50 || row.q50 > row.q84)
            || !value.fixed_parameters || Object.values(value.fixed_parameters).some(n => !Number.isFinite(n))
            || (value.comment !== undefined && typeof value.comment !== 'string')) return undefined;
        return { ...value,
          parameters: value.parameters.map(({ name, q16, q50, q84, stage }) => ({
            name, q16, q50, q84, stage: stage && posteriorStages.has(stage) ? stage : undefined,
          })),
          point_parameters: readPointParameters(value.point_parameters),
          stage_comments: readStageComments(value.stage_comments),
        };
      }).catch(() => undefined).then(value => {
        if (!controller.signal.aborted) setLoaded({ signature, value });
      });
    return () => controller.abort();
  }, [signature]);
  return { value: loaded?.signature === signature ? loaded?.value : undefined, pending: !!signature && loaded?.signature !== signature };
}
