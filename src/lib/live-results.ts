import type { AgentUpdate } from './agent-types';
import {verifiedLiveMapping,type LiveMapping} from './live-mapping.ts';
import {hasNumericRaster} from './image-scale.ts';

export type LivePlane = { src: string; shape: number[]; bounds_arcsec: number[]; half_extent_arcsec: number; vmin: number; vmax: number; data_min: number; data_max: number; stretch: string; asinh_a: number; colormap: string; colormap_src: string; sha256?: string; array_sha256?: string; input_fits_sha256?: string;values_base64?:string;values_sha256?:string;mask_base64?:string;array_y_direction?:'increasing'|'decreasing';color_lut_base64?:string;color_lut_sha256?:string;color_stops?:number[][];rendered_from?:'numeric-array' };

export type HistogramParameter = { name: string; q16: number; q50: number; q84: number; edges: number[]; density: number[]; shown_probability: number };
export type LiveMask = { background_src: string; overlay_src: string; shape: number[]; pixel_scale_arcsec: number; included: number; domain_pixels: number; modeling_radius_arcsec?: number; sha256: string; path: string; input_fits_sha256: string };
export type LiveResult = {
  schema: 'tinylens.readonly-result.v1'; kind: 'summary' | 'weighted_posterior' | 'evidence_scan' | 'preflight';
  stage: string; attempt: number | null; path: string; sha256: string;
  result?: { lens_id: string; stage: string; attempt: number; status: string; metrics: Record<string, unknown>; runtime_seconds?: number; gate_failures?: string[] };
  config?: { schema_version?: string; pipeline_release_id?: string; settings?: Record<string, unknown> };
  parameters?: HistogramParameter[]; sample_count?: number; effective_sample_size?: number;
  planes?: Partial<Record<'observation' | 'model' | 'source-lensed' | 'source' | 'residual' | 'chi-square', LivePlane>>;
  mask?: LiveMask;
  fixed_parameters?: Record<string, number>;
  display_mapping?:LiveMapping;
  scan?: { coarse: { log_lambda: number[]; log_evidence: number[] }; fine: { log_lambda: number[]; log_evidence: number[] }; log_lambda_best: number };
};

const normalize = (stage?: string) => stage?.trim().toLowerCase().replace(/^stage[\s_-]+/, '');
export function resultIdentity(update: AgentUpdate) {
  if (!update.path || !['artifact', 'stage'].includes(update.kind)) return null;
  const preflight=update.path.match(/^(.*)\/preflight\//);
  if(preflight&&normalize(update.stage)==='preflight')return {key:`${preflight[1]}/preflight`,stage:'preflight',attempt:null};
  const match = update.path.match(/^(.*)\/attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*)\//);
  return match && normalize(update.stage) === match[2] ? { key: `${match[1]}/attempts/${match[2]}/${match[3]}`, stage: match[2], attempt: Number(match[3]) } : null;
}

/** All displayed files must refer to one explicitly reported run and attempt. */
export function selectStageResults(updates: AgentUpdate[], stage: string) {
  const reports = updates.filter(update => normalize(update.stage) === stage);
  const identity = reports.map(resultIdentity).filter(item => item !== null).at(-1) ?? null;
  const bound = identity ? reports.filter(update => resultIdentity(update)?.key === identity.key) : reports.filter(update => !resultIdentity(update));
  const latestImages = new Map<string, AgentUpdate>();
  for (const update of bound) if (update.kind === 'artifact' && update.id && /\.(png|jpe?g|webp|gif)$/i.test(update.path ?? '')) {
    latestImages.delete(update.path!); latestImages.set(update.path!, update);
  }
  return {
    identity,
    summary: bound.filter(update => update.id && (stage==='preflight'?/\/preflight\/(inspector|inspection)\.json$/:/\/stage-result\.json$/).test(update.path ?? '')).at(-1),
    posterior: bound.filter(update => update.id && update.kind === 'artifact' && /\/artifacts\/stage_(a|m0|m1|m2|m3)\.pkl$/.test(update.path ?? '')).at(-1),
    images: [...latestImages.values()],
  };
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
    return !curve || !Array.isArray(curve.log_lambda) || !Array.isArray(curve.log_evidence) || !curve.log_lambda.length || curve.log_lambda.length !== curve.log_evidence.length || ![...curve.log_lambda, ...curve.log_evidence].every(Number.isFinite);
  }))) throw new Error('证据扫描格式无效。');
  if (data.planes) for (const [name, plane] of Object.entries(data.planes)) {
    if (!['observation', 'model', 'source-lensed', 'source', 'residual', 'chi-square'].includes(name) || !hasNumericRaster(plane) || plane.src!=='' || plane.colormap_src!=='' || !Array.isArray(plane.shape) || plane.shape.length !== 2 || !plane.shape.every(n => Number.isInteger(n) && n > 0 && n <= 512) || !Array.isArray(plane.bounds_arcsec) || plane.bounds_arcsec.length !== 4 || ![...plane.bounds_arcsec, plane.vmin, plane.vmax, plane.half_extent_arcsec].every(Number.isFinite) || plane.vmin > plane.vmax || plane.half_extent_arcsec <= 0 || plane.bounds_arcsec[0] >= plane.bounds_arcsec[1] || Math.abs(plane.bounds_arcsec[3] - plane.bounds_arcsec[2] - 2 * plane.half_extent_arcsec) > 1e-10 || !['linear','asinh'].includes(plane.stretch) || plane.stretch==='asinh'&&(!Number.isFinite(plane.asinh_a)||plane.asinh_a<=0)) throw new Error('已保存图层的数值或几何无效。');
    if(plane.values_base64!==undefined){
      const count=plane.shape[0]*plane.shape[1];
      if(!/^[A-Za-z0-9+/]+=*$/.test(plane.values_base64)||!/^[a-f0-9]{64}$/.test(plane.values_sha256??'')||typeof plane.mask_base64!=='string'||!/^[A-Za-z0-9+/]+=*$/.test(plane.mask_base64)||atob(plane.values_base64).length!==count*8||atob(plane.mask_base64).length!==count||plane.array_y_direction!=='increasing')throw Error('图像数值与显示网格不一致。');
    }
  }
  if(data.display_mapping&&!verifiedLiveMapping(data.display_mapping,{stage:data.stage,attempt:data.attempt??-1,path:data.path,sha256:data.sha256,fitsSha256:data.planes?.observation?.input_fits_sha256}))throw Error('透镜映射与保存结果不一致。');
  if(data.mask)throw Error('掩膜图像必须通过数值掩膜通道读取。');
  if (data.fixed_parameters && Object.values(data.fixed_parameters).some(value=>!Number.isFinite(value))) throw new Error('固定参数数值无效。');
  return data;
}
