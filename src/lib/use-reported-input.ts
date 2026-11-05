import { useEffect, useState } from 'react';
import type { AgentUpdate } from './agent-types';
import { parseInputDisplay, selectInputReport, type InputDisplay } from './input-display';
import {renderInputDisplay} from './render-input';
import { useAgentTaskId } from './agent-task-context';
import { agentTaskUrl } from './live-tasks';

/** Share one validated input between the preflight viewer and position picker. */
export function useReportedInput(updates: AgentUpdate[], enabled = true) {
  const taskId = useAgentTaskId();
  const report=selectInputReport(updates),id=report?.id;
  const [loaded,setLoaded]=useState<{id?:string;data?:InputDisplay;error?:string;loading?:boolean}>({});
  useEffect(()=>{
    if(!enabled||!id||!report)return;
    const controller=new AbortController();
    setLoaded(previous=>({...(previous.id===id?previous:{}),id,loading:true,error:undefined}));
    fetch(agentTaskUrl(`/api/agent/input?updateId=${encodeURIComponent(id)}`,taskId),{signal:controller.signal}).then(async response=>{
      const body:unknown=await response.json();
      if(!response.ok)throw new Error('暂时无法读取输入 FITS。');
      const data=await renderInputDisplay(parseInputDisplay(body,report));
      if(!controller.signal.aborted)setLoaded({id,data,loading:false});
    }).catch(error=>{if(!controller.signal.aborted)setLoaded(previous=>({...previous,id,error:error instanceof Error?error.message:'FITS 读取失败。',loading:false}));});
    return()=>controller.abort();
  },[enabled,id,report?.path,taskId]);
  const current=loaded.id===id?loaded:{};
  const display=current.data?.source.provenance_path===report?.path?current.data:undefined;
  return {id,report,display,loading:current.loading,error:current.error,missing:current.loading?'正在读取输入 FITS…':current.error??(id?'正在准备 FITS 四图。':'等待 AI 报告输入来源。')};
}
