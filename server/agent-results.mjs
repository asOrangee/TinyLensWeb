import { connectionConfig } from './connection-config.mjs';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';

const MAX_RESPONSE = 2 * 1024 * 1024;
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
  const match = path.match(/\/attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*)\/(stage-result\.json|artifacts\/stage_(a|m0|m1|m2|m3)\.pkl)$/);
  if (!match || normalizeStage(update.stage) !== match[1] || (match[4] && (match[4] !== match[1] || update.kind !== 'artifact'))) throw new Error('An explicit matching stage result report is required.');
  return { path, stage: match[1], attempt: Number(match[2]), kind: match[4] ? 'posterior' : 'summary' };
}

// This reader is sent over SSH stdin as data. It imports no pipeline modules,
// executes no science stage, and writes neither source nor result files.
export const REMOTE_RESULT_READER = `import sys,json,io,pickle,hashlib
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
def frozen_input(run,settings):
 if not (run/'run-manifest.json').is_file():return None
 from astropy.io import fits
 manifest=json.loads(read_local(run/'run-manifest.json',run,1024*1024))
 if manifest.get('schema_version')!='lens_run_manifest.v1':return None
 lens=Path(manifest['lens_dir']);provenance=json.loads(read_local(lens/'input-provenance.json',root/'output',1024*1024))
 f=Path(provenance['packaged_fits_path'])
 if f.parent!=lens: raise ValueError('Input FITS is not adjacent to its manifest')
 fits_raw=read_local(f,root/'output')
 if hashlib.sha256(fits_raw).hexdigest()!=provenance['packaged_fits_sha256']: raise ValueError('Input display checksum mismatch')
 g=provenance['input_geometry'];pixel=float(g['pixel_scale_arcsec'])
 if not np.isfinite(pixel) or pixel<=0 or manifest['input_geometry']!=g or any(settings.get(k)!=v for k,v in g.items()): raise ValueError('Display geometry disagrees with frozen inputs')
 with fits.open(io.BytesIO(fits_raw),memmap=False) as hdus:
  image=np.asarray(hdus['VIS_FLUX'].data,dtype=float);header=hdus['VIS_FLUX'].header
  if image.ndim!=2 or not 1<=min(image.shape)<=max(image.shape)<=512 or not np.isfinite(image).all():raise ValueError('Invalid declared input image')
  for axis,key in [(1,'input_x_direction'),(2,'input_y_direction')]:
   if g[key] not in ['increasing','decreasing']:raise ValueError('Invalid input axes')
   if 'CDELT'+str(axis) in header and (not np.isclose(header['CDELT'+str(axis)],pixel*(1 if g[key]=='increasing' else -1)) or header.get('CUNIT'+str(axis),'arcsec').lower()!='arcsec'):raise ValueError('Input WCS mismatch')
   if 'CRPIX'+str(axis) in header and not np.isclose(header['CRPIX'+str(axis)],(image.shape[2-axis]+1)/2):raise ValueError('Unsupported input origin')
   if abs(float(header.get('CRVAL'+str(axis),0)))>1e-10:raise ValueError('Unsupported input origin')
 if g['input_y_direction']=='increasing':image=np.flipud(image)
 if g['input_x_direction']=='decreasing':image=np.fliplr(image)
 return image,g,provenance['packaged_fits_sha256']
def png_url(array):
 from PIL import Image
 import base64
 b=io.BytesIO();Image.fromarray(array).save(b,format='PNG');return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()
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
 out['result']=value
 config=path.parent/'effective-config.json'
 if config.is_file():
  resolved=config.resolve(strict=True)
  if resolved.parent!=path.parent or resolved.stat().st_size>1024*1024: raise ValueError('Invalid configuration reference')
  out['config']=json.loads(resolved.read_text())
 run=path.parents[3]
 inputs=frozen_input(run,out.get('config',{}).get('settings',{}))
 if inputs is not None:
  from matplotlib import colormaps
  image,g,input_sha=inputs;pixel=float(g['pixel_scale_arcsec']);lo=float(image.min());hi=float(image.max())
  n=np.full_like(image,.5) if hi==lo else np.arcsinh(25*(image-lo))/np.arcsinh(25*(hi-lo))
  out['planes']={'observation':{'src':png_url(colormaps['magma'](n,bytes=True)[...,:3]),'shape':list(image.shape),'bounds_arcsec':[-image.shape[1]*pixel/2,image.shape[1]*pixel/2,-image.shape[0]*pixel/2,image.shape[0]*pixel/2],'half_extent_arcsec':image.shape[0]*pixel/2,'vmin':lo,'vmax':hi,'data_min':lo,'data_max':hi,'stretch':'asinh','asinh_a':25,'colormap':'magma','colormap_src':png_url(colormaps['magma'](np.linspace(1,0,256)[:,None],bytes=True)[...,:3]),'input_fits_sha256':input_sha}}
 if inputs is not None and request['stage']=='b' and value.get('artifacts',{}).get('feature_mask_fits'):
  from astropy.io import fits
  from PIL import Image
  from matplotlib import colormaps
  import base64
  mask_path=path.parent/value['artifacts']['feature_mask_fits']
  mask_raw=read_local(mask_path,path.parent)
  mask=np.asarray(fits.getdata(io.BytesIO(mask_raw)))
  if mask.ndim!=2 or not 1<=min(mask.shape)<=max(mask.shape)<=512 or not np.isin(mask,[0,1]).all(): raise ValueError('Invalid feature mask')
  settings=out.get('config',{}).get('settings',{})
  domain=np.asarray(fits.getdata(io.BytesIO(read_local(run/'preflight'/'modeling_mask.fits',run))))
  if image.shape!=mask.shape or domain.shape!=mask.shape or not np.isfinite(image).all() or not np.isin(domain,[0,1]).all() or np.any((mask==0)&(domain!=0)): raise ValueError('Mask input alignment mismatch')
  included=int((mask==0).sum());domain_count=int((domain==0).sum())
  if included!=value['metrics']['included_arc_pixels'] or mask.size-included!=value['metrics']['masked_pixels']: raise ValueError('Mask counts disagree with stage result')
  lo=float(image.min());hi=float(image.max());n=np.full_like(image,.5) if hi==lo else (image-lo)/(hi-lo)
  rgb=colormaps['magma'](n,bytes=True)[...,:3]
  rgba=np.zeros((*mask.shape,4),dtype=np.uint8);rgba[np.flipud(mask)==0]=[45,187,145,145]
  out['mask']={'background_src':png_url(rgb),'overlay_src':png_url(rgba),'shape':list(mask.shape),'pixel_scale_arcsec':g['pixel_scale_arcsec'],'included':included,'domain_pixels':domain_count,'modeling_radius_arcsec':settings.get('modeling_radius'),'sha256':hashlib.sha256(mask_raw).hexdigest(),'path':str(mask_path),'input_fits_sha256':input_sha}
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
 if request['stage']=='m0':
  if value.get('samples') is not None or value.get('weights') is not None: raise ValueError('Unexpected M0 samples')
  out['kind']='evidence_scan'
  out['scan']={}
  for label in ['coarse','fine']:
   x=np.asarray(extra['lambda_grid_'+label],dtype=float); y=np.asarray(extra['log_ev_'+label],dtype=float)
   if x.ndim!=1 or x.shape!=y.shape or not 1<=len(x)<=10000 or not np.isfinite(x).all() or not np.isfinite(y).all(): raise ValueError('Invalid evidence scan')
   out['scan'][label]={'log_lambda':x.tolist(),'log_evidence':y.tolist()}
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
`;

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

const diskIdentity=(state,id,result)=>JSON.stringify([state.threadId,id,result.path,digest(REMOTE_RESULT_READER)]);
function validateStoredResult(value,result){
 if(value?.schema!=='tinylens.readonly-result.v1'||value.path!==result.path||value.stage!==result.stage||value.attempt!==result.attempt||!['summary','weighted_posterior','evidence_scan','preflight'].includes(value.kind)||!/^[a-f0-9]{64}$/.test(value.sha256??''))throw new Error('Result cache identity mismatch.');
}
export async function storeReportedResult(state,id,value,{cacheDirectory=resultCacheDirectory}={}){
 const result=reportedResult(state,id);validateStoredResult(value,result);const identity=diskIdentity(state,id,result);
 await mkdir(cacheDirectory,{recursive:true,mode:0o700});const target=join(cacheDirectory,digest(identity)+'.json'),temporary=target+randomUUID();
 await writeFile(temporary,JSON.stringify({identity,value,sha256:digest(JSON.stringify(value))}),{mode:0o600});await rename(temporary,target);
}

export async function readReportedResult(state, updateId, { spawnProcess = spawn, timeoutMs = 30000, cacheDirectory=resultCacheDirectory } = {}) {
  const result = reportedResult(state, updateId);
  const key = JSON.stringify([state.threadId, updateId, result.path]);
  if (spawnProcess === spawn && cache.has(key)) return cache.get(key);
  if(spawnProcess===spawn){try{
   const identity=diskIdentity(state,updateId,result),record=JSON.parse(await readFile(join(cacheDirectory,digest(identity)+'.json'),'utf8'));
   if(record.identity!==identity||record.sha256!==digest(JSON.stringify(record.value)))throw new Error('Invalid result cache.');
   validateStoredResult(record.value,result);return record.value;
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
      if (length > MAX_RESPONSE) { proc.kill(); finish(new Error('Result exceeds display limit.')); }
      else chunks.push(chunk);
    });
    proc.on('close', code => {
      if (code !== 0) return finish(new Error('The reported result could not be read.'));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (value.schema !== 'tinylens.readonly-result.v1' || value.stage !== result.stage || value.attempt !== result.attempt || value.path !== result.path) throw new Error('Result identity mismatch.');
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
  if(spawnProcess===spawn)await storeReportedResult(state,updateId,value,{cacheDirectory}).catch(()=>{});
  return value;
}

export async function serveReportedResult(request, response, state, options = {}) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'updateId') || query.getAll('updateId').length !== 1) throw new Error('A result report identifier is required.');
    const stored = await readReportedResult(state, query.get('updateId'), options);
    const {planes,mask,...payload}=stored;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
