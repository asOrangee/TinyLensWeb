import type { StageId } from '../data/stages';

export const workbenchStageCopy: Partial<Record<StageId, { title: string; english: string }>> = {
  preflight: { title: '数据预览', english: 'Data preview' },
  a: { title: '参数化建模', english: 'Parametric modeling' },
  m0: { title: '像素化初始化', english: 'Pixelized source initialization' },
};
export const stageNavigationTitle = (stage: { id: StageId; code: string }) => stage.id === 'preflight' ? 'Data preview' : `Stage ${stage.code}`;
