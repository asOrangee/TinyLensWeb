import { useState } from 'react';
import { BookOpen, CircleHelp, CirclePlus, GitFork, Languages, MessageSquare, Palette, Trash2 } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import SidebarSelect from './SidebarSelect';
import { designs, type DesignId } from '../lib/designs';

type LensItem = { id: string; name: string; image?: string; kind?: 'task'; lastConversationAt?: string };
type Props = { lenses: LensItem[]; selected: string; open: boolean; onClose: () => void; onSelect: (id: string) => void; onNewTask: () => void; onDelete:(id:string)=>void; onTrash:()=>void; deletedCount:number; onHistory: () => void; onManual: () => void; onGuide: () => void; design: DesignId; onDesignChange: (design: DesignId) => void; live?: boolean; taskCreationDisabled?: boolean };

export default function DemoSidebar({ lenses, selected, open, onClose, onSelect, onNewTask, onDelete, onTrash, deletedCount, onHistory, onManual, onGuide, design, onDesignChange, live = false, taskCreationDisabled = live }: Props) {
  const { t, language, setLanguage } = useDemoI18n();
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [setting, setSetting] = useState<'language'|'appearance'|null>(null);
  const expanded = open || hovered || keyboardFocus || setting !== null;
  const leave = () => { onClose(); setSetting(null); setHovered(false); setKeyboardFocus(false); };
  function lastConversation(at?: string) {
    if (!at) return t('暂无对话');
    return t(live ? '最后对话：{time}' : '最后对话：{time} · 演示', { time: new Date(at).toLocaleString(language === 'en' ? 'en-GB' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) });
  }
  return <aside className={`sidebar lens-sidebar${open ? ' is-open' : ''}`} aria-label={t('Lens 导航')} data-expanded={expanded}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocusCapture={event => { if (event.target.matches(':focus-visible')) setKeyboardFocus(true); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); }}
    onKeyDown={event => { if (event.key === 'Tab') setKeyboardFocus(true); if (event.key === 'Escape') { onClose(); setHovered(false); setKeyboardFocus(false); (event.target as HTMLElement).blur(); } }}>
    <nav className="lens-shortcuts" aria-label={t('快捷操作')}>
      <button type="button" onClick={onHistory} aria-label={t('当前 lens 的分支历史')} title={t('当前 lens 的分支历史')}><GitFork size={21}/><span className="lens-shortcut-label">{t('历史记录')}</span></button>
      <button type="button" onClick={onManual} aria-label={t('参数手册')} title={t('参数手册')}><BookOpen size={21}/><span className="lens-shortcut-label">{t('参数手册')}</span></button>
      <SidebarSelect label={t('语言')} ariaLabel={t('界面语言')} icon={Languages} value={language} options={[{value:'zh',label:'中文'},{value:'en',label:'English'}]} design={design} open={setting==='language'} onOpenChange={open=>setSetting(open?'language':null)} onChange={value=>setLanguage(value==='en'?'en':'zh')}/>
      <SidebarSelect label={t('外观')} ariaLabel={t('切换视觉方案')} icon={Palette} value={design} options={designs.map(item=>({value:item.id,label:t(item.name),colors:[...item.palette]}))} design={design} open={setting==='appearance'} onOpenChange={open=>setSetting(open?'appearance':null)} onChange={value=>onDesignChange(value as DesignId)}/>
      <button type="button" onClick={onGuide} aria-label={t('使用说明')} title={t('使用说明')}><CircleHelp size={21}/><span className="lens-shortcut-label">{t('使用说明')}</span></button>
    </nav>
    <section className="lens-collection" aria-label="Lens systems">
      <div className="lens-collection-heading"><button className="lens-new-task" type="button" disabled={taskCreationDisabled} aria-label={t('新建任务')} title={t('新建任务')} onClick={()=>{onNewTask();leave();}}><CirclePlus size={21}/></button><h2 className="lens-section-title">LENS SYSTEMS</h2>{deletedCount>0&&<button className="lens-trash-link" type="button" aria-label={t('已删除任务')} title={t('已删除任务')} onClick={onTrash}><Trash2 size={14}/><span>{deletedCount}</span></button>}</div>
      <div className="lens-items">{lenses.map(lens => {const name=lens.kind==='task'?lens.name:t(lens.name);return <div className={`lens-item-row${selected===lens.id?' selected':''}`} key={lens.id}><button type="button" className="lens-item" aria-current={selected === lens.id ? 'page' : undefined} aria-label={t(lens.kind==='task'?'打开任务：{name}':'打开 lens：{name}', { name })} title={`${name} · ${lastConversation(lens.lastConversationAt)}`} onClick={() => { onSelect(lens.id); leave(); }}>
        {lens.image?<img className="lens-data-thumbnail" src={lens.image} alt={t('{name} 的观测图像', { name })}/>:<span className="lens-data-thumbnail lens-task-placeholder" aria-hidden="true"><MessageSquare size={17}/></span>}
        <span className="lens-item-meta"><strong>{name}</strong><time dateTime={lens.lastConversationAt}>{lastConversation(lens.lastConversationAt)}</time></span>
      </button>{!live&&<button className="lens-delete-button" type="button" aria-label={t('删除 {name}',{name})} title={t('删除 {name}',{name})} onClick={()=>onDelete(lens.id)}><Trash2 size={14}/></button>}</div>;})}</div>
    </section>
  </aside>;
}
