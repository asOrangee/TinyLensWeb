import type { AgentUpdate } from './agent-types';
import { type InputDisplay, parseInputDisplay } from './input-display';
import { parseLiveResult, type LiveResult } from './live-results';
import { verifiedLiveMapping } from './live-mapping';
import { parseMaskSource } from './mask-user-input';
import { agentTaskUrl } from './live-tasks';

export const isDisplayManifest = (update: AgentUpdate) =>
  update.kind === 'artifact' && !!update.id && update.path?.endsWith('/display-manifest.json') === true;

type PublishedResponse = {
  schema: string;
  report_path: string;
  stage: string;
  attempt: number | null;
  input?: InputDisplay;
  summary?: unknown;
  posterior?: unknown;
  mask?: unknown;
};

export async function fetchPublishedDisplay(taskId: string, report: AgentUpdate, signal: AbortSignal) {
  const url = agentTaskUrl('/api/agent/display?updateId=' + encodeURIComponent(report.id!), taskId);
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error('无法核验已报告的展示清单。');
  const data: PublishedResponse = await response.json();
  if (data?.schema !== 'tinylens.stage-display.v1' || data.report_path !== report.path
      || data.stage !== report.stage?.trim().toLowerCase()) throw Error('展示清单与当前阶段不匹配。');
  if (data.stage === 'preflight' && data.attempt === null) {
    return { input: parseInputDisplay(data.input, report) };
  }
  const raw = data.summary as LiveResult;
  const summary = parseLiveResult({ ...raw, display_mapping: undefined }, report);
  const mapping = raw?.display_mapping;
  if (mapping && verifiedLiveMapping(mapping, { stage: summary.stage, attempt: summary.attempt ?? -1,
    path: summary.path, sha256: summary.sha256, fitsSha256: summary.planes?.observation?.input_fits_sha256 })) {
    summary.display_mapping = mapping;
  }
  if (summary.kind !== 'summary' || summary.attempt !== data.attempt) throw Error('展示清单的 attempt 不匹配。');
  const posterior = data.posterior === undefined ? undefined : parseLiveResult(data.posterior, report);
  const mask = data.mask === undefined ? undefined : parseMaskSource(data.mask, report);
  if (data.stage === 'b' && mask?.sha256 !== summary.sha256) throw Error('掩膜与阶段摘要不匹配。');
  return { summary, posterior, mask };
}
