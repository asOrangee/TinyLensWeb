import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {MODEL_READER,reportedModelPlan,validateModelDisplay,readReportedModel,serveReportedModel} from './agent-models.mjs';
import {WORKSPACE} from './agent-state.mjs';

const run=WORKSPACE+'/output/run/lens';
const report=(stage,file,id=stage+'-'+file,attempt=0)=>({id,threadId:'bound',stage,kind:'artifact',path:run+'/attempts/'+stage+'/'+attempt+'/'+file});
function state(stage='m1'){
 const updates=[];
 const stages=['a','b','m0','m1','m2','m3'];
 for(const tag of stages.slice(0,stages.indexOf(stage)+1)){
  updates.push(report(tag,'stage-result.json',tag+'-summary'));
  if(tag!=='b')updates.push(report(tag,'artifacts/stage_'+tag+'.pkl',tag+'-pkl'));
 }
 return {threadId:'bound',updates};
}
const png='data:image/png;base64,iVBORw0KGgo=';
function value(plan){
 const hash=v=>createHash('sha256').update(v).digest('hex'),raw=Buffer.alloc(32);for(let i=0;i<4;i++)raw.writeDoubleLE(i,i*8);const mask=Buffer.from([1,1,1,1]),fitMask=Buffer.from([1,0,0,1]);
 const target=plan.files[plan.stage],plane={src:png,colormap_src:png,colormap:'magma',shape:[2,2],bounds_arcsec:[-.1,.1,-.1,.1],half_extent_arcsec:.1,vmin:0,vmax:9,data_min:0,data_max:64,stretch:'linear',asinh_a:1,valid_pixel_count:4,array_sha256:hash(raw),mask_sha256:hash(mask),input_fits_sha256:'c'.repeat(64)},numeric={...plane,values_base64:raw.toString('base64'),values_sha256:hash(raw),mask_base64:mask.toString('base64'),array_y_direction:'increasing'};
 const hashes={};for(const file of Object.values(plan.files))for(const k of ['summary','posterior'])if(file[k])hashes[file[k]]='d'.repeat(64);
 const frame={shape:plane.shape,bounds_arcsec:plane.bounds_arcsec,half_extent_arcsec:plane.half_extent_arcsec};
 return {schema:'tinylens.readonly-result.v1',kind:'summary',stage:plan.stage,attempt:target.attempt,path:target.summary,sha256:'e'.repeat(64),result:{stage:plan.stage,attempt:target.attempt,metrics:{}},planes:{model:{...numeric},observation:{...numeric},'source-lensed':{...numeric},source:{...numeric},residual:{...numeric},'chi-square':{...numeric}},display_mapping:{schema:'tinylens.lens-mapping.v1',synthetic:false,stage:plan.stage,attempt:target.attempt,path:target.summary,summary_sha256:'e'.repeat(64),fits_sha256:'c'.repeat(64),model:{kind:'sie-shear',theta_E:1,e1_mass:0,e2_mass:0,center_x_mass:0,center_y_mass:0,gamma1:0,gamma2:0},frames:{image:frame,source:frame},references:Array.from({length:5},()=>({image:{x:1,y:0},source:{x:0,y:0}}))},display_derivation:{schema:'tinylens.model-display-derivation.v1',chi_square_expression:'((data - model) / noise_rms)^2',chi_square_is_reduced:false,support:'full_image_grid',fit_support:'actual_likelihood_mask',full_output:'same_scientific_operator_before_active_pixel_indexing',fit_mask_base64:fitMask.toString('base64'),fit_mask_sha256:hash(fitMask),projection_max_difference_on_fit_pixels:0,full_grid_statistics:{pixel_count:4,rms:4,chi_square_sum:64},method:plan.stage==='m1'?'saved_source_pixels_full_operator_output':'frozen_parameters_conditional_linear_diagnostic_reconstruction',estimate:plan.stage==='m0'?'saved_evidence_scan_choice_and_conditional_linear_solution':'saved_posterior_medians_and_conditional_linear_solution',statistics:{pixel_count:2,rms:Math.sqrt(32),chi_square_sum:64},input_files_sha256:hashes}};
}
test('model reconstruction is bound to explicit reported attempts and never chooses ambiguous upstream results',()=>{
 const current=state(),plan=reportedModelPlan(current,'m1-summary');
 assert.deepEqual(Object.keys(plan.files),['a','b','m1']);
 assert.equal(plan.files.m1.posterior,run+'/attempts/m1/0/artifacts/stage_m1.pkl');
 assert.throws(()=>reportedModelPlan(current,'m1-pkl'));
 assert.throws(()=>reportedModelPlan({...current,threadId:'foreign'},'m1-summary'));
 assert.throws(()=>reportedModelPlan({threadId:'bound',updates:current.updates.filter(r=>r.id!=='a-pkl')},'m1-summary'));
 const changed={...current,updates:[...current.updates]};changed.updates.splice(2,0,report('a','stage-result.json','new-a',1));
 assert.throws(()=>reportedModelPlan(changed,'m1-summary'),/unambiguous/);
 // A later run/attempt report cannot silently replace an upstream of this result.
 current.updates.push(report('a','stage-result.json','later-a',1));
 assert.equal(reportedModelPlan(current,'m1-summary').files.a.attempt,0);
 assert.deepEqual(Object.keys(reportedModelPlan(state('m2'),'m2-summary').files),['a','b','m0','m1','m2']);
});

test('M3 renders six numerical planes from one attempt with the reported M2 dependency',()=>{
 const current=state('m3'),plan=reportedModelPlan(current,'m3-summary');
 assert.deepEqual(Object.keys(plan.files),['a','b','m0','m1','m2','m3']);
 assert.equal(plan.files.m2.posteriorReportId,'m2-pkl');
 const {display_mapping,...numeric}=value(plan);
 assert.equal(validateModelDisplay(numeric,plan),numeric);
 assert.throws(()=>validateModelDisplay({...numeric,display_mapping},plan),/Invalid frozen lens mapping/);
 const epl={...display_mapping,model:{...display_mapping.model,kind:'epl-shear',gamma:1.95},
  references:display_mapping.references.map(ray=>({...ray,determinant:-.1}))};
 const {theta_E,gamma,e1_mass,e2_mass,gamma1,gamma2}=epl.model;
 numeric.result.metrics.medians={theta_E,gamma,e1_mass,e2_mass,gamma1,gamma2};
 assert.equal(validateModelDisplay({...numeric,display_mapping:epl},plan).display_mapping,epl);
 assert.throws(()=>validateModelDisplay({...numeric,display_mapping:{...epl,model:{...epl.model,gamma:2}}},plan),/EPL parameters/);
 assert.throws(()=>reportedModelPlan({...current,updates:current.updates.filter(r=>r.id!=='m2-pkl')},'m3-summary'),/pickle has not been reported/);
 const wrongAttempt=current.updates.filter(r=>r.id!=='m3-pkl').concat(report('m3','artifacts/stage_m3.pkl','other-m3-pkl',1));
 assert.throws(()=>reportedModelPlan({...current,updates:wrongAttempt},'m3-summary'),/pickle has not been reported/);
});

test('derived displays keep full coverage separate from the likelihood mask and verify dependencies',()=>{
 const plan=reportedModelPlan(state(),'m1-summary'),good=value(plan);
 assert.equal(validateModelDisplay(good,plan),good);
 for(const change of [{stage:'m0'},{path:'/other'},{attempt:1},{planes:{...good.planes,debug:good.planes.model}},{display_derivation:{...good.display_derivation,chi_square_is_reduced:true}},{display_derivation:{...good.display_derivation,input_files_sha256:{}}},{display_derivation:{...good.display_derivation,statistics:{pixel_count:4,rms:4,chi_square_sum:1}}},{planes:{...good.planes,'chi-square':{...good.planes['chi-square'],mask_sha256:'f'.repeat(64)}}}])assert.throws(()=>validateModelDisplay({...good,...change},plan));
 for(const change of [{fit_mask_base64:'AAAAAA=='},{fit_mask_sha256:'0'.repeat(64)},{support:'actual_likelihood_mask_only'},{full_grid_statistics:{pixel_count:2,rms:4,chi_square_sum:32}}])assert.throws(()=>validateModelDisplay({...good,display_derivation:{...good.display_derivation,...change}},plan));
 const m0=reportedModelPlan(state('m0'),'m0-summary'),m0value=value(m0);assert.equal(validateModelDisplay(m0value,m0),m0value);
 assert.throws(()=>validateModelDisplay({...m0value,display_derivation:{...m0value.display_derivation,estimate:good.display_derivation.estimate}},m0));
});

test('full-grid pixels cannot reintroduce display masking or claim external images',()=>{
 const plan=reportedModelPlan(state(),'m1-summary'),good=value(plan);
 for(const change of [{src:'/demo/model.png'},{valid_pixel_count:5},{data_min:70},{shape:[1,1]},{bounds_arcsec:[0,NaN,0,1]},{mask_sha256:'bad'},{values_sha256:'0'.repeat(64)},{mask_base64:'AAAAAA=='},{mask_base64:Buffer.from([1,0,1,1]).toString('base64')}])assert.throws(()=>validateModelDisplay({...good,planes:{...good.planes,model:{...good.planes.model,...change}}},plan));
 assert.throws(()=>validateModelDisplay({...good,display_mapping:{...good.display_mapping,synthetic:true}},plan));
 assert.throws(()=>validateModelDisplay({...good,display_mapping:{...good.display_mapping,frames:{...good.display_mapping.frames,source:{...good.display_mapping.frames.source,bounds_arcsec:[0,1,0,1]}}}},plan));
});

function fakeReader(payload,onPlan=()=>{}){
 return (_command,args)=>{
  assert.equal(args[0],'-T');assert.match(args.at(-1),/JAX_PLATFORMS=cpu/);assert.match(args.at(-1),/CUDA_VISIBLE_DEVICES= /);
  const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{};
  let input='';proc.stdin.on('data',c=>input+=c);proc.stdin.on('finish',()=>queueMicrotask(()=>{onPlan(JSON.parse(input));proc.stdout.end(JSON.stringify(payload));proc.emit('close',0)}));return proc;
 };
}
test('verified model displays survive service reloads and reject modified cache records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tinylens-model-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const current=state(),plan=reportedModelPlan(current,'m1-summary'),payload=value(plan);let requests=0;
 const read=()=>readReportedModel(current,'m1-summary',{cacheDirectory:dir,spawnProcess:fakeReader(payload,p=>{requests++;assert.deepEqual(p,plan)})});
 assert.deepEqual(await read(),payload);assert.equal(requests,1);
 assert.deepEqual(await read(),payload);assert.equal(requests,1);
 const path=join(dir,(await readdir(dir))[0]),record=JSON.parse(await readFile(path,'utf8'));record.sha256='0'.repeat(64);await writeFile(path,JSON.stringify(record));
 assert.deepEqual(await read(),payload);assert.equal(requests,2);
 await assert.rejects(readReportedModel({...current,threadId:'other'},'m1-summary',{cacheDirectory:dir}));
});

test('verified M3 cache from before the PSF adapter survives a reader upgrade',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tinylens-model-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const current=state('m3'),updateId='m3-summary',plan=reportedModelPlan(current,updateId);
 const payload=value(plan),mapping=payload.display_mapping;
 mapping.model={...mapping.model,kind:'epl-shear',gamma:1.95};
 mapping.references=mapping.references.map(ray=>({...ray,determinant:-.1}));
 payload.result.metrics.medians=mapping.model;
 const identity=JSON.stringify({threadId:current.threadId,updateId,plan,reader:'5addce22452405ef0e06f37007c475dbb37ac33d0af886387b9f5fdb923cb7f1'});
 const hash=text=>createHash('sha256').update(text).digest('hex');
 await writeFile(join(dir,hash(identity)+'.json'),JSON.stringify({identity,sha256:hash(JSON.stringify(payload)),value:payload}));
 const offline=()=>{throw new Error('a validated cache must be available offline');};
 assert.deepEqual(await readReportedModel(current,updateId,{cacheDirectory:dir,spawnProcess:offline}),payload);
});

test('the read-only HTTP channel accepts only a report identifier',async()=>{
 const response={writeHead(status){this.status=status},end(body){this.body=JSON.parse(body)}};
 await serveReportedModel({url:'/api/agent/model?updateId=m1-summary&path=/other'},response,state());
 assert.equal(response.status,404);assert.match(response.body.error,/identifier/);
});

const python=process.env.TINYLENS_RESULT_TEST_PYTHON||'python3';
const numpy=spawnSync(python,['-B','-c','import numpy']).status===0;
test('numeric derivation preserves raw chi-square tails, boolean index order, RMS noise and likelihood masks',{skip:!numpy},()=>{
 const code=`import importlib.util,sys,numpy as np\nspec=importlib.util.spec_from_file_location('model_display',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nimage=np.array([[1.,3.],[8.,9.]])\nnoise=np.ones((2,2));light=np.ones((2,2));valid=np.array([[True,False],[False,True]])\nsource=np.array([[0.,1.],[2.,0.]])\nreference={'pixel_count':2,'rms':np.sqrt(32.),'abs_gt_3sigma_fraction':.5,'abs_gt_5sigma_fraction':.5}\nmodel,residual,chi,stats=m.diagnostic_arrays(image,noise,light,source,valid,reference)\nassert np.array_equal(model,light+source)\nassert chi[1,1]==64 and chi[1,1]>9\nassert stats['chi_square_sum']==64 and stats['pixel_count']==2\nassert np.array_equal(residual[valid],[0.,8.])\nassert residual[0,1]==1 and residual[1,0]==5 and chi[1,0]==25\nassert chi.sum()==90 and model[0,1]==2 and model[1,0]==3\nfor bad_noise,bad_valid,bad_reference in [(noise*0,valid,reference),(noise,np.ones((3,3),bool),reference),(noise,valid,{**reference,'rms':1.})]:\n try:m.diagnostic_arrays(image,bad_noise,light,source,bad_valid,bad_reference)\n except ValueError:pass\n else:raise AssertionError('Invalid diagnostic accepted')\ncompile(sys.argv[2],'<model-reader>','exec')\n`;
 const result=spawnSync(python,['-B','-c',code,fileURLToPath(new URL('./reconstruct-models.py',import.meta.url)),MODEL_READER],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

test('full-grid reconstruction uses the fitted PSF geometry and preserves exact fit pixels',{skip:!numpy},()=>{
 const code=`
import importlib.util
import sys
from types import ModuleType, SimpleNamespace

import numpy as np

spec = importlib.util.spec_from_file_location('model_display', sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
for package in ('TinyLensGpu', 'TinyLensGpu.ForwardSimulation', 'TinyLensGpu.ForwardSimulation.LensImage', 'jax'):
    sys.modules[package] = ModuleType(package)
    sys.modules[package].__path__ = []
sys.modules['jax.numpy'] = sys.modules['jax'].numpy = np

active = np.array([0.2, 0.5])
projection = np.array([[0.2000002, 0.3], [0.4, 0.4999998]])
projection.flags.writeable = False
data = SimpleNamespace(weights=object(), indices=object(), render_parents=object(), nsub=2, n_render=4)
def render_source(pixels, weights, indices, parents, nsub, n_render):
    assert (weights, indices, parents, nsub, n_render) == (data.weights, data.indices, data.render_parents, 2, 4)
    return pixels

operator = SimpleNamespace(__file__=sys.argv[1], render_source=render_source)
sys.modules['TinyLensGpu.ForwardSimulation.LensImage'].pixelized_operator = operator
sim = SimpleNamespace(image_shape=(2, 2), flat_indices=np.array([0, 3]),
                      precompute_operator_data=lambda *args, **kwargs: data,
                      forward_model=lambda *args, **kwargs: active,
                      psf_response=SimpleNamespace(full_image=lambda brightness: projection))
likelihood = SimpleNamespace(sim_obj=sim, _get_bbox=lambda: (0, 1, 0, 1, None, None, None, None))
image, _ = reader.full_operator_image(likelihood, np.ones(4))
np.testing.assert_array_equal(image, [[0.2, 0.3], [0.4, 0.5]])
assert image.flags.writeable

sim.psf_response.full_image = lambda brightness: projection + .01
with np.testing.assert_raises(ValueError):
    reader.full_operator_image(likelihood, np.ones(4))

del sim.psf_response
sim._psf_fft = object()
data.flat_indices, data.agg_segment_ids, data.agg_n_active = sim.flat_indices, None, 2
operator._apply_L_jit = lambda pixels, *args: pixels
operator._psf_convolve_full_jit = lambda image, *args: np.array([0.2, 0.3, 0.4, 0.5])
legacy, _ = reader.full_operator_image(likelihood, np.ones(4))
np.testing.assert_array_equal(legacy, image)
`;
 const result=spawnSync(python,['-B','-c',code,fileURLToPath(new URL('./reconstruct-models.py',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
