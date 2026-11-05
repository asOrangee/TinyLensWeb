import assert from 'node:assert/strict';
import test from 'node:test';
import { liveParameters } from '../src/lib/live-parameters.ts';
import type { Stage } from '../src/data/stages.ts';
import type { LiveResult } from '../src/lib/live-results.ts';

const stage: Stage = { id: 'm2', code: 'M2', title: '', english: '', description: '', model: '', references: [], review: '', outputs: [], parameters: [
  { key: 'theta_E', symbol: 'θE', name: '尺度', value: '99.9', mean: 99.9, sigma: 7, interval: '92–107', role: 'fixed', unit: 'arcsec', description: '说明' },
  { key: 'adaptive_reg_rho', symbol: 'ρ', name: '自适应参数', value: '88', mean: 88, sigma: 1, role: 'sampled', unit: '无量纲', description: '说明' },
  { key: 'n_live', symbol: 'N', name: '采样设置', value: '9999', role: 'setting', unit: '—', description: '说明' },
] };
const summary = { schema: 'tinylens.readonly-result.v1', kind: 'summary', stage: 'm2', attempt: 0, path: '/x', sha256: 's', config: { settings: { stage_m2_n_live: 250 } }, result: { lens_id: 'l', stage: 'm2', attempt: 0, status: 'success', metrics: { medians: { adaptive_reg_rho: 6.3 }, posterior_quantiles: { adaptive_reg_rho: { q16: 6.0, q50: 6.344463373016169, q84: 6.75 } } } } } as LiveResult;

test('real quantiles replace all fictional values and curve parameters', () => {
  const rows = liveParameters(stage, summary);
  const rho = rows.find(p => p.key === 'adaptive_reg_rho')!;
  assert.equal(rho.rawValue, '6.344463373016169'); assert.equal(rho.interval, '6 – 6.75');
  assert.equal(rho.role, 'sampled'); assert.equal(rho.mean, undefined); assert.equal(rho.sigma, undefined);
  assert.equal(rows.find(p => p.key === 'theta_E')!.value, '—');
  assert.equal(rows.find(p => p.key === 'theta_E')!.interval, undefined);
  assert.equal(rows.find(p => p.key === 'n_live')!.value, '250');
});
test('missing or not yet received results preserve descriptions without demonstration numbers', () => {
  for (const row of liveParameters(stage)) { assert.equal(row.value, '—'); assert.equal(row.mean, undefined); assert.equal(row.sigma, undefined); assert.equal(row.interval, undefined); }
});
test('reported parameters outside the prototype do not add rows or columns', () => {
  const result = structuredClone(summary); result.result!.metrics = { posterior_quantiles: { new_parameter: { q16: -2, q50: 0, q84: 3 } } };
  const parameters = liveParameters(stage, result);
  assert.deepEqual(parameters.map(p => p.key), stage.parameters.map(p => p.key));
  assert.equal(parameters.find(p => p.key === 'new_parameter'), undefined);
});
test('actual weighted sample quantiles can supply a missing JSON summary', () => {
  const posterior = { schema: 'tinylens.readonly-result.v1', kind: 'weighted_posterior', stage: 'm2', attempt: 0, path: '/x', sha256: 's', parameters: [{ name: 'adaptive_reg_rho', q16: 6, q50: 6.3, q84: 6.7, edges: [5, 7], density: [.5], shown_probability: 1 }] } as LiveResult;
  const rho = liveParameters(stage, undefined, posterior).find(p => p.key === 'adaptive_reg_rho')!;
  assert.equal(rho.rawValue, '6.3'); assert.equal(rho.interval, '6 – 6.7'); assert.equal(rho.mean, undefined);
});

test('M0 scan points remain settings and saved fixed mass values do not acquire posteriors',()=>{
  const m0={...stage,id:'m0',parameters:[{...stage.parameters[0],key:'log_lambda_reg',role:'setting'}]} as Stage;
  const m0Summary=structuredClone(summary);m0Summary.result!.metrics={medians:{log_lambda_reg:-3.2}};
  const point=liveParameters(m0,m0Summary)[0];assert.equal(point.role,'setting');assert.equal(point.value,'-3.2');assert.equal(point.interval,undefined);
  const posterior={schema:'tinylens.readonly-result.v1',kind:'weighted_posterior',stage:'m2',attempt:0,path:'/x',sha256:'s',fixed_parameters:{theta_E:1.4044637220855027}} as LiveResult;
  const fixed=liveParameters(stage,undefined,posterior)[0];assert.equal(fixed.role,'fixed');assert.equal(fixed.rawValue,'1.4044637220855027');assert.equal(fixed.interval,undefined);
});

test('explicit fixed metadata wins over a carried median or quantile field',()=>{
 const mixed=structuredClone(summary);mixed.result!.metrics={posterior_quantiles:{theta_E:{q16:1,q50:2,q84:3}}};
 const posterior={fixed_parameters:{theta_E:1.4}} as LiveResult;const fixed=liveParameters(stage,mixed,posterior).find(p=>p.key==='theta_E')!;
 assert.equal(fixed.role,'fixed');assert.equal(fixed.rawValue,'1.4');assert.equal(fixed.quantiles,undefined);assert.equal(fixed.interval,undefined);
});
