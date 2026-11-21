import { useEffect, useRef, useState } from 'react';
import { stages, type StageId } from '../data/stages';
import type { AgentUpdate } from '../lib/agent-types';
import { useDemoI18n } from '../lib/demo-i18n';
import { stageHistoryAnchors } from '../lib/live-results';
import { readStageHistoryBatch } from '../lib/stage-artifacts';
import { isArchiveReport, runKey, type StageAttempt } from '../lib/stage-attempts';
import { stageHistoryLayout, type HistoryReference } from '../lib/stage-history';
import StageHistoryChart from './StageHistoryChart';

const refreshAfterMs = 60_000;
const batchSize = 32;

export function useLiveRunHistory(task: string | undefined, thread: string | null, reports: readonly AgentUpdate[], open: boolean) {
  const archives = reports.filter(isArchiveReport).map(report => [report.run_id, report.path]);
  const anchors = [...stageHistoryAnchors(reports)].map(([key, report]) => ({
    key, report, signature: JSON.stringify([task, thread, key, report.id, report.path, archives]),
  }));
  const signature = JSON.stringify(anchors.map(anchor => anchor.signature));
  const [verified, setVerified] = useState(new Map<string, { signature: string; upstream: HistoryReference[]; at: number }>());
  const [settled, setSettled] = useState('');
  const [refresh, setRefresh] = useState(0);
  const lastCheckedAt = useRef(0);

  useEffect(() => {
    if (!task || !anchors.length) return;
    const ageLimit = Date.now() - refreshAfterMs;
    const missing = anchors.filter(anchor => {
      const entry = verified.get(anchor.key);
      return entry?.signature !== anchor.signature || entry.at <= ageLimit;
    });
    if (!missing.length) { setSettled(signature); return; }
    lastCheckedAt.current = 0;
    const controller = new AbortController();
    const load = async () => {
      for (let index = 0; index < missing.length; index += batchSize) {
        const group = new Map(missing.slice(index, index + batchSize).map(anchor => [anchor.report, anchor]));
        await readStageHistoryBatch([...group.keys()], task, controller.signal, (report, upstream) => {
          const anchor = group.get(report)!;
          setVerified(previous => new Map(previous).set(anchor.key, { signature: anchor.signature, upstream, at: Date.now() }));
        });
        if (controller.signal.aborted) return;
      }
      lastCheckedAt.current = Date.now();
      setSettled(signature);
    };
    const queued = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(queued); controller.abort(); };
  }, [signature, refresh]);

  useEffect(() => {
    if (open && lastCheckedAt.current && Date.now() - lastCheckedAt.current >= refreshAfterMs) setRefresh(value => value + 1);
  }, [open]);

  const sources = new Map<string, HistoryReference[]>();
  for (const anchor of anchors) {
    const entry = verified.get(anchor.key);
    if (entry?.signature === anchor.signature) sources.set(anchor.key, entry.upstream);
  }
  const pending = anchors.length > 0 && settled !== signature;
  return { sources, pending, unavailable: anchors.length > 0 && !pending && sources.size === 0 };
}

export default function LiveRunHistory({ attempts, reports, history, viewed, stageNames, onSelect }: {
  attempts: readonly StageAttempt[];
  reports: readonly AgentUpdate[];
  history: ReturnType<typeof useLiveRunHistory>;
  viewed?: string;
  stageNames: Readonly<Record<string, string>>;
  onSelect: (stage: StageId, key: string) => void;
}) {
  const { t } = useDemoI18n();

  const representedRuns = new Set(attempts.map(({ identity }) => runKey(identity)));
  const archives = new Map(reports.filter(isArchiveReport).map(report => [JSON.stringify([report.run_path, report.run_id]), report]));
  const emptyArchives = [...archives].filter(([key]) => !representedRuns.has(key));
  if (!attempts.length && !emptyArchives.length) return <p className="section-caption">{t('此任务尚无运行版本。')}</p>;

  const { nodes, edges } = stageHistoryLayout(attempts, history.sources);
  return <>
    {nodes.length > 0 && <StageHistoryChart nodes={nodes} edges={edges}
      stageLabel={stage => stages.find(item => item.id === stage)!.code}
      renderNode={({ identity, status, archived }) => {
        const attempt = identity.attempt === null ? t('预检记录') : t('尝试 {number}', { number: identity.attempt });
        const run = identity.runId ? t('运行 {version}', { version: identity.runId.slice(0, 8) }) : t('历史运行');
        return <button type="button" className="stage-history-attempt" title={identity.runPath} data-status={status}
          aria-current={identity.key === viewed ? 'true' : undefined} onClick={() => onSelect(identity.stage, identity.key)}>
          <span className="stage-history-attempt__title">{attempt}</span>
          <span className="stage-history-attempt__meta">{run}</span>
          {(status || archived) && <span className="stage-history-attempt__status">
            {[status && t(stageNames[status] ?? status), archived && t('已归档')].filter(Boolean).join(' · ')}
          </span>}
        </button>;
      }}/>}
    {history.pending && <p className="section-caption" role="status">{t('正在核对阶段依赖…')}</p>}
    {history.unavailable && <p className="section-caption" role="status">{t('暂时无法读取阶段依赖。')}</p>}
    {emptyArchives.map(([key, report]) => <p className="section-caption" key={key} title={report.run_path}>
      {t('已归档')} · {t('运行 {version}', { version: report.run_id?.slice(0, 8) ?? '' })} · {t('此运行尚无已报告的阶段。')}
    </p>)}
  </>;
}
