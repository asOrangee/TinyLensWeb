import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { WORKSPACE } from './agent-state.mjs';

const schema = 'tinylens.display-publications.v1';
const canonical = path => typeof path === 'string' && path.startsWith(WORKSPACE + '/output/')
  && !/[\0\r\n]/.test(path) && posix.normalize(path) === path;

export async function readDisplayPublications(directory, logger) {
  try {
    const value = JSON.parse(await readFile(join(directory, 'display-publications.json'), 'utf8'));
    if (value.schema === schema && typeof value.threadId === 'string' && Array.isArray(value.entries)) return value;
    throw Error('Invalid local display publication index.');
  } catch (error) {
    if (error.code !== 'ENOENT') logger.error('Could not read local display publications:', error.message);
    return undefined;
  }
}

function publishedFolder(report, stage, attempt) {
  if (!canonical(report.path) || report.schema || !['stage', 'artifact'].includes(report.kind)) return undefined;
  if (stage === 'preflight') {
    const match = /^(.*)\/preflight\/[^/]+$/.exec(report.path);
    return report.stage === stage && attempt === null && match ? match[1] + '/preflight' : undefined;
  }
  if (!['a', 'b', 'm0', 'm1', 'm2', 'm3'].includes(stage) || !Number.isSafeInteger(attempt) || attempt < 0) return undefined;
  const accepted = /^(.*)\/accepted\/(a|b|m0|m1|m2|m3)\.json$/.exec(report.path);
  if (accepted && report.kind === 'stage' && report.status === 'accepted' && report.stage === accepted[2]
      && (stage === accepted[2] || (accepted[2] === 'm0' && stage === 'b'))) {
    if (stage === report.stage && report.verified_attempt !== undefined && report.verified_attempt !== attempt) return undefined;
    return `${accepted[1]}/attempts/${stage}/${attempt}`;
  }
  const match = /^(.*\/attempts\/(a|b|m0|m1|m2|m3)\/(0|[1-9]\d*))\/stage-result\.json$/.exec(report.path);
  if (match && report.stage === stage && stage === match[2] && attempt === Number(match[3])) return match[1];
}

/** Publish verified exports beside their original reports in the view only. */
export function withDisplayPublications(state, publication) {
  if (!state.threadId || state.threadId !== publication?.threadId) return state;
  const updates = state.updates.flatMap(report => {
    if (!report.id || report.threadId !== state.threadId) return [report];
    let original = report;
    const exports = [];
    const stages = new Set();
    for (const entry of publication.entries) {
      if (entry?.anchorId !== report.id || entry.anchorPath !== report.path || !/^[a-f0-9]{64}$/.test(entry.manifestSha256 ?? '')) continue;
      const { stage, attempt } = entry;
      const folder = publishedFolder(report, stage, attempt);
      const path = folder && folder + '/display-manifest.json';
      if (!path || stages.has(stage)) continue;
      stages.add(stage);
      if (stage === report.stage && stage !== 'preflight' && report.path.endsWith(`/accepted/${stage}.json`)) {
        original = { ...report, verified_attempt: attempt };
      }
      exports.push({
        id: `display-publication:${report.id}:${stage}`, threadId: report.threadId, kind: 'artifact',
        stage, status: 'available', title: '展示清单', path, manifestSha256: entry.manifestSha256,
        display_source_report_id: report.id,
      });
    }
    return [original, ...exports];
  });
  return { ...state, updates };
}
