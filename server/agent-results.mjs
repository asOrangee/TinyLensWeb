import { connectionConfig } from './connection-config.mjs';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { withAttemptEvidenceReader } from './attempt-evidence-reader.mjs';

const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_SCAN_RESPONSE = 12 * 1024 * 1024;
const PYTHON = connectionConfig.python;
const cache = new Map();
const resultCacheDirectory=fileURLToPath(new URL('../.local/result-cache/',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const normalizeStage = stage => typeof stage === 'string' ? stage.trim().toLowerCase().replace(/^stage[\s_-]+/, '') : '';

/** Resolve one explicitly reported result, never discover runs or infer acceptance. */
export function reportedResult(state, updateId) {
  const update = state.updates.find(item => item.id === updateId && item.threadId === state.threadId && ['artifact', 'stage'].includes(item.kind));
  if (!update || typeof update.path !== 'string' || !posix.isAbsolute(update.path) || update.path.includes('\0')) throw new Error('AI has not reported this result.');
  const path = posix.normalize(update.path);
  if (!path.startsWith(WORKSPACE + '/output/')) throw new Error('Result is outside the pipeline output directory.');
  if (/\/preflight\/(inspector|inspection)\.json$/.test(path) && normalizeStage(update.stage) === 'preflight') return { path, stage: 'preflight', attempt: null, kind: 'preflight' };
  const match = path.match(/\/attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*)\/(stage-result\.json|decision\.json|artifacts\/stage_(a|m0|m1|m2|m3)\.pkl)$/);
  if (!match || normalizeStage(update.stage) !== match[1] || (match[4] && (match[4] !== match[1] || update.kind !== 'artifact'))) throw new Error('An explicit matching stage result report is required.');
  if (match[3] === 'decision.json' && (match[1] === 'b' || update.kind !== 'artifact' || path !== update.path)) throw new Error('An explicit matching modeling decision is required.');
  return { path, stage: match[1], attempt: Number(match[2]), kind: match[4] ? 'posterior' : 'summary' };
}

// This reader is sent over SSH stdin as data. It imports no pipeline modules,
// executes no science stage, and writes neither source nor result files.
export const REMOTE_RESULT_READER = withAttemptEvidenceReader(`import sys,json,io,pickle,hashlib
from pathlib import Path
import numpy as np
request=json.loads(sys.stdin.readline())
root=Path(request['root']).resolve()
path=Path(request['path']).resolve(strict=True)
if not path.is_relative_to(root/'output'): raise ValueError('Result path leaves output directory')
if path!=root/Path(request['path']).relative_to(Path(request['root'])): raise ValueError('Result reference must identify the actual file')
if not path.is_file() or path.stat().st_size>64*1024*1024: raise ValueError('Result unavailable or too large')
raw=path.read_bytes()
out={'schema':'tinylens.readonly-result.v1','kind':request['kind'],'stage':request['stage'],'attempt':request['attempt'],'path':request['path'],'sha256':hashlib.sha256(raw).hexdigest()}
def read_local(p,base,limit=16*1024*1024):
 resolved=p.resolve(strict=True)
 if resolved!=p or not resolved.is_relative_to(base) or not resolved.is_file() or resolved.stat().st_size>limit: raise ValueError('Invalid declared display input')
 return resolved.read_bytes()
decision=None
if path.name=='decision.json':
 from read_attempt_evidence import decision_evidence,verify_decision_file
 decision=decision_evidence(raw,request['stage'],request['attempt'])
 path=path.parent/'stage-result.json'
 raw=verify_decision_file(decision,path.name,read_local(path,path.parent,1024*1024))
 out['sha256']=hashlib.sha256(raw).hexdigest()
if request['kind']=='declared_posterior':
 summary=json.loads(raw)
 if summary.get('stage')!=request['stage'] or summary.get('attempt')!=request['attempt'] or summary.get('lens_id')!=path.parents[3].name:
  raise ValueError('Declared posterior summary identity mismatch')
 artifact='artifacts/stage_'+request['stage']+'.pkl'
 if summary.get('artifacts',{}).get('stage_pickle')!=artifact: raise ValueError('The reported summary does not declare its saved posterior')
 raw=read_local(path.parent/artifact,path.parent,64*1024*1024)
 if decision is not None: verify_decision_file(decision,'artifact:'+artifact,raw)
 out['summary_sha256']=out['sha256']
 out['sha256']=hashlib.sha256(raw).hexdigest()
if request['kind']=='preflight':
 run=path.parent.parent
 packet_raw=raw if path.name=='inspection.json' else read_local(path.parent/'inspection.json',run,1024*1024)
 packet=json.loads(packet_raw)
 manifest=json.loads(read_local(run/'run-manifest.json',run,1024*1024))
 reported=json.loads(raw)
 if packet.get('schema_version')!='inspection_packet.v5' or manifest.get('schema_version')!='lens_run_manifest.v1' or packet.get('lens_id')!=run.name or reported.get('lens_id')!=run.name or packet.get('lens_dir')!=manifest.get('lens_dir') or packet.get('input_geometry')!=manifest.get('input_geometry'):raise ValueError('Preflight input identity mismatch')
 detection=packet.get('segmentation_detection',{});settings={}
 threshold=detection.get('threshold_sigma');minimum=detection.get('min_connected_pixels')
 if detection.get('method')=='single_threshold' and isinstance(threshold,(int,float)) and np.isfinite(threshold) and threshold>0:settings['detection_threshold']=threshold
 if isinstance(minimum,int) and not isinstance(minimum,bool) and minimum>0:settings['minimum_connected_pixels']=minimum
 votes=[]
 for i in range(3):
  vote_path=path.parent/'inspector-votes'/f'{i}.json'
  if not vote_path.is_file():break
  vote_raw=read_local(vote_path,run,1024*1024);vote=json.loads(vote_raw)
  if vote.get('lens_id')!=run.name or vote.get('disposition') not in ['model','skip','human_review']:raise ValueError('Invalid inspector vote')
  votes.append({'path':str(vote_path),'sha256':hashlib.sha256(vote_raw).hexdigest()})
 if len(votes)==3:settings['inspector_count']=len(votes)
 out['config']={'settings':settings};out['inspection_sha256']=hashlib.sha256(packet_raw).hexdigest();out['votes']=votes
elif request['kind']=='summary':
 value=json.loads(raw)
 if value.get('stage')!=request['stage'] or value.get('attempt')!=request['attempt']: raise ValueError('Result identity mismatch')
 if not isinstance(value.get('metrics'),dict) or not isinstance(value.get('lens_id'),str): raise ValueError('Invalid stage result')
 if decision is not None and value['lens_id']!=path.parents[3].name: raise ValueError('Declared summary belongs to a different lens')
 out['result']=value
 config=path.parent/'effective-config.json'
 if config.is_file():
  config_raw=read_local(config,path.parent,1024*1024)
  if decision is not None: verify_decision_file(decision,config.name,config_raw)
  out['config']=json.loads(config_raw)
else:
 class ArraysOnly(pickle.Unpickler):
  def find_class(self,module,name):
   allowed={('numpy','ndarray'):np.ndarray,('numpy','dtype'):np.dtype}
   for prefix in ['numpy.core.multiarray','numpy._core.multiarray']:
    allowed[(prefix,'_reconstruct')]=np.core.multiarray._reconstruct
    allowed[(prefix,'scalar')]=np.core.multiarray.scalar
   if (module,name) not in allowed: raise ValueError('Unsupported pickle object')
   return allowed[(module,name)]
 value=ArraysOnly(io.BytesIO(raw)).load()
 if not isinstance(value,dict): raise ValueError('Invalid posterior payload')
 extra=value.get('extra',{})
 if isinstance(extra.get('mass_medians_fixed'),dict):
  out['fixed_parameters']={k:float(v) for k,v in extra['mass_medians_fixed'].items() if k in ['theta_E','e1_mass','e2_mass','center_x_mass','center_y_mass','gamma1','gamma2'] and isinstance(v,(int,float)) and np.isfinite(v)}
 if request['stage']=='m3' and isinstance(extra.get('reg_hyperparams_fixed'),dict):
  fixed=out.setdefault('fixed_parameters',{})
  fixed.update({k:float(v) for k,v in extra['reg_hyperparams_fixed'].items() if k in ['log_lambda_reg','adaptive_reg_rho'] and isinstance(v,(int,float)) and np.isfinite(v)})
 if request['stage']=='m0':
  if value.get('samples') is not None or value.get('weights') is not None: raise ValueError('Unexpected M0 samples')
  out['kind']='evidence_scan'
  out['scan']={}
  for label in ['coarse','fine']:
   x=np.asarray(extra['lambda_grid_'+label],dtype=float); y=np.asarray(extra['log_ev_'+label],dtype=float)
   if x.ndim!=1 or x.shape!=y.shape or not 1<=len(x)<=100000 or not np.isfinite(x).all() or not np.isfinite(y).any(): raise ValueError('Invalid evidence scan')
   out['scan'][label]={'log_lambda':x.tolist(),'log_evidence':[float(v) if np.isfinite(v) else None for v in y]}
  out['scan']['log_lambda_best']=float(extra['log_lambda_best'])
 else:
  samples=np.asarray(value['samples'],dtype=float);w=np.asarray(value['weights'],dtype=float);names=value['param_names']
  if not isinstance(names,list) or not 1<=len(names)<=200 or any(not isinstance(n,str) or not n or len(n)>160 for n in names) or len(set(names))!=len(names): raise ValueError('Invalid parameter schema')
  if samples.ndim!=2 or samples.shape[1]!=len(names) or w.shape!=(len(samples),) or len(samples)==0 or not np.isfinite(samples).all() or not np.isfinite(w).all() or np.any(w<0) or not 0<float(w.sum())<float('inf'): raise ValueError('Invalid weighted samples')
  w=w/w.sum();parameters=[]
  for index,name in enumerate(names):
   column=samples[:,index];order=np.argsort(column);cumulative=np.cumsum(w[order]);q=np.interp([.001,.16,.5,.84,.999],cumulative,column[order]);lo=float(column[order[min(int(np.searchsorted(cumulative,.001)),len(column)-1)]]);hi=float(column[order[min(int(np.searchsorted(cumulative,.999)),len(column)-1)]])
   if lo==hi:
    lo=float(column.min());hi=float(column.max())
   if lo==hi:
    lo-=max(abs(lo)*1e-6,1e-9);hi+=max(abs(hi)*1e-6,1e-9)
   hist,edges=np.histogram(column,bins=64,range=(lo,hi),weights=w)
   parameters.append({'name':name,'q16':float(q[1]),'q50':float(q[2]),'q84':float(q[3]),'edges':edges.tolist(),'density':(hist/np.diff(edges)).tolist(),'shown_probability':float(hist.sum())})
  out.update(kind='weighted_posterior',sample_count=len(samples),effective_sample_size=float(1/np.square(w).sum()),parameters=parameters)
 # Only display arrays actually saved by this exact attempt. Do not run a model.
 if request['stage']=='m1' and isinstance(extra.get('s1'),dict) and 'source_image' in extra['s1']:
  from PIL import Image
  from matplotlib import colormaps
  import base64
  saved=extra['s1'];a=np.asarray(saved['source_image'],dtype=float)
  x=np.asarray(saved['source_x_axis'],dtype=float);y=np.asarray(saved['source_y_axis'],dtype=float)
  if a.ndim!=2 or not 2<=min(a.shape)<=max(a.shape)<=512 or not np.isfinite(a).all(): raise ValueError('Invalid saved source image')
  if x.shape!=(a.shape[1],) or y.shape!=(a.shape[0],) or not np.isfinite(x).all() or not np.isfinite(y).all() or not np.all(np.diff(x)>0) or not np.all(np.diff(y)>0): raise ValueError('Invalid saved source axes')
  dx=float(x[1]-x[0]);dy=float(y[1]-y[0])
  if not np.allclose(np.diff(x),dx) or not np.allclose(np.diff(y),dy) or not np.allclose(saved['source_bbox'],[x[0],x[-1],y[0],y[-1]]): raise ValueError('Source image geometry mismatch')
  if not np.array_equal(np.asarray(saved['source_pixels']).reshape(a.shape),a): raise ValueError('Source pixel identity mismatch')
  lo=float(a.min());hi=float(a.max());n=np.full_like(a,.5) if lo==hi else (a-lo)/(hi-lo)
  rgba=colormaps['magma'](np.flipud(n),bytes=True)[...,:3]
  buffer=io.BytesIO();Image.fromarray(rgba).save(buffer,format='PNG');png=buffer.getvalue()
  palette=io.BytesIO();Image.fromarray(colormaps['magma'](np.linspace(1,0,256)[:,None],bytes=True)[...,:3]).save(palette,format='PNG')
  out['planes']={'source':{'src':'data:image/png;base64,'+base64.b64encode(png).decode(),'shape':list(a.shape),'bounds_arcsec':[float(x[0]-dx/2),float(x[-1]+dx/2),float(y[0]-dy/2),float(y[-1]+dy/2)],'half_extent_arcsec':a.shape[0]*dy/2,'vmin':lo,'vmax':hi,'data_min':lo,'data_max':hi,'stretch':'linear','asinh_a':1,'colormap':'magma','colormap_src':'data:image/png;base64,'+base64.b64encode(palette.getvalue()).decode(),'sha256':hashlib.sha256(png).hexdigest(),'array_sha256':hashlib.sha256(a.tobytes()).hexdigest()}}
print(json.dumps(out,allow_nan=False,separators=(',',':')))
`);

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

const previousReaderHash='1f32d30f2ea6cf06a6046a06e77f5f63637ec935642406d9b4279c5381fce151';
const olderReaderHash='405493dc1e98275443748452bc967fce231a22e7c509dd9140d0956baf04931e';
const directSummaryReaderHash='592065bc9fc85d516cd98ac1e5aaf054484bcd33675bb411adbffdc25f37f8cd';
const readerHash=digest(REMOTE_RESULT_READER);
const diskIdentity=(state,id,result,hash=readerHash)=>JSON.stringify([state.threadId,id,result.path,hash,
  ...(result.kind==='declared_posterior'?['posterior']:[])]);
function resultForView(state, id, view) {
  const result = reportedResult(state, id);
  if (view === undefined) return result;
 if (view !== 'posterior' || result.kind !== 'summary' || !['a','m0','m1','m2','m3'].includes(result.stage)) throw new Error('A reported modeling summary is required.');
  return { ...result, kind: 'declared_posterior' };
}
function validateStoredResult(value,result){
 if(value?.schema!=='tinylens.readonly-result.v1'||value.path!==result.path||value.stage!==result.stage||value.attempt!==result.attempt||!['summary','weighted_posterior','evidence_scan','preflight'].includes(value.kind)||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw new Error('Result cache identity mismatch.');
 if(result.kind==='declared_posterior'&&(value.kind!==(result.stage==='m0'?'evidence_scan':'weighted_posterior')||!/^[a-f0-9]{64}$/.test(value.summary_sha256??'')))throw new Error('Result is not bound to the reported summary.');
}
export async function storeReportedResult(state,id,value,{cacheDirectory=resultCacheDirectory,view}={}){
 const result=resultForView(state,id,view);validateStoredResult(value,result);const identity=diskIdentity(state,id,result);
 await mkdir(cacheDirectory,{recursive:true,mode:0o700});const target=join(cacheDirectory,digest(identity)+'.json'),temporary=target+randomUUID();
 await writeFile(temporary,JSON.stringify({identity,value,sha256:digest(JSON.stringify(value))}),{mode:0o600});await rename(temporary,target);
}

export async function readCachedReportedResult(state, id, { cacheDirectory = resultCacheDirectory, view } = {}) {
  const result = resultForView(state, id, view);
  const hashes = [readerHash, directSummaryReaderHash, previousReaderHash, ...(view === undefined ? [olderReaderHash, '405493dc1e98275443748452bc967fce231a22e7c509dd9140d0956baf04931e'] : [])];
  for (const hash of hashes) {
    try {
      const identity=diskIdentity(state,id,result,hash),record=JSON.parse(await readFile(join(cacheDirectory,digest(identity)+'.json'),'utf8'));
      if(record.identity!==identity||record.sha256!==digest(JSON.stringify(record.value)))throw new Error('Invalid result cache.');
      validateStoredResult(record.value,result);
      return record.value;
    } catch { /* Try the previous verified reader, where applicable. */ }
  }
  throw new Error('No verified result cache for this report.');
}

export async function readReportedResult(state, updateId, { spawnProcess = spawn, timeoutMs = 30000, cacheDirectory=resultCacheDirectory, view } = {}) {
  const result = resultForView(state, updateId, view);
  const key = JSON.stringify([state.threadId, updateId, result.path, result.kind]);
  const maxResponse = result.stage === 'm0' && result.kind !== 'summary' ? MAX_SCAN_RESPONSE : MAX_RESPONSE;
  if (spawnProcess === spawn && cache.has(key)) return cache.get(key);
  if(spawnProcess===spawn){try{
   return await readCachedReportedResult(state,updateId,{cacheDirectory,view});
  }catch{/* Only this explicitly reported file may be requested remotely. */}}
  const pending = new Promise((resolve, reject) => {
    const command = `env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 ${shellQuote(PYTHON)} -B -c ${shellQuote(REMOTE_RESULT_READER)}`;
    const proc = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', connectionConfig.sshHost, command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let length = 0, settled = false;
    const chunks = [];
    const finish = (error, data) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { proc.kill(); finish(new Error('Result transfer timed out.')); }, timeoutMs);
    proc.on('error', error => finish(error));
    proc.stdin.on('error', error => finish(error));
    proc.stderr.resume();
    proc.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > maxResponse) { proc.kill(); finish(new Error('Result exceeds display limit.')); }
      else chunks.push(chunk);
    });
    proc.on('close', code => {
      if (code !== 0) return finish(new Error('The reported result could not be read.'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        validateStoredResult(value,result);
        finish(null, value);
      } catch (error) { finish(error); }
    });
    proc.stdin.end(JSON.stringify({ root: WORKSPACE, ...result }) + '\n');
  });
  if (spawnProcess === spawn) {
    cache.set(key, pending);
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    pending.catch(() => cache.delete(key));
  }
  const value=await pending;
  if(spawnProcess===spawn)await storeReportedResult(state,updateId,value,{cacheDirectory,view}).catch(()=>{});
  return value;
}

export async function serveReportedResult(request, response, state, options = {}) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => !['updateId','view'].includes(key)) || query.getAll('updateId').length !== 1 || query.getAll('view').length > 1) throw new Error('A result report identifier is required.');
    const stored = await readReportedResult(state, query.get('updateId'), { ...options, view: query.get('view') ?? undefined });
    const {planes,mask,...payload}=stored;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
