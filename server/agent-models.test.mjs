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
 for(const tag of ['a','b','m0','m1','m2'].slice(0,['a','b','m0','m1','m2'].indexOf(stage)+1)){
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
