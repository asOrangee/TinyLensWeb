import type { AgentUpdate } from './agent-types';
import { type InputDisplay, parseInputDisplay } from './input-display';
import { parseLiveResult, type LiveResult } from './live-results';
import { verifiedResultMapping } from './live-mapping';
import { parseMaskSource } from './mask-user-input';
import { agentTaskUrl } from './live-tasks';
import { isNamedDisplayDirectory, isNamedDisplaySchema, namedDisplaySchema } from './display-report';

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
  const validSchema = isNamedDisplaySchema(data?.schema)
    || (data?.schema === 'tinylens.stage-display.v1' && !isNamedDisplayDirectory(report.path));
  if (!validSchema || data.report_path !== report.path
      || data.stage !== report.stage?.trim().toLowerCase()) throw Error('展示清单与当前阶段不匹配。');
  if (data.stage === 'preflight' && data.attempt === null) {
    const input = data.input === undefined && data.schema === namedDisplaySchema ? undefined : parseInputDisplay(data.input, report);
    const summary = data.summary === undefined ? undefined : parseLiveResult(data.summary, report);
    return { input, summary };
  }
  const raw = data.summary as LiveResult;
  const summary = parseLiveResult({ ...raw, display_mapping: undefined }, report);
  const mapping = raw?.display_mapping;
  if (mapping && verifiedResultMapping({ ...summary, display_mapping: mapping })) {
    summary.display_mapping = mapping;
  }
  if (summary.kind !== 'summary' || summary.attempt !== data.attempt || (report.run_id && summary.run_id !== report.run_id)) throw Error('展示清单的运行或 attempt 不匹配。');
  let posterior: LiveResult | undefined;
  if (data.posterior !== undefined) {
    try {
      const distribution = parseLiveResult(data.posterior, report);
      if (data.schema !== namedDisplaySchema || distribution.sha256 === summary.parameter_source?.sha256) posterior = distribution;
    }
    catch { /* A missing or invalid parameter file leaves the image planes available. */ }
  }
  const mask = data.mask === undefined ? undefined : parseMaskSource(data.mask, report);
  if (data.stage === 'b' && (mask || data.schema !== namedDisplaySchema) && mask?.sha256 !== summary.sha256) throw Error('掩膜与阶段摘要不匹配。');
  return { summary, posterior, mask };
}
