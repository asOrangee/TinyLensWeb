import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportedMask,validateMask,readReportedMask,serveReportedMask,MASK_READER} from './agent-masks.mjs';
import {WORKSPACE} from './agent-state.mjs';
const run=WORKSPACE+'/output/test/lens',path=run+'/attempts/b/0/stage-result.json',state={threadId:'thread',updates:[{id:'b',threadId:'thread',stage:'b',kind:'artifact',path}]},request=reportedMask(state,'b');
const hash=v=>createHash('sha256').update(v).digest('hex'),bytes=Buffer.alloc(32);for(let i=0;i<4;i++)bytes.writeDoubleLE(i+1,i*8);
function value(){return {schema:'tinylens.mask-edit.v1',stage:'b',attempt:0,path,sha256:'a'.repeat(64),mask_path:run+'/attempts/b/0/artifacts/mask.fits',mask_sha256:'d'.repeat(64),domain_path:run+'/preflight/modeling_mask.fits',domain_sha256:'e'.repeat(64),input_fits_sha256:'c'.repeat(64),display_y_direction:'decreasing',shape:[2,2],pixel_scale_arcsec:.1,modeling_radius_arcsec:null,included:2,domain_pixels:3,included_base64:Buffer.from([1,0,1,0]).toString('base64'),domain_base64:Buffer.from([1,1,1,0]).toString('base64'),plane:{src:'data:image/png;base64,iVBORw0KGgo=',colormap_src:'data:image/png;base64,iVBORw0KGgo=',shape:[2,2],input_fits_sha256:'c'.repeat(64),array_y_direction:'increasing',values_base64:bytes.toString('base64'),values_sha256:hash(bytes),mask_base64:Buffer.from([1,1,1,1]).toString('base64'),half_extent_arcsec:.1,bounds_arcsec:[-.1,.1,-.1,.1]},input_files_sha256:{[path]:'a'.repeat(64),[run+'/attempts/b/0/artifacts/mask.fits']:'d'.repeat(64),[run+'/preflight/modeling_mask.fits']:'e'.repeat(64)}};}
test('editable masks require an explicit Stage-B report in this thread',()=>{
 assert.equal(request.path,path);assert.throws(()=>reportedMask({...state,threadId:'other'},'b'));assert.throws(()=>reportedMask({threadId:'thread',updates:[{...state.updates[0],stage:'a',path:path.replace('/b/','/a/')}]},'b'));
 assert.doesNotMatch(MASK_READER,/import .*TinyLens|run_stage_|_sample\(/);
});
test('mask edits retain exact pixels, included polarity, frozen domain and background geometry',()=>{
 const good=value();assert.equal(validateMask(good,request),good);
 for(const change of [{included:3},{domain_pixels:4},{attempt:1},{mask_path:'/outside/mask.fits'},{included_base64:Buffer.from([1,0,1,1]).toString('base64')},{included_base64:Buffer.from([2,0,1,0]).toString('base64')},{domain_path:run+'/other.fits'},{input_files_sha256:{}},{plane:{...good.plane,values_sha256:'0'.repeat(64)}},{plane:{...good.plane,bounds_arcsec:[0,.2,0,.2]}}])assert.throws(()=>validateMask({...good,...change},request));
});
test('frozen editable masks persist across reloads and reject tampered cache records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tinylens-mask-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
 const fake=(_cmd,args)=>{calls++;assert.equal(args[0],'-T');assert.match(args.at(-1),/CUDA_VISIBLE_DEVICES= /);const proc=new EventEmitter();proc.stdin=new PassThrough();proc.stdout=new PassThrough();proc.stderr=new PassThrough();proc.kill=()=>{};let input='';proc.stdin.on('data',c=>input+=c);proc.stdin.on('finish',()=>queueMicrotask(()=>{assert.deepEqual(JSON.parse(input),request);proc.stdout.end(JSON.stringify(value()));proc.emit('close',0)}));return proc;};
 const read=()=>readReportedMask(state,'b',{spawnProcess:fake,cacheDirectory:dir});assert.deepEqual(await read(),value());assert.deepEqual(await read(),value());assert.equal(calls,1);
 const path=join(dir,(await readdir(dir))[0]),record=JSON.parse(await readFile(path,'utf8'));record.sha256='bad';await writeFile(path,JSON.stringify(record));assert.deepEqual(await read(),value());assert.equal(calls,2);
});
test('mask HTTP accepts only one report identifier and no arbitrary paths',async()=>{
 for(const query of ['?path=/other','?updateId=b&path=/other','?updateId=b&updateId=b']){let status;await serveReportedMask({url:'/api/agent/mask'+query},{writeHead(s){status=s},end(){}},state,{spawnProcess(){assert.fail('must not fetch')}});assert.equal(status,404);}
});
