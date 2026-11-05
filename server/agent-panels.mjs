import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportedImage, readReportedImage } from './agent-artifacts.mjs';
import { formatReportedColorbars } from './diagnostic-colorbars.mjs';

const readerPath = fileURLToPath(new URL('./extract-diagnostic-panels.py', import.meta.url));
const defaultCache = fileURLToPath(new URL('../.local/panel-cache/', import.meta.url));
const python = process.env.TINYLENS_DISPLAY_PYTHON ?? 'python3';
const hash = value => createHash('sha256').update(value).digest('hex');
const pending = new Map();
const signature = Buffer.from([137,80,78,71,13,10,26,10]);

export function reportedDiagnostic(state, updateId) {
  const image = reportedImage(state, updateId);
  const match = image.path.match(/\/attempts\/(a|m0|m1|m2|m3)\/(0|[1-9]\d*)\/diagnostics\/stage_(a|m0|m1|m2|m3)_model\.png$/);
  const update = state.updates.find(item => item.id === updateId && item.threadId === state.threadId && item.kind === 'artifact');
  if (!match || match[1] !== match[3] || update.stage?.trim().toLowerCase().replace(/^stage[\s_-]+/,'') !== match[1]) throw new Error('An explicitly reported matching model diagnostic is required.');
  return { path: image.path, stage: match[1], attempt: Number(match[2]), updateId, threadId: state.threadId };
}

function validate(value, identity) {
  if (value?.schema !== 'tinylens.reported-panels.v1' || value.path !== identity.path || value.stage !== identity.stage || value.attempt !== identity.attempt || value.updateId !== identity.updateId || !/^[a-f0-9]{64}$/.test(value.source_sha256 ?? '')) throw new Error('Diagnostic panel identity mismatch.');
  if (!value.panels || Object.keys(value.panels).sort().join() !== 'residual,source,source-lensed') throw new Error('Incomplete native diagnostic panels.');
  for (const panel of Object.values(value.panels)) {
    if (panel.kind !== 'reported-raster' || !Array.isArray(panel.pixel_shape) || panel.pixel_shape.length !== 2 || !panel.pixel_shape.every(n => Number.isInteger(n) && n >= 32 && n <= 2048) || !Number.isFinite(panel.colorbar_top) || Math.abs(panel.colorbar_top) > 1 || !Number.isFinite(panel.colorbar_height) || panel.colorbar_height < .2 || panel.colorbar_height > 2) throw new Error('Invalid native panel geometry.');
    for (const field of ['src', 'colorbar_src']) {
      if (!/^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/.test(panel[field])) throw new Error('Invalid native panel image.');
      if (!Buffer.from(panel[field].slice(22), 'base64').subarray(0, 8).equals(signature)) throw new Error('Native panel is not PNG.');
    }
  }
}

export async function readReportedPanels(state, updateId, { readImage = readReportedImage, spawnProcess = spawn, cacheDirectory = defaultCache, timeoutMs = 20000 } = {}) {
  const identity = reportedDiagnostic(state, updateId);
  const reader = await readFile(readerPath);
  const cacheIdentity = JSON.stringify({ ...identity, reader_sha256: hash(reader) });
  const base = resolve(cacheDirectory, hash(cacheIdentity));
  try {
    const record = JSON.parse(await readFile(base + '.json', 'utf8'));
    if (record.identity !== cacheIdentity || hash(JSON.stringify(record.value)) !== record.sha256) throw new Error('Invalid panel cache.');
    validate(record.value, identity);
    if (hash(await readFile(base + '.png')) !== record.value.source_sha256) throw new Error('Diagnostic source checksum mismatch.');
    return record.value;
  } catch { /* Fetch only this exact reported image when there is no valid cache. */ }
  if (pending.has(base)) return pending.get(base);
  const operation = (async () => {
    const source = await readImage(state, updateId);
    const extracted = await new Promise((accept, reject) => {
      const proc = spawnProcess(python, ['-B', readerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let size = 0, done = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : accept(result); };
      const timer = setTimeout(() => { proc.kill(); finish(new Error('Diagnostic extraction timed out.')); }, timeoutMs);
      proc.on('error', error => finish(error)); proc.stdin.on('error', error => finish(error)); proc.stderr.resume();
      proc.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { proc.kill(); finish(new Error('Diagnostic display is too large.')); } else chunks.push(chunk); });
      proc.on('close', code => {
        if (code !== 0) return finish(new Error('The reported image has no verified supported panel layout.'));
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(error); }
      });
      proc.stdin.end(JSON.stringify({ stage: identity.stage, png_base64: source.bytes.toString('base64') }) + '\n');
    });
    if (extracted.source_sha256 !== hash(source.bytes)) throw new Error('Extracted panels do not match the reported image.');
    const value = { schema: 'tinylens.reported-panels.v1', ...identity, ...extracted };
    validate(value, identity);
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const suffix = randomUUID();
    await writeFile(base + suffix + '.png', source.bytes, { mode: 0o600 }); await rename(base + suffix + '.png', base + '.png');
    await writeFile(base + suffix + '.json', JSON.stringify({ identity: cacheIdentity, value, sha256: hash(JSON.stringify(value)) }), { mode: 0o600 }); await rename(base + suffix + '.json', base + '.json');
    return value;
  })();
  pending.set(base, operation);
  try { return await operation; } finally { pending.delete(base); }
}

export async function serveReportedPanels(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'updateId') || query.getAll('updateId').length !== 1) throw new Error('A diagnostic report identifier is required.');
    let value = await readReportedPanels(state, query.get('updateId'), options);
    try { value=await formatReportedColorbars(value,{cacheDirectory:join(options?.cacheDirectory??defaultCache,'labels')}); } catch { /* Unsupported printed axes keep their original colorbar. */ }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value));
  } catch (error) { response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify({ error: error.message })); }
}
