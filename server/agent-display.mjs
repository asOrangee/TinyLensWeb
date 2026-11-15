import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { connectionConfig, shellQuote } from './connection-config.mjs';
import { fitsImages, numericalHash, numericalPlane } from './numeric-payload.mjs';

export const DISPLAY_SCHEMA = 'tinylens.stage-display.v1';
export const DISPLAY_READER = await readFile(new URL('./read-stage-display.py', import.meta.url), 'utf8');
const readerHash = numericalHash(DISPLAY_READER);
const MAX_RESPONSE = 24 * 1024 * 1024;
const defaultCache = fileURLToPath(new URL('../.local/display-cache/', import.meta.url));
const pending = new Map();
const extensions = {
  data: 'DATA', noise: 'RMS', snr: 'SNR', psf: 'PSF',
  observation: 'DATA', mask: 'ARC_MASK', domain: 'VALID_DOMAIN',
  model: 'MODEL', 'source-lensed': 'LENSED_SOURCE', source: 'SOURCE',
  residual: 'RESIDUAL', 'chi-square': 'CHI_SQUARE',
};
const keys = {
  preflight: ['data', 'noise', 'snr', 'psf'],
  b: ['observation', 'mask', 'domain'],
  model: ['observation', 'model', 'source-lensed', 'source', 'residual', 'chi-square'],
};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function reportedDisplay(state, updateId) {
  const report = state.threadId && state.updates.find(item =>
    item.id === updateId && item.threadId === state.threadId && item.kind === 'artifact');
  const path = report?.path;
  if (typeof path !== 'string' || path.includes('\0') || posix.normalize(path) !== path
    || !path.startsWith(WORKSPACE + '/output/')) throw Error('An explicit display manifest is required.');
  const m = /^(.*)\/(?:preflight|attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*))\/display-manifest\.json$/.exec(path);
  const stage = m?.[2] ?? 'preflight';
  if (!m || !m[1].startsWith(WORKSPACE + '/output/') || report.stage?.trim().toLowerCase() !== stage) {
    throw Error('Display report does not match its stage.');
  }
  return { root: WORKSPACE, path, run: m[1], stage, attempt: m[3] === undefined ? null : Number(m[3]) };
}

function raster(values, shape, bounds, sha, { decreasing = false, limits, color = 'magma' } = {}) {
  const raw = Buffer.alloc(values.length * 8);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    lo = Math.min(lo, value); hi = Math.max(hi, value);
    raw.writeDoubleLE(value, i * 8);
  }
  return numericalPlane({
    shape, bounds_arcsec: bounds, half_extent_arcsec: (bounds[3] - bounds[2]) / 2,
    vmin: limits?.[0] ?? lo, vmax: limits?.[1] ?? hi, data_min: lo, data_max: hi,
    stretch: 'linear', asinh_a: 1, colormap: color, input_fits_sha256: sha,
    values_base64: raw.toString('base64'), values_sha256: numericalHash(raw),
    mask_base64: Buffer.alloc(values.length, 1).toString('base64'),
    array_y_direction: decreasing ? 'decreasing' : 'increasing',
  });
}

function flippedRows(values, [height, width]) {
  const flipped = new Float64Array(values.length);
  for (let y = 0; y < height; y++) flipped.set(values.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
  return flipped;
}

function validatePlanes(manifest, fits, kind) {
  const metadata = manifest.planes;
  const roles = Object.keys(metadata);
  const expected = keys[kind];
  if (roles.some(role => !expected.includes(role)) || roles.length !== fits.size
    || (kind === 'model' ? !roles.includes('observation') : roles.length !== expected.length)) {
    throw Error('Unexpected display plane list.');
  }
  const out = {};
  for (const role of roles) {
    const plane = metadata[role];
    const bounds = plane.bounds_arcsec;
    const hdu = fits.get(extensions[role]);
    if (!hdu || plane.extension !== extensions[role] || !same(hdu.shape, plane.shape)
        || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
        || bounds[0] >= bounds[1] || bounds[2] >= bounds[3]) throw Error('Published FITS frame mismatch.');
    const [ny, nx] = hdu.shape;
    const expectedPixel = manifest.input.pixel_scale_arcsec;
    const close = (a, b) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b));
    const dx = (bounds[1] - bounds[0]) / nx, dy = (bounds[3] - bounds[2]) / ny;
    const header = hdu.header;
    if ((role !== 'source' && (!close(dx, expectedPixel) || !close(dy, expectedPixel)
        || !close(bounds[0], -bounds[1]) || !close(bounds[2], -bounds[3])))
        || !close(header.CDELT1, dx) || !close(header.CDELT2, dy)
        || header.CUNIT1 !== 'arcsec' || header.CUNIT2 !== 'arcsec'
        || header.CRPIX1 !== 1 || header.CRPIX2 !== 1
        || !close(header.CRVAL1, bounds[0] + dx / 2) || !close(header.CRVAL2, bounds[2] + dy / 2)) {
      throw Error('Published FITS calibration mismatch.');
    }
    out[role] = { ...hdu, bounds, unit: plane.unit, zscale: plane.zscale };
  }
  const image = out.data ?? out.observation;
  for (const [role, plane] of Object.entries(out)) {
    if (role !== 'source' && role !== 'psf' && (!same(plane.shape, image.shape) || !same(plane.bounds, image.bounds))) {
      throw Error('Published image-plane grids do not align.');
    }
  }
  return out;
}

function preflightInput(m, arrays, request, envelope) {
  if (!same(envelope.image_shape, arrays.data.shape)
    || arrays.noise.values.some(value => value <= 0)
    || arrays.snr.values.some((value, i) => value !== arrays.data.values[i] / arrays.noise.values[i])) {
    throw Error('Published preflight arrays disagree.');
  }
  const pixel = m.input.pixel_scale_arcsec;
  const planes = keys.preflight.map(id => {
    const { values, shape, bounds, zscale, unit } = arrays[id];
    const numeric = raster(flippedRows(values, shape), shape, bounds, m.input.sha256, { decreasing: true });
    const low = numeric.data_min, high = numeric.data_max;
    if (!Array.isArray(zscale) || zscale.length !== 2 || !zscale.every(Number.isFinite) || zscale[0] > zscale[1]) {
      throw Error('Published ZScale interval is invalid.');
    }
    const quarter = shape[1] * pixel / 4;
    const base = 10 ** Math.floor(Math.log10(quarter));
    const scale_bar_arcsec = base * Math.max(...[1, 2, 5].filter(n => n <= quarter / base));
    const linear = { src: '', vmin: low, vmax: high };
    return { id, shape, unit, numeric, constant: low === high, data_min: low, data_max: high,
      half_extent_arcsec: bounds[3], half_extent_x_arcsec: bounds[1], scale_bar_arcsec,
      variants: { linear, log: linear, zscale: { src: '', vmin: zscale[0], vmax: zscale[1] } } };
  });
  return {
    schema: 'tinylens.input-display.v1', pixel_scale_arcsec: pixel, log_a: 1000,
    x_direction: 'increasing', y_direction: 'decreasing',
    psf_sum: arrays.psf.values.reduce((sum, x) => sum + x, 0), planes,
    source: { report_path: request.path, provenance_path: request.path, provenance_sha256: envelope.manifest_sha256,
      fits_path: m.input.path, fits_sha256: m.input.sha256,
      array_sha256: Object.fromEntries(planes.map(p => [p.id, p.numeric.values_sha256])) },
  };
}

function maskPayload(m, arrays, request, summary) {
  const included = flippedRows(arrays.mask.values, arrays.mask.shape);
  const domain = flippedRows(arrays.domain.values, arrays.domain.shape);
  const count = included.reduce((sum, value) => sum + value, 0);
  const domainCount = domain.reduce((sum, value) => sum + value, 0);
  if (included.some((v, i) => (v !== 0 && v !== 1) || v > domain[i])
    || domain.some(v => v !== 0 && v !== 1) || !domainCount
    || count !== summary.result.metrics.included_arc_pixels
    || included.length - count !== summary.result.metrics.masked_pixels) throw Error('Published arc mask counts disagree.');
  const { values, shape, bounds } = arrays.observation;
  return {
    schema: 'tinylens.mask-edit.v1', stage: 'b', attempt: request.attempt, report_path: request.path,
    path: posix.join(posix.dirname(request.path), 'stage-result.json'), sha256: m.summary.sha256,
    mask_path: request.run + '/' + m.feature_mask.path, mask_sha256: m.feature_mask.sha256,
    domain_path: request.run + '/' + m.modeling_mask.path, domain_sha256: m.modeling_mask.sha256,
    input_fits_sha256: m.input.sha256, pixel_scale_arcsec: m.input.pixel_scale_arcsec,
    modeling_radius_arcsec: summary.config?.settings?.modeling_radius ?? null,
    shape, included: count, domain_pixels: domainCount, display_y_direction: 'decreasing',
    included_base64: Buffer.from(included).toString('base64'), domain_base64: Buffer.from(domain).toString('base64'),
    plane: raster(values, shape, bounds, m.input.sha256),
  };
}

export function adaptDisplayEnvelope(envelope, request) {
  const m = envelope?.manifest;
  if (m?.schema !== DISPLAY_SCHEMA || m.run !== request.run || m.stage !== request.stage || m.attempt !== request.attempt
    || !hash(envelope.manifest_sha256) || !hash(m.input?.sha256) || !hash(m.fits?.sha256)
    || !Number.isFinite(m.input.pixel_scale_arcsec) || m.input.pixel_scale_arcsec <= 0 || !posix.isAbsolute(m.input.path)) {
    throw Error('Published display identity mismatch.');
  }
  const fits = Buffer.from(envelope.fits_base64, 'base64');
  if (numericalHash(fits) !== m.fits.sha256) throw Error('Published FITS checksum mismatch.');
  const kind = request.stage === 'preflight' || request.stage === 'b' ? request.stage : 'model';
  const arrays = validatePlanes(m, fitsImages(fits), kind);
  const payload = { schema: DISPLAY_SCHEMA, report_path: request.path, stage: request.stage, attempt: request.attempt };
  if (kind === 'preflight') {
    return { ...payload, input: preflightInput(m, arrays, request, envelope) };
  }

  const { summary: result, configuration: config, parameters } = envelope;
  if (!hash(m.summary?.sha256) || result?.stage !== request.stage || result.attempt !== request.attempt
    || result.lens_id !== m.lens_id || result.status !== 'success' || !result.metrics) throw Error('Published summary mismatch.');
  const identity = {
    schema: 'tinylens.readonly-result.v1', stage: request.stage, attempt: request.attempt, path: request.path,
  };
  const summary = { ...identity, kind: 'summary', sha256: m.summary.sha256, result, config };
  if (kind === 'b') return { ...payload, summary, mask: maskPayload(m, arrays, request, summary) };

  const range = request.stage === 'a' ? 5 : 3;
  const planes = Object.fromEntries(Object.entries(arrays).map(([role, { values, shape, bounds }]) => {
    const limits = role === 'residual' ? [-range, range] : role === 'chi-square' ? [0, range * range] : undefined;
    const color = limits ? 'blue-white-red' : role === 'source' && request.stage !== 'm1' ? 'inferno' : 'magma';
    return [role, raster(values, shape, bounds, m.input.sha256, { limits, color })];
  }));
  summary.planes = planes;
  if (m.mapping && planes.source && planes.model) {
    const frame = ({ shape, bounds_arcsec, half_extent_arcsec }) => ({ shape, bounds_arcsec, half_extent_arcsec });
    summary.display_mapping = {
      ...m.mapping, ...identity, schema: 'tinylens.lens-mapping.v1', synthetic: false,
      summary_sha256: m.summary.sha256, fits_sha256: m.input.sha256,
      frames: { image: frame(planes.model), source: frame(planes.source) },
    };
  }
  const posterior = parameters ? { ...parameters, ...identity, sha256: m.parameters.sha256 } : undefined;
  return { ...payload, summary, posterior };
}

function readRemoteDisplay(request, spawnProcess, timeout) {
  const command = 'env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 ' + shellQuote(connectionConfig.python)
    + ' -B -c ' + shellQuote(DISPLAY_READER);
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', connectionConfig.sshHost, command],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0;
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(Error('Display package read timed out.')); }, timeout);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE) { child.kill(); fail(Error('Display package exceeds the size limit.')); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      if (code !== 0) return fail(Error('The reported display package could not be verified.'));
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function readReportedDisplay(state, updateId, { spawnProcess = spawn, timeoutMs = 45000, cacheDirectory = defaultCache } = {}) {
  const request = reportedDisplay(state, updateId);
  const identity = JSON.stringify([state.threadId, updateId, request, readerHash]);
  const location = join(cacheDirectory, numericalHash(identity) + '.json');
  try {
    if ((await stat(location)).size > MAX_RESPONSE) throw Error('Display cache exceeds size limit.');
    const record = JSON.parse(await readFile(location, 'utf8'));
    if (record.identity === identity && record.sha256 === numericalHash(JSON.stringify(record.envelope))) {
      return adaptDisplayEnvelope(record.envelope, request);
    }
  } catch { /* Only attempt the same explicitly reported package. */ }
  if (pending.has(location)) return pending.get(location);
  const operation = (async () => {
    const envelope = await readRemoteDisplay(request, spawnProcess, timeoutMs);
    const payload = adaptDisplayEnvelope(envelope, request);
    try {
      await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      const temporary = location + randomUUID();
      await writeFile(temporary, JSON.stringify({ identity, envelope, sha256: numericalHash(JSON.stringify(envelope)) }), { mode: 0o600 });
      await rename(temporary, location);
    } catch { /* A verified package can still be used when local caching is unavailable. */ }
    return payload;
  })();
  pending.set(location, operation);
  try { return await operation; } finally { pending.delete(location); }
}

export async function serveReportedDisplay(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'updateId') || query.getAll('updateId').length !== 1) {
      throw Error('A display report identifier is required.');
    }
    const payload = await readReportedDisplay(state, query.get('updateId'), options);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
