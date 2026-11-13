import type { StageId } from '../data/stages';

export type StageTab = 'results' | 'parameters' | 'config' | 'positions';

export function supportsStageTab(stageId: StageId, tab: StageTab): boolean {
  if (tab === 'results') return true;
  if (tab === 'positions') return stageId === 'preflight';
  return stageId !== 'preflight' && stageId !== 'b';
}

export const workbenchStageCopy: Partial<Record<StageId, { title: string; english: string }>> = {
  preflight: { title: '数据预览', english: 'Data preview' },
  a: { title: '参数化建模', english: 'Parametric modeling' },
  m0: { title: '像素化初始化', english: 'Pixelized source initialization' },
};
export const stageNavigationTitle = (stage: { id: StageId; code: string }) => stage.id === 'preflight' ? 'Data preview' : `Stage ${stage.code}`;
