import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Check, CircleHelp, CirclePlus, GitFork, Languages, Layers, LoaderCircle, MessageSquare, Palette, Pencil, Trash2, X } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import SidebarSelect from './SidebarSelect';
import { designs, type DesignId } from '../lib/designs';

type LensItem = { id: string; name: string; image?: string; kind?: 'task'; createdAt?: string; lastConversationAt?: string; openDisabled?: boolean };
type Props = { lenses: LensItem[]; selected: string; open: boolean; onClose: () => void; onSelect: (id: string) => void; onNewTask: () => void; onRename?: (id: string, name: string) => Promise<void>; onDelete:(id:string)=>void; onTrash:()=>void; deletedCount:number; onHistory: () => void; onManual: () => void; onGuide: () => void; onBatches?: () => void; onVisibleTasks?: (ids: ReadonlySet<string>) => void; design: DesignId; onDesignChange: (design: DesignId) => void; live?: boolean; taskCreationDisabled?: boolean };
const maxTaskNameLength = 120;

function SidebarTaskRename({ name, thumbnail, onSave, onClose }: {
  name: string; thumbnail: ReactNode; onSave: (name: string) => Promise<void>; onClose: () => void;
}) {
  const { t } = useDemoI18n();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const requestActive = useRef(false);
  const errorId = useId();

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  async function save() {
    if (requestActive.current) return;
    const updated = draft.trim();
    if (!updated || updated.length > maxTaskNameLength) {
      setError(t('请输入 1–120 个字符的任务名称。'));
      input.current?.focus();
      return;
    }
    if (updated === name) { onClose(); return; }
    requestActive.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(updated);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && !(reason instanceof TypeError) ? t(reason.message) : t('暂时无法重命名任务。'));
      input.current?.focus();
    } finally {
      requestActive.current = false;
      setSaving(false);
    }
  }

  const saveLabel = t(saving ? '正在保存任务名称' : '保存任务名称');
  const cancelLabel = t('取消重命名');
  return <form className="lens-rename-form" aria-busy={saving} onSubmit={event => { event.preventDefault(); void save(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        if (event.key === 'Enter') event.preventDefault();
        if (event.key === 'Escape') event.stopPropagation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!requestActive.current) onClose();
      }
    }}>
    {thumbnail}
    <input ref={input} type="text" aria-label={t('任务名称')} aria-invalid={!!error || undefined}
      aria-describedby={error ? errorId : undefined} value={draft} maxLength={maxTaskNameLength} readOnly={saving}
      onChange={event => { setDraft(event.currentTarget.value); setError(''); }}/>
    <button type="submit" disabled={saving} aria-label={saveLabel} title={saveLabel}>
      {saving ? <LoaderCircle className="spin" size={14} aria-hidden="true"/> : <Check size={14} aria-hidden="true"/>}
    </button>
    <button type="button" disabled={saving} aria-label={cancelLabel} title={cancelLabel} onClick={onClose}>
      <X size={14} aria-hidden="true"/>
    </button>
    {error && <p id={errorId} role="alert" className="lens-rename-error">{error}</p>}
  </form>;
}

export default function DemoSidebar({ lenses, selected, open, onClose, onSelect, onNewTask, onRename, onDelete, onTrash, deletedCount, onHistory, onManual, onGuide, onBatches, onVisibleTasks, design, onDesignChange, live = false, taskCreationDisabled = live }: Props) {
  const { t, language, setLanguage } = useDemoI18n();
  const lensList = useRef<HTMLDivElement>(null);
  const lensIds = onVisibleTasks ? lenses.map(lens => lens.id).join(' ') : '';
  useEffect(() => {
    const root = lensList.current;
    if (!root || !onVisibleTasks) return;
    if (!lensIds) { onVisibleTasks(new Set()); return; }
    if (!('IntersectionObserver' in window)) { onVisibleTasks(new Set(lensIds.split(' '))); return; }
    const nearViewport = new Set<string>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.lensTask;
        if (id && entry.isIntersecting) nearViewport.add(id);
        else if (id) nearViewport.delete(id);
      }
      onVisibleTasks(new Set(nearViewport));
    }, { root, rootMargin: '120px 0px' });
    root.querySelectorAll('[data-lens-task]').forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [lensIds, onVisibleTasks]);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [setting, setSetting] = useState<'language'|'appearance'|null>(null);
  const [renamingId, setRenamingId] = useState<string>();
  const renameFocus = useRef<HTMLButtonElement>(null);
  const returnFocusTo = useRef<string | undefined>(undefined);
  const editing = live && !!onRename && lenses.some(item => item.id === renamingId && !!item.createdAt);
  const expanded = open || hovered || keyboardFocus || setting !== null || editing;
  useEffect(() => {
    if (renamingId && !editing) setRenamingId(undefined);
    if (!renamingId && returnFocusTo.current) {
      returnFocusTo.current = undefined;
      renameFocus.current?.focus();
    }
  }, [renamingId, editing]);
  const leave = () => { onClose(); setSetting(null); setHovered(false); setKeyboardFocus(false); setRenamingId(undefined); };
  function finishRename(id: string) {
    returnFocusTo.current = id;
    setKeyboardFocus(true);
    setRenamingId(undefined);
  }
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
      {onBatches && <button type="button" onClick={() => { onBatches(); leave(); }} aria-label={t('批次进度')} title={t('批次进度')}><Layers size={21}/><span className="lens-shortcut-label">{t('批次进度')}</span></button>}
      <button type="button" onClick={onHistory} aria-label={t('当前 lens 的分支历史')} title={t('当前 lens 的分支历史')}><GitFork size={21}/><span className="lens-shortcut-label">{t('历史记录')}</span></button>
      <button type="button" onClick={onManual} aria-label={t('参数手册')} title={t('参数手册')}><BookOpen size={21}/><span className="lens-shortcut-label">{t('参数手册')}</span></button>
      <SidebarSelect label={t('语言')} ariaLabel={t('界面语言')} icon={Languages} value={language} options={[{value:'zh',label:'中文'},{value:'en',label:'English'}]} design={design} open={setting==='language'} onOpenChange={open=>setSetting(open?'language':null)} onChange={value=>setLanguage(value==='en'?'en':'zh')}/>
      <SidebarSelect label={t('外观')} ariaLabel={t('切换视觉方案')} icon={Palette} value={design} options={designs.map(item=>({value:item.id,label:t(item.name),colors:[...item.palette]}))} design={design} open={setting==='appearance'} onOpenChange={open=>setSetting(open?'appearance':null)} onChange={value=>onDesignChange(value as DesignId)}/>
      <button type="button" onClick={onGuide} aria-label={t('使用说明')} title={t('使用说明')}><CircleHelp size={21}/><span className="lens-shortcut-label">{t('使用说明')}</span></button>
    </nav>
    <section className="lens-collection" aria-label="Lens systems">
      <div className="lens-collection-heading"><button className="lens-new-task" type="button" disabled={taskCreationDisabled} aria-label={t('新建任务')} title={t('新建任务')} onClick={()=>{onNewTask();leave();}}><CirclePlus size={21}/></button><h2 className="lens-section-title">LENS SYSTEMS</h2>{deletedCount>0&&<button className="lens-trash-link" type="button" aria-label={t('已删除任务')} title={t('已删除任务')} onClick={onTrash}><Trash2 size={14}/><span>{deletedCount}</span></button>}</div>
      <div ref={lensList} className="lens-items">{lenses.map(lens => {
        const name = live || lens.kind === 'task' ? lens.name : t(lens.name);
        const rename = live && lens.createdAt ? onRename : undefined;
        const renameLabel = t('重命名 {name}', { name });
        const thumbnail = lens.image ? <img className="lens-data-thumbnail" src={lens.image} alt={t('{name} 的观测图像', { name })}/>
          : <span className="lens-data-thumbnail lens-task-placeholder" aria-hidden="true"><MessageSquare size={17}/></span>;
        return <div className={`lens-item-row${selected === lens.id ? ' selected' : ''}`} key={lens.id} data-lens-task={onVisibleTasks ? lens.id : undefined}>
          {rename && renamingId === lens.id ? <SidebarTaskRename name={name} thumbnail={thumbnail}
            onSave={updated => rename(lens.id, updated)} onClose={() => finishRename(lens.id)}/>
            : <>
              <button type="button" className="lens-item" aria-current={selected === lens.id ? 'page' : undefined} disabled={lens.openDisabled}
                aria-label={t(lens.kind === 'task' ? '打开任务：{name}' : '打开 lens：{name}', { name })}
                title={`${name} · ${lens.openDisabled ? t('该任务暂不可打开') : lastConversation(lens.lastConversationAt)}`} onClick={() => { onSelect(lens.id); leave(); }}>
                {thumbnail}<span className="lens-item-meta"><strong>{name}</strong><time dateTime={lens.lastConversationAt}>{lastConversation(lens.lastConversationAt)}</time></span>
              </button>
              {rename && <button type="button" className="lens-rename-button" title={renameLabel} aria-label={renameLabel}
                ref={returnFocusTo.current === lens.id ? renameFocus : undefined} disabled={editing} onClick={() => setRenamingId(lens.id)}>
                <Pencil size={14} aria-hidden="true"/>
              </button>}
              <button className="lens-delete-button" type="button" aria-label={t('删除 {name}', { name })}
                title={t('删除 {name}', { name })} onClick={() => onDelete(lens.id)}><Trash2 size={14}/></button>
            </>}
        </div>;
      })}</div>
    </section>
  </aside>;
}
