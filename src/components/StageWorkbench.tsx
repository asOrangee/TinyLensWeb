import type { ReactNode } from 'react';
import { LayoutDashboard, MapPin, Settings2, SlidersHorizontal } from 'lucide-react';
import type { StageId } from '../data/stages';
import { useDemoI18n } from '../lib/demo-i18n';
import { supportsStageTab, type StageTab } from '../lib/stage-navigation';
import ImageLabelContrast from './ImageLabelContrast';

/** One stage surface for the prototype and real runs. Only its data differs. */
export default function StageWorkbench({ stageId, title, tab, onTabChange, parameterCount, toolbarRef, children }: {
  stageId: StageId; title: string; tab: StageTab; onTabChange: (tab: StageTab) => void; parameterCount?: number;
  toolbarRef: (element: HTMLDivElement | null) => void; children: ReactNode;
}) {
  const { t } = useDemoI18n();
  const tabs = [
    { id: 'config', label: '模型配置', icon: Settings2 },
    { id: 'results', label: stageId === 'preflight' ? '输入预览' : '结果预览', icon: LayoutDashboard },
    { id: 'positions', label: '位置约束', icon: MapPin },
    { id: 'parameters', label: '参数后验', icon: SlidersHorizontal },
  ] as const;
  return <section className="stage-workspace" aria-label={title}>
    <div className="stage-content-header"><div className="content-tabs" role="tablist" aria-label={t('阶段内容')}>
      {tabs.filter(item => supportsStageTab(stageId, item.id)).map(item =>
        <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'selected' : ''} onClick={() => onTabChange(item.id)}><item.icon size={15}/>{t(item.label)}{item.id === 'parameters' && parameterCount !== undefined && <span>{parameterCount}</span>}</button>)}
    </div><div className="stage-viewer-tools" ref={toolbarRef}/></div>
    {children}
    <ImageLabelContrast/>
  </section>;
}
