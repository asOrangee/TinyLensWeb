import { useEffect, useState } from 'react';
import type { AgentUpdate } from '../lib/agent-types';
import type { Parameter, Stage } from '../data/stages';
import { Layers3 } from 'lucide-react';
import ParameterCards from './ParameterCards';
import StageConfiguration from './StageConfiguration';
import { liveParameters } from '../lib/live-parameters';
import { parametersForPosterior } from '../lib/parameter-presentation';
import { EvidenceChart } from './PosteriorChart';
import { JointPosteriorView } from './StageArtifactViews';
import { useDemoI18n } from '../lib/demo-i18n';
import { inheritedConfigurationAnchor, legacyAcceptanceReport, parseLiveResult, resultIdentity, stageDisplayCandidates, type LiveResult } from '../lib/live-results';
import { parseMaskSource } from '../lib/mask-user-input';
import { fetchPublishedDisplay } from '../lib/published-display';
import { useAgentTaskId } from '../lib/agent-task-context';
import { agentTaskUrl } from '../lib/live-tasks';
import { isNamedDisplayDirectory, isNamedDisplaySchema, namedDisplaySchema } from '../lib/display-report';
import { useStageView } from '../lib/stage-artifacts';

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(4) : Number(value.toPrecision(7)).toString()) : '—';
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Selection = ReturnType<typeof stageDisplayCandidates>[number];
type StageDisplay = {
  reports: Selection;
  summary?: LiveResult;
  posterior?: LiveResult;
  model?: LiveResult;
  mask?: ReturnType<typeof parseMaskSource>;
  maskReport?: AgentUpdate;
};

async function fetchLegacy(taskId: string, report: AgentUpdate | undefined,
                           endpoint: 'result' | 'model' | 'mask', signal: AbortSignal, view?: 'posterior') {
  if (!report?.id) return undefined;
  const params = new URLSearchParams({ updateId: report.id });
  if (view) params.set('view', view);
  const url = agentTaskUrl('/api/agent/' + endpoint + '?' + params, taskId);
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error('无法读取本次已报告的数值结果。');
  return response.json();
}

async function optional<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation(); } catch { return undefined; }
}

async function loadAccepted(taskId: string, report: AgentUpdate, reports: Selection, stage: string,
                            attempt: number | null | undefined, signal: AbortSignal): Promise<StageDisplay> {
  const params = new URLSearchParams({ updateId: report.id!, stage });
  if (typeof attempt === 'number') params.set('attempt', String(attempt));
  const response = await fetch(agentTaskUrl('/api/agent/accepted-stage?' + params, taskId), { signal });
  if (!response.ok) throw Error('无法读取已接受的数值结果。');
  const data = await response.json();
  const index = data.summary?.attempt;
  if (data.stage !== stage || data.report_path !== report.path || !Number.isSafeInteger(index) || index < 0
      || (typeof attempt === 'number' && index !== attempt)) throw Error('接受记录与所选阶段不匹配。');
  const run = report.path!.replace(/\/accepted\/[^/]+$/, '');
  const summaryReport = { ...report, stage, path: `${run}/attempts/${stage}/${index}/stage-result.json` };
  const summary = parseLiveResult(data.summary, summaryReport);
  const posterior = await optional(async () => {
    const parsed = parseLiveResult(data.posterior, summaryReport);
    return parsed.summary_sha256 === summary.sha256 || parsed.sha256 === summary.parameter_source?.sha256 ? parsed : undefined;
  });
  const model = await optional(async () => {
    const payload = data.model ?? (data.observation ? { ...summary, planes: { observation: data.observation } } : summary);
    const parsed = parseLiveResult(payload, summaryReport);
    return parsed.planes && parsed.sha256 === summary.sha256 ? parsed : undefined;
  });
  const mask = data.mask === undefined ? undefined : parseMaskSource(data.mask, summaryReport);
  if (mask && mask.sha256 !== summary.sha256) throw Error('掩膜与已接受的阶段摘要不匹配。');
  return { reports: { ...reports, identity: resultIdentity(summaryReport) }, summary, posterior, model, mask, maskReport: mask ? summaryReport : undefined };
}

async function loadAttempt(taskId: string, reports: Selection, stage: string, signal: AbortSignal): Promise<StageDisplay> {
  const readPublished = async (report: AgentUpdate) => {
    const bundle = await optional(() => fetchPublishedDisplay(taskId, report, signal));
    return bundle?.summary ? { reports, summary: bundle.summary, posterior: bundle.posterior,
      model: bundle.summary.planes ? bundle.summary : undefined, mask: bundle.mask, maskReport: bundle.mask ? report : undefined } : undefined;
  };
  if (reports.published) {
    const published = await readPublished(reports.published);
    if (published) return published;
    if (isNamedDisplayDirectory(reports.published.path) || signal.aborted) return { reports };
  }
  const declaration = reports.declaration ?? (stage === 'preflight' ? undefined : reports.summary);
  if (declaration) {
    const published = await readPublished(declaration);
    if (published) return published;
  }
  if (!reports.legacyReadable) return { reports };
  const readResult = (report: AgentUpdate | undefined, endpoint: 'result' | 'model', view?: 'posterior') => optional(async () => {
    const body = await fetchLegacy(taskId, report, endpoint, signal, view);
    return body && report ? parseLiveResult(body, report) : undefined;
  });
  const summary = await readResult(reports.summary, 'result');
  const schema = summary?.result?.display?.schema;
  if (schema === namedDisplaySchema) return { reports };
  if (isNamedDisplaySchema(schema)) return { reports, summary };
  const readMask = optional(async () => {
    if (stage !== 'b' || !reports.summary) return undefined;
    const body = await fetchLegacy(taskId, reports.summary, 'mask', signal);
    return body ? parseMaskSource(body, reports.summary) : undefined;
  });
  const declaredPosterior = !reports.posterior && summary?.result?.status === 'success' && !['b', 'preflight'].includes(stage);
  const [posterior, model, mask] = await Promise.all([
    declaredPosterior ? readResult(reports.summary, 'result', 'posterior') : readResult(reports.posterior, 'result'),
    stage === 'b' || stage === 'preflight' ? undefined : readResult(reports.summary, 'model'),
    readMask,
  ]);
  return {
    reports, summary, posterior: declaredPosterior && posterior?.summary_sha256 !== summary?.sha256 ? undefined : posterior,
    model: model && (!summary || model.sha256 === summary.sha256) ? model : undefined,
    mask: mask && mask.sha256 === summary?.sha256 ? mask : undefined,
    maskReport: reports.summary,
  };
}

const hasImage = (value: StageDisplay) => value.mask || value.model?.planes?.model || value.model?.planes?.source;

export function useLiveStageData(stage: Stage, updates: AgentUpdate[], historical?: string, showConfiguration = false) {
  const taskId = useAgentTaskId();
  const candidates = stageDisplayCandidates(updates, stage.id, historical);
  const acceptance = legacyAcceptanceReport(updates, stage.id, historical);
  const inheritanceAnchor = showConfiguration && stage.id === 'a' && !historical && !candidates[0].identity
    ? inheritedConfigurationAnchor(updates) : undefined;
  const inherited = useStageView('inherited_configuration', inheritanceAnchor);
  // Report delivery updates other session fields frequently. Reload only when
  // a scoped report changes, including a newly announced result in the same run.
  const signature = JSON.stringify([acceptance?.id, historical, candidates.map(({ identity, published, summary, posterior, declaration, legacyReadable }) =>
    [identity?.key, published?.id, summary?.id, posterior?.id, declaration?.id, legacyReadable])]);
  const [loaded, setLoaded] = useState<{ taskId: string; stage: string; signature: string; value: StageDisplay }>();
  useEffect(() => {
    const controller = new AbortController();
    const commit = (value: StageDisplay) => {
      if (!controller.signal.aborted) setLoaded({ taskId, stage: stage.id, signature, value });
    };
    async function load() {
      let incomplete: StageDisplay | undefined;
      if (acceptance && !candidates.some(candidate => candidate.published)) {
        const context = candidates[0];
        const accepted = await optional(() => loadAccepted(taskId, acceptance, context, stage.id,
          historical ? context.identity?.attempt : undefined, controller.signal));
        if (accepted) { commit(accepted); return; }
      }
      for (const reports of candidates) {
        if (controller.signal.aborted) return;
        const attempt = await loadAttempt(taskId, reports, stage.id, controller.signal);
        if (controller.signal.aborted) return;
        if (hasImage(attempt) || attempt.summary?.parameter_source) { commit(attempt); return; }
        if (!incomplete && (attempt.summary || attempt.posterior)) incomplete = attempt;
      }
      commit(incomplete ?? { reports: candidates[0] });
    }
    void load();
    return () => controller.abort();
  }, [taskId, stage.id, signature]);
  const current = loaded?.taskId === taskId && loaded.stage === stage.id
    && (loaded.signature === signature || candidates.some(candidate => candidate.identity?.key === loaded.value.reports.identity?.key))
    ? loaded : undefined;
  const reports = current?.value.reports ?? candidates[0];
  const { summary, posterior, model, mask, maskReport } = current?.value ?? { reports };
  const source = inheritanceAnchor && resultIdentity(inheritanceAnchor);
  const configuration = inherited.value;
  const inheritedSummary: LiveResult | undefined = configuration && source ? {
    schema: 'tinylens.readonly-result.v1', kind: 'summary', stage: 'a', attempt: configuration.attempt,
    path: `${source.runPath}/attempts/a/${configuration.attempt}/stage-result.json`,
    sha256: configuration.summary_sha256, run_id: configuration.run_id, config: configuration.config,
    result: { lens_id: source.lensId, stage: 'a', attempt: configuration.attempt, status: 'success',
      metrics: configuration.mass_model ? { a_mass_model: configuration.mass_model } : {} },
  } : undefined;
  const parameterDetails = liveParameters(stage, summary ?? inheritedSummary, posterior, model);
  return {
    reports, summary, posterior, modelResult: model, modelPlanes: model?.planes, mask, maskReport,
    configurationSummary: summary ?? inheritedSummary, configurationInherited: !summary && !!inheritedSummary,
    loading: current?.signature !== signature && !!(acceptance || reports.summary || reports.posterior || reports.published),
    parameterDetails, parameters: parametersForPosterior(stage.id, parameterDetails),
  };
}

export default function LiveStageData({ stage, data, view, onDetail, connection }: {
  stage: Stage; data: ReturnType<typeof useLiveStageData>; view: 'parameters' | 'config';
  onDetail: (parameter: Parameter) => void; connection?: string;
}) {
  const { t } = useDemoI18n();
  const [posteriorView, setPosteriorView] = useState<'marginal' | 'joint'>('marginal');
  const { summary, posterior, parameters } = data;
  const source = summary ?? posterior;
  const histograms = posterior?.parameters?.filter(item => parameters.some(parameter => parameter.key === item.name&&parameter.role==='sampled')) ?? [];
  if (view === 'config') return <StageConfiguration stage={stage} live summary={data.configurationSummary}
    inherited={data.configurationInherited} model={data.modelResult} onDetail={onDetail}/>;
  const hasJointView = ['a', 'm1', 'm2', 'm3'].includes(stage.id);
  const showJoint = hasJointView && posteriorView === 'joint';
  const switcher = hasJointView && <div className="posterior-view-switch" role="group" aria-label={t('后验图类型')}>
      <button type="button" aria-pressed={!showJoint} onClick={() => setPosteriorView('marginal')}>{t('一维后验')}</button>
      <button type="button" aria-pressed={showJoint} onClick={() => setPosteriorView('joint')}>{t('联合后验')}</button>
    </div>;
  return <div className="live-numerical-results" data-posterior-view={showJoint ? 'joint' : 'marginal'} data-result-attempt={source?.attempt}>
    {showJoint ? <JointPosteriorView switcher={switcher} report={data.reports.published ?? data.reports.summary}
      parameters={data.parameterDetails} marginal={posterior}/>
      : <>
        {switcher && <div className="posterior-toolbar">{switcher}</div>}
        {stage.id === 'm0' ? <EvidenceChart parameter={parameters.find(p => p.key === 'log_lambda_reg')}
          data={posterior?.kind === 'evidence_scan' ? posterior.scan : undefined} onDetail={onDetail} real/>
          : <div className="panel"><ParameterCards parameters={parameters} histograms={histograms} live onDetail={onDetail}/></div>}
      </>}
    {(stage.id === 'b' || stage.id === 'preflight') && <div className="empty-state"><Layers3 size={28}/><h3>这个阶段没有采样后验</h3><p>{stage.id === 'b' ? '使用掩膜与覆盖信息检查本阶段结果。' : '使用预检图像和 Inspector 的证据检查本阶段结果。'}</p></div>}
  </div>;
}
