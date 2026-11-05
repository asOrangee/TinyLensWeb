import {useEffect,type ReactNode} from 'react';
import { LayoutDashboard, MapPin, Settings2, SlidersHorizontal } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import ImageLabelContrast from './ImageLabelContrast';

export type StageTab = 'results' | 'parameters' | 'config' | 'positions';

/** One stage surface for the prototype and real runs. Only its data differs. */
export default function StageWorkbench({ title, tab, onTabChange, parameterCount, toolbarRef, children,showParameters=true,showConfig=true,showPositions=false,resultsLabel='结果预览' }: {
  title: string; tab: StageTab; onTabChange: (tab: StageTab) => void; parameterCount?: number;
  toolbarRef: (element: HTMLDivElement | null) => void; children: ReactNode;showParameters?:boolean;showConfig?:boolean;showPositions?:boolean;resultsLabel?:string;
}) {
  const { t } = useDemoI18n();
  const hiddenBaseTab=(!showParameters&&tab==='parameters')||(!showConfig&&tab==='config');
  useEffect(()=>{if(hiddenBaseTab||(!showPositions&&tab==='positions'))onTabChange('results');},[hiddenBaseTab,showPositions,tab,onTabChange]);
  return <section className="stage-workspace" aria-label={title}>
    <div className="stage-content-header"><div className="content-tabs" role="tablist" aria-label={t('阶段内容')}>
      {([{ id: 'config', label: '模型配置', icon: Settings2 }, { id: 'results', label: resultsLabel, icon: LayoutDashboard }, { id: 'positions', label: '位置约束', icon: MapPin }, { id: 'parameters', label: '参数后验', icon: SlidersHorizontal }] as const).filter(item=>(showParameters||item.id!=='parameters')&&(showConfig||item.id!=='config')&&(showPositions||item.id!=='positions')).map(item =>
        <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'selected' : ''} onClick={() => onTabChange(item.id)}><item.icon size={15}/>{t(item.label)}{item.id === 'parameters' && parameterCount !== undefined && <span>{parameterCount}</span>}</button>)}
    </div><div className="stage-viewer-tools" ref={toolbarRef}/></div>
    {children}
    <ImageLabelContrast/>
  </section>;
}
