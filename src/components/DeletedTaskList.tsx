import { RotateCcw } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';

export default function DeletedTaskList({ tasks, onRestore }: {
  tasks: readonly { id: string; name: string }[];
  onRestore: (id: string) => void;
}) {
  const { t } = useDemoI18n();
  if (tasks.length === 0) return <p className="section-caption">{t('没有已删除的任务。')}</p>;
  return <>
    <p className="section-caption">{t('已删除的任务保留原有版本、会话与草稿。')}</p>
    <div className="deleted-lens-list">{tasks.map(task => <div key={task.id}>
      <strong>{task.name}</strong>
      <button className="button secondary" type="button" aria-label={t('恢复 {name}', { name: task.name })} onClick={() => onRestore(task.id)}>
        <RotateCcw size={14}/>{t('恢复')}
      </button>
    </div>)}</div>
  </>;
}
