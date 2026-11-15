import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { numericalInput } from './numeric-payload.mjs';
import { connectionConfig } from './connection-config.mjs';

const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_FITS = 16 * 1024 * 1024;
const defaultCache = fileURLToPath(new URL('../.local/input-cache/', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pending = new Map();
const output = WORKSPACE + '/output/';
const provenanceReport = path => path.endsWith('/input-provenance.json');
const preflightReport = /\/preflight\/(?:inspection\.json|preflight_[26]panel\.png)$/;

// Keep already verified offline FITS previews readable after updating the reader.
const legacyReaderHash = 'ee3c696e2a4700633771afa61c346c98e2bbcb433c264758b1db91021ab1e9d5';
export const REMOTE_INPUT_READER = await readFile(new URL('./read-preflight-input.py', import.meta.url), 'utf8');
const readerHash = digest(REMOTE_INPUT_READER);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const unavailable = () => Object.assign(new Error('无法连接 GPU 服务器，恢复连接后可刷新预览。'), { status: 503 });

export function reportedInput(state, updateId) {
  const update = state.threadId && state.updates.find(item => item.id === updateId && item.threadId === state.threadId && item.kind === 'artifact');
  if (!update || update.stage?.trim().toLowerCase() !== 'preflight' || typeof update.path !== 'string' || update.path.includes('\0')) {
    throw new Error('AI has not reported these inputs.');
  }
  const { path } = update;
  if (!path.startsWith(output) || posix.normalize(path) !== path || !(provenanceReport(path) || preflightReport.test(path))) {
    throw new Error('An explicit preflight input or inspection report is required.');
  }
  return { path, threadId: state.threadId, updateId };
}

function validate(display, { path }, legacy = false) {
  const source = display?.source;
  if (display?.schema !== 'tinylens.input-display.v1' || !source
    || (legacy ? source.provenance_path : source.report_path) !== path
    || !/^[a-f0-9]{64}$/.test(source.fits_sha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(source.provenance_sha256 ?? '')
    || typeof source.provenance_path !== 'string' || !source.provenance_path.startsWith(output) || !provenanceReport(source.provenance_path)
    || (provenanceReport(path) && source.provenance_path !== path)
    || typeof source.fits_path !== 'string' || posix.dirname(source.fits_path) !== posix.dirname(source.provenance_path)
    || !source.fits_path.toLowerCase().endsWith('.fits')) throw new Error('Input display identity mismatch.');
  if (!Array.isArray(display.planes) || display.planes.map(plane => plane.id).join() !== 'data,noise,snr,psf') {
    throw new Error('Incomplete input preview.');
  }
  for (const plane of display.planes) for (const scale of ['linear', 'log', 'zscale']) {
    const variant = plane.variants?.[scale];
    if (!variant || !Number.isFinite(variant.vmin) || !Number.isFinite(variant.vmax) || variant.vmax < variant.vmin || (!legacy && variant.src !== '')) {
      throw new Error('Invalid numerical input display range.');
    }
  }
}

async function loadReportedInput(state, updateId, { spawnProcess = spawn, cacheDirectory = defaultCache, timeoutMs = 45000, refresh = false } = {}) {
  const input = reportedInput(state, updateId);
  const identityFor = reader_sha256 => JSON.stringify({ ...input, reader_sha256 });
  const cachedAt = identity => resolve(cacheDirectory, digest(identity));
  const identity = identityFor(readerHash);
  const base = cachedAt(identity);
  async function saved(cacheIdentity, legacy = false) {
    const location = cachedAt(cacheIdentity);
    const jsonPath = location + '.json', fitsPath = location + '.fits';
    if ((await stat(jsonPath)).size > MAX_RESPONSE || (await stat(fitsPath)).size > MAX_FITS) throw new Error('Input cache too large.');
    const record = JSON.parse(await readFile(jsonPath, 'utf8'));
    if (record.identity !== cacheIdentity || digest(JSON.stringify(record.display)) !== record.display_sha256) throw new Error('Input cache identity mismatch.');
    validate(record.display, input, legacy);
    const fits = await readFile(fitsPath);
    if (digest(fits) !== record.display.source.fits_sha256) throw new Error('Cached FITS checksum mismatch.');
    return { fits, display: { ...record.display, cache: { saved_at: record.saved_at, from_cache: true } } };
  }
  if (!refresh) {
    try { return await saved(identity); } catch { /* Fetch only this exact report. */ }
    if (provenanceReport(input.path)) {
      try { return await saved(identityFor(legacyReaderHash), true); } catch { /* No usable legacy cache for this report. */ }
    }
  }
  if (pending.has(base)) return pending.get(base);
  const operation = (async () => {
    const envelope = await new Promise((resolveValue, reject) => {
      const remote = 'env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 ' + shellQuote(connectionConfig.python) + ' -B -c ' + shellQuote(REMOTE_INPUT_READER);
      const proc = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', connectionConfig.sshHost, remote], { stdio: ['pipe', 'pipe', 'pipe'] });
      let size = 0, done = false;
      const chunks = [];
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolveValue(value); };
      const timer = setTimeout(() => { proc.kill(); finish(unavailable()); }, timeoutMs);
      proc.on('error', error => finish(error));
      proc.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
      proc.stderr.resume();
      proc.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { proc.kill(); finish(new Error('Input preview exceeds size limit.')); }
        else chunks.push(chunk);
      });
      proc.on('close', code => {
        if (code !== 0) return finish(code === 255 ? unavailable() : new Error('无法校验本次预检报告对应的输入 FITS。'));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(error); }
      });
      proc.stdin.end(JSON.stringify({ root: WORKSPACE, path: input.path }) + '\n');
    });
    const { display } = envelope;
    validate(display, input);
    const fits = Buffer.from(envelope.fits_base64, 'base64');
    if (!fits.length || fits.length > MAX_FITS || digest(fits) !== display.source.fits_sha256) throw new Error('Downloaded FITS checksum mismatch.');
    const saved_at = new Date().toISOString();
    const record = { identity, saved_at, display, display_sha256: digest(JSON.stringify(display)) };
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const temp = randomUUID();
    await writeFile(base + '.fits' + temp, fits, { mode: 0o600 });
    await rename(base + '.fits' + temp, base + '.fits');
    await writeFile(base + '.json' + temp, JSON.stringify(record), { mode: 0o600 });
    await rename(base + '.json' + temp, base + '.json');
    return { fits, display: { ...display, cache: { saved_at, from_cache: false } } };
  })();
  pending.set(base, operation);
  try { return await operation; } finally { pending.delete(base); }
}

export async function readReportedInput(state, updateId, options) {
  return (await loadReportedInput(state, updateId, options)).display;
}

export async function serveReportedInput(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => !['updateId', 'refresh'].includes(key)) || query.getAll('updateId').length !== 1 || query.getAll('refresh').length > 1 || query.has('refresh') && query.get('refresh') !== '1') throw new Error('An input report identifier is required.');
    const { display, fits } = await loadReportedInput(state, query.get('updateId'), { ...options, refresh: query.get('refresh') === '1' });
    const payload = numericalInput(display, fits);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(error.status === 503 ? 503 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
