import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const reader=fileURLToPath(new URL('./diagnostic_colorbars.py',import.meta.url));
const swift=fileURLToPath(new URL('./read-diagnostic-labels.swift',import.meta.url));
const python=process.env.TINYLENS_DISPLAY_PYTHON??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const hash=value=>createHash('sha256').update(value).digest('hex');
const pending=new Map();

export function validateFormattedColorbars(value,panels){
  if(!value||Object.keys(value).sort().join()!==Object.keys(panels).sort().join())throw new Error('Colorbar identities differ');
  for(const bar of Object.values(value)){
    if(!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(bar.gradient_src)||![bar.top,bar.height].every(Number.isFinite)||Math.abs(bar.top)>1||bar.height<=0||bar.height>2||!Array.isArray(bar.ticks)||bar.ticks.length<3||bar.ticks.length>16)throw new Error('Invalid original colorbar');
    for(const [i,tick] of bar.ticks.entries())if(![tick.position,tick.value].every(Number.isFinite)||tick.position<-.2||tick.position>1.2||i&&(tick.position<=bar.ticks[i-1].position||tick.value>=bar.ticks[i-1].value))throw new Error('Invalid printed ticks');
  }
}

/** Optional display-only enrichment; retain the exact original image on uncertainty. */
export async function formatReportedColorbars(value,{cacheDirectory,spawnProcess=spawn,timeoutMs=25000}={}){
  const version=hash(Buffer.concat(await Promise.all([readFile(reader),readFile(swift)])));
  const key=hash(JSON.stringify({source:value.source_sha256,version,bars:Object.values(value.panels).map(p=>hash(p.colorbar_src))}));
  const base=join(cacheDirectory,key+'.json');
  const decorate=bars=>({...value,panels:Object.fromEntries(Object.entries(value.panels).map(([name,p])=>[name,{...p,formatted_colorbar:bars[name]}]))});
  try{
    const stored=JSON.parse(await readFile(base,'utf8'));
    if(stored.key!==key||hash(JSON.stringify(stored.bars))!==stored.sha256)throw new Error('Colorbar cache mismatch');
    validateFormattedColorbars(stored.bars,value.panels);return decorate(stored.bars);
  }catch{/* The source images are already verified by the caller. */}
  if(pending.has(key))return decorate(await pending.get(key));
  const operation=(async()=>{
    const bars=await new Promise((accept,reject)=>{
      const proc=spawnProcess(python,['-B',reader],{stdio:['pipe','pipe','pipe']});
      let done=false,size=0;const chunks=[];
      const finish=(error,data)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):accept(data);};
      const timer=setTimeout(()=>{proc.kill();finish(new Error('Label reading timed out'));},timeoutMs);
      proc.on('error',error=>finish(error));proc.stdin.on('error',error=>finish(error));proc.stderr.resume();
      proc.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){proc.kill();finish(new Error('Colorbar too large'));}else chunks.push(chunk);});
      proc.on('close',code=>{if(code!==0)return finish(new Error('Printed labels unavailable'));try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){finish(error);}});
      proc.stdin.end(JSON.stringify({panels:value.panels,module_cache:fileURLToPath(new URL('../.local/swift-module-cache/',import.meta.url))})+'\n');
    });
    validateFormattedColorbars(bars,value.panels);
    await mkdir(cacheDirectory,{recursive:true,mode:0o700});const temporary=base+randomUUID();
    await writeFile(temporary,JSON.stringify({key,bars,sha256:hash(JSON.stringify(bars))}),{mode:0o600});await rename(temporary,base);return bars;
  })();
  pending.set(key,operation);
  try{return decorate(await operation);}finally{pending.delete(key);}
}
