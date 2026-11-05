import type { StageId } from '../data/stages';

/** Historical demo metadata only; ordinary composer messages have no send mode. */
export type SendIntent = 'reply' | 'rerun';
export const selectableStages: StageId[] = ['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3'];
export function selectedStages(values: StageId[]): StageId[] {
  if (values.some(value => !selectableStages.includes(value))) throw new Error('Unknown stage');
  return selectableStages.filter(stage => values.includes(stage));
}
export const requestStageLabel = (id: StageId) => id === 'preflight' ? 'Data preview' : `Stage ${id.toUpperCase()}`;
