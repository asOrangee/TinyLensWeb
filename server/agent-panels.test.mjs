import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedDiagnostic, readReportedPanels, serveReportedPanels } from './agent-panels.mjs';
import { WORKSPACE } from './agent-state.mjs';

const path=WORKSPACE+'/output/run/lens/attempts/a/0/diagnostics/stage_a_model.png';
const report={id:'image',threadId:'thread',stage:'a',kind:'artifact',path};
const state={threadId:'thread',updates:[report]};
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x8AAAAASUVORK5CYII=','base64');
const hash=value=>createHash('sha256').update(value).digest('hex');
const fixture=()=>({source_sha256:hash(bytes),source_pixel_shape:[1440,2234],panels:Object.fromEntries(['source-lensed','residual','source'].map(name=>[name,{kind:'reported-raster',src:'data:image/png;base64,'+bytes.toString('base64'),colorbar_src:'data:image/png;base64,'+bytes.toString('base64'),pixel_shape:[80,80],colorbar_top:-.1,colorbar_height:1.1}]))});
function extractor(value,inspect=()=>{}) {
  return(command,args)=>{
    const proc=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
    let input='';proc.stdin.on('data',chunk=>input+=chunk);
    proc.stdin.on('finish',()=>{inspect(command,args,JSON.parse(input));proc.stdout.end(JSON.stringify(value));proc.emit('close',0);});
    return proc;
  };
}
test('native panels require this thread to report an exact diagnostic with matching stage and attempt',()=>{
  assert.equal(reportedDiagnostic(state,'image').stage,'a');
  for(const change of [{threadId:'other'},{kind:'note'},{stage:'m1'},{path:path.replace('stage_a','stage_m1')},{path:'/tmp/stage_a_model.png'},{path:path.replace('/a/0/','/a/-1/')},{path:path.replace('/diagnostics/','/../diagnostics/')}])assert.throws(()=>reportedDiagnostic({...state,updates:[{...report,...change}]},'image'));
  assert.throws(()=>reportedDiagnostic(state,'unreported'));
});
test('lossless panel cache remains available offline and validates original bytes before reuse',async t=>{
  const cacheDirectory=await mkdtemp(join(tmpdir(),'tinylens-panels-'));t.after(()=>rm(cacheDirectory,{recursive:true,force:true}));
  let reads=0;
  const options={cacheDirectory,readImage:async()=>{reads++;return {bytes};},spawnProcess:extractor(fixture(),(command,args,input)=>{
    assert.equal(input.stage,'a');assert.equal(input.png_base64,bytes.toString('base64'));assert.match(args.at(-1),/extract-diagnostic-panels.py$/);assert.equal(command.includes('ssh'),false);
  })};
  const first=await readReportedPanels(state,'image',options);assert.equal(first.panels.residual.kind,'reported-raster');assert.equal(first.panels.model,undefined);assert.equal(first.panels['chi-square'],undefined);
  const offline={cacheDirectory,readImage:async()=>{throw new Error('offline');},spawnProcess(){assert.fail('must use cache');}};
  assert.deepEqual(await readReportedPanels(state,'image',offline),first);assert.equal(reads,1);
  await assert.rejects(readReportedPanels({...state,threadId:'other'},'image',offline));
  const stored=(await readdir(cacheDirectory)).find(name=>name.endsWith('.png'));await writeFile(join(cacheDirectory,stored),'corrupt');
  await assert.rejects(readReportedPanels(state,'image',offline),/offline/);
});
test('mismatched source and fabricated extra planes are rejected',async t=>{
  const cacheDirectory=await mkdtemp(join(tmpdir(),'tinylens-panels-'));t.after(()=>rm(cacheDirectory,{recursive:true,force:true}));
  const options={cacheDirectory,readImage:async()=>({bytes})};
  await assert.rejects(readReportedPanels(state,'image',{...options,spawnProcess:extractor({...fixture(),source_sha256:'0'.repeat(64)})}),/match the reported image/);
  const extra=fixture();extra.panels.model=extra.panels.source;
  await assert.rejects(readReportedPanels(state,'image',{...options,spawnProcess:extractor(extra)}),/Incomplete native/);
  assert.deepEqual(await readdir(cacheDirectory),[]);
});
test('native panel route takes one report ID, never an arbitrary remote path',async()=>{
  for(const query of ['?path=/tmp/private.png','?updateId=image&updateId=image','?updateId=image&stage=m1']){
    let status,body;await serveReportedPanels({url:'/api/agent/panels'+query},{writeHead(code){status=code;},end(text){body=JSON.parse(text);}},state,{readImage(){assert.fail('must not read');}});
    assert.equal(status,404);assert.ok(body.error);
  }
});
