import { useDemoI18n } from '../lib/demo-i18n';
import { ArrowUpRight, Check, LayoutGrid, Palette } from 'lucide-react';
import { designs, type DesignId } from '../lib/designs';
import {useScaledPlanes} from '../lib/use-scaled-planes';

type Props = { value: DesignId; onChange: (value: DesignId) => void };
export function DesignPicker({ value, onChange, onCompare, compact = false, sidebar = false }: Props & { onCompare?: () => void; compact?: boolean; sidebar?: boolean }) {
  const {t}=useDemoI18n();
  const minimal = compact || sidebar;
  const currentName = t(designs.find(design=>design.id===value)!.name);
  return <div className={`design-controls${compact ? ' design-controls-compact' : ''}${sidebar ? ' design-controls-sidebar' : ''}`}>
    <label className="design-select-wrap" title={minimal ? `${t('切换视觉方案')} · ${currentName}` : undefined}><Palette size={sidebar ? 21 : compact ? 17 : 15} aria-hidden="true"/>{sidebar && <><span className="lens-shortcut-label">{t('外观')}</span><span className="lens-setting-value">{currentName}</span></>}<span className="sr-only">{t("切换视觉方案")}</span><select aria-label={t("切换视觉方案")} className="design-select" value={value} onChange={event=>onChange(event.target.value as DesignId)}>{designs.map(design=><option key={design.id} value={design.id}>{minimal ? t(design.name) : `${design.number} · ${t(design.name)}`}</option>)}</select></label>
    {!minimal && onCompare && <button className="design-compare" onClick={onCompare} aria-label={t("对比四种外观与构图方案")}><LayoutGrid size={14}/><span>{t("对比方案")}</span></button>}
  </div>;
}

export function DesignGallery({ value, onChange }: Props) {
  const {t}=useDemoI18n();
  const preview=useScaledPlanes(undefined,'original',false);
  return <div className="design-gallery">
    <p className="design-gallery-intro">{t("四种工作方式，同一套科学流程。选择一个方案，直接体验完整界面。")}</p>
    <div className="design-cards">{designs.map(design=><button key={design.id} className={`design-card ${value===design.id?'chosen':''}`} onClick={()=>onChange(design.id)} aria-label={t('预览{name}',{name:t(design.name)})}>
      <div className={`design-mini mini-${design.id}`} aria-hidden="true">
        <div className="mini-sidebar"><i/><i/><i/><b/><i/></div>
        <div className="mini-header"><b/><i/><i/></div>
        <div className="mini-stage">{Array.from({length:6},(_,i)=><i key={i}/>)}</div>
        <div className="mini-content"><div className="mini-caption"/><div className="mini-images">{(['observation','model','residual'] as const).map(name=>preview.planes?.[name]?.src&&<img key={name} src={preview.planes[name]!.src} alt=""/>)}</div><div className="mini-table"><i/><i/><i/></div></div>
        <div className="mini-inspector"><i/><i/><b/><i/><strong/></div>
      </div>
      <div className="design-card-body"><div className="design-card-heading"><span className="design-number">{design.number}</span><h3>{t(design.name)}</h3>{value===design.id?<span className="design-current"><Check size={12}/>{t("当前")}</span>:<ArrowUpRight size={16}/>}</div><span className="design-english">{design.english}</span><p>{t(design.description)}</p><div className="design-card-foot"><span>{t(design.focus)}</span><div className="design-swatches">{design.palette.map(color=><i key={color} style={{backgroundColor:color}}/>)}</div></div></div>
    </button>)}</div>
    <p className="design-gallery-note">{t("切换时保留当前 Stage、mask 草稿和意见。科学图像的色阶不随界面外观改变。")}</p>
  </div>;
}
