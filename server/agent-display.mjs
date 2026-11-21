import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { WORKSPACE } from './agent-state.mjs';
import { connectionConfig, shellQuote } from './connection-config.mjs';
import { fitsImages, numericalHash, numericalPlane } from './numeric-payload.mjs';
import { archiveForReport, stageReportSchema, validateStageReport } from './stage-reports.mjs';
import { withAttemptEvidenceReader } from './attempt-evidence-reader.mjs';

const contractJson = await readFile(new URL('../pipeline/src/lens_agent/display_contract.json', import.meta.url), 'utf8');
const contract = JSON.parse(contractJson);
export const DISPLAY_SCHEMA = contract.schema;
const legacySchema = 'tinylens.stage-display.v1';
const namedSchemas = [DISPLAY_SCHEMA, contract.previousNamedSchema];
export const DISPLAY_READER = 'DISPLAY_CONTRACT_JSON = ' + JSON.stringify(contractJson) + '\n'
  + withAttemptEvidenceReader(await readFile(new URL('./read-stage-display.py', import.meta.url), 'utf8'));
const readerHash = numericalHash(DISPLAY_READER);
const previousHistoryBatchReaderHash = 'eb7c61fc61d1ee6ac8f2bdadaa614962af6cf6a932e993b364a38e2bcfd9e85d';
const previousLineageReaderHash = '766bb98071b2f018a1b008405a5ce62161b82adfe636cc9d65ecbe447a43fad4';
const previousDisplayReaderHash = 'f56f0d615c5834f1b8a26c2e2ef98365ffb909c1c14cc15e3f9b2154d7079066';
const previousMaskReaderHash = 'ec1bb9dd31baf518709be6a07da181792eea6fe61cfca977ec41e6ea7ec4efd4';
const previousJointReaderHash = '4eb73a411759726ca3affadf365ed62a19d89eb66cdcf4a2b2d4009b305b1732';
const previousExtrasReaderHash = '61063eb83822a0575495eddbf015290e6ea69b52195f2c62458c8e8c4629148c';
const previousDomainReaderHash = 'e2f754c141bc2264965c3802438a5a94c432de3c25b2dcc9eb169de30eb98a4f';
const stageVersionsReaderHash = 'e37375a2fa4c6a955be191b64a42b8c0d6a955392ef4666f806b98ea6ef6691d';
const stageParametersReaderHash = 'c1bd8d5229a6835b1e4417f353e2007e1a4ca204935375c97b5046852a503add';
const previousReaderHash = 'd4c50514b0b45389031765a324ffe251887841b86bbc0fc868858fbac4140491';
const legacyReaderHash = 'ffdff33ab11c39ca1b5d19a28c44de89268d5583e0abff501231e050512cd41d';
const MAX_RESPONSE = 44 * 1024 * 1024;
const MAX_CONTOUR_RESPONSE = 8 * 1024 * 1024;
const MAX_HISTORY_BATCH_SIZE = 32;
const MAX_HISTORY_BATCH_RESPONSE = 2 * 1024 * 1024;
const MAX_CONCURRENT_DENSITIES = 4;
const originalOptionalViews = ['raw_artifacts', 'mask_layers', 'joint_posterior'];
const jointDisplayViews = ['joint_parameters', 'joint_density'];
const optionalViews = new Set([...originalOptionalViews, ...jointDisplayViews, 'inherited_configuration', 'history_lineage']);
const stageOrder = ['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3'];
const displayQueryFields = new Set(['updateId', 'updateIds', 'view', 'x', 'y']);
const sampleParameter = value => typeof value === 'string' && value.length >= 1 && value.length <= 160
  && value.trim() === value && !/[\0\r\n]/.test(value);
const defaultCache = fileURLToPath(new URL('../.local/display-cache/', import.meta.url));
const pending = new Map();
let densitiesInFlight = 0;
const extensions = {
  data: 'DATA', noise: 'RMS', snr: 'SNR', psf: 'PSF',
  observation: 'DATA', mask: 'ARC_MASK', domain: 'VALID_DOMAIN',
  model: 'MODEL', 'source-lensed': 'LENSED_SOURCE', source: 'SOURCE',
  residual: 'RESIDUAL', 'chi-square': 'CHI_SQUARE',
};
const keys = contract.required;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const directPreflightImages = Object.values(contract.rawArtifacts.preflight);

export function reportedDisplay(state, updateId, view) {
  const report = state.threadId && state.updates.find(item =>
    item.id === updateId && item.threadId === state.threadId && ['artifact', 'stage'].includes(item.kind));
  if (report) validateStageReport(report, WORKSPACE);
  const path = report?.display_manifest ?? report?.path;
  if (typeof path !== 'string' || path.includes('\0') || posix.normalize(path) !== path
    || !path.startsWith(WORKSPACE + '/output/')) throw Error('An explicit display manifest is required.');
  const display = /^(.*)\/(?:preflight|attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*))\/(display\/?|display-manifest\.json|inspection\.json|stage-result\.json)$/.exec(path);
  const directImage = view === 'raw_artifacts' && report.kind === 'artifact'
    && directPreflightImages.includes(posix.basename(path)) && posix.basename(posix.dirname(path)) === 'preflight';
  const run = display?.[1] ?? (directImage ? posix.dirname(posix.dirname(path)) : undefined);
  const stage = display?.[2] ?? 'preflight';
  if (!run?.startsWith(WORKSPACE + '/output/') || report.stage?.trim().toLowerCase() !== stage) {
    throw Error('Display report does not match its stage.');
  }
  const declaration = stage === 'preflight' ? 'inspection.json' : 'stage-result.json';
  const anchor = display?.[4] ?? posix.basename(path);
  if (!directImage && anchor !== declaration
    && ((report.kind !== 'artifact' && path !== report.display_manifest) || !/^display(?:\/|-manifest\.json)?$/.test(anchor))) {
    throw Error('An explicit stage display report is required.');
  }
  const attempt = display?.[3] === undefined ? null : Number(display[3]);
  if (view === 'inherited_configuration' && (report.schema !== stageReportSchema || !/^m[0-3]$/.test(stage))) {
    throw Error('A reported downstream attempt is required for inherited configuration.');
  }
  if (view === 'history_lineage' && report.schema !== stageReportSchema) {
    throw Error('A versioned display report is required for history lineage.');
  }
  const request = { root: WORKSPACE, path, run, stage, attempt,
    ...(hash(report.manifestSha256) && { manifestSha256: report.manifestSha256 }) };
  if (view === 'raw_artifacts' && stage === 'preflight' && (directImage || anchor === 'inspection.json')
    && !request.manifestSha256 && (report.schema === stageReportSchema || unambiguousLegacyRun(state, run))) {
    request.legacyRaw = true;
  }
  if (directImage && !request.legacyRaw) throw Error('The preflight image report has no unambiguous run scope.');
  if (report.schema !== stageReportSchema) return request;
  if (report.run_path !== request.run || report.attempt !== attempt) throw Error('Display path and attempt scope disagree.');
  const archiveReport = state.updates.findLast(update => update.threadId === state.threadId
    && update.run_id === report.run_id && update.run_path === report.run_path && archiveForReport(update));
  if (archiveReport) validateStageReport(archiveReport, WORKSPACE);
  return { ...request, runId: report.run_id, ...(archiveReport && { storageRun: archiveForReport(archiveReport) }) };
}

function unambiguousLegacyRun(state, run) {
  if (run.split('/').includes('_archive')) return false;
  const archive = `${posix.dirname(run)}/_archive`;
  const archivePrefix = posix.basename(run) + '_old_';
  return !state.updates.some(update => {
    if (update.threadId !== state.threadId) return false;
    if (update.run_id && (update.run_path === run
      || (typeof update.path === 'string' && update.path.startsWith(run + '/')))) return true;
    if (typeof update.path !== 'string' || posix.basename(update.path) !== 'run-manifest.json') return false;
    const folder = posix.dirname(update.path);
    const label = posix.basename(folder);
    return posix.dirname(folder) === archive && label.startsWith(archivePrefix)
      && /^(0|[1-9]\d*)$/.test(label.slice(archivePrefix.length));
  });
}

function legacyJointEligible(state, request) {
  return jointDisplayViews.includes(request.view) && !request.runId && !request.manifestSha256
    && request.path.endsWith('/stage-result.json') && unambiguousLegacyRun(state, request.run);
}

function raster(values, shape, bounds, sha, { decreasing = false, limits, color = 'magma', valid } = {}) {
  if (valid && (valid.length !== values.length || valid.some(value => value !== 0 && value !== 1))) {
    throw Error('Invalid display mask.');
  }
  const mask = valid ? Buffer.from(valid) : Buffer.alloc(values.length, 1);
  const raw = Buffer.alloc(values.length * 8);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (mask[i]) { lo = Math.min(lo, value); hi = Math.max(hi, value); }
    raw.writeDoubleLE(value, i * 8);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw Error('No visible display pixels.');
  return numericalPlane({
    shape, bounds_arcsec: bounds, half_extent_arcsec: (bounds[3] - bounds[2]) / 2,
    vmin: limits?.[0] ?? lo, vmax: limits?.[1] ?? hi, data_min: lo, data_max: hi,
    stretch: 'linear', asinh_a: 1, colormap: color, input_fits_sha256: sha,
    values_base64: raw.toString('base64'), values_sha256: numericalHash(raw),
    mask_base64: mask.toString('base64'),
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
  const expected = keys[kind];
  const named = namedSchemas.includes(manifest.schema);
  const roles = Object.keys(metadata).filter(role => !(named && role === 'lens-light' && !fits.has(role)));
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
  if (out['lens-light'] && out['lens-light'].unit !== image.unit) throw Error('Published lens light unit mismatch.');
  return out;
}

function namedImages(manifest, envelope) {
  const encoded = envelope.fits_files;
  if (!encoded) throw Error('Missing named FITS files.');
  const entries = Object.entries(manifest.planes)
    .filter(([role]) => !(role === 'lens-light' && !Object.hasOwn(encoded, role)));
  if (Object.keys(encoded).length !== entries.length) throw Error('Missing named FITS files.');
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
  const valid = arrays.domain.values;
  const domain = flippedRows(valid, arrays.domain.shape);
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
    plane: raster(values, shape, bounds, m.input.sha256, { valid }),
    ...(lensed && { lensed_source_plane: raster(lensed.values, lensed.shape, lensed.bounds, m.input.sha256, { valid }) }),
  };
}

function validateHistoryLineage(result, request, manifest) {
  if (!Array.isArray(result.upstream) || !Array.isArray(manifest?.upstream) || result.upstream.length >= stageOrder.length) {
    throw Error('Invalid stage history lineage.');
  }
  const childIndex = stageOrder.indexOf(request.stage);
  const lens = posix.basename(request.run);
  let previous = -1;
  let inheritedSource;
  const inheritedStages = new Set();
  for (const link of result.upstream) {
    const stage = link?.stage;
    const index = stageOrder.indexOf(stage);
    if (index <= previous || index >= childIndex || typeof link.run_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(link.run_id)
        || typeof link.run_path !== 'string' || !link.run_path.startsWith(request.root + '/output/')
        || link.run_path.includes('\0') || link.run_path.endsWith('/') || posix.normalize(link.run_path) !== link.run_path
        || link.run_path.split('/').includes('_archive') || posix.basename(link.run_path) !== lens
        || (stage === 'preflight' ? link.attempt !== null : !Number.isSafeInteger(link.attempt) || link.attempt < 0
          || !manifest.upstream.some(entry => entry.stage === stage && entry.attempt === link.attempt))) {
      throw Error('Stage history lineage leaves the reported run or attempt scope.');
    }
    previous = index;
    if (link.run_id === request.runId && link.run_path === request.run) continue;
    if (link.run_id === request.runId || link.run_path === request.run || index > stageOrder.indexOf('b')) {
      throw Error('Only inherited preprocessing and A/B stages may come from a different run.');
    }
    const source = JSON.stringify([link.run_id, link.run_path]);
    if (inheritedSource && inheritedSource !== source) throw Error('Inherited stages disagree on their source run.');
    inheritedSource = source;
    inheritedStages.add(stage);
  }
  if (inheritedSource && (!inheritedStages.has('a') || !inheritedStages.has('b')
    || result.upstream.some(link => link.stage === 'preflight' && link.run_id === request.runId))) {
    throw Error('Inherited stage history is incomplete.');
  }
}

function optionalDisplayPayload(envelope, request, schema) {
  if (!optionalViews.has(request.view)) throw Error('Unknown optional display view.');
  const result = envelope[request.view];
  if (request.view === 'raw_artifacts' && result != null && request.stage === 'preflight') {
    const reportName = posix.basename(request.path);
    const names = directPreflightImages.includes(reportName) ? [reportName] : directPreflightImages;
    if (!Array.isArray(result) || result.length > names.length
      || new Set(result.map(entry => entry?.name)).size !== result.length
      || result.some(entry => !names.includes(entry?.name))) {
      throw Error('Original image does not belong to the reported preflight scope.');
    }
  }
  if (request.view === 'joint_density' && result != null
    && (result.method !== 'getdist' || !same(result.parameters, [request.x, request.y]))) {
    throw Error('The joint density does not match the selected parameters.');
  }
  if (request.view === 'inherited_configuration' && result != null
    && (result.run_id !== request.runId || result.stage !== 'a' || !hash(result.summary_sha256)
      || !Number.isSafeInteger(result.attempt) || result.attempt < 0)) {
    throw Error('The inherited model configuration belongs to a different stage or run.');
  }
  if (request.view === 'history_lineage' && result != null) validateHistoryLineage(result, request, envelope.manifest);
  return { schema, report_path: request.path, stage: request.stage, attempt: request.attempt,
    ...(['inherited_configuration', 'history_lineage'].includes(request.view) && { run_id: request.runId }),
    ...(result != null && { [request.view]: result }) };
}

export function adaptDisplayEnvelope(envelope, request) {
  const rawScope = envelope?.legacy_raw_scope;
  if (rawScope) {
    if (request.legacyRaw !== true || request.view !== 'raw_artifacts' || request.manifestSha256
      || request.stage !== 'preflight' || request.attempt !== null
      || rawScope.run !== request.run || rawScope.run_id !== request.runId
      || rawScope.stage !== request.stage || rawScope.attempt !== request.attempt
      || ![rawScope.run_sha256, rawScope.inspection_sha256].every(hash)) {
      throw Error('Legacy preflight original image identity mismatch.');
    }
    return optionalDisplayPayload(envelope, request, legacySchema);
  }
  const legacy = envelope?.legacy_joint_scope;
  if (legacy) {
    if (request.legacyJoint !== true || !jointDisplayViews.includes(request.view) || request.runId || request.manifestSha256
      || legacy.run !== request.run || legacy.stage !== request.stage || legacy.attempt !== request.attempt
      || ![legacy.run_sha256, legacy.summary_sha256, legacy.posterior_sha256].every(hash)) {
      throw Error('Legacy joint posterior identity mismatch.');
    }
    return optionalDisplayPayload(envelope, request, legacySchema);
  }
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
  const payload = { schema: m.schema, report_path: request.path, stage: request.stage, attempt: request.attempt };
  if (request.view) return optionalDisplayPayload(envelope, request, m.schema);
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
  const grid = result.metrics.source_grid_spec;
  const gridMetrics = grid?.schema_version === 'source_grid_spec.v1'
    && Number.isSafeInteger(grid.nsrc) && grid.nsrc > 0
    && Number.isFinite(grid.pixel_scale_arcsec) && grid.pixel_scale_arcsec > 0
    ? { source_grid_spec: { schema_version: grid.schema_version, nsrc: grid.nsrc, pixel_scale_arcsec: grid.pixel_scale_arcsec } }
    : {};
  // Previous verified display caches carried configuration inside the parameter packet only.
  const savedConfig = Object.hasOwn(envelope, 'configuration') ? config ?? undefined : packet?.config;
  const summary = { ...identity, ...namedParameters, kind: 'summary', sha256: m.summary.sha256,
    result: current ? { ...result, metrics: packet?.metrics ?? gridMetrics } : result,
    config: savedConfig, fixed_parameters: packet?.fixed_parameters,
    linear_parameters: packet?.linear_parameters };
  if (kind === 'b') {
    let mask;
    if (arrays) {
      try { mask = maskPayload(m, arrays, request, { result, config: summary.config }); }
      catch (error) { if (!current) throw error; }
    }
    return { ...payload, summary, mask };
  }

  let planes;
  if (arrays) {
    try {
      const valid = arrays.domain?.values;
      const fitCount = result.metrics.residual_diagnostics?.pixel_count;
      if (valid && fitCount !== undefined && valid.reduce((n, pixel) => n + pixel, 0) !== fitCount) {
        throw Error('Display mask disagrees with the fitted pixel count.');
      }
      const range = request.stage === 'a' ? 5 : 3;
      planes = Object.fromEntries(Object.entries(arrays).filter(([role]) => role !== 'domain')
        .map(([role, { values, shape, bounds, unit, header }]) => {
          const limits = role === 'residual' ? [-range, range] : role === 'chi-square' ? [0, range * range] : undefined;
          const color = limits ? 'blue-white-red' : role === 'source' && request.stage !== 'm1' ? 'inferno' : 'magma';
          const savedUnit = namedSchemas.includes(m.schema) ? unit : header.BUNIT;
          const label = typeof savedUnit === 'string' ? savedUnit.trim() : '';
          const plane = raster(values, shape, bounds, m.input.sha256, { limits, color, valid: role === 'source' ? undefined : valid });
          return [role, { ...plane, ...(label && { unit: label }),
            ...(role === 'source-lensed' && valid && { mask_scope: 'likelihood-fit' }) }];
        }));
    } catch (error) { if (!current) throw error; }
    if (planes && current && !Object.hasOwn(m.planes, 'lens-light') && typeof envelope.legacy_lens_light === 'string') {
      const { values: observation, shape, bounds, unit } = arrays.observation;
      const total = arrays.model.values, source = arrays['source-lensed'].values;
      const bytes = Buffer.from(envelope.legacy_lens_light, 'base64');
      if (bytes.length === observation.length * 8) {
        const light = Float64Array.from(observation, (_, i) => bytes.readDoubleLE(i * 8));
        if (light.every((value, i) => Number.isFinite(value)
            && Math.abs(value + source[i] - total[i]) <= 1e-7 * Math.max(1, Math.abs(total[i])))) {
          planes['lens-light'] = { ...raster(light, shape, bounds, m.input.sha256, { valid: arrays.domain?.values }),
            ...(unit && { unit }) };
        }
      }
    }
  }
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
  } else if (current && request.stage === 'a' && planes?.observation && planes.source
      && !Object.hasOwn(m, 'mapping_file') && !Object.hasOwn(m, 'mapping')
      && hash(parameterSource?.sha256) && packet?.metrics?.medians
      && isDeepStrictEqual(packet.metrics.medians, result.metrics.medians)) {
    summary.display_mapping_from_parameters = true;
  }
  const distribution = current ? packet?.distribution : parameters;
  const posterior = distribution ? { ...distribution, ...identity, sha256: m.parameters.sha256 } : undefined;
  return { ...payload, summary, posterior };
}

function readRemoteDisplay(request, spawnProcess, timeout) {
  const command = 'env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 OMP_NUM_THREADS=1 MPLBACKEND=Agg '
    + shellQuote(connectionConfig.python)
    + ' -B -c ' + shellQuote(DISPLAY_READER);
  const limit = request.historyLineageBatch ? MAX_HISTORY_BATCH_RESPONSE
    : request.view === 'joint_density' ? MAX_CONTOUR_RESPONSE : MAX_RESPONSE;
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
      if (bytes > limit) { child.kill(); fail(Error('Display package exceeds the size limit.')); }
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

export async function readReportedDisplay(state, updateId, {
  spawnProcess = spawn, timeoutMs = 45000, cacheDirectory = defaultCache, view, x, y,
} = {}) {
  if (view !== undefined) {
    if (!optionalViews.has(view)) throw Error('Unknown optional display view.');
  }
  const request = reportedDisplay(state, updateId, view);
  if (view !== undefined) request.view = view;
  const density = view === 'joint_density';
  const fresh = view === 'inherited_configuration' || view === 'history_lineage';
  if (density) {
    if (!sampleParameter(x) || !sampleParameter(y) || x === y) throw Error('Choose two different sampled parameters.');
    Object.assign(request, { x, y });
  } else if (x !== undefined || y !== undefined) {
    throw Error('Axes are only valid when requesting a joint density.');
  }
  if (legacyJointEligible(state, request)) request.legacyJoint = true;
  // An explicitly archived run keeps its original immutable cache identity.
  const { storageRun, ...cacheRequest } = request;
  const identity = JSON.stringify([state.threadId, updateId, cacheRequest, readerHash]);
  const location = join(cacheDirectory, numericalHash(identity) + '.json');
  const cacheKeys = fresh ? [] : [identity];
  if (!view) {
    const previous = [previousHistoryBatchReaderHash, previousLineageReaderHash, previousDisplayReaderHash, previousMaskReaderHash, previousJointReaderHash, previousExtrasReaderHash, previousDomainReaderHash,
      stageVersionsReaderHash, stageParametersReaderHash, previousReaderHash];
    if (request.path.endsWith('/display-manifest.json')) previous.push(legacyReaderHash);
    cacheKeys.push(...previous.map(hash => JSON.stringify([state.threadId, updateId, cacheRequest, hash])));
  } else if (!fresh) {
    const previous = [previousHistoryBatchReaderHash, previousLineageReaderHash];
    if (view !== 'mask_layers') previous.push(previousDisplayReaderHash, previousMaskReaderHash);
    if (view !== 'mask_layers' && originalOptionalViews.includes(view)) previous.push(previousJointReaderHash);
    cacheKeys.push(...previous.map(hash => JSON.stringify([state.threadId, updateId, cacheRequest, hash])));
  }
  let cachedModel;
  for (const key of cacheKeys) {
    const cached = join(cacheDirectory, numericalHash(key) + '.json');
    try {
      if ((await stat(cached)).size > (density ? MAX_CONTOUR_RESPONSE : MAX_RESPONSE)) continue;
      const record = JSON.parse(await readFile(cached, 'utf8'));
      if (record.identity !== key || record.sha256 !== numericalHash(JSON.stringify(record.envelope))) continue;
      const payload = adaptDisplayEnvelope(record.envelope, request);
      const planes = payload.summary?.planes;
      if (key === identity || !planes || planes['lens-light']) return payload;
      cachedModel ??= payload;
    } catch { /* Only attempt the same explicitly reported package. */ }
  }
  if (pending.has(location)) return pending.get(location);
  if (density && densitiesInFlight >= MAX_CONCURRENT_DENSITIES) throw Error('The joint density reader is busy.');
  if (density) densitiesInFlight++;
  const operation = (async () => {
    const envelope = await readRemoteDisplay(request, spawnProcess, timeoutMs);
    const payload = adaptDisplayEnvelope(envelope, request);
    if (view) {
      if (fresh || payload[view] == null || payload[view]?.length === 0) return payload;
      // Only a published raw-artifact index pins the image bytes across reads.
      if (view === 'raw_artifacts' && request.stage === 'preflight' && !envelope.manifest?.raw_artifacts)
        return payload;
      if (view === 'mask_layers' && Object.keys(envelope.manifest.mask_layers ?? {}).some(name => !payload.mask_layers[name]))
        return payload;
    } else if (payload.schema === DISPLAY_SCHEMA) {
      const missingImages = Object.keys(envelope.manifest.planes).length > 0 && !(payload.input || payload.mask || payload.summary?.planes);
      const missingLensLight = envelope.manifest.planes['lens-light'] && !payload.summary?.planes?.['lens-light'];
      const missingParameters = envelope.manifest.parameters && !envelope.parameter_packet;
      const missingMapping = envelope.manifest.mapping_file && !envelope.mapping_packet;
      const missingConfiguration = request.stage !== 'preflight' && !envelope.configuration;
      if (missingImages || missingLensLight || missingParameters || missingMapping || missingConfiguration) return payload;
    }
    try {
      await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      const temporary = location + randomUUID();
      await writeFile(temporary, JSON.stringify({ identity, envelope, sha256: numericalHash(JSON.stringify(envelope)) }), { mode: 0o600 });
      await rename(temporary, location);
    } catch { /* A verified package can still be used when local caching is unavailable. */ }
    return payload;
  })().catch(error => {
    if (cachedModel) return cachedModel;
    throw error;
  });
  pending.set(location, operation);
  try { return await operation; } finally {
    pending.delete(location);
    if (density) densitiesInFlight--;
  }
}

async function readReportedHistoryBatch(state, updateIds, { spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  const requests = new Map();
  for (const updateId of updateIds) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(updateId) || requests.has(updateId)) continue;
    try {
      requests.set(updateId, { ...reportedDisplay(state, updateId, 'history_lineage'), view: 'history_lineage' });
    } catch { /* A missing report, or one outside this conversation, contributes no lineage. */ }
  }
  if (!requests.size) return { results: {} };
  const key = 'history:' + numericalHash(JSON.stringify([state.threadId, [...requests], readerHash]));
  if (pending.has(key)) return pending.get(key);
  const operation = (async () => {
    const batch = await readRemoteDisplay({ historyLineageBatch: [...requests.values()] }, spawnProcess, timeoutMs);
    if (!Array.isArray(batch?.envelopes) || batch.envelopes.length !== requests.size) throw Error('Invalid history batch response.');
    const results = [];
    let index = 0;
    for (const [updateId, request] of requests) {
      const envelope = batch.envelopes[index++];
      try {
        const payload = adaptDisplayEnvelope(envelope, request);
        if (payload.history_lineage) results.push([updateId, payload]);
      } catch { /* Only this report's verification failed. */ }
    }
    return { results: Object.fromEntries(results) };
  })().catch(() => { throw Object.assign(Error('The stage history could not be read.'), { statusCode: 503 }); });
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

export async function serveReportedDisplay(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => !displayQueryFields.has(key) || query.getAll(key).length > 1)) {
      throw Error('A display report identifier is required.');
    }
    let payload;
    if (query.has('updateIds')) {
      const values = query.get('updateIds').split(',');
      if (query.has('updateId') || query.get('view') !== 'history_lineage' || query.has('x') || query.has('y')
          || !query.get('updateIds') || values.length > MAX_HISTORY_BATCH_SIZE) {
        throw Object.assign(Error('Supply up to 32 report identifiers for stage history.'), { statusCode: 400 });
      }
      payload = await readReportedHistoryBatch(state, values, options);
    } else {
      if (!query.get('updateId')) throw Error('A display report identifier is required.');
      payload = await readReportedDisplay(state, query.get('updateId'), {
        ...options, view: query.get('view') ?? undefined, x: query.get('x') ?? undefined, y: query.get('y') ?? undefined,
      });
    }
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(payload));
  } catch (error) {
    response.writeHead(error.statusCode ?? 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: error.message }));
  }
}
