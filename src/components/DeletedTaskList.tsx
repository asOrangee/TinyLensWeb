import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import type { TaskDeletionPlan } from '../lib/live-tasks';

type Props = {
  tasks: readonly { id: string; name: string }[];
  onRestore: (id: string) => void;
} & ({ getDeletionPlan?: undefined; onDelete: (id: string) => void | Promise<void> }
  | { getDeletionPlan: (id: string, signal: AbortSignal) => Promise<TaskDeletionPlan>; onDelete: (id: string, token: string) => Promise<void> });
type Confirmation = { id: string; status: 'loading' }
  | { id: string; status: 'ready'; plan?: TaskDeletionPlan }
  | { id: string; status: 'error'; message: string };

export default function DeletedTaskList(props: Props) {
  const { tasks, onRestore } = props;
  const { t } = useDemoI18n();
  const [confirming, setConfirming] = useState<Confirmation>();
  const [pending, setPending] = useState<string>();
  const preview = useRef<AbortController>(undefined);
  const deleting = useRef(false);
  useEffect(() => () => preview.current?.abort(), []);

  function cancel() {
    preview.current?.abort();
    setConfirming(undefined);
  }
  async function review(id: string) {
    preview.current?.abort();
    if (!props.getDeletionPlan) {
      setConfirming({ id, status: 'ready' });
      return;
    }
    const request = new AbortController();
    preview.current = request;
    setConfirming({ id, status: 'loading' });
    try {
      const plan = await props.getDeletionPlan(id, request.signal);
      if (!request.signal.aborted) setConfirming({ id, status: 'ready', plan });
    } catch (reason) {
      if (!request.signal.aborted) setConfirming({ id, status: 'error', message: reason instanceof Error ? reason.message : '无法读取任务的永久删除清单。' });
    }
  }
  async function remove({ id, plan }: Extract<Confirmation, { status: 'ready' }>) {
    if (deleting.current) return;
    deleting.current = true;
    setPending(id);
    try {
      if (props.getDeletionPlan) {
        if (!plan) return;
        await props.onDelete(id, plan.token);
      } else {
        await props.onDelete(id);
      }
      setConfirming(undefined);
    } catch (reason) {
      setConfirming({ id, status: 'error', message: reason instanceof Error ? reason.message : '暂时无法彻底删除任务。' });
    } finally { deleting.current = false; setPending(undefined); }
  }
  if (tasks.length === 0) return <p className="section-caption">{t('没有已删除的任务。')}</p>;
  return <div className="deleted-lens-list">{tasks.map(task => <div key={task.id} data-task-id={task.id}>
      <div className="deleted-task-heading"><strong>{task.name}</strong>
        <div className="deleted-task-actions">
          <button className="button secondary" type="button" disabled={!!pending}
            aria-label={t('恢复 {name}', { name: task.name })} onClick={() => {
              if (confirming?.id === task.id) cancel();
              onRestore(task.id);
            }}>
            <RotateCcw size={14}/>{t('恢复')}
          </button>
          <button className="button secondary deleted-task-danger" type="button" disabled={!!pending}
            aria-label={t('彻底删除 {name}', { name: task.name })}
            onClick={() => void review(task.id)}>
            <Trash2 size={14}/>{t('彻底删除')}
          </button>
        </div>
      </div>
      {confirming?.id === task.id && <div className="deleted-task-confirmation">
        {confirming.status === 'loading' && <p role="status">{t('正在读取永久删除清单…')}</p>}
        {confirming.status === 'error' && <p className="deleted-task-error" role="alert">{t(confirming.message)}</p>}
        {confirming.status === 'ready' && <>
          <p>{t(confirming.plan?.runs.length
            ? '将永久删除“{name}”的工作台记录、本地会话、草稿、预览缓存以及 GPU 服务器上属于该任务的建模结果。此操作无法撤销。'
            : '将永久删除“{name}”的工作台记录、本地会话、草稿和预览缓存。此操作无法撤销。', { name: task.name })}</p>
          {confirming.plan && <div className="deleted-task-plan">
            <strong>{t('将删除的 GPU 建模结果目录')}</strong>
            {confirming.plan.runs.length ? <ul>{confirming.plan.runs.map(path => <li key={path}><code>{path}</code></li>)}</ul>
              : <p>{t('可删除的目录为 0 个。')}</p>}
            {confirming.plan.retained.length > 0 && <>
              <strong>{t('将保留的 GPU 建模结果目录')}</strong>
              <ul>{confirming.plan.retained.map(path => <li key={path}><code>{path}</code></li>)}</ul>
            </>}
          </div>}
        </>}
        <div className="deleted-task-actions">
          <button className="button secondary" type="button" disabled={!!pending} onClick={cancel}>{t('取消')}</button>
          {confirming.status === 'error' && <button className="button secondary" type="button" onClick={() => void review(task.id)}>{t('重新检查')}</button>}
          {confirming.status === 'ready' && <button className="button secondary deleted-task-danger" type="button" disabled={!!pending} onClick={() => void remove(confirming)}>
            {t(pending === task.id ? '正在删除…' : '确认彻底删除')}
          </button>}
        </div>
      </div>}
    </div>)}</div>;
}
