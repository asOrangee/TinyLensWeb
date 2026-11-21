import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { shellQuote } from './connection-config.mjs';
import { archiveForReport, stageReportSchema, validateStageReport } from './stage-reports.mjs';

const reader = await readFile(new URL('./remove-task-runs.py', import.meta.url), 'utf8');
const workspacePath = (path, workspace) => typeof path === 'string' && path.length <= 4000
  && !/[\0\r\n]/.test(path) && posix.normalize(path) === path && path.startsWith(workspace + '/output/');
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function reportScope(report, workspace) {
  if (!['stage', 'artifact'].includes(report?.kind)) return undefined;
  if (report.schema === stageReportSchema) {
    try { validateStageReport(report, workspace); }
    catch { return undefined; }
    const path = archiveForReport(report) ?? report.run_path;
    return { path, runPath: report.run_path, runId: report.run_id };
  }
  if (!workspacePath(report.path, workspace) || report.schema) return undefined;
  const archive = /^(.*)\/_archive\/([^/]+)_old_(?:0|[1-9]\d*)\/run-manifest\.json$/.exec(report.path);
  if (archive) return { path: posix.dirname(report.path), runPath: `${archive[1]}/${archive[2]}`, anchor: 'run-manifest.json' };
  const match = /^(.*?)\/(preflight\/.+|attempts\/(?:a|b|m[0-3])\/(?:0|[1-9]\d*)\/.+|accepted\/(?:a|b|m[0-3])\.json|run-manifest\.json|modeling-comment\.json)$/.exec(report.path);
  if (!match) return undefined;
  const [, path, anchor] = match;
  return { path, runPath: path, anchor, sha256: fingerprint(report.manifestSha256) ? report.manifestSha256 : undefined };
}

export function deletionCandidates(state, workspace, batchJob) {
  const scopes = state?.threadId && Array.isArray(state.updates) ? state.updates.filter(report => report.threadId === state.threadId)
    .map(report => reportScope(report, workspace)).filter(Boolean) : [];
  const scopesByPath = new Map();
  // A later archive moves a version away from its original live folder.
  const archivedVersions = new Set(scopes.filter(scope => scope.path !== scope.runPath && scope.runId)
    .map(scope => JSON.stringify([scope.runPath, scope.runId])));
  for (const { path, runPath, runId, anchor, sha256 } of scopes) {
    if (path === runPath && runId && archivedVersions.has(JSON.stringify([runPath, runId]))) continue;
    if (!workspacePath(path, workspace)) continue;
    const item = scopesByPath.get(path) ?? { path, runPath, runIds: [], legacy: false, anchors: [], proofs: [] };
    if (runId && !item.runIds.includes(runId)) item.runIds.push(runId);
    if (anchor && !item.anchors.includes(anchor)) item.anchors.push(anchor);
    if (sha256 && anchor.endsWith('/display-manifest.json')
        && !item.proofs.some(proof => proof.path === anchor && proof.sha256 === sha256)) item.proofs.push({ path: anchor, sha256 });
    scopesByPath.set(path, item);
  }
  for (const item of scopesByPath.values()) {
    item.legacy = item.runIds.length === 0 && item.anchors.length > 0;
    if (batchJob && item.runPath === batchJob.path) item.inputPath = batchJob.inputPath;
  }
  return [...scopesByPath.values()];
}

export function isolateTaskRuns(candidates, otherPaths, batchJob) {
  const retained = [], eligible = [];
  for (const item of candidates) {
    if (otherPaths.some(path => overlap(path, item.path))
      || (batchJob && (item.runPath !== batchJob.path || batchJob.runId))) retained.push(item.path);
    else eligible.push(item);
  }
  return { eligible, retained };
}

export async function remoteTaskRuns(mode, candidates, config) {
  if (!candidates.length) return { runs: [], retained: [] };
  const command = `${shellQuote(config.python)} -B -c ${shellQuote(reader)}`;
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', config.sshHost, command];
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Remote result cleanup timed out')); }, 120_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) child.kill();
    });
    child.stdin.on('error', error => reject(error));
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      if (status === 0) resolve(output);
      else reject(Error('Remote result cleanup failed'));
    });
    child.stdin.end(JSON.stringify({ mode, root: config.workspace, candidates }));
  });
  const response = JSON.parse(raw);
  const paths = new Set(candidates.map(item => item.path));
  if (!Array.isArray(response?.runs) || !Array.isArray(response.retained)
      || response.runs.some(item => !paths.has(item?.path) || !fingerprint(item.fingerprint))
      || response.retained.some(item => !paths.has(item?.path))
      || new Set([...response.runs, ...response.retained].map(item => item.path)).size !== response.runs.length + response.retained.length) {
    throw Error('Remote result cleanup returned an invalid plan');
  }
  return response;
}
