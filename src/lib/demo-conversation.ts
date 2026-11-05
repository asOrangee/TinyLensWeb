import type { StageId } from '../data/stages';
import type { SendIntent } from './message-intent';

export type DemoMessage = { id: string; lensId: string; runId: string; createdAt: string; text: string; intent: SendIntent; stages: StageId[] };
export function readDemoMessages(): DemoMessage[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem('tinylens-demo-conversations-v1') || '[]');
    return Array.isArray(entries) ? entries.filter((entry): entry is DemoMessage => !!entry && typeof entry.id === 'string' && typeof entry.lensId === 'string' && typeof entry.runId === 'string' && typeof entry.createdAt === 'string' && typeof entry.text === 'string' && ['reply', 'rerun'].includes(entry.intent) && Array.isArray(entry.stages) && entry.stages.every((id: string) => ['preflight','a','b','m0','m1','m2','m3'].includes(id))) : [];
  } catch { return []; }
}
