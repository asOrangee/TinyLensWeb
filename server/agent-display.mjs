import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { connectionConfig, shellQuote } from './connection-config.mjs';
import { fitsImages, numericalHash, numericalPlane } from './numeric-payload.mjs';
import { archiveForReport, stageReportSchema, validateStageReport } from './stage-reports.mjs';

const contractJson = await readFile(new URL('../pipeline/src/lens_agent/display_contract.json', import.meta.url), 'utf8');
const contract = JSON.parse(contractJson);
export const DISPLAY_SCHEMA = contract.schema;
const legacySchema = 'tinylens.stage-display.v1';
const namedSchemas = [DISPLAY_SCHEMA, contract.previousNamedSchema];
export const DISPLAY_READER = 'DISPLAY_CONTRACT_JSON = ' + JSON.stringify(contractJson) + '\n'
  + await readFile(new URL('./read-stage-display.py', import.meta.url), 'utf8');
const readerHash = numericalHash(DISPLAY_READER);
const stageVersionsReaderHash = 'e37375a2fa4c6a955be191b64a42b8c0d6a955392ef4666f806b98ea6ef6691d';
const stageParametersReaderHash = 'c1bd8d5229a6835b1e4417f353e2007e1a4ca204935375c97b5046852a503add';
const previousReaderHash = 'd4c50514b0b45389031765a324ffe251887841b86bbc0fc868858fbac4140491';
const legacyReaderHash = 'ffdff33ab11c39ca1b5d19a28c44de89268d5583e0abff501231e050512cd41d';
const MAX_RESPONSE = 44 * 1024 * 1024;
const defaultCache = fileURLToPath(new URL('../.local/display-cache/', import.meta.url));
const pending = new Map();
const extensions = {
  data: 'DATA', noise: 'RMS', snr: 'SNR', psf: 'PSF',
  observation: 'DATA', mask: 'ARC_MASK', domain: 'VALID_DOMAIN',
  model: 'MODEL', 'source-lensed': 'LENSED_SOURCE', source: 'SOURCE',
  residual: 'RESIDUAL', 'chi-square': 'CHI_SQUARE',
};
const keys = contract.required;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function reportedDisplay(state, updateId) {
  const report = state.threadId && state.updates.find(item =>
    item.id === updateId && item.threadId === state.threadId && ['artifact', 'stage'].includes(item.kind));
  if (report) validateStageReport(report, WORKSPACE);
  const path = report?.display_manifest ?? report?.path;
  if (typeof path !== 'string' || path.includes('\0') || posix.normalize(path) !== path
    || !path.startsWith(WORKSPACE + '/output/')) throw Error('An explicit display manifest is required.');
  const m = /^(.*)\/(?:preflight|attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*))\/(display\/?|display-manifest\.json|inspection\.json|stage-result\.json)$/.exec(path);
  const stage = m?.[2] ?? 'preflight';
  if (!m || !m[1].startsWith(WORKSPACE + '/output/') || report.stage?.trim().toLowerCase() !== stage) {
    throw Error('Display report does not match its stage.');
  }
  const declaration = stage === 'preflight' ? 'inspection.json' : 'stage-result.json';
  if (m[4] !== declaration && ((report.kind !== 'artifact' && path !== report.display_manifest) || !/^display(?:\/|-manifest\.json)?$/.test(m[4])))
    throw Error('An explicit stage display report is required.');
  const attempt = m[3] === undefined ? null : Number(m[3]);
  const request = { root: WORKSPACE, path, run: m[1], stage, attempt,
    ...(hash(report.manifestSha256) && { manifestSha256: report.manifestSha256 }) };
  if (report.schema !== stageReportSchema) return request;
  if (report.run_path !== request.run || report.attempt !== attempt) throw Error('Display path and attempt scope disagree.');
  const archiveReport = state.updates.findLast(update => update.threadId === state.threadId
    && update.run_id === report.run_id && update.run_path === report.run_path && archiveForReport(update));
  if (archiveReport) validateStageReport(archiveReport, WORKSPACE);
  return { ...request, runId: report.run_id, ...(archiveReport && { storageRun: archiveForReport(archiveReport) }) };
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
  const named = namedSchemas.includes(manifest.schema);
  const allowed = named ? [...expected, ...(contract.optional[kind] ?? [])] : expected;
  if (roles.some(role => !allowed.includes(role)) || roles.length !== fits.size
    || (named || kind !== 'model' ? !expected.every(role => roles.includes(role)) : !roles.includes('observation'))) {
    throw Error('Unexpected display plane list.');
  }
  const out = {};
  for (const role of roles) {
    const plane = metadata[role];
    const bounds = plane.bounds_arcsec;
    const hdu = fits.get(named ? role : extensions[role]);
    if (!hdu || (!named && plane.extension !== extensions[role]) || !same(hdu.shape, plane.shape)
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
        || (named && (header.CTYPE1 !== 'LINEAR' || header.CTYPE2 !== 'LINEAR' || header.BUNIT !== plane.unit))
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

function namedImages(manifest, envelope) {
  const encoded = envelope.fits_files;
  const entries = Object.entries(manifest.planes);
  if (!encoded || Object.keys(encoded).length !== entries.length) throw Error('Missing named FITS files.');
  return new Map(entries.map(([role, entry]) => {
    const name = contract.stagePrefixes[manifest.stage] + '_' + contract.imageNames[role] + '.fits';
    if (!Object.hasOwn(contract.imageNames, role) || entry.path !== contract.directory + '/' + name
        || !hash(entry.sha256) || typeof encoded[role] !== 'string') throw Error('Unexpected named FITS file.');
    const bytes = Buffer.from(encoded[role], 'base64');
    if (numericalHash(bytes) !== entry.sha256) throw Error('Published FITS checksum mismatch.');
    const hdus = fitsImages(bytes);
    if (hdus.size !== 1 || !hdus.get('PRIMARY')?.header.SIMPLE) throw Error('Display FITS must have a primary image.');
    return [role, hdus.get('PRIMARY')];
  }));
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
    source: { report_path: request.path, provenance_path: posix.join(posix.dirname(request.path), 'display-manifest.json'), provenance_sha256: envelope.manifest_sha256,
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
  const lensed = arrays['source-lensed'];
  return {
    schema: 'tinylens.mask-edit.v1', stage: 'b', attempt: request.attempt, report_path: request.path,
    path: posix.join(posix.dirname(request.path), 'stage-result.json'), sha256: m.summary.sha256,
    mask_path: request.run + '/' + m.feature_mask.path, mask_sha256: m.feature_mask.sha256,
    domain_path: request.run + '/' + m.modeling_mask.path, domain_sha256: m.modeling_mask.sha256,
    input_fits_sha256: m.input.sha256, pixel_scale_arcsec: m.input.pixel_scale_arcsec,
    modeling_radius_arcsec: m.modeling_radius_arcsec ?? summary.config?.settings?.modeling_radius ?? null,
    shape, included: count, domain_pixels: domainCount, display_y_direction: 'decreasing',
    included_base64: Buffer.from(included).toString('base64'), domain_base64: Buffer.from(domain).toString('base64'),
    plane: raster(values, shape, bounds, m.input.sha256),
    ...(lensed && { lensed_source_plane: raster(lensed.values, lensed.shape, lensed.bounds, m.input.sha256) }),
  };
}

export function adaptDisplayEnvelope(envelope, request) {
  if (request.manifestSha256 && envelope?.manifest_sha256 !== request.manifestSha256) {
    throw Error('The locally published display no longer matches its manifest.');
  }
  const m = envelope?.manifest;
  if (![...namedSchemas, legacySchema].includes(m?.schema) || m.run !== request.run || m.stage !== request.stage || m.attempt !== request.attempt
    || request.runId !== m.run_id
    || !hash(envelope.manifest_sha256) || !hash(m.input?.sha256)
    || !Number.isFinite(m.input.pixel_scale_arcsec) || m.input.pixel_scale_arcsec <= 0 || !posix.isAbsolute(m.input.path)) {
    throw Error('Published display identity mismatch.');
  }
  const current = m.schema === DISPLAY_SCHEMA;
  const kind = request.stage === 'preflight' || request.stage === 'b' ? request.stage : 'model';
  let arrays;
  try {
    let fits;
    if (namedSchemas.includes(m.schema)) {
      if (envelope.fits_files) fits = namedImages(m, envelope);
    } else {
      const bytes = Buffer.from(envelope.fits_base64, 'base64');
      if (numericalHash(bytes) !== m.fits?.sha256) throw Error('Published FITS checksum mismatch.');
      fits = fitsImages(bytes);
    }
    if (fits) arrays = validatePlanes(m, fits, kind);
    else if (!current) throw Error('Missing named FITS files.');
  } catch (error) {
    if (!current) throw error;
  }

  const payload = { schema: m.schema, report_path: request.path, stage: request.stage, attempt: request.attempt };
  const identity = { schema: 'tinylens.readonly-result.v1', stage: request.stage, attempt: request.attempt, path: request.path,
    ...(request.runId && { run_id: request.runId }) };
  const packet = current ? envelope.parameter_packet : undefined;
  const parameterSource = packet ? { path: posix.join(posix.dirname(request.path), m.parameters.path), sha256: m.parameters.sha256 } : undefined;
  const namedParameters = current ? { parameter_contract: contract.parameterFile.schema, parameter_source: parameterSource } : {};
  if (kind === 'preflight') {
    if (arrays) {
      try { payload.input = preflightInput(m, arrays, request, envelope); }
      catch (error) { if (!current) throw error; }
    }
    if (current) payload.summary = { ...identity, ...namedParameters, kind: 'preflight',
      sha256: m.inspection.sha256, config: packet?.config ?? { settings: {} } };
    return payload;
  }

  const { summary: result, configuration: config, parameters } = envelope;
  if (!hash(m.summary?.sha256) || result?.stage !== request.stage || result.attempt !== request.attempt
    || result.lens_id !== m.lens_id || result.status !== 'success' || !result.metrics) throw Error('Published summary mismatch.');
  const summary = { ...identity, ...namedParameters, kind: 'summary', sha256: m.summary.sha256,
    result: current ? { ...result, metrics: packet?.metrics ?? {} } : result,
    config: current ? packet?.config : config, fixed_parameters: packet?.fixed_parameters,
    linear_parameters: packet?.linear_parameters };
  if (kind === 'b') {
    let mask;
    if (arrays) {
      try { mask = maskPayload(m, arrays, request, { result, config: summary.config }); }
      catch (error) { if (!current) throw error; }
    }
    return { ...payload, summary, mask };
  }

  const range = request.stage === 'a' ? 5 : 3;
  const planes = arrays && Object.fromEntries(Object.entries(arrays).map(([role, { values, shape, bounds }]) => {
    const limits = role === 'residual' ? [-range, range] : role === 'chi-square' ? [0, range * range] : undefined;
    const color = limits ? 'blue-white-red' : role === 'source' && request.stage !== 'm1' ? 'inferno' : 'magma';
    return [role, raster(values, shape, bounds, m.input.sha256, { limits, color })];
  }));
  summary.planes = planes;
  if (planes?.observation && planes.source && m.mapping_file?.path && hash(m.mapping_file.sha256)
      && envelope.mapping_packet?.schema === contract.mappingFile.schema) {
    summary.display_mapping = { ...envelope.mapping_packet, path: request.path,
      mapping_source: { path: posix.join(posix.dirname(request.path), m.mapping_file.path), sha256: m.mapping_file.sha256 } };
  } else if (!Object.hasOwn(m, 'mapping_file') && m.mapping && planes?.source && planes.model) {
    const frame = ({ shape, bounds_arcsec, half_extent_arcsec }) => ({ shape, bounds_arcsec, half_extent_arcsec });
    summary.display_mapping = {
      ...m.mapping, ...identity, schema: 'tinylens.lens-mapping.v1', synthetic: false,
      summary_sha256: m.summary.sha256, fits_sha256: m.input.sha256,
      frames: { image: frame(planes.model), source: frame(planes.source) },
    };
  }
  const distribution = current ? packet?.distribution : parameters;
  const posterior = distribution ? { ...distribution, ...identity, sha256: m.parameters.sha256 } : undefined;
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
  // An explicitly archived run keeps its original immutable cache identity.
  const { storageRun, ...cacheRequest } = request;
  const identity = JSON.stringify([state.threadId, updateId, cacheRequest, readerHash]);
  const location = join(cacheDirectory, numericalHash(identity) + '.json');
  const cacheKeys = [identity, ...[stageVersionsReaderHash, stageParametersReaderHash, previousReaderHash]
    .map(hash => JSON.stringify([state.threadId, updateId, cacheRequest, hash]))];
  if (request.path.endsWith('/display-manifest.json')) cacheKeys.push(JSON.stringify([state.threadId, updateId, cacheRequest, legacyReaderHash]));
  for (const key of cacheKeys) {
    const cached = join(cacheDirectory, numericalHash(key) + '.json');
    try {
      if ((await stat(cached)).size > MAX_RESPONSE) continue;
      const record = JSON.parse(await readFile(cached, 'utf8'));
      if (record.identity === key && record.sha256 === numericalHash(JSON.stringify(record.envelope)))
        return adaptDisplayEnvelope(record.envelope, request);
    } catch { /* Only attempt the same explicitly reported package. */ }
  }
  if (pending.has(location)) return pending.get(location);
  const operation = (async () => {
    const envelope = await readRemoteDisplay(request, spawnProcess, timeoutMs);
    const payload = adaptDisplayEnvelope(envelope, request);
    const missingImages = Object.keys(envelope.manifest.planes).length > 0 && !(payload.input || payload.mask || payload.summary?.planes);
    const missingParameters = envelope.manifest.parameters && !envelope.parameter_packet;
    const missingMapping = envelope.manifest.mapping_file && !envelope.mapping_packet;
    if (payload.schema === DISPLAY_SCHEMA && (missingImages || missingParameters || missingMapping)) return payload;
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
