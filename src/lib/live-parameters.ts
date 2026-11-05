import type { Parameter, Stage } from '../data/stages';
import type { LiveResult } from './live-results';
import {parameterMetadata} from './parameter-presentation.ts';

export const resultNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(4) : Number(value.toPrecision(7)).toString() : '未提供';
export const resultObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Carry descriptions across modes, never demonstration numbers or distributions. */
export function liveParameters(stage: Stage, summary?: LiveResult, posterior?: LiveResult, model?:LiveResult): Parameter[] {
  const metrics = resultObject(summary?.result?.metrics), quantiles = resultObject(metrics.posterior_quantiles), medians = resultObject(metrics.medians), settings = resultObject(summary?.config?.settings);
  const histograms = posterior?.parameters ?? [];
  const grid = resultObject(metrics.source_grid_spec);
  const savedGrid = grid.schema_version === 'source_grid_spec.v1' ? grid : {};
  const frozenMass:Record<string,unknown>=model?.stage===stage.id&&model.path===summary?.path&&model.sha256===summary?.sha256&&model.attempt===summary?.attempt?model.display_mapping?.model??{}:{};
  const names = [...new Set([...stage.parameters.map(p => p.key),...Object.keys(quantiles),...Object.keys(medians),...histograms.map(p=>p.name),...Object.keys(posterior?.fixed_parameters??{})])].filter(key=>stage.parameters.some(p=>p.key===key)||!!parameterMetadata(key));
  return names.map(key => {
    const handbook = stage.parameters.find(p => p.key === key)??parameterMetadata(key), q = resultObject(quantiles[key]), histogram = histograms.find(p => p.name === key);
    const sampled = !(key in (posterior?.fixed_parameters??{}))&&!['m0','b','preflight'].includes(stage.id) && (key in quantiles || key in medians || !!histogram);
    const settingKey = ['n_live', 'n_eff'].includes(key) ? `stage_${stage.id}_${key}` : key;
    const source = posterior?.planes?.source ?? (stage.id === 'm1' ? model?.planes?.source : undefined);
    const value = sampled ? q.q50 ?? histogram?.q50 ?? medians[key] : settings[settingKey]
      ?? (stage.id === 'm0' && key === 'log_lambda_reg' ? posterior?.scan?.log_lambda_best : undefined)
      ?? (key === 'log_lambda_best' ? posterior?.scan?.log_lambda_best : undefined)
      ?? (stage.id === 'm0' && key === 'log_lambda_reg' ? medians[key] : undefined)
      ?? posterior?.fixed_parameters?.[key]
      ?? (handbook?.role==='fixed'?frozenMass[key]:undefined)
      ?? (source && key === 'source_grid_shape' ? source.shape.join(' × ') : undefined)
      ?? (source && key === 'source_brightness' ? '条件线性解' : undefined)
      ?? (key === 'source_grid_shape' && Number.isInteger(savedGrid.nsrc) ? `${savedGrid.nsrc} × ${savedGrid.nsrc}` : undefined)
      ?? (key === 'source_pixel_scale' ? savedGrid.pixel_scale_arcsec : undefined)
      ?? (key === 'source_grid_half_extent' ? savedGrid.half_width_arcsec : undefined);
    const lower = q.q16 ?? histogram?.q16, upper = q.q84 ?? histogram?.q84;
    return { key, symbol: handbook?.symbol ?? key, name: handbook?.name ?? key,
      role: sampled ? 'sampled' : key in (posterior?.fixed_parameters??{})?'fixed':handbook?.role ?? 'setting', unit: handbook?.unit ?? '未提供',
      description: handbook?.description ?? '本次结果中实际保存的采样参数。当前未接入该参数的物理说明和单位，请结合原始实现核对。',
      reference: handbook?.reference, value: typeof value === 'number' ? resultNumber(value) : value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value),
      rawValue: value == null ? undefined : String(value),
      numericValue:typeof value==='number'&&Number.isFinite(value)?value:undefined,
      quantiles:sampled&&typeof lower==='number'&&typeof value==='number'&&typeof upper==='number'&&[lower,value,upper].every(Number.isFinite)&&lower<=value&&value<=upper?{q16:lower,q50:value,q84:upper}:undefined,
      interval: sampled&&typeof lower === 'number' && typeof upper === 'number' ? `${resultNumber(lower)} – ${resultNumber(upper)}` : undefined };
  });
}
