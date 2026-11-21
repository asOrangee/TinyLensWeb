import { stageHistoryLayout, type HistoryReference } from './stage-history';
import type { StageAttempt } from './stage-attempts';
import { stageOrder, type Run } from './workspace';

export function demoStageHistory(runs: readonly Run[], lensId: string) {
  const versions = new Map(runs.filter(run => run.lensId === lensId).map((run, index) => {
    const firstStage = stageOrder.indexOf(run.from);
    const planned = run.requestedStages ?? stageOrder.slice(firstStage, Math.max(firstStage, run.progress) + 1);
    const finished = run.finishedStages;
    const unfinished = finished && planned.find(stage => !finished.includes(stage));
    const available = run.status !== 'complete' && finished
      ? planned.filter(stage => finished.includes(stage) || stage === unfinished) : planned;
    return [run.id, { run, version: index + 1, available }] as const;
  }));
  const runPath = `/demo/${lensId}`;
  const attempts: StageAttempt[] = [];
  const sources = new Map<string, HistoryReference[]>();
  for (const { run, available } of versions.values()) {
    for (const stage of available) {
      const attempt = stage === 'preflight' ? null : 0;
      const key = JSON.stringify([runPath, run.id, stage, attempt]);
      attempts.push({ identity: { key, stage, attempt, runPath, runId: run.id, lensId }, firstReportedAt: run.createdAt, archived: false });
      const upstream: HistoryReference[] = [];
      for (const previous of stageOrder.slice(0, stageOrder.indexOf(stage)).reverse()) {
        const seen = new Set<string>();
        let source = versions.get(run.id);
        while (source && !seen.has(source.run.id)) {
          if (source.available.includes(previous)) {
            upstream.push({ stage: previous, attempt: previous === 'preflight' ? null : 0, run_id: source.run.id, run_path: runPath });
            break;
          }
          seen.add(source.run.id);
          source = source.run.parentId ? versions.get(source.run.parentId) : undefined;
        }
      }
      sources.set(key, upstream);
    }
  }
  const { nodes, edges } = stageHistoryLayout(attempts, sources);
  return { nodes: nodes.map(node => ({ ...node, value: versions.get(node.value.identity.runId!)! })), edges };
}
