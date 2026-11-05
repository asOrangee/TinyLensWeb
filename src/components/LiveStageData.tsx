import { useEffect, useState } from 'react';
import type { AgentUpdate } from '../lib/agent-types';
import type { Parameter, Stage } from '../data/stages';
import { Layers3 } from 'lucide-react';
import ParameterCards from './ParameterCards';
import StageConfiguration from './StageConfiguration';
import { liveParameters } from '../lib/live-parameters';
import { EvidenceChart } from './PosteriorChart';
import { parseLiveResult, selectStageResults, type LiveResult } from '../lib/live-results';
import { useAgentTaskId } from '../lib/agent-task-context';
import { agentTaskUrl } from '../lib/live-tasks';

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(4) : Number(value.toPrecision(7)).toString()) : '—';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function useReportedResult(update?: AgentUpdate, endpoint: 'result' | 'model' = 'result') {
  const taskId = useAgentTaskId();
  const id = update?.id;
  const [loaded, setLoaded] = useState<{ id?: string; data?: LiveResult; error?: string }>({});
  useEffect(() => {
    if (!id || !update) return;
    const controller = new AbortController();
    fetch(agentTaskUrl(`/api/agent/${endpoint}?updateId=${encodeURIComponent(id)}`,taskId), { signal: controller.signal }).then(async response => {
      const body: unknown = await response.json();
      if (!response.ok) throw new Error('暂时无法读取这份已报告的数值结果。');
      const data = parseLiveResult(body, update);
      if (!controller.signal.aborted) setLoaded({ id, data });
    }).catch(error => { if (!controller.signal.aborted) setLoaded({ id, error: error instanceof Error ? error.message : '读取失败。' }); });
    return () => controller.abort();
  }, [id, endpoint, taskId]);
  return loaded.id === id ? loaded : { id, data: undefined, error: undefined };
}

export function useLiveStageData(stage: Stage, updates: AgentUpdate[]) {
  const selection = selectStageResults(updates, stage.id);
  const summary = useReportedResult(selection.summary), posterior = useReportedResult(selection.posterior);
  const model = useReportedResult(['a','m0','m1','m2'].includes(stage.id) ? selection.summary : undefined, 'model');
  return { summary: summary.data, posterior: posterior.data, error: summary.error ?? posterior.error,reports:selection,
    modelPlanes:model.data?.planes,modelResult:model.data,
    loading: !!(selection.summary || selection.posterior) && !summary.data && !posterior.data,
    parameters: liveParameters(stage, summary.data, posterior.data,model.data) };
}

export default function LiveStageData({ stage, data, view, onDetail, connection }: {
  stage: Stage; data: ReturnType<typeof useLiveStageData>; view: 'parameters' | 'config';
  onDetail: (parameter: Parameter) => void; connection?: string;
}) {
  const { summary, posterior, parameters, error } = data;
  const source = summary ?? posterior;
  const histograms = posterior?.parameters?.filter(item => parameters.some(parameter => parameter.key === item.name&&parameter.role==='sampled')) ?? [];
  if (view === 'config') return <StageConfiguration stage={stage} live summary={summary} model={data.modelResult} onDetail={onDetail}/>;
  return <div className="live-numerical-results" data-result-attempt={source?.attempt}>
    <div className="panel">
      <ParameterCards parameters={parameters} histograms={histograms} live onDetail={onDetail}/>
    </div>
    {posterior?.kind === 'evidence_scan' ? <EvidenceChart key={posterior.sha256} data={posterior.scan} real/>
      : (stage.id === 'b' || stage.id === 'preflight') && <div className="empty-state"><Layers3 size={28}/><h3>这个阶段没有采样后验</h3><p>{stage.id === 'b' ? '使用掩膜与覆盖信息检查本阶段结果。' : '使用预检图像和 Inspector 的证据检查本阶段结果。'}</p></div>}
  </div>;
}
