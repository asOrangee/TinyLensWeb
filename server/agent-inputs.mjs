import { connectionConfig } from './connection-config.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import {numericalInput} from './numeric-payload.mjs';

const PYTHON = connectionConfig.python;
const MAX_RESPONSE = 32 * 1024 * 1024;
const defaultCache = fileURLToPath(new URL('../.local/input-cache/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pending = new Map();

export function reportedInput(state, updateId) {
  const update = state.updates.find(item => item.id === updateId && item.threadId === state.threadId && item.kind === 'artifact');
  if (!update || update.stage?.toLowerCase() !== 'preflight' || typeof update.path !== 'string' || update.path.includes('\0') || !posix.isAbsolute(update.path)) throw new Error('AI has not reported these inputs.');
  const path = posix.normalize(update.path);
  if (!path.startsWith(WORKSPACE + '/output/') || !path.endsWith('/input-provenance.json')) throw new Error('An explicit input provenance report is required.');
  return { path, threadId: state.threadId, updateId };
}

// A display reader only: no pipeline imports, stages, resampling or remote writes.
export const REMOTE_INPUT_READER = `import sys,json,hashlib,base64,io,math
from pathlib import Path
import numpy as np
from astropy.io import fits
from astropy.visualization import ZScaleInterval,LogStretch
from PIL import Image
from matplotlib import colormaps
r=json.loads(sys.stdin.readline())
root=Path(r['root']).resolve()
requested=Path(r['path'])
p=requested.resolve(strict=True)
if p!=requested or not p.is_relative_to(root/'output') or p.name!='input-provenance.json': raise ValueError('Invalid input manifest path')
if p.stat().st_size>1024*1024: raise ValueError('Input manifest too large')
manifest_raw=p.read_bytes();m=json.loads(manifest_raw)
if m.get('schema_version')!='mock_input_provenance.v1': raise ValueError('Unsupported input manifest')
f=Path(m['packaged_fits_path']);actual=f.resolve(strict=True)
if f!=actual or f.parent!=p.parent or f.suffix.lower()!='.fits': raise ValueError('FITS must be the declared adjacent input')
if f.stat().st_size>16*1024*1024: raise ValueError('FITS exceeds preview limit')
raw=f.read_bytes();sha=hashlib.sha256(raw).hexdigest()
if sha!=m['packaged_fits_sha256']: raise ValueError('FITS checksum does not match provenance')
g=m['input_geometry'];pixel=float(g['pixel_scale_arcsec'])
if not math.isfinite(pixel) or pixel<=0: raise ValueError('Invalid input pixel scale')
if g['input_x_direction'] not in ['increasing','decreasing'] or g['input_y_direction'] not in ['increasing','decreasing']: raise ValueError('Unsupported input axes')
arrays={};array_hashes={};headers=m.get('geometry_headers',{})
with fits.open(io.BytesIO(raw),memmap=False) as h:
 for name,ext,key in [('data','VIS_FLUX','image'),('noise','VIS_RMS','noise'),('psf','VIS_PSF','psf')]:
  a=np.asarray(h[ext].data)
  if a.ndim!=2 or not 1<=min(a.shape)<=max(a.shape)<=512 or not np.isfinite(a).all(): raise ValueError('Invalid FITS image array')
  array_hashes[name]=hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()
  for header in [headers.get(key,{}),h[ext].header]:
   for axis,direction in [(1,g['input_x_direction']),(2,g['input_y_direction'])]:
    step=header.get('CDELT'+str(axis))
    if step is not None and not np.isclose(float(step),pixel*(1 if direction=='increasing' else -1)): raise ValueError('Input WCS disagrees with provenance')
    if step is not None and str(header.get('CUNIT'+str(axis),'arcsec')).lower()!='arcsec': raise ValueError('Unsupported input WCS units')
    center=header.get('CRPIX'+str(axis))
    if center is not None and not np.isclose(float(center),(a.shape[2-axis]+1)/2): raise ValueError('Unsupported off-center input WCS')
    if abs(float(header.get('CRVAL'+str(axis),0)))>1e-10: raise ValueError('Unsupported nonzero input reference')
  a=a.astype(float)
  if g['input_x_direction']=='decreasing': a=np.fliplr(a)
  if g['input_y_direction']=='increasing': a=np.flipud(a)
  arrays[name]=a
if arrays['data'].shape!=arrays['noise'].shape or np.any(arrays['noise']<=0): raise ValueError('Invalid aligned RMS map')
arrays['snr']=arrays['data']/arrays['noise']
if not np.isfinite(arrays['snr']).all(): raise ValueError('Invalid signal-to-noise map')
palette=io.BytesIO();Image.fromarray(colormaps['magma'](np.linspace(1,0,256)[:,None],bytes=True)[...,:3]).save(palette,format='PNG')
planes=[]
for name in ['data','noise','snr','psf']:
 a=arrays[name];lo=float(a.min());hi=float(a.max());constant=lo==hi
 zlo,zhi=map(float,ZScaleInterval(n_samples=1000,contrast=.25).get_limits(a))
 span=a.shape[1]*pixel;target=span/4;base=10**math.floor(math.log10(target));bar=max(v*base for v in [1,2,5] if v*base<=target)
 variants={}
 for scale in ['linear','log','zscale']:
  vmin,vmax=(zlo,zhi) if scale=='zscale' else (lo,hi)
  n=np.full_like(a,.5) if vmin==vmax else np.clip((a-vmin)/(vmax-vmin),0,1)
  if scale=='log' and not constant:n=LogStretch(a=1000)(n)
  rgba=colormaps['magma'](n,bytes=True)[...,:3];buffer=io.BytesIO();Image.fromarray(rgba).save(buffer,format='PNG');png=buffer.getvalue()
  variants[scale]={'src':'data:image/png;base64,'+base64.b64encode(png).decode(),'vmin':vmin,'vmax':vmax,'sha256':hashlib.sha256(png).hexdigest()}
  if vmin==vmax: variants[scale]['constant_color']='#'+''.join(format(int(v),'02x') for v in rgba[0,0])
 key={'data':'image','noise':'noise','psf':'psf'}.get(name)
 planes.append({'id':name,'shape':list(a.shape),'constant':constant,'half_extent_arcsec':a.shape[0]*pixel/2,'half_extent_x_arcsec':a.shape[1]*pixel/2,'scale_bar_arcsec':bar,'unit':'1' if name=='snr' else headers.get(key,{}).get('BUNIT','未提供'),'data_min':lo,'data_max':hi,'variants':variants})
display={'schema':'tinylens.input-display.v1','source':{'provenance_path':str(p),'provenance_sha256':hashlib.sha256(manifest_raw).hexdigest(),'fits_path':str(f),'fits_sha256':sha,'array_sha256':array_hashes},'pixel_scale_arcsec':pixel,'x_direction':'increasing','y_direction':'decreasing','input_geometry':g,'log_a':1000,'zscale':{'n_samples':1000,'contrast':.25},'noise_definition':'1-sigma RMS','snr_definition':'data / noise_rms','psf_sum':float(arrays['psf'].sum()),'colormap_src':'data:image/png;base64,'+base64.b64encode(palette.getvalue()).decode(),'planes':planes}
print(json.dumps({'display':display,'fits_base64':base64.b64encode(raw).decode()},allow_nan=False,separators=(',',':')))
`;

const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function validate(display, input) {
  if (display?.schema !== 'tinylens.input-display.v1' || display.source?.provenance_path !== input.path || !/^[a-f0-9]{64}$/.test(display.source?.fits_sha256 ?? '') || posix.dirname(display.source.fits_path) !== posix.dirname(input.path)) throw new Error('Input display identity mismatch.');
  if (!Array.isArray(display.planes) || display.planes.map(p => p.id).join() !== 'data,noise,snr,psf') throw new Error('Incomplete input preview.');
  for (const plane of display.planes) for (const scale of ['linear', 'log', 'zscale']) {
    const variant = plane.variants?.[scale];
    if (!variant || !Number.isFinite(variant.vmin) || !Number.isFinite(variant.vmax) || variant.vmax < variant.vmin || !/^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/.test(variant.src)) throw new Error('Invalid input image.');
    const png = Buffer.from(variant.src.slice(22), 'base64');
    if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || digest(png) !== variant.sha256) throw new Error('Input preview checksum mismatch.');
  }
}

export async function readReportedInput(state, updateId, { spawnProcess = spawn, cacheDirectory = defaultCache, timeoutMs = 45000, refresh = false } = {}) {
  const input = reportedInput(state, updateId), identity = JSON.stringify({ ...input, reader_sha256: digest(REMOTE_INPUT_READER) }), key = digest(identity);
  const base = resolve(cacheDirectory, key), jsonPath = base + '.json', fitsPath = base + '.fits';
  async function saved() {
    if ((await stat(jsonPath)).size > MAX_RESPONSE || (await stat(fitsPath)).size > 16 * 1024 * 1024) throw new Error('Input cache too large.');
    const record = JSON.parse(await readFile(jsonPath, 'utf8'));
    if (record.identity !== identity || digest(Buffer.from(JSON.stringify(record.display))) !== record.display_sha256) throw new Error('Input cache identity mismatch.');
    validate(record.display, input);
    if (digest(await readFile(fitsPath)) !== record.display.source.fits_sha256) throw new Error('Cached FITS checksum mismatch.');
    return { ...record.display, cache: { saved_at: record.saved_at, from_cache: true } };
  }
  if (!refresh) { try { return await saved(); } catch { /* Fetch this exact reported input when no valid cache exists. */ } }
  if (pending.has(base)) return pending.get(base);
  const operation = (async () => {
    const envelope = await new Promise((resolveValue, reject) => {
      const proc = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', connectionConfig.sshHost, `env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 ${shellQuote(PYTHON)} -B -c ${shellQuote(REMOTE_INPUT_READER)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      let size = 0, done = false; const chunks = [];
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolveValue(value); };
      const timer = setTimeout(() => { proc.kill(); finish(new Error('FITS 读取超时，请检查 GPU 网络连接。')); }, timeoutMs);
      proc.on('error', error => finish(error)); proc.stdin.on('error', error => finish(error)); proc.stderr.resume();
      proc.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { proc.kill(); finish(new Error('Input preview exceeds size limit.')); } else chunks.push(chunk); });
      proc.on('close', code => {
        if (code !== 0) return finish(new Error('暂时无法读取已报告的 FITS，请检查 GPU 服务器连接后重试。'));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(error); }
      });
      proc.stdin.end(JSON.stringify({ root: WORKSPACE, path: input.path }) + '\n');
    });
    validate(envelope.display, input);
    const fits = Buffer.from(envelope.fits_base64, 'base64');
    if (fits.length > 16 * 1024 * 1024 || digest(fits) !== envelope.display.source.fits_sha256) throw new Error('Downloaded FITS checksum mismatch.');
    const saved_at = new Date().toISOString();
    const record = { identity, saved_at, display: envelope.display, display_sha256: digest(Buffer.from(JSON.stringify(envelope.display))) };
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const temp = randomUUID();
    await writeFile(fitsPath + temp, fits, { mode: 0o600 }); await rename(fitsPath + temp, fitsPath);
    await writeFile(jsonPath + temp, JSON.stringify(record), { mode: 0o600 }); await rename(jsonPath + temp, jsonPath);
    return { ...envelope.display, cache: { saved_at, from_cache: false } };
  })();
  pending.set(base, operation);
  try { return await operation; } finally { pending.delete(base); }
}

export async function serveReportedInput(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => !['updateId', 'refresh'].includes(key)) || query.getAll('updateId').length !== 1 || query.getAll('refresh').length > 1 || query.has('refresh') && query.get('refresh') !== '1') throw new Error('An input report identifier is required.');
    const display = await readReportedInput(state, query.get('updateId'), { ...options, refresh: query.get('refresh') === '1' });
    const input=reportedInput(state,query.get('updateId')),identity=JSON.stringify({...input,reader_sha256:digest(REMOTE_INPUT_READER)});
    const fits=await readFile(resolve(options?.cacheDirectory??defaultCache,digest(identity))+'.fits');
    const payload=numericalInput(display,fits);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: error.message }));
  }
}
