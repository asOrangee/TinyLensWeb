import { useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';

export default function DeletedTaskList({ tasks, onRestore, onDelete }: {
  tasks: readonly { id: string; name: string }[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const { t } = useDemoI18n();
  const [confirming, setConfirming] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<{ id: string; text: string }>();
  const deleting = useRef(false);
  async function remove(id: string) {
    if (deleting.current) return;
    deleting.current = true;
    setPending(id); setError(undefined);
    try {
      await onDelete(id);
      setConfirming(undefined);
    } catch (reason) {
      setError({ id, text: reason instanceof Error ? reason.message : t('暂时无法彻底删除任务。') });
    } finally { deleting.current = false; setPending(undefined); }
  }
  if (tasks.length === 0) return <p className="section-caption">{t('没有已删除的任务。')}</p>;
  return <>
    <p className="section-caption">{t('已删除的任务保留原有版本、会话与草稿。')}</p>
    <div className="deleted-lens-list">{tasks.map(task => <div key={task.id} data-task-id={task.id}>
      <div className="deleted-task-heading"><strong>{task.name}</strong>
        <div className="deleted-task-actions">
          <button className="button secondary" type="button" disabled={!!pending}
            aria-label={t('恢复 {name}', { name: task.name })} onClick={() => onRestore(task.id)}>
            <RotateCcw size={14}/>{t('恢复')}
          </button>
          <button className="button secondary deleted-task-danger" type="button" disabled={!!pending}
            aria-label={t('彻底删除 {name}', { name: task.name })}
            onClick={() => { setConfirming(task.id); setError(undefined); }}>
            <Trash2 size={14}/>{t('彻底删除')}
          </button>
        </div>
      </div>
      {confirming === task.id && <div className="deleted-task-confirmation">
        <p>{t('将永久删除“{name}”的工作台记录、本地会话、草稿和预览缓存，无法撤销。服务器原始数据和科学结果会保留。', { name: task.name })}</p>
        <div className="deleted-task-actions">
          <button className="button secondary" type="button" disabled={!!pending} onClick={() => setConfirming(undefined)}>{t('取消')}</button>
          <button className="button secondary deleted-task-danger" type="button" disabled={!!pending} onClick={() => void remove(task.id)}>
            {t(pending === task.id ? '正在删除…' : '确认彻底删除')}
          </button>
        </div>
      </div>}
      {error?.id === task.id && <p className="deleted-task-error" role="alert">{t(error.text)}</p>}
    </div>)}</div>
  </>;
}
