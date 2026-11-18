import { useEffect, useState } from 'react';
import type { AgentUpdate } from './agent-types';
import { inputMatchesReport, parseInputDisplay, selectInputReport, type InputDisplay } from './input-display';
import {renderInputDisplay} from './render-input';
import { useAgentTaskId } from './agent-task-context';
import { agentTaskUrl } from './live-tasks';
import { fetchPublishedDisplay } from './published-display';
import { isPublishedDisplayReport } from './display-report';
import { resultIdentity } from './stage-attempts';

export async function fetchReportedInput(taskId: string, report: AgentUpdate, signal: AbortSignal, legacyReadable = true) {
  if (!report.id) throw new Error('等待 AI 报告输入来源。');
  if (isPublishedDisplayReport(report)) {
    const { input } = await fetchPublishedDisplay(taskId, report, signal);
    if (!input) throw Error('预检清单缺少输入图层。');
    return input;
  }
  if (report.path?.endsWith('/preflight/inspection.json')) {
    try {
      const { input } = await fetchPublishedDisplay(taskId, report, signal);
      if (input) return input;
    } catch {
      if (signal.aborted) throw signal.reason;
    }
  }
  if (!legacyReadable || report.run_id) throw Error('暂时无法核验这一版本的预检 FITS。');
  const url = agentTaskUrl(`/api/agent/input?updateId=${encodeURIComponent(report.id)}`, taskId);
  const response = await fetch(url, { signal });
  if (response.status === 503) throw new Error('无法连接 GPU 服务器，恢复连接后可刷新预览。');
  if (!response.ok) throw new Error('暂时无法读取输入 FITS。');
  return parseInputDisplay(await response.json(), report);
}

/** Share one validated input between the preflight viewer and position picker. */
export function useReportedInput(updates: AgentUpdate[], enabled = true, versionKey?: string, published?: AgentUpdate, legacyReadable = true) {
  const taskId = useAgentTaskId();
  const report = published ?? selectInputReport(versionKey ? updates.filter(update => resultIdentity(update)?.key === versionKey) : updates);
  const id = report?.id;
  const [loaded,setLoaded]=useState<{id?:string;data?:InputDisplay;error?:string;loading?:boolean}>({});
  useEffect(()=>{
    if(!enabled||!id||!report)return;
    const controller=new AbortController();
    setLoaded(previous=>({...(previous.id===id?previous:{}),id,loading:true,error:undefined}));
    fetchReportedInput(taskId,report,controller.signal,legacyReadable).then(async input=>{
      const data=await renderInputDisplay(input);
      if(!controller.signal.aborted)setLoaded({id,data,loading:false});
    }).catch(error=>{if(!controller.signal.aborted)setLoaded(previous=>({...previous,id,error:error instanceof Error?error.message:'FITS 读取失败。',loading:false}));});
    return()=>controller.abort();
  },[enabled,id,report?.path,taskId,legacyReadable]);
  const current=loaded.id===id?loaded:{};
  const display=inputMatchesReport(current.data,report)?current.data:undefined;
  return {id,report,display,loading:current.loading,error:current.error,missing:current.loading?'正在读取输入 FITS…':current.error??(id?'正在准备 FITS 四图。':'等待 AI 报告输入来源。')};
}
