import { CirclePlus, MessageSquarePlus } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import './task-welcome.css';

export default function BlankTaskWorkspace({name,placeholder,onNameChange,onCreate,onNameBlur}:{name:string;placeholder:string;onNameChange:(name:string)=>void;onCreate?:()=>void;onNameBlur?:()=>void}){
  const {t}=useDemoI18n();
  return <section className="blank-task-workspace" aria-label={t('新任务')}>
    {!onCreate&&<div className="blank-task-heading"><input autoFocus aria-label={t('任务名称')} value={name} maxLength={120} placeholder={placeholder} onChange={event=>onNameChange(event.target.value)} onBlur={onNameBlur}/></div>}
    {onCreate?<div className="blank-task-placeholder"><MessageSquarePlus size={28}/><p>{t('暂无任务')}</p><button className="button secondary" type="button" onClick={onCreate}><CirclePlus size={15}/>{t('新建任务')}</button></div>
      :<div className="task-welcome" lang="en"><div className="task-welcome-content"><img className="task-welcome-logo" src="/favicon.svg" alt="TinyLens" width={104} height={104}/><h1 className="task-welcome-title"><span>Model the light.</span>{' '}<span>Reveal the unseen.</span></h1></div></div>}
  </section>;
}
