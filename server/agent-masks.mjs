import { connectionConfig } from './connection-config.mjs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportedResult} from './agent-results.mjs';
import {WORKSPACE} from './agent-state.mjs';
import {numericalPlane} from './numeric-payload.mjs';

export const MASK_READER=await readFile(new URL('./read-mask.py',import.meta.url),'utf8');
const cacheDefault=fileURLToPath(new URL('../.local/mask-cache/',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const pending=new Map();
export function reportedMask(state,id){const result=reportedResult(state,id);if(result.stage!=='b'||result.kind!=='summary')throw Error('An explicit Stage-B summary is required.');return {root:WORKSPACE,...result};}
export function validateMask(value,request){
 const hash=v=>/^[a-f0-9]{64}$/.test(v??'');
 if(value?.schema!=='tinylens.mask-edit.v1'||value.stage!=='b'||value.path!==request.path||value.attempt!==request.attempt||!hash(value.sha256)||!hash(value.mask_sha256)||!hash(value.domain_sha256)||!hash(value.input_fits_sha256)||value.display_y_direction!=='decreasing'||!Array.isArray(value.shape)||value.shape.length!==2||value.shape[0]!==value.shape[1]||!value.shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||!Number.isFinite(value.pixel_scale_arcsec)||value.pixel_scale_arcsec<=0||value.modeling_radius_arcsec!==null&&(!Number.isFinite(value.modeling_radius_arcsec)||value.modeling_radius_arcsec<=0))throw Error('Invalid editable mask identity.');
 const size=value.shape[0]*value.shape[1],pixels=Buffer.from(value.included_base64??'','base64'),domain=Buffer.from(value.domain_base64??'','base64');
 if(pixels.length!==size||domain.length!==size||pixels.some((v,i)=>v!==0&&v!==1||v>domain[i])||domain.some(v=>v!==0&&v!==1)||pixels.reduce((n,v)=>n+v,0)!==value.included||domain.reduce((n,v)=>n+v,0)!==value.domain_pixels||value.domain_pixels<=0)throw Error('Invalid editable mask pixels.');
 const base=request.path.slice(0,-'stage-result.json'.length),run=request.path.replace(/\/attempts\/b\/\d+\/stage-result.json$/,'');
 if(!value.mask_path?.startsWith(base)||value.mask_path.includes('..')||value.domain_path!==run+'/preflight/modeling_mask.fits'||value.input_files_sha256?.[value.mask_path]!==value.mask_sha256||value.input_files_sha256?.[value.domain_path]!==value.domain_sha256||value.input_files_sha256?.[value.path]!==value.sha256)throw Error('Unverified mask dependencies.');
 const p=value.plane,raw=Buffer.from(p?.values_base64??'','base64'),valid=Buffer.from(p?.mask_base64??'','base64');
 if(!p||!/^data:image\/png;base64,/.test(p.src)||!/^data:image\/png;base64,/.test(p.colormap_src)||JSON.stringify(p.shape)!==JSON.stringify(value.shape)||p.input_fits_sha256!==value.input_fits_sha256||p.array_y_direction!=='increasing'||raw.length!==size*8||sha(raw)!==p.values_sha256||valid.length!==size||valid.some(v=>v!==1)||p.half_extent_arcsec!==value.shape[0]*value.pixel_scale_arcsec/2||JSON.stringify(p.bounds_arcsec)!==JSON.stringify([-p.half_extent_arcsec,p.half_extent_arcsec,-p.half_extent_arcsec,p.half_extent_arcsec]))throw Error('Invalid mask background geometry.');
 for(let i=0;i<size;i++)if(!Number.isFinite(raw.readDoubleLE(i*8)))throw Error('Invalid background pixels.');
 return value;
}
export async function readReportedMask(state,id,{spawnProcess=spawn,cacheDirectory=cacheDefault,timeoutMs=30000}={}){
 const request=reportedMask(state,id),identity=JSON.stringify([state.threadId,id,request,sha(MASK_READER)]),path=join(cacheDirectory,sha(identity)+'.json');
 try{const stored=JSON.parse(await readFile(path,'utf8'));if(stored.identity!==identity||stored.sha256!==sha(JSON.stringify(stored.value)))throw Error('Invalid mask cache');return validateMask(stored.value,request);}catch{/* Read only this reported mask and its declared frozen inputs. */}
 if(pending.has(path))return pending.get(path);
 const operation=(async()=>{const value=await new Promise((resolve,reject)=>{
  const proc=spawnProcess('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10',connectionConfig.sshHost,`env PYTHONDONTWRITEBYTECODE=1 CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg ${quote(connectionConfig.python)} -B -c ${quote(MASK_READER)}`],{stdio:['pipe','pipe','pipe']});
  const chunks=[];let size=0,done=false;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v)};
  const timer=setTimeout(()=>{proc.kill();finish(Error('Mask read timed out.'));},timeoutMs);
  proc.on('error',e=>finish(e));proc.stdin.on('error',e=>finish(e));proc.stderr.resume();proc.stdout.on('data',c=>{size+=c.length;if(size>4*1024*1024){proc.kill();finish(Error('Mask is too large.'))}else chunks.push(c)});
  proc.on('close',code=>{try{if(code!==0)throw Error('The reported mask could not be read.');finish(null,validateMask(JSON.parse(Buffer.concat(chunks).toString('utf8')),request));}catch(e){finish(e)}});
  proc.stdin.end(JSON.stringify(request)+'\n');
 });await mkdir(cacheDirectory,{recursive:true,mode:0o700});const tmp=path+randomUUID();await writeFile(tmp,JSON.stringify({identity,sha256:sha(JSON.stringify(value)),value}),{mode:0o600});await rename(tmp,path);return value;})();
 pending.set(path,operation);try{return await operation}finally{pending.delete(path)}
}
export async function serveReportedMask(request,response,state,options={}){try{
 const query=new URL(request.url,'http://localhost').searchParams;if([...query.keys()].some(k=>k!=='updateId')||query.getAll('updateId').length!==1)throw Error('A mask report identifier is required.');
 const value=await readReportedMask(state,query.get('updateId'),options),payload={...value,plane:numericalPlane(value.plane)};response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(payload));
 }catch(e){response.writeHead(404,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify({error:e.message}));}}
