import type { StageId } from '../data/stages.ts';
import type { LiveResult } from './live-results.ts';
import { mgeReference } from '../data/scientific-references.ts';

type Reference = { label: string; url: string };
type Detail = string | { template: string; values: Record<string, string | number> };
export type ModelParameterRole = 'sampled' | 'linear' | 'fixed' | 'scan';
export type ModelConfigurationCard = {
  id: 'lens-mass' | 'lens-light' | 'source-light'; label: string; model: string;
  parameters: { key: string; symbol: string; role: ModelParameterRole }[]; details: Detail[];
  linearMethod?: '非负线性求解';
  introduction: string; references: Reference[];
};
const papers = {
  mass: { label: 'Tessore & Metcalf 2015', url: 'https://arxiv.org/abs/1507.01819' },
  mge: mgeReference,
  inversion: { label: 'Warren & Dye 2003', url: 'https://arxiv.org/abs/astro-ph/0302587' },
  regularization: { label: 'Suyu et al. 2006', url: 'https://arxiv.org/abs/astro-ph/0601493' },
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parameters = (keys: string[], role: ModelParameterRole | ((key: string) => ModelParameterRole) = 'sampled') => keys.map(key => ({ key, symbol: key, role: typeof role === 'function' ? role(key) : role }));
const count = (value: unknown) => Number.isInteger(value) && Number(value) > 0 ? String(value) : '—';

/** Verified config.v5 / input-geometry.v1 forms. Real cards require the selected
 * attempt's reported config; another release needs verified model definitions. */
export function modelConfigurationCards(stage: StageId, live = false, summary?: LiveResult, model?: LiveResult): ModelConfigurationCard[] {
  const cards: ModelConfigurationCard[] = [
    { id: 'lens-mass', label: 'Lens mass', model: '—', parameters: [], details: [], introduction: '—', references: [] },
    { id: 'lens-light', label: 'Lens light', model: '—', parameters: [], details: [], introduction: '—', references: [] },
    { id: 'source-light', label: 'Source light', model: '—', parameters: [], details: [], introduction: '—', references: [] },
  ];
  if (!['a', 'm0', 'm1', 'm2', 'm3'].includes(stage)) return cards;
  const config = summary?.config;
  if (live && (summary?.stage !== stage || config?.schema_version !== 'lens_pipeline_config.v5' || config.pipeline_release_id !== 'input-geometry.v1')) return cards;
  const settings = live ? object(config?.settings) : { n_gaussians_lens: 10, n_gaussians_src: 10 };
  const epl = stage === 'm3', mass = epl ? 'EPL + Shear' : 'SIE + Shear';
  const declaredMass = object(summary?.result?.metrics)[`${stage}_mass_model`];
  if (!declaredMass || typeof declaredMass === 'string' && declaredMass.replaceAll(' ', '') === mass.replaceAll(' ', '')) {
    cards[0] = { ...cards[0], model: mass,
      parameters: parameters(['theta_E', ...(epl ? ['gamma'] : []), 'center_x_mass', 'center_y_mass', 'e1_mass', 'e2_mass', 'gamma1', 'gamma2'], key => ['m0','m2'].includes(stage) || stage !== 'a' && key.startsWith('center_') ? 'fixed' : 'sampled'),
      details: stage === 'm0' ? ['质量参数固定于 A'] : stage === 'm2' ? ['质量参数固定于 M1'] : stage === 'a' ? [] : ['质量中心固定于 A'],
      introduction: epl
        ? '用椭圆幂律描述质量并叠加外剪切，径向斜率可调，比等温模型灵活；仍假设光滑椭圆结构，对局部质量扰动的表达有限。'
        : '用椭圆等温分布描述透镜质量，外剪切近似周围环境的潮汐作用。计算快、参数少；径向斜率固定，对复杂质量结构的表达有限。',
      references: [papers.mass] };
  }
  cards[1] = { ...cards[1], model: 'MGE',
    parameters: parameters([1, 2].flatMap(group => [`center_x_lens_${group}`, `center_y_lens_${group}`, `e1_lens_${group}`, `e2_lens_${group}`]).concat(['lens_mge_sigmas', 'lens_mge_amplitudes']), key => stage !== 'a' || key.endsWith('_sigmas') ? 'fixed' : key.endsWith('_amplitudes') ? 'linear' : 'sampled'),
    linearMethod: stage === 'a' ? '非负线性求解' : undefined,
    details: [stage === 'a' ? {template:'{groups} 组 × {count} 个高斯分量',values:{groups:2,count:count(settings.n_gaussians_lens)}} : '沿用 A 的透镜光模型'],
    introduction: '用多尺度椭圆高斯叠加描述透镜星系光，便于卷积 PSF 和拟合复杂亮度。灵活高效，但分量容易相互补偿，单个高斯通常没有独立物理含义。',
    references: [papers.mge] };
  if (stage === 'a') {
    cards[2] = { ...cards[2], model: 'MGE',
      parameters: parameters(['center_x_src', 'center_y_src', 'e1_src', 'e2_src', 'source_mge_sigmas', 'source_mge_amplitudes'], key => key.endsWith('_sigmas') ? 'fixed' : key.endsWith('_amplitudes') ? 'linear' : 'sampled'),
      linearMethod: '非负线性求解',
      details: [{template:'{groups} 组 × {count} 个高斯分量',values:{groups:1,count:count(settings.n_gaussians_src)}}],
      introduction: '用多尺度椭圆高斯叠加源光，经透镜映射形成弧像。便于联合拟合；同组共用中心与椭率，对不规则或分离结构的表达有限。',
      references: [papers.mge] };
  } else {
    const grid = object(object(summary?.result?.metrics).source_grid_spec);
    const boundModel = model?.stage === stage && model.path === summary?.path && model.sha256 === summary?.sha256 && model.attempt === summary?.attempt ? model : undefined;
    const shape = boundModel?.planes?.source?.shape;
    const gridShape = shape?.length === 2 ? shape.join(' × ') : grid.schema_version === 'source_grid_spec.v1' && Number.isInteger(grid.nsrc) && Number(grid.nsrc) > 0 ? `${grid.nsrc} × ${grid.nsrc}` : undefined;
    cards[2] = { ...cards[2], model: 'Pixelized source',
      parameters: parameters(['source_brightness', 'log_lambda_reg', ...(['m2', 'm3'].includes(stage) ? ['adaptive_reg_rho'] : []), 'source_grid_shape', 'source_pixel_scale'], key => key === 'source_brightness' ? 'linear' : key.startsWith('source_') || stage === 'm3' ? 'fixed' : stage === 'm0' ? 'scan' : 'sampled'),
      details: [stage === 'm0' || stage === 'm1' ? '一阶正则化' : '一阶自适应正则化', ...(gridShape ? [{template:'源网格：{shape}',values:{shape:gridShape}}] : []), ...(stage === 'm0' ? ['扫描正则化强度'] : stage === 'm3' ? ['正则化参数固定于 M2'] : [])],
      introduction: '在给定质量模型的网格上线性重建源亮度，以正则化抑制噪声。能表达不规则结构；依赖网格与平滑强度，过强的平滑会抹去细节。',
      references: [papers.inversion, papers.regularization] };
  }
  return cards;
}
