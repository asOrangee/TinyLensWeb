import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { connectionConfig, shellQuote } from './connection-config.mjs';
import { WORKSPACE } from './agent-state.mjs';
import { withAttemptEvidenceReader } from './attempt-evidence-reader.mjs';
import { DISPLAY_READER, DISPLAY_SCHEMA, adaptDisplayEnvelope } from './agent-display.mjs';
import { MASK_READER, validateMask } from './agent-masks.mjs';
import { readAcceptedModel, readReportedModel } from './agent-models.mjs';
import { REMOTE_RESULT_READER } from './agent-results.mjs';
import { numericalPlane } from './numeric-payload.mjs';

const execute = promisify(execFile);
export const ACCEPTED_READER = withAttemptEvidenceReader(
  'MASK_READER = ' + JSON.stringify(MASK_READER) + '\n'
  + 'RESULT_READER = ' + JSON.stringify(REMOTE_RESULT_READER) + '\n'
  + 'DISPLAY_READER = ' + JSON.stringify(DISPLAY_READER) + '\n'
  + 'DISPLAY_SCHEMA = ' + JSON.stringify(DISPLAY_SCHEMA) + '\n'
  + await readFile(new URL('./read-accepted-stage.py', import.meta.url), 'utf8')
);

export function reportedAcceptance(state, id, stage, attempt) {
  const reports = state.updates.filter(item => state.threadId && item.threadId === state.threadId);
  const report = reports.find(item => item.id === id);
  const path = report?.path;
  const head = typeof path === 'string' && /^(.*)\/accepted\/(a|b|m0|m1)\.json$/.exec(path);
  if (!head || path.includes('\0') || posix.normalize(path) !== path || !head[1].startsWith(WORKSPACE + '/output/')
      || !['artifact', 'stage'].includes(report.kind) || report.status !== 'accepted' || report.schema
      || report.stage?.trim().toLowerCase() !== head[2] || (head[2] !== stage && !(head[2] === 'm0' && stage === 'b'))
      || reports.some(update => update.run_path === head[1] && update.run_id)
      || (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 0))) {
    throw Error('An explicit acceptance report from the older run is required.');
  }
  const prefix = `${head[1]}/attempts/${head[2]}/`;
  const reportedAttempts = new Set(reports.filter(update => report.turnId && update.turnId === report.turnId
    && update.stage?.trim().toLowerCase() === head[2] && update.path?.startsWith(prefix))
    .map(update => update.path.slice(prefix.length).split('/')[0]).filter(item => /^(0|[1-9]\d*)$/.test(item)));
  const anchorAttempt = report.verified_attempt ?? (reportedAttempts.size === 1 ? Number([...reportedAttempts][0]) : undefined);
  return { root: WORKSPACE, path, run: head[1], stage, attempt, anchorAttempt };
}

async function readAcceptance(request) {
  const command = 'env CUDA_VISIBLE_DEVICES= OPENBLAS_NUM_THREADS=1 MPLBACKEND=Agg '
    + shellQuote(connectionConfig.python) + ' -B -c ' + shellQuote(
      'import io,sys\nsys.stdin=io.StringIO('
      + JSON.stringify(JSON.stringify(request) + '\n') + ')\n' + ACCEPTED_READER);
  try {
    const { stdout } = await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      connectionConfig.sshHost, command], { timeout: 25000, maxBuffer: 44 * 1024 * 1024 });
    const value = JSON.parse(stdout);
    if (value.stage === request.stage && value.report_path === request.path) return value;
  } catch {
    throw Error('The accepted result could not be verified.');
  }
  throw Error('Accepted result identity mismatch.');
}

async function cachedForeground(state, foreground, options) {
  if (!foreground) return undefined;
  const report = state.updates.findLast(item => item.threadId === state.threadId
    && item.stage?.trim().toLowerCase() === 'a' && item.kind === 'artifact' && item.path === foreground.decision);
  if (!report) return undefined;
  try {
    const model = await readReportedModel(state, report.id, { ...options, cacheOnly: true });
    if (model?.sha256 === foreground.summarySha256
        && model?.display_derivation?.input_files_sha256?.[foreground.decision] === foreground.decisionSha256) return model;
  } catch { /* The accepted mask and parameters do not depend on a cached model. */ }
}

function numericalModel(model, path) {
  return { ...model, path, ...(model.display_mapping && { display_mapping: { ...model.display_mapping, path } }),
    planes: Object.fromEntries(Object.entries(model.planes).map(([key, plane]) => [key, numericalPlane(plane)])) };
}

export async function readAcceptedDisplay(state, id, stage, { attempt, projectSavedSource = false, ...options } = {}) {
  const request = reportedAcceptance(state, id, stage, attempt);
  const { display, foreground, reconstruction, ...result } = await readAcceptance(request);
  const summary = result.summary;
  const path = `${request.run}/attempts/${stage}/${summary?.attempt}/stage-result.json`;
  if (summary?.stage !== stage || !Number.isSafeInteger(summary.attempt) || summary.attempt < 0 || summary.path !== path) {
    throw Error('Accepted summary identity mismatch.');
  }
  if (display) {
    try {
      const bundle = adaptDisplayEnvelope(display, { ...request, path, attempt: summary.attempt });
      if (bundle.summary?.sha256 === summary.sha256) return { ...bundle, report_path: request.path };
    } catch { /* A missing manifest still leaves the accepted summary. */ }
  }
  if (summary.result?.display?.schema === DISPLAY_SCHEMA) return { stage, report_path: request.path, summary };
  if (result.mask) {
    const mask = validateMask(result.mask, { path, attempt: summary.attempt });
    if (mask.sha256 !== summary.sha256) throw Error('Mask disagrees with the accepted summary.');
    const plane = numericalPlane(mask.plane);
    const lensed = (await cachedForeground(state, foreground, options))?.planes?.['source-lensed'];
    const aligned = lensed?.input_fits_sha256 === mask.input_fits_sha256
      && JSON.stringify(lensed.shape) === JSON.stringify(plane.shape)
      && JSON.stringify(lensed.bounds_arcsec) === JSON.stringify(plane.bounds_arcsec);
    return { ...result, mask: { ...mask, plane, ...(aligned && { lensed_source_plane: numericalPlane(lensed) }) } };
  }
  if (result.observation) result.observation = numericalPlane(result.observation);
  let model;
  try {
    model = reconstruction ? await readAcceptedModel(state, reconstruction, { ...options, projectSavedSource })
      : await cachedForeground(state, foreground, options);
  } catch (error) {
    if (projectSavedSource) throw error;
  }
  if (model?.sha256 === summary.sha256 && (!reconstruction || model.planes.observation.input_fits_sha256 === reconstruction.inputSha256)) {
    result.model = numericalModel(model, path);
  }
  return result;
}

export async function serveAcceptedDisplay(request, response, state, options) {
  try {
    const query = new URL(request.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => !['stage', 'updateId', 'attempt'].includes(key))
        || query.getAll('updateId').length !== 1 || query.getAll('stage').length !== 1
        || query.getAll('attempt').length > 1) throw Error('Expected one stage and acceptance report.');
    const index = query.get('attempt');
    if (index !== null && !/^(0|[1-9]\d*)$/.test(index)) throw Error('Invalid accepted attempt.');
    const value = await readAcceptedDisplay(state, query.get('updateId'), query.get('stage'), {
      ...options, attempt: index === null ? undefined : Number(index),
    });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value));
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ error: error.message }));
  }
}
