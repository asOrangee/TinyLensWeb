import {numericalFixture} from './fixtures/numerical-plane.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStageResults, parseLiveResult } from '../src/lib/live-results.ts';
import type { AgentUpdate } from '../src/lib/agent-types.ts';
import { parseReportedPanels } from '../src/lib/reported-panels.ts';

test('native diagnostic display is bound to one image and cannot claim numeric model or chi-square planes',()=>{
 const update=artifact('png','run',0,'diagnostics/stage_a_model.png');
 const panel={kind:'reported-raster',src:'data:image/png;base64,iVBORw0KGgo=',colorbar_src:'data:image/png;base64,iVBORw0KGgo=',pixel_shape:[520,520],colorbar_top:-.1,colorbar_height:1.13};
 const value={schema:'tinylens.reported-panels.v1',stage:'a',attempt:0,path:update.path,updateId:update.id,source_sha256:'a'.repeat(64),panels:{'source-lensed':panel,residual:panel,source:panel}};
 assert.equal(parseReportedPanels(value,update).panels.residual?.kind,'reported-raster');
 for(const change of [{attempt:1},{stage:'m1'},{updateId:'other'},{path:'/other'},{panels:{...value.panels,model:panel}},{panels:{...value.panels,source:{...panel,kind:'numeric'}}},{panels:{...value.panels,residual:{...panel,colorbar_src:'/demo/residual.png'}}}])assert.throws(()=>parseReportedPanels({...value,...change},update));
 const bar={gradient_src:panel.src,top:0,height:1,ticks:[{position:0,value:3},{position:.5,value:0},{position:1,value:-3}]};
 assert.equal(parseReportedPanels({...value,panels:{...value.panels,residual:{...panel,formatted_colorbar:bar}}},update).panels.residual?.formatted_colorbar?.ticks.length,3);
 assert.throws(()=>parseReportedPanels({...value,panels:{...value.panels,residual:{...panel,formatted_colorbar:{...bar,ticks:[...bar.ticks].reverse()}}}},update));
});
test('preflight parameters follow the current reported run and retain only saved settings',()=>{
 const old={id:'old',kind:'stage',stage:'preflight',path:'/output/old/lens/preflight/inspector.json'} as AgentUpdate;
 const latest={...old,id:'latest',path:'/output/new/lens/preflight/inspector.json'};
 assert.equal(selectStageResults([old,latest],'preflight').summary?.id,'latest');
 const value={schema:'tinylens.readonly-result.v1',kind:'preflight',stage:'preflight',attempt:null,path:latest.path,config:{settings:{detection_threshold:3,minimum_connected_pixels:5,inspector_count:3}}};
 assert.equal(parseLiveResult(value,latest).config?.settings?.modeling_radius,undefined);
 assert.throws(()=>parseLiveResult({...value,path:old.path},latest));
 assert.throws(()=>parseLiveResult({...value,attempt:0},latest));
 assert.throws(()=>parseLiveResult({...value,kind:'weighted_posterior',parameters:[]},latest));
 assert.throws(()=>parseLiveResult({...value,config:{settings:{theta_E_hint:1.5}}},latest));
});

const artifact = (id: string, run: string, attempt: number, file: string, stage = 'a'): AgentUpdate => ({ id, kind: 'artifact', stage, path: `/project/output/${run}/lens/attempts/${stage}/${attempt}/${file}` });
test('derived total-model and per-pixel chi-square planes retain the reported attempt and raw numeric range',()=>{
 const update=artifact('summary','run',0,'stage-result.json');
 const plane={...numericalFixture([151,151]),shape:[151,151],bounds_arcsec:[-3.775,3.775,-3.775,3.775],half_extent_arcsec:3.775,vmin:0,vmax:9,data_min:0,data_max:64,stretch:'linear',asinh_a:1};
 const value={schema:'tinylens.readonly-result.v1',kind:'summary',stage:'a',attempt:0,path:update.path,result:{stage:'a',attempt:0,metrics:{}},planes:{model:plane,'chi-square':plane}};
 assert.equal(parseLiveResult(value,update).planes?.['chi-square']?.data_max,64);
 assert.throws(()=>parseLiveResult({...value,attempt:1},update));
 assert.throws(()=>parseLiveResult({...value,planes:{...value.planes,model:{...plane,src:'/demo/model.png'}}},update));
});
test('changing run or attempt never mixes old posterior, summary or diagnostic images', () => {
  const updates = [artifact('old-json', 'run1', 0, 'stage-result.json'), artifact('old-samples', 'run1', 0, 'artifacts/stage_a.pkl'), artifact('old-image', 'run1', 0, 'diagnostics/model.png'), artifact('new-json', 'run2', 0, 'stage-result.json'), artifact('new-image', 'run2', 0, 'diagnostics/model.png')];
  const selected = selectStageResults(updates, 'a');
  assert.equal(selected.summary?.id, 'new-json');
  assert.equal(selected.posterior, undefined);
  assert.deepEqual(selected.images.map(item => item.id), ['new-image']);
  updates.push(artifact('attempt1', 'run2', 1, 'effective-config.json'));
  const next = selectStageResults(updates, 'a');
  assert.equal(next.identity?.attempt, 1);
  assert.equal(next.summary, undefined);
  assert.deepEqual(next.images, []);
});
test('latest report of the same image replaces only that image and never infers stage from a filename', () => {
  const image = artifact('first', 'run1', 0, 'diagnostics/model.png');
  const selected = selectStageResults([image, { ...image, id: 'latest' }, { id: 'unassigned', kind: 'artifact', path: '/project/stage_a.png' }], 'a');
  assert.deepEqual(selected.images.map(item => item.id), ['latest']);
  assert.deepEqual(selectStageResults([image], 'b').images, []);
});
test('transport results must match the requested identity and carry real finite histogram data', () => {
  const update = artifact('samples', 'run1', 0, 'artifacts/stage_a.pkl');
  const value = { schema: 'tinylens.readonly-result.v1', kind: 'weighted_posterior', stage: 'a', attempt: 0, path: update.path, parameters: [{ name: 'x', q16: 0, q50: 1, q84: 2, edges: [0, 1, 2], density: [.5, .5], shown_probability: 1 }] };
  assert.equal(parseLiveResult(value, update).parameters?.length, 1);
  assert.throws(() => parseLiveResult({ ...value, attempt: 1 }, update));
  assert.throws(() => parseLiveResult({ ...value, parameters: [{ ...value.parameters[0], density: [NaN, .5] }] }, update));
  assert.throws(() => parseLiveResult({ ...value, parameters: [{ ...value.parameters[0], edges: [0, 1] }] }, update));
});

test('saved source geometry cannot be replaced by centred prototype coordinates or external images', () => {
  const update=artifact('source','run1',0,'artifacts/stage_m1.pkl','m1');
  const plane={...numericalFixture([80,80]),shape:[80,80],bounds_arcsec:[-.65,.95,-.86,.74],half_extent_arcsec:.8,vmin:-.1,vmax:2,stretch:'linear'};
  const value={schema:'tinylens.readonly-result.v1',kind:'weighted_posterior',stage:'m1',attempt:0,path:update.path,parameters:[],planes:{source:plane}};
  assert.deepEqual(parseLiveResult(value,update).planes?.source?.bounds_arcsec,plane.bounds_arcsec);
  assert.throws(()=>parseLiveResult({...value,planes:{source:{...plane,half_extent_arcsec:4}}},update));
  assert.throws(()=>parseLiveResult({...value,planes:{source:{...plane,src:'/demo/source.png'}}},update));
  assert.throws(()=>parseLiveResult({...value,planes:{source:{...plane,bounds_arcsec:[0,1,0,NaN]}}},update));
});

test('mask previews preserve their stage and cannot invent the valid domain coverage',()=>{
  const update=artifact('mask','run1',0,'stage-result.json','b');
  const mask={background_src:'data:image/png;base64,iVBORw0KGgo=',overlay_src:'data:image/png;base64,iVBORw0KGgo=',shape:[151,151],pixel_scale_arcsec:.05,included:1757,domain_pixels:19469};
  const value={schema:'tinylens.readonly-result.v1',kind:'summary',stage:'b',attempt:0,path:update.path,result:{stage:'b',attempt:0,metrics:{}},mask};
  assert.throws(()=>parseLiveResult(value,update),/数值掩膜/);
  assert.throws(()=>parseLiveResult({...value,mask:{...mask,domain_pixels:100}},update));
  assert.throws(()=>parseLiveResult({...value,mask:{...mask,shape:[96,96]}},update));
});
