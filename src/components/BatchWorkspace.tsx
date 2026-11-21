import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Layers, Pause, Play, RotateCcw, X } from 'lucide-react';
import { batchFetch, type Batch, type BatchJob, type BatchPlan, type BatchSummary } from '../lib/live-batches';
import { useDemoI18n } from '../lib/demo-i18n';
import { standaloneTaskGroup, type LiveTask } from '../lib/live-tasks';
import './batch-workspace.css';

const statusLabels: Record<BatchJob['status'], string> = {
  queued: '排队', starting: '正在派发', running: 'AI 正在处理', waiting_gpu: '等待 GPU', waiting_user: '等待你的答复',
  unconfirmed: '送达待确认', accepted: '已接受', human_review: '人工审查', attention: '需要处理', incomplete: '待继续', removed: '任务已删除',
};
const reportLabels: Record<string, string> = { preparing: '准备中', running: '拟合中', executed: '计算完成', awaiting_review: '等待审查',
  reviewing: '科学审查中', retry: '重试', accepted: '阶段已接受', failed: '阶段失败', rejected: '未通过审查', blocked: '受阻', interrupted: '已中断' };

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function BatchPlanCard({ plan, onProgress }: { plan: BatchPlan; onProgress: () => void }) {
  const { t } = useDemoI18n();
  return <article className="agent-question-card batch-plan-card" aria-label={t('批次名单')}>
    {plan.status === 'submitted'
      ? <><h2>{t('{count} 个 lens 已加入队列', { count: plan.targets.length })}</h2>
        <button type="button" className="button secondary" onClick={onProgress}>{t('查看批次进度')}<ArrowUpRight size={14}/></button></>
      : <><h2>{t('核对 {count} 个 lens', { count: plan.targets.length })}</h2>
        <dl className="batch-paths"><dt>{t('输入目录')}</dt><dd>{plan.inputDir}</dd><dt>{t('结果目录')}</dt><dd>{plan.outputDir}</dd>
          <dt>{t('自动并发上限')}</dt><dd>{plan.parallelism}</dd></dl>
        <p className="batch-plan-instruction">{t('核对后在对话框回复「确认提交这批」。也可以直接告诉 AI 要调整哪些内容。')}</p>
        <details className="batch-plan-targets"><summary>{t('查看完整名单')}</summary>
          <ul className="batch-targets">{plan.targets.map(item => <li key={item.lensId}><strong>{item.lensId}</strong>
            <small>{t(item.existing ? '继续已有运行' : '新运行')}</small></li>)}</ul>
        </details>
        {plan.message && <details className="batch-message"><summary>{t('查看第一条发送给 Pipeline AI 的消息')}</summary><pre>{plan.message}</pre></details>}</>}
  </article>;
}

export default function BatchWorkspace({ activeId, batch, batchError, standaloneTasks, onSelectBatch, onBatchUpdate, onClose, onOpenTask }: {
  activeId: string; batch?: Batch; batchError?: string; standaloneTasks: LiveTask[];
  onSelectBatch: (id: string) => void; onBatchUpdate: (batch: Batch) => void;
  onClose: () => void; onOpenTask: (id: string) => Promise<void>;
}) {
  const { t } = useDemoI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const actionLock = useRef(false);
  const [catalog, setCatalog] = useState<BatchSummary[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [requeued, setRequeued] = useState<number>();

  useEffect(() => {
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    batchFetch<{ batches: BatchSummary[] }>('', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setCatalog(result.batches);
    }).catch(reason => { if (!controller.signal.aborted) setCatalogError(errorText(reason)); });
    return () => controller.abort();
  }, []);

  function close() { if (!actionLock.current) onClose(); }
  async function perform<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (actionLock.current) return undefined;
    actionLock.current = true; setBusy(true); setError(''); setRequeued(undefined);
    try { return await operation(); }
    catch (reason) { setError(errorText(reason)); return undefined; }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function pause(selected: Batch) {
    const result = await perform(() => batchFetch<{ batch: Batch }>(`/${selected.id}/dispatch`, { data: { paused: !selected.paused } }));
    if (result) onBatchUpdate(result.batch);
  }
  async function retryStart(selected: Batch) {
    const result = await perform(async () => {
      const response = await batchFetch<{ requeued: number; batch: Batch }>(`/${selected.id}/retry-start`, { data: {} });
      if (response.batch?.id !== selected.id || !Number.isSafeInteger(response.requeued) || response.requeued < 0) {
        throw Error(t('批次重试响应无效。'));
      }
      return response;
    });
    if (result) {
      onBatchUpdate(result.batch);
      setRequeued(result.requeued);
    }
  }

  const standalone = activeId === standaloneTaskGroup;
  const selectedSummary = catalog?.find(item => item.id === activeId) ?? batch;
  const batchName = standalone ? t('单独建模') : selectedSummary?.name;
  const options = catalog ?? (batch ? [batch] : []);
  const loadError = catalogError || batchError;
  return <dialog ref={dialog} className="batch-dialog" aria-labelledby="batch-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="batch-shell">
      <header className="batch-header">
        <h2 id="batch-title"><Layers size={21} aria-hidden="true"/>{t('建模批次')}</h2>
        <button type="button" className="workspace-dialog-close" aria-label={t('关闭')} title={t('关闭')} disabled={busy} onClick={close}><X size={20} aria-hidden="true"/></button>
      </header>
      <div className="batch-body">
        <div className="batch-toolbar">
          <h3>{batchName ?? t('批次')}</h3>
          <select aria-label={t('切换批次')} value={activeId} disabled={busy} onChange={event => { onSelectBatch(event.target.value); setError(''); setRequeued(undefined); }}>
            <option value={standaloneTaskGroup}>{t('单独建模')} · {standaloneTasks.length} lens</option>
            {!standalone && !options.some(item => item.id === activeId) && <option value={activeId}>{t('当前批次')}</option>}
            {options.map(item => <option key={item.id} value={item.id}>{item.name} · {new Date(item.createdAt).toLocaleString()} · {item.size} lens</option>)}
          </select>
        </div>
        {standalone ? <StandaloneBatch tasks={standaloneTasks} busy={busy} onOpen={id => void perform(() => onOpenTask(id))}/>
          : batch ? <BatchProgress key={batch.id} batch={batch} busy={busy} requeued={requeued} onPause={() => void pause(batch)}
          onRetryStart={() => void retryStart(batch)}
          onOpen={id => void perform(() => onOpenTask(id))}/>
          : !batchError && <p className="batch-hint" role="status">{t('正在读取批次…')}</p>}
        {(error || loadError) && <p className="batch-error" role="alert">{error || loadError}</p>}
      </div>
    </div>
  </dialog>;
}

function StandaloneBatch({ tasks, busy, onOpen }: { tasks: LiveTask[]; busy: boolean; onOpen: (id: string) => void }) {
  const { t } = useDemoI18n();
  const [query, setQuery] = useState('');
  const matches = tasks.filter(task => task.name.toLowerCase().includes(query.trim().toLowerCase()));
  if (!tasks.length) return <p className="batch-hint" role="status">{t('暂无单独建模任务。')}</p>;
  return <>
    <input className="batch-search" type="search" aria-label={t('查找任务名称')} placeholder={t('查找任务名称')}
      value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="batch-table-wrap"><table className="batch-table batch-table--standalone"><thead><tr>
      <th scope="col">{t('任务名称')}</th><th scope="col">{t('任务')}</th>
    </tr></thead><tbody>{matches.map(task => <tr key={task.id}>
      <th scope="row">{task.name}</th><td><button type="button" className="batch-open-task" disabled={busy}
        aria-label={t('打开任务：{name}', { name: task.name })} onClick={() => onOpen(task.id)}>{t('打开')}<ArrowUpRight size={14}/></button></td>
    </tr>)}</tbody></table>{!matches.length && <p className="batch-hint">{t('未找到任务。')}</p>}</div>
  </>;
}

function BatchProgress({ batch, busy, requeued, onPause, onRetryStart, onOpen }: {
  batch: Batch; busy: boolean; requeued?: number; onPause: () => void; onRetryStart: () => void; onOpen: (id: string) => void;
}) {
  const { t } = useDemoI18n();
  const [query, setQuery] = useState('');
  const accepted = batch.jobs.filter(job => job.status === 'accepted').length;
  const review = batch.jobs.filter(job => job.status === 'human_review').length;
  const queued = batch.jobs.filter(job => job.status === 'queued').length;
  const waiting = batch.jobs.filter(job => job.status === 'waiting_user').length;
  const retryable = batch.retryableStartCount ?? 0;
  const canRetryStart = batch.compatible && Number.isSafeInteger(retryable) && retryable > 0;
  const jobs = batch.jobs.filter(job => job.lensId.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="batch-progress" aria-label={t('逐目标进度')}>
    <div className="batch-overview">
      <div className="batch-output" title={batch.outputDir}>{batch.outputDir}</div>
      <div className="batch-actions">
        {canRetryStart && <button type="button" className="button secondary" disabled={busy} onClick={onRetryStart}
          title={t('可重试 {count} 个未启动任务', { count: retryable })}>
          <RotateCcw size={14} aria-hidden="true"/>{t('重试未启动任务')}</button>}
        {queued > 0 && batch.compatible && <button type="button" className="button secondary" disabled={busy} onClick={onPause}>
          {batch.paused ? <Play size={14}/> : <Pause size={14}/>} {t(batch.paused ? '继续派发' : '暂停派发')}</button>}
      </div>
    </div>
    {requeued !== undefined && <p className="batch-hint" role="status">{requeued > 0
      ? t('已将 {count} 个未启动任务移回队列。', { count: requeued })
      : t('没有可重试的未启动任务。')}</p>}
    {!batch.compatible && <p className="batch-error" role="status">{t('此批次使用了另一份 GPU 服务器配置。')}</p>}
    {batch.paused && <p className="batch-hint" role="status">{t('队列已暂停，已派发的任务继续运行。')}</p>}
    <div className="batch-counts"><strong>{t('{done} / {total} 已到科学终态', { done: accepted + review, total: batch.size })}</strong>
      <span>{t('已接受 {count}', { count: accepted })}</span><span>{t('人工审查 {count}', { count: review })}</span>
      <span>{t('排队 {count}', { count: queued })}</span><span>{t('待答复 {count}', { count: waiting })}</span></div>
    <progress className="batch-meter" aria-label={t('科学终态进度')} value={accepted + review} max={batch.size}/>
    <input className="batch-search" type="search" aria-label={t('查找 lens ID')} placeholder={t('查找 lens ID')} value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="batch-table-wrap"><table className="batch-table"><thead><tr>
      <th scope="col">Lens ID</th><th scope="col">{t('当前阶段')}</th><th scope="col">{t('状态')}</th><th scope="col">{t('任务')}</th>
    </tr></thead><tbody>{jobs.map(job => {
      const needsFirstResult = job.status === 'incomplete' && !job.stage;
      const delivered = needsFirstResult && job.delivered === true;
      const statusLabel = delivered ? '已送达，尚无阶段结果' : needsFirstResult ? '尚无阶段结果' : statusLabels[job.status];
      return <tr key={job.taskId}>
        <th scope="row">{job.lensId}</th><td>{job.stage === 'preflight' ? t('D · 预检') : job.stage?.toUpperCase() ?? '—'}</td>
        <td><span className="batch-status" data-status={job.status} title={job.message}>{t(statusLabel)}</span>
          {job.stageStatus && !['waiting_gpu', 'accepted', 'human_review'].includes(job.status) && reportLabels[job.stageStatus]
            && <small className="batch-stage-status">{t(reportLabels[job.stageStatus])}</small>}
          {delivered && job.canOpen && batch.compatible && <div className="batch-job-message">{t('可打开原会话继续。')}</div>}
          {job.message && ['attention', 'unconfirmed', 'incomplete'].includes(job.status) && <div className="batch-job-message">{job.message}</div>}</td>
        <td>{job.canOpen && batch.compatible && <button type="button" className="batch-open-task" disabled={busy}
          aria-label={t('打开任务：{name}', { name: job.lensId })} onClick={() => onOpen(job.taskId)}>{t('打开')}<ArrowUpRight size={14}/></button>}</td>
      </tr>;
    })}</tbody></table>{!jobs.length && <p className="batch-hint">{t('未找到该 lens。')}</p>}</div>
  </section>;
}
