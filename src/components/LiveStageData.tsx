import { useEffect, useState } from 'react';
import type { AgentUpdate } from '../lib/agent-types';
import type { Parameter, Stage } from '../data/stages';
import { Layers3 } from 'lucide-react';
import ParameterCards from './ParameterCards';
import StageConfiguration from './StageConfiguration';
import { liveParameters } from '../lib/live-parameters';
import { parametersForPosterior } from '../lib/parameter-presentation';
import { EvidenceChart } from './PosteriorChart';
import { parseLiveResult, stageDisplayCandidates, type LiveResult } from '../lib/live-results';
import { parseMaskSource } from '../lib/mask-user-input';
import { fetchPublishedDisplay } from '../lib/published-display';
import { useAgentTaskId } from '../lib/agent-task-context';
import { agentTaskUrl } from '../lib/live-tasks';

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(4) : Number(value.toPrecision(7)).toString()) : '—';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Selection = ReturnType<typeof stageDisplayCandidates>[number];
type StageDisplay = {
  reports: Selection;
  summary?: LiveResult;
  posterior?: LiveResult;
  model?: LiveResult;
  mask?: ReturnType<typeof parseMaskSource>;
};

async function fetchLegacy(taskId: string, report: AgentUpdate | undefined,
                           endpoint: 'result' | 'model' | 'mask', signal: AbortSignal) {
  if (!report?.id) return undefined;
  const url = agentTaskUrl('/api/agent/' + endpoint + '?updateId=' + encodeURIComponent(report.id), taskId);
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error('无法读取本次已报告的数值结果。');
  return response.json();
}

async function optional<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); } catch { return undefined; }
}

async function loadAttempt(taskId: string, reports: Selection, stage: string, signal: AbortSignal): Promise<StageDisplay> {
  if (reports.published) {
    const bundle = await optional(() => fetchPublishedDisplay(taskId, reports.published!, signal));
    if (bundle?.summary) {
      return { reports, summary: bundle.summary, posterior: bundle.posterior,
        model: bundle.summary.planes ? bundle.summary : undefined, mask: bundle.mask };
    }
  }
  const readResult = (report: AgentUpdate | undefined, endpoint: 'result' | 'model') => optional(async () => {
    const body = await fetchLegacy(taskId, report, endpoint, signal);
    return body && report ? parseLiveResult(body, report) : undefined;
  });
  const readMask = optional(async () => {
    if (stage !== 'b' || !reports.summary) return undefined;
    const body = await fetchLegacy(taskId, reports.summary, 'mask', signal);
    return body ? parseMaskSource(body, reports.summary) : undefined;
  });
  const [summary, posterior, model, mask] = await Promise.all([
    readResult(reports.summary, 'result'), readResult(reports.posterior, 'result'),
    stage === 'b' || stage === 'preflight' ? undefined : readResult(reports.summary, 'model'),
    readMask,
  ]);
  return {
    reports, summary, posterior,
    model: model && (!summary || model.sha256 === summary.sha256) ? model : undefined,
    mask: mask && mask.sha256 === summary?.sha256 ? mask : undefined,
  };
}

const hasImage = (value: StageDisplay) => value.mask || value.model?.planes?.model || value.model?.planes?.source;

export function useLiveStageData(stage: Stage, updates: AgentUpdate[], historical?: string) {
  const taskId = useAgentTaskId();
  const candidates = stageDisplayCandidates(updates, stage.id, historical);
  // Report delivery updates other session fields frequently. Reload only when
  // a scoped report changes, including a newly announced result in the same run.
  const signature = JSON.stringify(candidates.map(({ identity, published, summary, posterior }) =>
    [identity?.key, published?.id, summary?.id, posterior?.id]));
  const [loaded, setLoaded] = useState<{ taskId: string; stage: string; signature: string; value: StageDisplay }>();
  useEffect(() => {
    const controller = new AbortController();
    const commit = (value: StageDisplay) => {
      if (!controller.signal.aborted) setLoaded({ taskId, stage: stage.id, signature, value });
    };
    async function load() {
      let incomplete: StageDisplay | undefined;
      for (const reports of candidates) {
        if (controller.signal.aborted) return;
        const attempt = await loadAttempt(taskId, reports, stage.id, controller.signal);
        if (controller.signal.aborted) return;
        if (hasImage(attempt)) { commit(attempt); return; }
        if (!incomplete && (attempt.summary || attempt.posterior)) incomplete = attempt;
      }
      commit(incomplete ?? { reports: candidates[0] });
    }
    void load();
    return () => controller.abort();
  }, [taskId, stage.id, signature]);
  const current = loaded?.taskId === taskId && loaded.stage === stage.id
    && candidates.some(candidate => candidate.identity?.key === loaded.value.reports.identity?.key)
    ? loaded : undefined;
  const reports = current?.value.reports ?? candidates[0];
  const { summary, posterior, model, mask } = current?.value ?? { reports };
  return {
    reports, summary, posterior, modelResult: model, modelPlanes: model?.planes, mask,
    loading: current?.signature !== signature && !!(reports.summary || reports.posterior || reports.published),
    parameters: parametersForPosterior(stage.id, liveParameters(stage, summary, posterior, model)),
  };
}

export default function LiveStageData({ stage, data, view, onDetail, connection }: {
  stage: Stage; data: ReturnType<typeof useLiveStageData>; view: 'parameters' | 'config';
  onDetail: (parameter: Parameter) => void; connection?: string;
}) {
  const { summary, posterior, parameters } = data;
  const source = summary ?? posterior;
  const histograms = posterior?.parameters?.filter(item => parameters.some(parameter => parameter.key === item.name&&parameter.role==='sampled')) ?? [];
  if (view === 'config') return <StageConfiguration stage={stage} live summary={summary} model={data.modelResult} onDetail={onDetail}/>;
  return <div className="live-numerical-results" data-result-attempt={source?.attempt}>
    {stage.id === 'm0' ? <EvidenceChart parameter={parameters.find(p => p.key === 'log_lambda_reg')}
      data={posterior?.kind === 'evidence_scan' ? posterior.scan : undefined} onDetail={onDetail} real/>
      : <div className="panel"><ParameterCards parameters={parameters} histograms={histograms} live onDetail={onDetail}/></div>}
    {(stage.id === 'b' || stage.id === 'preflight') && <div className="empty-state"><Layers3 size={28}/><h3>这个阶段没有采样后验</h3><p>{stage.id === 'b' ? '使用掩膜与覆盖信息检查本阶段结果。' : '使用预检图像和 Inspector 的证据检查本阶段结果。'}</p></div>}
  </div>;
}
