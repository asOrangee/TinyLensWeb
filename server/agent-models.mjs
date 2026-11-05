import { connectionConfig } from './connection-config.mjs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportedResult} from './agent-results.mjs';
import {WORKSPACE} from './agent-state.mjs';
import {numericalPlane} from './numeric-payload.mjs';

export const MODEL_READER=await readFile(new URL('./reconstruct-models.py',import.meta.url),'utf8');
const cacheDirectoryDefault=fileURLToPath(new URL('../.local/model-cache/',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const pending=new Map();
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const stages=['a','m0','m1','m2'];

/** Resolve only explicit reports in one run; never guess an upstream attempt. */
export function reportedModelPlan(state,updateId){
 const target=reportedResult(state,updateId);
 if(target.kind!=='summary'||!stages.includes(target.stage))throw Error('A reported modeling-stage summary is required.');
 const run=target.path.replace(/\/attempts\/(a|m0|m1|m2)\/\d+\/stage-result\.json$/,'');
 const position=state.updates.findIndex(u=>u.id===updateId);
 const required=target.stage==='a'?['a']:target.stage==='m2'?['a','b','m0','m1','m2']:['a','b',target.stage];
 const files={};
 for(const stage of required){
  let summary=target.stage===stage?state.updates[position]:undefined;
  if(!summary){
   const attempts=new Map();
   for(const update of state.updates.slice(0,position+1)){
    if(update.threadId!==state.threadId)continue;
    let result;try{result=reportedResult(state,update.id)}catch{continue;}
    if(result.kind==='summary'&&result.stage===stage&&result.path.startsWith(run+'/attempts/'))attempts.set(result.path,update);
   }
   if(attempts.size!==1)throw Error('The saved display has no unambiguous reported upstream attempt.');
   summary=[...attempts.values()][0];
  }
  const identity=reportedResult(state,summary.id),base=dirname(identity.path);
  const posterior=state.updates.filter(u=>u.threadId===state.threadId&&u.kind==='artifact'&&u.path===base+'/artifacts/stage_'+stage+'.pkl').at(-1);
  if(stage!=='b'&&!posterior)throw Error('The saved model pickle has not been reported.');
  if(posterior)reportedResult(state,posterior.id);
  files[stage]={summary:identity.path,summaryReportId:summary.id,attempt:identity.attempt,
   ...(posterior?{posterior:posterior.path,posteriorReportId:posterior.id}:{})};
 }
 return {root:WORKSPACE,run,stage:target.stage,files};
}

export function validateModelDisplay(value,plan){
 const target=plan.files[plan.stage],derived=value?.display_derivation,stats=derived?.statistics;
 if(value?.schema!=='tinylens.readonly-result.v1'||value.kind!=='summary'||value.stage!==plan.stage||value.attempt!==target.attempt||value.path!==target.summary||!/^[a-f0-9]{64}$/.test(value.sha256??'')||value.result?.stage!==plan.stage||value.result?.attempt!==target.attempt)throw Error('Derived model identity mismatch.');
 if(!derived||derived.schema!=='tinylens.model-display-derivation.v1'||derived.chi_square_expression!=='((data - model) / noise_rms)^2'||derived.chi_square_is_reduced!==false||derived.support!=='full_image_grid'||derived.fit_support!=='actual_likelihood_mask'||derived.full_output!=='same_scientific_operator_before_active_pixel_indexing'||!Number.isInteger(stats?.pixel_count)||stats.pixel_count<=0||![stats.rms,stats.chi_square_sum].every(Number.isFinite)||stats.rms<0||stats.chi_square_sum<0||Math.abs(stats.chi_square_sum-stats.rms**2*stats.pixel_count)>1e-8*Math.max(1,stats.chi_square_sum))throw Error('Invalid derived chi-square definition.');
 const estimate=plan.stage==='m0'?'saved_evidence_scan_choice_and_conditional_linear_solution':'saved_posterior_medians_and_conditional_linear_solution';
 const method=plan.stage==='m1'?'saved_source_pixels_full_operator_output':'frozen_parameters_conditional_linear_diagnostic_reconstruction';
 if(derived.estimate!==estimate||derived.method!==method)throw Error('The stage diagnostic reference point is mislabeled.');
 if(Object.keys(value.planes??{}).sort().join()!=='chi-square,model,observation,residual,source,source-lensed')throw Error('Only the six prototype image planes may be displayed.');
 const png=src=>typeof src==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)&&Buffer.from(src.slice(22),'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 for(const [name,plane] of Object.entries(value.planes)){
  if(!png(plane.src)||!png(plane.colormap_src)||!Array.isArray(plane.shape)||plane.shape.length!==2||!plane.shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||!Array.isArray(plane.bounds_arcsec)||plane.bounds_arcsec.length!==4||![...plane.bounds_arcsec,plane.vmin,plane.vmax,plane.data_min,plane.data_max,plane.half_extent_arcsec].every(Number.isFinite)||plane.vmax<plane.vmin||plane.data_max<plane.data_min||plane.valid_pixel_count!==plane.shape[0]*plane.shape[1]||plane.bounds_arcsec[0]>=plane.bounds_arcsec[1]||plane.bounds_arcsec[2]>=plane.bounds_arcsec[3]||Math.abs(plane.bounds_arcsec[3]-plane.bounds_arcsec[2]-2*plane.half_extent_arcsec)>1e-10||!['linear','asinh'].includes(plane.stretch)||!/^[a-f0-9]{64}$/.test(plane.mask_sha256??'')||!/^[a-f0-9]{64}$/.test(plane.array_sha256??'')||!/^[a-f0-9]{64}$/.test(plane.input_fits_sha256??''))throw Error('Invalid derived model pixels.');
  if(name!=='source'&&(JSON.stringify(plane.shape)!==JSON.stringify(value.planes.observation.shape)||JSON.stringify(plane.bounds_arcsec)!==JSON.stringify(value.planes.observation.bounds_arcsec)))throw Error('Image-plane frames must agree.');
  if(plane.input_fits_sha256!==value.planes.observation.input_fits_sha256)throw Error('Image inputs must agree.');
  {
   const raw=Buffer.from(plane.values_base64??'','base64'),mask=Buffer.from(plane.mask_base64??'','base64'),size=plane.shape[0]*plane.shape[1];
   if(raw.length!==size*8||mask.length!==size||mask.some(v=>v!==1)||mask.reduce((n,v)=>n+v,0)!==plane.valid_pixel_count||sha(raw)!==plane.values_sha256||sha(mask)!==plane.mask_sha256||plane.array_y_direction!=='increasing')throw Error('Invalid intensity-scale pixels.');
   for(let i=0;i<size;i++)if(!Number.isFinite(raw.readDoubleLE(i*8)))throw Error('Nonfinite intensity pixels.');
  }
 }
 const fitMask=Buffer.from(derived.fit_mask_base64??'','base64'),size=value.planes.observation.shape[0]*value.planes.observation.shape[1];
 if(fitMask.length!==size||fitMask.some(v=>v!==0&&v!==1)||fitMask.reduce((n,v)=>n+v,0)!==stats.pixel_count||sha(fitMask)!==derived.fit_mask_sha256||!Number.isFinite(derived.projection_max_difference_on_fit_pixels)||derived.projection_max_difference_on_fit_pixels<0)throw Error('Invalid independent likelihood mask.');
 const full=derived.full_grid_statistics;
 if(full?.pixel_count!==size||![full.rms,full.chi_square_sum].every(Number.isFinite)||full.rms<0||full.chi_square_sum<0||Math.abs(full.chi_square_sum-full.rms**2*size)>1e-8*Math.max(1,full.chi_square_sum))throw Error('Invalid complete-grid statistics.');
 if(value.planes.model.mask_sha256!==value.planes['chi-square'].mask_sha256)throw Error('Model and chi-square masks must agree.');
 for(const name of ['residual','source-lensed'])if(value.planes[name].mask_sha256!==value.planes.model.mask_sha256)throw Error('Display coverage must agree.');
 const mapping=value.display_mapping;
 if(mapping?.schema!=='tinylens.lens-mapping.v1'||mapping.synthetic!==false||mapping.stage!==value.stage||mapping.attempt!==value.attempt||mapping.path!==value.path||mapping.summary_sha256!==value.sha256||mapping.fits_sha256!==value.planes.observation.input_fits_sha256||mapping.model?.kind!=='sie-shear'||!['theta_E','e1_mass','e2_mass','center_x_mass','center_y_mass','gamma1','gamma2'].every(k=>Number.isFinite(mapping.model[k]))||mapping.model.theta_E<=0||!Array.isArray(mapping.references)||mapping.references.length<5||mapping.references.some(ray=>![ray.image?.x,ray.image?.y,ray.source?.x,ray.source?.y].every(Number.isFinite)))throw Error('Invalid frozen lens mapping.');
 for(const [space,name] of [['image','model'],['source','source']])for(const key of ['shape','bounds_arcsec','half_extent_arcsec'])if(JSON.stringify(mapping.frames?.[space]?.[key])!==JSON.stringify(value.planes[name][key]))throw Error('Lens mapping frame mismatch.');
 for(const entry of Object.values(plan.files))for(const key of ['summary','posterior'])if(entry[key]&&!/^[a-f0-9]{64}$/.test(derived.input_files_sha256?.[entry[key]]??''))throw Error('The diagnostic dependency was not verified.');
 return value;
}

export async function readReportedModel(state,updateId,{spawnProcess=spawn,cacheDirectory=cacheDirectoryDefault,timeoutMs=180000}={}){
 const plan=reportedModelPlan(state,updateId),identity=JSON.stringify({threadId:state.threadId,updateId,plan,reader:sha(MODEL_READER)}),key=sha(identity);
 const path=join(cacheDirectory,key+'.json');
 try{
  const record=JSON.parse(await readFile(path,'utf8'));
  if(record.identity!==identity||record.sha256!==sha(JSON.stringify(record.value)))throw Error('Derived cache checksum mismatch.');
  return validateModelDisplay(record.value,plan);
 }catch{/* Rebuild only these explicitly reported, frozen diagnostics. */}
 if(pending.has(path))return pending.get(path);
 const operation=(async()=>{
  const value=await new Promise((resolve,reject)=>{
   const command=`env PYTHONDONTWRITEBYTECODE=1 CUDA_VISIBLE_DEVICES= JAX_PLATFORMS=cpu OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MPLBACKEND=Agg ${quote(connectionConfig.python)} -B -c ${quote(MODEL_READER)}`;
   const proc=spawnProcess('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10',connectionConfig.sshHost,command],{stdio:['pipe','pipe','pipe']});
   const chunks=[];let bytes=0,done=false;
   const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result)};
   const timer=setTimeout(()=>{proc.kill();finish(Error('Frozen diagnostic reconstruction timed out.'));},timeoutMs);
   proc.on('error',e=>finish(e));proc.stdin.on('error',e=>finish(e));proc.stderr.resume();
   proc.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){proc.kill();finish(Error('Diagnostic display is too large.'))}else chunks.push(chunk)});
   proc.on('close',code=>{if(code!==0)return finish(Error('The frozen diagnostic could not be reconstructed and verified.'));
    try{finish(null,validateModelDisplay(JSON.parse(Buffer.concat(chunks).toString('utf8')),plan))}catch(error){finish(error)}});
   proc.stdin.end(JSON.stringify(plan)+'\n');
  });
  await mkdir(cacheDirectory,{recursive:true,mode:0o700});const tmp=path+randomUUID();
  await writeFile(tmp,JSON.stringify({identity,sha256:sha(JSON.stringify(value)),value}),{mode:0o600});await rename(tmp,path);
  return value;
 })();
 pending.set(path,operation);try{return await operation}finally{pending.delete(path)}
}

export async function serveReportedModel(request,response,state,options={}){
 try{
  const query=new URL(request.url,'http://localhost').searchParams;
  if([...query.keys()].some(k=>k!=='updateId')||query.getAll('updateId').length!==1)throw Error('A model report identifier is required.');
  const value=await readReportedModel(state,query.get('updateId'),options);
  const payload={...value,planes:Object.fromEntries(Object.entries(value.planes).map(([name,plane])=>[name,numericalPlane(plane)]))};
  response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(payload));
 }catch(error){response.writeHead(404,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify({error:error.message}))}
}
