import type { StageId } from '../data/stages';
import type { PositionRequest } from './position-likelihood';

export type LightModels = { lens: 'MGE' | 'Sérsic'; source: 'MGE' | 'Sérsic' };
export type Run = {
  id: string; lensId: string; parentId?: string; from: StageId;
  createdAt: string; comment: string; systemComment?: 'initial' | 'mask' | 'models'; mask: number[]; models: LightModels;
  status: 'complete' | 'running' | 'interrupted'; progress: number;
  positionLikelihood?: PositionRequest;
  requestedStages?: StageId[];
  finishedStages?: StageId[];
};
export const stageOrder: StageId[] = ['preflight', 'a', 'b', 'm0', 'm1', 'm2', 'm3'];
export const demoLenses = [
  {id: 'TL-DEMO-001', name: 'Einstein arc', subtitle: '合成透镜 · 单透镜星系'},
  {id: 'TL-DEMO-002', name: '第二工作区', subtitle: '独立记录 · 共用合成样例'},
];
/** A version is a submitted demo opinion; the seeded initial run is not a conversation. */
export function lastLensConversationAt(runs: Run[], lensId: string, messages: { lensId: string; createdAt: string }[] = []): string | undefined {
  return [...runs.filter(run => !!run.parentId), ...messages].filter(run => run.lensId === lensId && Number.isFinite(Date.parse(run.createdAt)))
    .reduce<string | undefined>((latest, run) => !latest || Date.parse(run.createdAt) > Date.parse(latest) ? run.createdAt : latest, undefined);
}
/** Demo animation only: advance exactly the stages explicitly selected by the user. */
export function advanceDemoRun(run: Run): Run {
  if (run.status !== 'running') return run;
  const queue = run.requestedStages ?? stageOrder.slice(stageOrder.indexOf(run.from));
  const finished = run.finishedStages ?? [];
  const next = queue.find(stage => !finished.includes(stage));
  if (!next) return { ...run, status: 'complete' };
  const finishedStages = [...finished, next];
  return { ...run, finishedStages, progress: stageOrder.indexOf(next), status: finishedStages.length >= queue.length ? 'complete' : 'running' };
}
export function lensBranches(runs: Run[], lensId: string) {
  const entries = runs.filter(run => run.lensId === lensId).map((run, index) => ({ run, version: index + 1 }));
  const byId = new Map(entries.map(entry => [entry.run.id, entry]));
  const result: { run: Run; version: number; depth: number; parentVersion?: number }[] = [];
  const seen = new Set<string>();
  function visit(entry: typeof entries[number], depth: number) {
    if (seen.has(entry.run.id)) return;
    seen.add(entry.run.id);
    result.push({ ...entry, depth, parentVersion: entry.run.parentId ? byId.get(entry.run.parentId)?.version : undefined });
    for (const child of entries) if (child.run.parentId === entry.run.id) visit(child, depth + 1);
  }
  for (const entry of entries) if (!entry.run.parentId || !byId.has(entry.run.parentId)) visit(entry, 0);
  for (const entry of entries) visit(entry, 0);
  return result;
}
export function initialRun(lensId: string, mask: number[]): Run {
  return {id: `${lensId}-r01`, lensId, from:'preflight', createdAt:'2026-10-26T02:30:00.000Z', comment:'初始合成样例，用于体验界面。未执行科学拟合。',systemComment:'initial',mask,models:{lens:'MGE',source:'MGE'},status:'complete',progress:6};
}
export function readRuns(initialMask: number[]): Run[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('tinylens-demo-runs-v1') || 'null');
    if (Array.isArray(stored) && stored.length && stored.every((r:Run)=> typeof r.id==='string' && demoLenses.some(l=>l.id===r.lensId) && stageOrder.includes(r.from) && Array.isArray(r.mask) && r.mask.length===9216 && r.mask.every((v:number)=>v===0||v===1) && r.models && ['MGE','Sérsic'].includes(r.models.lens) && ['MGE','Sérsic'].includes(r.models.source) && ['running','complete','interrupted'].includes(r.status) && Number.isInteger(r.progress))) {
      const recovered:Run[]=stored.map((r:Run)=>{
        const requestedStages=Array.isArray(r.requestedStages)?stageOrder.filter(id=>r.requestedStages!.includes(id)):undefined;
        const finishedStages=requestedStages&&Array.isArray(r.finishedStages)?requestedStages.filter(id=>r.finishedStages!.includes(id)):undefined;
        return {...r,requestedStages,finishedStages,status:r.status==='running'?'interrupted':r.status};
      });
      for(const lens of demoLenses) if(!recovered.some(r=>r.lensId===lens.id)) recovered.push(initialRun(lens.id,initialMask.slice()));
      return recovered;
    }
  } catch { /* Unavailable or invalid local storage: use a clean demo. */ }
  return demoLenses.map(l=>initialRun(l.id,initialMask.slice()));
}
export function downloadJSON(data: unknown, filename: string) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
