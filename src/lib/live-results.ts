import type { AgentUpdate } from './agent-types';
import {verifiedResultMapping,type LiveMapping} from './live-mapping.ts';
import {hasNumericRaster} from './image-scale.ts';
import { isPublishedDisplayReport } from './display-report.ts';
import { activeRun, resultIdentity, runKey, stageAttempts, type AttemptIdentity } from './stage-attempts.ts';
import type { StageId } from '../data/stages.ts';

export { resultIdentity } from './stage-attempts.ts';

export type LivePlane = { src: string; shape: number[]; bounds_arcsec: number[]; half_extent_arcsec: number; vmin: number; vmax: number; data_min: number; data_max: number; stretch: string; asinh_a: number; colormap: string; colormap_src: string; sha256?: string; array_sha256?: string; input_fits_sha256?: string;values_base64?:string;values_sha256?:string;mask_base64?:string;array_y_direction?:'increasing'|'decreasing';color_lut_base64?:string;color_lut_sha256?:string;color_stops?:number[][];rendered_from?:'numeric-array' };

export type HistogramParameter = { name: string; q16: number; q50: number; q84: number; edges: number[]; density: number[]; shown_probability: number };
export type LiveMask = { background_src: string; overlay_src: string; shape: number[]; pixel_scale_arcsec: number; included: number; domain_pixels: number; modeling_radius_arcsec?: number; sha256: string; path: string; input_fits_sha256: string };
export type LiveResult = {
  schema: 'tinylens.readonly-result.v1'; kind: 'summary' | 'weighted_posterior' | 'evidence_scan' | 'preflight';
  stage: string; attempt: number | null; path: string; sha256: string;
  summary_sha256?: string;
  run_id?: string;
  result?: { lens_id: string; stage: string; attempt: number; status: string; metrics: Record<string, unknown>; runtime_seconds?: number; gate_failures?: string[]; display?: { schema: string; path: string } };
  config?: { schema_version?: string; pipeline_release_id?: string; settings?: Record<string, unknown> };
  parameters?: HistogramParameter[]; sample_count?: number; effective_sample_size?: number;
  planes?: Partial<Record<'observation' | 'model' | 'source-lensed' | 'source' | 'residual' | 'chi-square', LivePlane>>;
  mask?: LiveMask;
  fixed_parameters?: Record<string, number>;
  linear_parameters?: Record<string, { values?: number[]; fits?: string; shape?: number[] }>;
  parameter_contract?: 'tinylens.stage-parameters.v1';
  parameter_source?: { path: string; sha256: string };
  display_mapping?:LiveMapping;
  scan?: { coarse: EvidenceCurve; fine: EvidenceCurve; log_lambda_best: number };
};

type EvidenceCurve = { log_lambda: number[]; log_evidence: (number | null)[] };

function displayReport(update: AgentUpdate): AgentUpdate | undefined {
  if (update.display_manifest) return { ...update, kind: 'artifact', path: update.display_manifest };
  return isPublishedDisplayReport(update) ? update : undefined;
}

export function isNumericalStageReport(update: AgentUpdate) {
  const identity = resultIdentity(update);
  if (!update.id || !identity) return false;
  if (displayReport(update)) return true;
  if (!identity.runId && update.kind === 'artifact' && !['preflight', 'b'].includes(identity.stage)
      && update.path?.endsWith('/decision.json')) return true;
  if (/\/artifacts\/stage_(a|m0|m1|m2|m3)\.pkl$/.test(update.path ?? '')) return update.kind === 'artifact';
  return /\/(?:preflight\/(?:inspector|inspection)|stage-result)\.json$/.test(update.path ?? '');
}

function selection(reports: readonly AgentUpdate[], identity: AttemptIdentity | null, stage: string) {
  const bound = identity ? reports.filter(update => resultIdentity(update)?.key === identity.key) : [];
  const latestImages = new Map<string, AgentUpdate>();
  for (const update of bound) if (update.kind === 'artifact' && update.id && /\.(png|jpe?g|webp|gif)$/i.test(update.path ?? '')) {
    latestImages.delete(update.path!);
    latestImages.set(update.path!, update);
  }
  return {
    identity,
    legacyReadable: !identity?.runId && !reports.some(update => update.run_id && update.run_path === identity?.runPath),
    published: bound.map(displayReport).filter(Boolean).at(-1),
    summary: bound.filter(update => update.id && (stage === 'preflight'
      ? /\/preflight\/(?:inspector|inspection)\.json$/ : /\/stage-result\.json$/).test(update.path ?? '')).at(-1)
      ?? bound.filter(update => update.path?.endsWith('/decision.json') && isNumericalStageReport(update)).at(-1),
    declaration: stage === 'preflight' ? bound.filter(update => update.id && update.path?.endsWith('/preflight/inspection.json')).at(-1) : undefined,
    posterior: bound.filter(update => update.id && update.kind === 'artifact'
      && update.path?.endsWith('/artifacts/stage_' + stage + '.pkl')).at(-1),
    images: [...latestImages.values()],
  };
}

export function legacyAcceptanceReport(updates: AgentUpdate[], stage: StageId, historical?: string) {
  if (!['a', 'b', 'm0', 'm1'].includes(stage)) return undefined;
  const attempts = stageAttempts(updates);
  const selected = historical ? attempts.find(item => item.identity.key === historical) : undefined;
  if (historical && (selected?.archived || selected?.status !== 'accepted')) return undefined;
  const run = selected?.identity ?? activeRun(attempts);
  if (!run || run.runId || updates.some(update => update.run_id && update.run_path === run.runPath)) return undefined;
  const anchor = (name: string) => updates.filter(update => update.id && !update.schema
    && ['stage', 'artifact'].includes(update.kind) && update.status === 'accepted'
    && update.stage?.trim().toLowerCase() === name && update.path === `${run.runPath}/accepted/${name}.json`).at(-1);
  return anchor(stage) ?? (stage === 'b' ? anchor('m0') : undefined);
}

export function stageDisplayCandidates(updates: AgentUpdate[], stage: StageId, historical?: string) {
  const attempts = stageAttempts(updates);
  const forStage = attempts.filter(item => item.identity.stage === stage);
  if (historical) return [selection(updates, forStage.find(item => item.identity.key === historical)?.identity ?? null, stage)];
  const reportedNumerical = new Set(updates.filter(isNumericalStageReport).map(update => resultIdentity(update)?.key));
  const globalRun = activeRun(attempts);
  const active = globalRun?.runId ? globalRun : activeRun(forStage);
  const current = active ? forStage.filter(item => runKey(item.identity) === runKey(active)) : [];
  const previouslyAccepted = forStage.filter(item => item.status === 'accepted' && item.archived
    && (!active || item.identity.runPath === active.runPath && item.identity.lensId === active.lensId));
  const newestFirst = current.slice().sort((a, b) => (b.identity.attempt ?? 0) - (a.identity.attempt ?? 0));
  const order = [
    ...newestFirst.filter(item => item.status === 'accepted'),
    ...previouslyAccepted.reverse(),
    ...newestFirst.filter(item => item.status !== 'accepted'),
  ];
  const candidates = order.filter(item => reportedNumerical.has(item.identity.key)).map(item => selection(updates, item.identity, stage));
  return candidates.length ? candidates : [selection(updates, order[0]?.identity ?? null, stage)];
}

export function selectStageResults(updates: AgentUpdate[], stage: StageId) {
  return stageDisplayCandidates(updates, stage)[0];
}

export function parseLiveResult(value: unknown, update: AgentUpdate): LiveResult {
  if (!value || typeof value !== 'object') throw new Error('无法读取真实结果。');
  const data = value as LiveResult, identity = resultIdentity(update);
  if (!identity || data.schema !== 'tinylens.readonly-result.v1' || data.stage !== identity.stage || data.attempt !== identity.attempt || data.path !== update.path || !['summary', 'weighted_posterior', 'evidence_scan','preflight'].includes(data.kind)) throw new Error('结果与所选阶段或 attempt 不匹配。');
  if ((data.stage==='preflight') !== (data.kind==='preflight')) throw new Error('预检与建模结果不能互换。');
  if(data.kind==='preflight'&&(data.stage!=='preflight'||!data.config?.settings||Object.entries(data.config.settings).some(([key,value])=>!['detection_threshold','minimum_connected_pixels','inspector_count'].includes(key)||typeof value!=='number'||!Number.isFinite(value)||value<=0)))throw new Error('预检参数格式无效。');
  if (data.kind === 'weighted_posterior' && (!Array.isArray(data.parameters) || data.parameters.some(p => !p || typeof p.name !== 'string' || !Array.isArray(p.edges) || !Array.isArray(p.density) || p.edges.length !== p.density.length + 1 || ![p.q16, p.q50, p.q84, ...p.edges, ...p.density, p.shown_probability].every(Number.isFinite) || p.density.some(v => v < 0)))) throw new Error('后验样本摘要格式无效。');
  if (data.kind === 'summary' && (!data.result || data.result.stage !== identity.stage || data.result.attempt !== identity.attempt || !data.result.metrics || typeof data.result.metrics !== 'object')) throw new Error('阶段摘要身份无效。');
  if (data.kind === 'evidence_scan' && (!data.scan || !Number.isFinite(data.scan.log_lambda_best) || ['coarse', 'fine'].some(key => {
    const curve = data.scan![key as 'coarse' | 'fine'];
    return !curve || !Array.isArray(curve.log_lambda) || !Array.isArray(curve.log_evidence) || !curve.log_lambda.length
      || curve.log_lambda.length !== curve.log_evidence.length || !curve.log_lambda.every(Number.isFinite)
      || !curve.log_evidence.every(value => value === null || Number.isFinite(value))
      || !curve.log_evidence.some(Number.isFinite);
  }))) throw new Error('证据扫描格式无效。');
  if (data.planes) for (const [name, plane] of Object.entries(data.planes)) {
    if (!['observation', 'model', 'source-lensed', 'source', 'residual', 'chi-square'].includes(name) || !hasNumericRaster(plane) || plane.src!=='' || plane.colormap_src!=='' || !Array.isArray(plane.shape) || plane.shape.length !== 2 || !plane.shape.every(n => Number.isInteger(n) && n > 0 && n <= 512) || !Array.isArray(plane.bounds_arcsec) || plane.bounds_arcsec.length !== 4 || ![...plane.bounds_arcsec, plane.vmin, plane.vmax, plane.half_extent_arcsec].every(Number.isFinite) || plane.vmin > plane.vmax || plane.half_extent_arcsec <= 0 || plane.bounds_arcsec[0] >= plane.bounds_arcsec[1] || Math.abs(plane.bounds_arcsec[3] - plane.bounds_arcsec[2] - 2 * plane.half_extent_arcsec) > 1e-10 || !['linear','asinh'].includes(plane.stretch) || plane.stretch==='asinh'&&(!Number.isFinite(plane.asinh_a)||plane.asinh_a<=0)) throw new Error('已保存图层的数值或几何无效。');
    if(plane.values_base64!==undefined){
      const count=plane.shape[0]*plane.shape[1];
      if(!/^[A-Za-z0-9+/]+=*$/.test(plane.values_base64)||!/^[a-f0-9]{64}$/.test(plane.values_sha256??'')||typeof plane.mask_base64!=='string'||!/^[A-Za-z0-9+/]+=*$/.test(plane.mask_base64)||atob(plane.values_base64).length!==count*8||atob(plane.mask_base64).length!==count||plane.array_y_direction!=='increasing')throw Error('图像数值与显示网格不一致。');
    }
  }
  if(data.display_mapping&&!verifiedResultMapping(data))throw Error('透镜映射与保存结果不一致。');
  if(data.mask)throw Error('掩膜图像必须通过数值掩膜通道读取。');
  if (data.fixed_parameters && Object.values(data.fixed_parameters).some(value=>!Number.isFinite(value))) throw new Error('固定参数数值无效。');
  return data;
}
