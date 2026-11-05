export type TaskMessage = { id:string; text:string; createdAt:string };
export type DemoTask = { id:string; name:string; createdAt:string; draft:string; messages:TaskMessage[] };
export const tasksStorageKey='tinylens-demo-tasks-v1';
export const activeTaskStorageKey='tinylens-demo-active-task-v1';
export const deletedLensesStorageKey='tinylens-demo-deleted-lenses-v1';
export function parseDeletedLenses(raw:string|null):string[]{try{const value:unknown=JSON.parse(raw??'[]');return Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'&&(id.startsWith('task-')||/^TL-DEMO-\d+$/.test(id))))]:[];}catch{return [];}}
export function readDeletedLenses():string[]{try{return parseDeletedLenses(localStorage.getItem(deletedLensesStorageKey));}catch{return [];}}
export const hideLens=(deleted:string[],id:string)=>deleted.includes(id)?deleted:[...deleted,id];
export const restoreLens=(deleted:string[],id:string)=>deleted.filter(value=>value!==id);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const date=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function parseTasks(raw:string|null):DemoTask[]{
  try{
    const data:unknown=JSON.parse(raw??'[]');if(!Array.isArray(data))return [];
    const ids=new Set<string>();
    return data.flatMap(value=>{
      if(!record(value)||typeof value.id!=='string'||!value.id.startsWith('task-')||ids.has(value.id)||typeof value.name!=='string'||typeof value.draft!=='string'||!date(value.createdAt)||!Array.isArray(value.messages))return [];
      if(!value.messages.every(message=>record(message)&&typeof message.id==='string'&&typeof message.text==='string'&&date(message.createdAt)))return [];
      ids.add(value.id);
      return [{id:value.id,name:value.name,createdAt:value.createdAt,draft:value.draft,messages:value.messages.map(message=>({id:message.id as string,text:message.text as string,createdAt:message.createdAt as string}))}];
    });
  }catch{return [];}
}
export function readTasks():DemoTask[]{try{return parseTasks(localStorage.getItem(tasksStorageKey));}catch{return [];}}
export function readActiveTask(tasks:DemoTask[]):string|null{try{const id=localStorage.getItem(activeTaskStorageKey);return tasks.some(task=>task.id===id)?id:null;}catch{return null;}}
export function createBlankTask():DemoTask{return {id:`task-${crypto.randomUUID()}`,name:'',createdAt:new Date().toISOString(),draft:'',messages:[]};}
export function patchTask(tasks:DemoTask[],id:string,patch:Partial<Pick<DemoTask,'name'|'draft'>>):DemoTask[]{return tasks.map(task=>task.id===id?{...task,...patch}:task);}
export function submitTaskMessage(tasks:DemoTask[],id:string):DemoTask[]{
  const task=tasks.find(task=>task.id===id);if(!task?.draft.trim())return tasks;
  const message={id:crypto.randomUUID(),text:task.draft,createdAt:new Date().toISOString()};
  return tasks.map(task=>task.id===id?{...task,draft:'',messages:[...task.messages,message]}:task);
}
