import test from 'node:test';
import assert from 'node:assert/strict';
import { modelConfigurationCards } from '../src/lib/model-configuration.ts';
import type { LiveResult } from '../src/lib/live-results.ts';

const summary = (stage: string, settings: Record<string, unknown> = {}): LiveResult => ({
  schema: 'tinylens.readonly-result.v1', kind: 'summary', stage, attempt: 0,
  path: `/run/attempts/${stage}/0/stage-result.json`, sha256: 'same-result',
  config: { schema_version: 'lens_pipeline_config.v5', pipeline_release_id: 'input-geometry.v1', settings },
  result: { lens_id: 'fixture', stage, attempt: 0, status: 'completed', metrics: {} },
});
test('real cards require a matching, supported reported configuration', () => {
  const a = summary('a');
  for (const result of [undefined, summary('m1'), { ...a, config: { ...a.config, pipeline_release_id: 'unverified-release' } }]) {
    const cards = modelConfigurationCards('a', true, result);
    assert.deepEqual(cards.map(card => card.model), ['—', '—', '—']);
    assert.ok(cards.every(card => card.parameters.length === 0 && card.references.length === 0));
  }
  assert.ok(modelConfigurationCards('m3', true).every(card => card.model === '—'));
});
test('A describes both MGE groups and reads counts without substituting defaults', () => {
  const cards = modelConfigurationCards('a', true, summary('a', { n_gaussians_lens: 12, n_gaussians_src: 8 }));
  assert.deepEqual(cards.map(card => card.model), ['SIE + Shear', 'MGE', 'MGE']);
  assert.deepEqual(cards[1].details[0], {template:'{groups} 组 × {count} 个高斯分量',values:{groups:2,count:'12'}});
  assert.deepEqual(cards[2].details[0], {template:'{groups} 组 × {count} 个高斯分量',values:{groups:1,count:'8'}});
  assert.ok(cards[1].parameters.some(p => p.key === 'center_x_lens_2'));
  assert.ok(cards[1].parameters.some(p => p.key === 'lens_mge_sigmas'));
  assert.match(JSON.stringify(modelConfigurationCards('a', true, summary('a'))[1].details[0]), /—/);
  assert.ok(cards.every(card => card.references.length > 0));
});
test('stages retain fixed geometry, pixelized source and scan distinctions', () => {
  assert.ok(modelConfigurationCards('m0', true, summary('m0'))[2].details.includes('扫描正则化强度'));
  const m2 = modelConfigurationCards('m2', true, summary('m2', { n_gaussians_lens: 99 }));
  assert.ok(m2[0].details.includes('质量参数固定于 M1'));
  assert.equal(m2[2].model, 'Pixelized source');
  assert.ok(m2[2].parameters.some(p => p.key === 'adaptive_reg_rho'));
  assert.ok(m2[1].details.every(detail => !JSON.stringify(detail).includes('99')));
  const m3 = modelConfigurationCards('m3', true, summary('m3'));
  assert.equal(m3[0].model, 'EPL + Shear');
  assert.ok(m3[0].parameters.some(p => p.key === 'gamma'));
});
test('reported model contradictions and another attempt grid cannot be relabelled', () => {
  const result = summary('m1');
  result.result!.metrics.m1_mass_model = 'NFW';
  assert.equal(modelConfigurationCards('m1', true, result)[0].model, '—');
  const wrongModel = { ...result, sha256: 'other-result', planes: { source: { shape: [999, 999] } } } as LiveResult;
  assert.ok(modelConfigurationCards('m1', true, result, wrongModel)[2].details.every(detail => !JSON.stringify(detail).includes('999')));
});

test('A separates sampled geometry, linear amplitudes and fixed widths', () => {
  const [mass, lens, source] = modelConfigurationCards('a', true, summary('a'));
  assert.ok(mass.parameters.every(p => p.role === 'sampled'));
  for (const [card, prefix] of [[lens, 'lens'], [source, 'source']] as const) {
    assert.equal(card.parameters.find(p => p.key === `${prefix}_mge_amplitudes`)?.role, 'linear');
    assert.equal(card.parameters.find(p => p.key === `${prefix}_mge_sigmas`)?.role, 'fixed');
    assert.ok(card.parameters.filter(p => !p.key.includes('_mge_')).every(p => p.role === 'sampled'));
    assert.equal(card.linearMethod, '非负线性求解');
  }
});
test('later stages classify frozen lens light and geometry separately from new inference', () => {
  for (const stage of ['m0','m1','m2','m3'] as const) {
    const [mass, lens, source] = modelConfigurationCards(stage, true, summary(stage));
    assert.ok(lens.parameters.every(p => p.role === 'fixed'));
    assert.equal(lens.linearMethod, undefined);
    assert.ok(mass.parameters.filter(p => p.key.startsWith('center_')).every(p => p.role === 'fixed'));
    assert.equal(source.parameters.find(p => p.key === 'source_brightness')?.role, 'linear');
    assert.ok(source.parameters.filter(p => p.key.startsWith('source_grid') || p.key === 'source_pixel_scale').every(p => p.role === 'fixed'));
    assert.equal(source.parameters.find(p => p.key === 'log_lambda_reg')?.role, stage === 'm0' ? 'scan' : stage === 'm3' ? 'fixed' : 'sampled');
    if (stage === 'm0' || stage === 'm2') assert.ok(mass.parameters.every(p => p.role === 'fixed'));
    else assert.ok(mass.parameters.filter(p => !p.key.startsWith('center_')).every(p => p.role === 'sampled'));
    if (stage === 'm2' || stage === 'm3') assert.equal(source.parameters.find(p => p.key === 'adaptive_reg_rho')?.role, stage === 'm2' ? 'sampled' : 'fixed');
  }
});
