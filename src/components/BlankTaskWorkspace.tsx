import type { ReactNode } from 'react';
import { CirclePlus, MessageSquarePlus } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import './task-welcome.css';

export default function BlankTaskWorkspace({ composer, onCreate, createDisabled = false }: {
  composer?: ReactNode;
  onCreate?: () => void;
  createDisabled?: boolean;
}) {
  const { t } = useDemoI18n();
  return <section className="blank-task-workspace" aria-label={t('新任务')}>
    {onCreate ? <div className="blank-task-placeholder">
      <MessageSquarePlus size={28}/><p>{t('暂无任务')}</p>
      <button className="button secondary" type="button" disabled={createDisabled} onClick={onCreate}><CirclePlus size={15}/>{t('新建任务')}</button>
    </div> : <div className="task-welcome"><div className="task-welcome-content">
      <img className="task-welcome-logo" src="/favicon.svg" alt="TinyLens" width={104} height={104}/>
      <h1 className="task-welcome-title" lang="en"><span>Model the light</span>{' '}<span>Reveal the unseen</span></h1>
      {composer}
    </div></div>}
  </section>;
}
