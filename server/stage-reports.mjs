import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { connectionConfig, shellQuote } from './connection-config.mjs';

export const stageReportSchema = 'tinylens.stage-report.v1';
export const stageReportFields = {
  schema: { type: 'string', enum: [stageReportSchema] },
  run_id: { type: 'string' }, run_path: { type: 'string' }, lens_id: { type: 'string' },
  attempt: { type: ['integer', 'null'], minimum: 0 }, display_manifest: { type: 'string' },
};
const stages = new Set(['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3']);
const statuses = new Set(['preparing', 'running', 'executed', 'awaiting_review', 'reviewing', 'accepted',
  'human_review', 'retry', 'failed', 'rejected', 'interrupted', 'paused', 'blocked', 'queued']);
const canonical = path => typeof path === 'string' && path.length <= 4000 && posix.isAbsolute(path)
  && !/[\0\r\n]/.test(path) && posix.normalize(path) === path;
const inside = (path, base) => canonical(path) && path.startsWith(base + '/');
const stageDirectory = ({ run_path, stage, attempt }) => stage === 'preflight' ? `${run_path}/preflight` : `${run_path}/attempts/${stage}/${attempt}`;
const execute = promisify(execFile);
export const STAGE_SCOPE_READER = await readFile(new URL('./read-stage-scope.py', import.meta.url), 'utf8');

export function archiveForReport(report) {
  if (report?.schema !== stageReportSchema || report.kind !== 'artifact' || report.stage !== 'preflight'
      || report.attempt !== null || !canonical(report.path) || !canonical(report.run_path)) return undefined;
  const folder = posix.dirname(report.path);
  const prefix = `${posix.dirname(report.run_path)}/_archive/${posix.basename(report.run_path)}_old_`;
  return folder.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(folder.slice(prefix.length))
    && posix.basename(report.path) === 'run-manifest.json' ? folder : undefined;
}

/** Validate only delivery scope. A reported acceptance is the AI's decision. */
export function validateStageReport(report, workspace) {
  if (!Object.keys(stageReportFields).some(key => Object.hasOwn(report, key))) return;
  if (report.schema !== stageReportSchema || !['artifact', 'stage'].includes(report.kind)
      || !stages.has(report.stage) || typeof report.run_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(report.run_id)
      || !inside(report.run_path, workspace + '/output') || report.run_path.endsWith('/')
      || report.run_path.split('/').includes('_archive') || report.lens_id !== posix.basename(report.run_path)
      || (report.stage === 'preflight' ? report.attempt !== null : !Number.isSafeInteger(report.attempt) || report.attempt < 0)) {
    throw Error('Invalid stage report run or attempt scope.');
  }
  const folder = stageDirectory(report);
  if (report.display_manifest !== undefined && report.display_manifest !== `${folder}/display-manifest.json`) {
    throw Error('The display manifest belongs to a different attempt.');
  }
  if (report.kind === 'artifact') {
    if (!inside(report.path, folder) && !archiveForReport(report)) throw Error('The artifact belongs to a different attempt.');
    return;
  }
  if (!statuses.has(report.status)) throw Error('Invalid stage report status.');
  const acceptedPath = report.stage === 'preflight' ? `${folder}/inspector.json` : `${report.run_path}/accepted/${report.stage}.json`;
  if (report.status === 'accepted' && report.path !== acceptedPath) throw Error('Report the verified acceptance record for this stage.');
  if (report.path !== undefined && report.path !== acceptedPath && !inside(report.path, folder)) {
    throw Error('The status evidence belongs to a different attempt.');
  }
}

export function keepStageReport(report, workspace) {
  const stage = typeof report.stage === 'string' ? report.stage.trim().toLowerCase().replace(/^stage[\s_-]+/, '') : undefined;
  if (!stages.has(stage) && stage !== 'p') return false;
  if (report.kind === 'stage' || report.schema === stageReportSchema) return true;
  return report.kind === 'artifact' && inside(report.path, workspace + '/output')
    && /\/(?:preflight|attempts\/(?:a|b|m0|m1|m2|m3)\/\d+)\//.test(report.path);
}

function legacyScope(report, workspace, stage) {
  if (!inside(report.path, workspace + '/output')) return undefined;
  const archive = /^(.*)\/_archive\/([^/]+)_old_(?:0|[1-9]\d*)\/run-manifest\.json$/.exec(report.path);
  if (stage === 'preflight' && archive && report.kind === 'artifact') {
    return { run_path: `${archive[1]}/${archive[2]}`, storage: posix.dirname(report.path), attempt: null };
  }
  if (stage === 'preflight') {
    const preview = /^(.*)\/preflight\/[^/]+\/?$/.exec(report.path);
    return preview && { run_path: preview[1], storage: preview[1], attempt: null };
  }
  const head = new RegExp(`^(.*)/accepted/${stage}\\.json$`).exec(report.path);
  if (head && report.kind === 'stage' && report.status === 'accepted') return { run_path: head[1], storage: head[1], attempt: null };
  const attempt = new RegExp(`^(.*)/attempts/${stage}/(0|[1-9]\\d*)(?:/|$)`).exec(report.path);
  return attempt && { run_path: attempt[1], storage: attempt[1], attempt: Number(attempt[2]) };
}

/** Existing Codex threads can still report canonical paths with their original tool schema. */
export async function readStageScope(report, workspace, { verifyHumanReview = false, expectedLensDirectory } = {}) {
  if (!['stage', 'artifact'].includes(report?.kind)) return undefined;
  if (typeof report.stage !== 'string') return undefined;
  validateStageReport(report, workspace);
  const stage = report.stage.trim().toLowerCase();
  if (!stages.has(stage)) return undefined;
  const accepted = report.kind === 'stage' && report.status === 'accepted';
  const versioned = report.schema === stageReportSchema;
  const humanReview = verifyHumanReview && versioned && report.kind === 'stage' && report.status === 'human_review';
  if (humanReview && report.path !== `${stageDirectory(report)}/${stage === 'preflight' ? 'inspector.json' : 'decision.json'}`) {
    throw Error('Report the canonical Human Review record for this stage.');
  }
  const info = versioned ? (accepted || humanReview) && { run_path: report.run_path, storage: report.run_path, attempt: report.attempt }
    : legacyScope(report, workspace, stage);
  if (!info) return undefined;
  const lens_id = posix.basename(info.run_path);
  const request = { root: workspace, storage: info.storage, lens_id, stage, attempt: info.attempt, accepted,
    human_review: humanReview, input_lens: expectedLensDirectory };
  try {
    const command = [shellQuote(connectionConfig.python), '-B', '-c', shellQuote(STAGE_SCOPE_READER), shellQuote(JSON.stringify(request))].join(' ');
    const { stdout } = await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', connectionConfig.sshHost, command],
      { timeout: 5000, maxBuffer: 32 * 1024 });
    const scope = JSON.parse(stdout);
    if (versioned) {
      if (scope.run_id !== report.run_id || scope.attempt !== report.attempt) throw Error('Run version disagrees with the scientific record.');
      return undefined;
    }
    if (!scope.run_id) return accepted && stage !== 'preflight' ? { verified_attempt: scope.attempt } : undefined;
    const aliases = { review_pending: 'awaiting_review', pending_review: 'awaiting_review', in_review: 'reviewing',
      complete: 'executed', completed: 'executed', success: 'executed', succeeded: 'executed', error: 'failed', retrying: 'running' };
    const normalized = { schema: stageReportSchema, stage, run_path: info.run_path, lens_id, run_id: scope.run_id, attempt: scope.attempt,
      ...(Object.hasOwn(aliases, report.status) && { status: aliases[report.status] }) };
    try { validateStageReport({ ...report, ...normalized }, workspace); }
    catch { return undefined; } // Older status vocabulary remains displayable as-is.
    return normalized;
  } catch {
    if (versioned) throw Error(humanReview ? 'Could not verify the reported Human Review against the run and attempt.'
      : 'Could not verify the reported acceptance against the run and attempt.');
    return undefined;
  }
}
