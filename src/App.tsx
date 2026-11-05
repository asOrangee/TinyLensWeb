import {useScaledPlanes} from './lib/use-scaled-planes';
import {useDemoInput} from './lib/use-demo-input';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, ChevronRight, CircleHelp, Cpu, ExternalLink, FlaskConical, GitBranch, Info, Layers3, LayoutDashboard, LoaderCircle, RotateCcw, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { stages as originalStages } from './data/stages';
import type { StageId, Parameter } from './data/stages';
import { advanceDemoRun, demoLenses, downloadJSON, lastLensConversationAt, lensBranches, readRuns, stageOrder } from './lib/workspace';
import type { LightModels, Run } from './lib/workspace';
import ScienceViewer from './components/ScienceViewer';
import StageWorkbench, {type StageTab} from './components/StageWorkbench';
import StageConfiguration from './components/StageConfiguration';
import { catalogParameters } from './lib/parameter-catalog';
import { ParameterDetail } from './components/ParameterTable';
import ParameterCards from './components/ParameterCards';
import ParameterManual from './components/ParameterManual';
import PreflightViewer from './components/PreflightViewer';
import DemoSidebar from './components/DemoSidebar';
import BlankTaskWorkspace from './components/BlankTaskWorkspace';
import { activeTaskStorageKey, createBlankTask, patchTask, readActiveTask, readTasks, submitTaskMessage, tasksStorageKey, deletedLensesStorageKey, hideLens, readDeletedLenses, restoreLens } from './lib/demo-tasks';
import ConversationRail, { type ConversationMessage } from './components/ConversationRail';
import { readDemoMessages, type DemoMessage } from './lib/demo-conversation';
import PositionLikelihoodEditor from './components/PositionLikelihoodEditor';
import { usePreflightScale } from './lib/use-preflight-scale';
import {useImageScale} from './lib/use-image-scale';
import preflightFixtures from './data/preflight-demo.json';
import { draftFromPositionRequest, emptyPositionDraft, mergePositionPrompt, positionError, positionPrompt, positionRequest, validStoredPositionDraft, type PositionContext, type PositionDraft } from './lib/position-likelihood';
import { createInitialMask } from './components/MaskEditor';
import DemoMaskEditor from './components/DemoMaskEditor';
import { EvidenceChart } from './components/PosteriorChart';
import { DesignGallery } from './components/DesignPicker';
import AgentInboxNotice from './components/AgentInboxNotice';
import ConnectionStatusBar from './components/ConnectionStatusBar';
import { designs, readDesign, isDesign, type DesignId } from './lib/designs';
import { localizeStage, useDemoI18n, type DemoTranslate } from './lib/demo-i18n';
import { workbenchStageCopy as demoStageCopy, stageNavigationTitle } from './lib/stage-navigation';

type Tab = StageTab;
type Modal = 'history' | 'manual' | 'settings' | 'parameter' | 'guide' | 'design' | 'trash' | null;
type Draft = { comment?: string; mask?: number[]; models?: LightModels; position?: PositionDraft; positionPrompt?: string };
const prettyDate = (s:string,language:string)=>new Date(s).toLocaleString(language==='en'?'en-GB':'zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function readDrafts():Record<string,Draft> {try {const data=JSON.parse(localStorage.getItem('tinylens-demo-drafts-v1')||'{}');return data && typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}}

export default function App() {
  const {language,t}=useDemoI18n();
  const [serverConnected,setServerConnected]=useState(false);
  const stages=useMemo(()=>originalStages.map(stage=>localizeStage({...stage,...demoStageCopy[stage.id]},t)),[t]);
  const getStage=(id:StageId)=>stages.find(stage=>stage.id===id)!;
  const [designId,setDesignId]=useState<DesignId>(readDesign);
  const design=designs.find(d=>d.id===designId)!;
  const [runs,setRuns]=useState<Run[]>(()=>readRuns(createInitialMask()));
  const [lensId,setLensId]=useState(demoLenses[0].id);
  const [runId,setRunId]=useState(()=>runs[0].id);
  const [stageId,setStageId]=useState<StageId>('m1');
  const [tab,setTab]=useState<Tab>('results');
  const [viewerToolbarTarget,setViewerToolbarTarget]=useState<HTMLDivElement|null>(null);
  const [drafts,setDrafts]=useState<Record<string,Draft>>(readDrafts);
  const [modal,setModal]=useState<Modal>(null);
  const [parameterKey,setParameterKey]=useState('');
  const [search,setSearch]=useState('');
  const [toast,setToast]=useState('');
  const [storageError,setStorageError]=useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const [messages,setMessages]=useState<DemoMessage[]>(readDemoMessages);
  const [tasks,setTasks]=useState(readTasks);
  const [activeTaskId,setActiveTaskId]=useState<string|null>(()=>readActiveTask(tasks));
  const [deletedLenses,setDeletedLenses]=useState(readDeletedLenses);
  const activeTask=tasks.find(task=>task.id===activeTaskId&&!deletedLenses.includes(task.id));
  const taskName=(id:string)=>{const index=tasks.findIndex(task=>task.id===id);return tasks[index]?.name.trim()||t('新任务 {number}',{number:index+1});};
  const sidebarImage=useScaledPlanes(undefined,'original',false,['observation']);
  const allLenses=[...demoLenses.map(l=>({...l,image:sidebarImage.planes?.observation?.src,lastConversationAt:lastLensConversationAt(runs,l.id,messages)})),...tasks.map(task=>({id:task.id,name:taskName(task.id),kind:'task' as const,lastConversationAt:task.messages.at(-1)?.createdAt}))];
  const sidebarLenses=allLenses.filter(lens=>!deletedLenses.includes(lens.id));
  const hasSelection=sidebarLenses.some(lens=>lens.id===(activeTaskId??lensId));
  const blankWorkspace=!!activeTask||!hasSelection;
  const dialog=useRef<HTMLDialogElement>(null);
  const stageTrack=useRef<HTMLDivElement>(null);
  const run=runs.find(r=>r.id===runId) ?? runs.find(r=>r.lensId===lensId) ?? runs[0];
  const stage=getStage(stageId);
  const branches=lensBranches(runs,lensId);
  const parameter=stage.parameters.find(parameter=>parameter.key===parameterKey)??catalogParameters(stage).find(parameter=>parameter.key===parameterKey);
  const stageIndex=stageOrder.indexOf(stageId);
  const runIndex=runs.filter(r=>r.lensId===lensId).findIndex(r=>r.id===run.id)+1;
  const key=`${run.id}:${stageId}`;
  const draft=drafts[key]??{};
  const conversation:ConversationMessage[]=[...runs.filter(r=>r.lensId===lensId&&r.parentId&&!messages.some(m=>m.runId===r.id&&m.intent==='rerun')).map(r=>({id:r.id,role:'user' as const,text:r.comment,at:r.createdAt,intent:'rerun' as const,stages:r.requestedStages??stageOrder.slice(stageOrder.indexOf(r.from)),note:t('本地演示记录')})),...messages.filter(m=>m.lensId===lensId).map(m=>({id:m.id,role:'user' as const,text:m.text,at:m.createdAt,intent:m.intent,stages:m.stages,note:t('仅本机演示')}))].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const [preflightScale,setPreflightScale]=usePreflightScale('demo');
  const [imageScale,setImageScale]=useImageScale('demo',stageId);
  const numericInput=useDemoInput(stageId==='preflight');
  const positionContext:PositionContext={target:lensId,synthetic:true,stage:'preflight',image:numericInput?.planes.find(p=>p.id==='data')?.variants[preflightScale].src,frame:{shape:preflightFixtures.planes.find(p=>p.id==='data')!.shape as [number,number],pixelScale:preflightFixtures.pixel_scale_arcsec,xDirection:'increasing',yDirection:'decreasing'}};
  const positionValue=validStoredPositionDraft(draft.position)?draft.position:run.positionLikelihood?draftFromPositionRequest(run.positionLikelihood):emptyPositionDraft();
  const positionManual=!!draft.positionPrompt&&!(draft.comment??'').includes(draft.positionPrompt);
  const editMask=drafts[`${run.id}:b`]?.mask??run.mask;
  const editModels=drafts[`${run.id}:a`]?.models??run.models;
  const editedMask=JSON.stringify(editMask)!==JSON.stringify(run.mask);
  const editedModels=JSON.stringify(editModels)!==JSON.stringify(run.models);
  const isRunning=runs.some(r=>r.status==='running');
  const runningId=runs.find(r=>r.status==='running')?.id;
  const pending=run.status!=='complete' && (run.requestedStages?run.requestedStages.includes(stageId)&&!run.finishedStages?.includes(stageId):stageIndex>run.progress);
  const updateDraft=(patch:Draft,at=key)=>setDrafts(prev=>({...prev,[at]:{...prev[at],...patch}}));
  const notify=(message:string)=>setToast(message);
  function updatePositions(value:PositionDraft,force=false){
    const next=positionError(value,positionContext.frame)?'':positionPrompt(value,positionContext,language);
    setDrafts(prev=>{const current=prev[key]??{};const merged=mergePositionPrompt(typeof current.comment==='string'?current.comment:'',current.positionPrompt??'',next,force);return {...prev,[key]:{...current,position:value,comment:merged.text,positionPrompt:merged.manual?current.positionPrompt:next}};});
  }

  useEffect(()=>{try{localStorage.setItem('tinylens-demo-runs-v1',JSON.stringify(runs));localStorage.setItem('tinylens-demo-drafts-v1',JSON.stringify(drafts));localStorage.setItem('tinylens-demo-conversations-v1',JSON.stringify(messages));}catch{setStorageError(true);}},[runs,drafts,messages]);
  useEffect(()=>{try{localStorage.setItem(tasksStorageKey,JSON.stringify(tasks));if(activeTaskId)localStorage.setItem(activeTaskStorageKey,activeTaskId);else localStorage.removeItem(activeTaskStorageKey);}catch{setStorageError(true);}},[tasks,activeTaskId]);
  useEffect(()=>{try{localStorage.setItem(deletedLensesStorageKey,JSON.stringify(deletedLenses));}catch{setStorageError(true);}},[deletedLenses]);
  useEffect(()=>{if(!hasSelection&&sidebarLenses.length)selectLens(sidebarLenses[0].id);},[hasSelection,sidebarLenses.map(lens=>lens.id).join(',')]);
  useEffect(()=>{if(!runningId)return;const timer=window.setInterval(()=>setRuns(prev=>prev.map(r=>r.id===runningId&&r.status==='running'?advanceDemoRun(r):r)),1100);return()=>clearInterval(timer);},[runningId]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(t);},[toast]);
  useEffect(()=>{if(modal){if(!dialog.current?.open)dialog.current?.showModal();}else dialog.current?.close();},[modal]);
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();setModal('manual');} };window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[]);
  useEffect(()=>{try{localStorage.setItem('tinylens-design-v1',designId);}catch{/* Styling works without persistence. */}},[designId]);
  useEffect(()=>{const onHistory=()=>setDesignId(readDesign());window.addEventListener('popstate',onHistory);return()=>window.removeEventListener('popstate',onHistory);},[]);
  useEffect(()=>{
    const revealStage=()=>{const track=stageTrack.current;const selected=track?.querySelector<HTMLElement>('[aria-current="step"]');if(track&&selected&&track.scrollWidth>track.clientWidth+1){const current=selected.getBoundingClientRect();const container=track.getBoundingClientRect();track.scrollLeft+=current.left-container.left-(track.clientWidth-current.width)/2;}};
    revealStage();window.addEventListener('resize',revealStage);const observer=new ResizeObserver(revealStage);if(stageTrack.current)observer.observe(stageTrack.current);return()=>{window.removeEventListener('resize',revealStage);observer.disconnect();};
  },[stageId,designId,language]);

  function chooseDesign(id:DesignId){if(!isDesign(id))return;setDesignId(id);setMenuOpen(false);const url=new URL(window.location.href);url.searchParams.set('design',id);window.history.replaceState(null,'',url);window.scrollTo({top:0,behavior:'instant'});}

  function selectLens(id:string){
    if(tasks.some(task=>task.id===id)){setActiveTaskId(id);setMenuOpen(false);return;}
    const latest=runs.filter(r=>r.lensId===id).at(-1);if(!latest)return;
    setActiveTaskId(null);if(id!==lensId){setLensId(id);setRunId(latest.id);}setMenuOpen(false);
  }
  function newTask(){const task=createBlankTask();setTasks(previous=>[...previous,task]);setActiveTaskId(task.id);setModal(null);setMenuOpen(false);setToast('');}
  function chooseStage(id:StageId){setStageId(id);setTab('results');setMenuOpen(false);}
  function submit() {
    if(isRunning)return;
    const comment=draft.comment??'';
    if(!comment.trim())return;
    const createdAt=new Date().toISOString();
    const messageId=`message-${Date.now().toString(36)}`;
    setMessages(prev=>[...prev,{id:messageId,lensId,runId:run.id,createdAt,text:comment,intent:'reply',stages:[]}]);
    updateDraft({comment:'',positionPrompt:''});
    notify('消息已保存到本地会话。');
  }
  function runComment(record:Run){
    const kind=record.systemComment??(record.id===record.lensId+'-r01'&&record.comment==='初始合成样例，用于体验界面。未执行科学拟合。'?'initial':undefined);
    return kind?t({initial:'初始合成样例，用于体验界面。未执行科学拟合。',mask:'应用手动编辑的透镜弧区域。',models:'应用光分布模型选择。'}[kind]):record.comment;
  }
  function exportRun(){downloadJSON({schema:'tinylens-ui-demo.v1',synthetic:true,language,displayedComment:runComment(run),notice:t("交互原型；不是服务器科学结果，后验数值及图像为固定合成样例。"),run,stage:stageId,draft,conversations:messages.filter(m=>m.lensId===lensId),displayedParameters:stage.parameters},`tinylens-DEMO-${stageId}-${run.id}.json`);notify('已导出演示记录 JSON，包含版本、评论与掩膜。');}
  function stopSimulation(){setRuns(prev=>prev.map(r=>r.status==='running'?{...r,status:'interrupted'}:r));notify('已停止本地演示。已保留版本记录；未影响任何服务器任务。');}
  function parameterDetail(p:Parameter){setParameterKey(p.key);setModal('parameter');}

  return <div className="app-shell demo-workspace" data-design={designId} data-demo-language={language}>
    {menuOpen&&<button className="sidebar-scrim" aria-label={t("关闭导航")} onClick={()=>setMenuOpen(false)}/>}
    <DemoSidebar lenses={sidebarLenses} selected={activeTask?.id??lensId} open={menuOpen} onClose={()=>setMenuOpen(false)} onSelect={selectLens} onNewTask={newTask} onDelete={id=>{setDeletedLenses(previous=>hideLens(previous,id));notify('已移入已删除任务，可随时恢复。');}} onTrash={()=>setModal('trash')} deletedCount={allLenses.filter(lens=>deletedLenses.includes(lens.id)).length} onHistory={()=>{setModal(hasSelection?'history':'trash');setMenuOpen(false);}} onManual={()=>{setModal('manual');setMenuOpen(false);}} onGuide={()=>{setModal('guide');setMenuOpen(false);}} design={designId} onDesignChange={chooseDesign}/>

    <div className="workspace">
      <main className="main-content">
        <div className="demo-existing-workbench" hidden={blankWorkspace}>
        <AgentInboxNotice designId={designId} onConnectionChange={setServerConnected}/>
        <div className="workbench-heading"><div className="lens-identity"><h1 title={t(demoLenses.find(l=>l.id===lensId)!.name)}>{t(demoLenses.find(l=>l.id===lensId)!.name)}</h1><p className="lens-version">Version {String(runIndex).padStart(2,'0')}</p></div>
        <div ref={stageTrack} className="stage-track" aria-label={t("建模阶段")}>{stages.map((s,i)=>{
          const selectedQueue=run.requestedStages;
          const complete=selectedQueue?(!selectedQueue.includes(s.id)||!!run.finishedStages?.includes(s.id)):run.status==='complete'||i<=run.progress;
          const next=selectedQueue?s.id===selectedQueue.find(id=>!run.finishedStages?.includes(id)):i===run.progress+1;
          const running=run.status==='running'&&next;
          const status=running?'running':complete?'completed':run.status==='interrupted'&&next?'blocked':'pending';
          const label=t(running?'模拟运行中':complete?'演示完成':status==='blocked'?'已中断':'尚未开始');
          return <div className="stage-nav-item" key={s.id}><div className="stage-name-line"><button className={`stage-step ${s.id===stageId?'current':''} ${complete?'done':''}`} data-stage-status={status} aria-label={`${stageNavigationTitle(s)} ${s.title}`} aria-description={label} title={label} aria-current={s.id===stageId?'step':undefined} aria-busy={running||undefined} onClick={()=>chooseStage(s.id)}><span className="step-dot stage-initial">{s.id==='preflight'?'D':s.code}</span><span className="stage-description">{s.id==='preflight'&&language==='en'?t('输入数据'):s.title}</span></button></div></div>;
        })}</div>
        </div>
        <div className="workbench-grid"><StageWorkbench title={stage.title} tab={tab} onTabChange={setTab} parameterCount={stage.parameters.length} toolbarRef={setViewerToolbarTarget} showParameters={stageId!=='preflight'&&stageId!=='b'} showConfig={stageId!=='preflight'&&stageId!=='b'} showPositions={stageId==='preflight'} resultsLabel={stageId==='preflight'?'输入预览':'结果预览'}>
          {storageError&&<div className="notice warning"><Info size={16}/>{t("浏览器存储不可用，请导出记录以保留修改。")}</div>}
          {pending&&<div className="notice"><LoaderCircle size={16} className={run.status==='running'?'spin':''}/>{run.status==='running'?t("本阶段尚未完成模拟，下面保留固定合成样例供浏览。"):t("本阶段的模拟尚未完成，下面展示固定合成样例。")}</div>}
          {(run.models.lens!=='MGE'||run.models.source!=='MGE')&&<div className="notice warning"><Info size={16}/>{t("此版本包含 Sérsic 配置草稿；当前图像与参数仍为 MGE 合成样例，未进行 Sérsic 拟合。")}</div>}

          {stageId==='preflight'&&<>
            <div className="tab-panel" role="tabpanel" aria-label={t('输入预览')} hidden={tab!=='results'}><PreflightViewer toolbarTarget={tab==='results'?viewerToolbarTarget:null} scale={preflightScale} onScaleChange={setPreflightScale}/></div>
            <div className="tab-panel" role="tabpanel" aria-label={t('位置约束')} hidden={tab!=='positions'}><PositionLikelihoodEditor value={positionValue} context={positionContext} onChange={updatePositions} onReplacePrompt={()=>updatePositions(positionValue,true)} manualPrompt={positionManual} promptPresent={!!draft.positionPrompt&&!positionManual} disabled={isRunning} toolbarTarget={tab==='positions'?viewerToolbarTarget:null} scale={preflightScale} onScaleChange={setPreflightScale}/></div>
          </>}
          {tab==='results'&&stageId!=='preflight'&&<div className="tab-panel" role="tabpanel">
            {stageId==='b'?<DemoMaskEditor key={run.id} value={editMask} onChange={mask=>updateDraft({mask},`${run.id}:b`)} disabled={isRunning} toolbarTarget={viewerToolbarTarget} scale={imageScale} onScaleChange={setImageScale}/>:<ScienceViewer stageId={stageId} toolbarTarget={viewerToolbarTarget} imageScale={imageScale} onScaleChange={setImageScale}/>}
            {stageId==='b'&&<div className="notice"><Info size={16}/>{t("B 生成透镜弧区域，没有采样后验。编辑会保存为草稿；提交后创建新版本，旧掩膜保留。")}</div>}
          </div>}

          {tab==='parameters'&&<div className="tab-panel" role="tabpanel"><div className="panel"><ParameterCards parameters={stage.parameters} onDetail={parameterDetail}/></div>
            {stageId==='m0'&&<EvidenceChart/>}
          </div>}

          {tab==='config'&&stageId!=='preflight'&&stageId!=='b'&&<div className="tab-panel" role="tabpanel"><StageConfiguration stage={stage} onDetail={parameterDetail}/></div>}

        </StageWorkbench>

        </div></div>
        {activeTask&&<BlankTaskWorkspace key={activeTask.id} name={activeTask.name} placeholder={taskName(activeTask.id)} onNameChange={name=>setTasks(previous=>patchTask(previous,activeTask.id,{name}))}/>}
        {!hasSelection&&<BlankTaskWorkspace name="" placeholder="" onNameChange={()=>{}} onCreate={newTask}/>}
        <ConversationRail conversationId={activeTask?.id ?? lensId} messages={activeTask?activeTask.messages.map(message=>({id:message.id,role:'user' as const,text:message.text,at:message.createdAt,note:t('仅本机演示')})):hasSelection?conversation:[]} value={activeTask?activeTask.draft:hasSelection&&typeof draft.comment==='string'?draft.comment:''} onChange={comment=>activeTask?setTasks(previous=>patchTask(previous,activeTask.id,{draft:comment})):hasSelection?updateDraft({comment}):undefined} onSubmit={activeTask?()=>setTasks(previous=>submitTaskMessage(previous,activeTask.id)):submit} disabled={!hasSelection} busy={!blankWorkspace&&isRunning} newTask={blankWorkspace} inactive={!hasSelection} textareaId="stage-feedback" onInterrupt={activeTask?undefined:stopSimulation}/>

      </main>
    </div>
    <ConnectionStatusBar connected={serverConnected}/>

    <dialog ref={dialog} className={`modal modal-${modal}`} onCancel={()=>setModal(null)} onClick={e=>{if(e.target===dialog.current)setModal(null);}} aria-labelledby="modal-title"><div className="modal-header"><div>{modal!=='parameter'&&<span className="eyebrow">TINYLENS WORKSPACE</span>}<h2 id="modal-title">{modal==='trash'?t('已删除任务'):modal==='design'?t("外观与构图方案"):modal==='history'?t('{lens} 的分支历史',{lens:activeTask?taskName(activeTask.id):lensId}):modal==='manual'?t("参数手册"):modal==='settings'?t("连接与设置"):modal==='parameter'?t(parameter?.name??''):t("欢迎来到 TinyLens")}</h2></div><button className="icon-button" aria-label={t("关闭窗口")} onClick={()=>setModal(null)}><X size={20}/></button></div><div className="modal-body">
      {modal==='trash'&&<><p className="section-caption">{t('已删除的任务保留原有版本、会话与草稿。')}</p><div className="deleted-lens-list">{allLenses.filter(lens=>deletedLenses.includes(lens.id)).map(lens=><div key={lens.id}><strong>{'kind' in lens?lens.name:t(lens.name)}</strong><button className="button secondary" type="button" aria-label={t('恢复 {name}',{name:'kind' in lens?lens.name:t(lens.name)})} onClick={()=>setDeletedLenses(previous=>restoreLens(previous,lens.id))}><RotateCcw size={14}/>{t('恢复')}</button></div>)}</div>{!allLenses.some(lens=>deletedLenses.includes(lens.id))&&<p className="section-caption">{t('没有已删除的任务。')}</p>}</>}
      {modal==='design'&&<DesignGallery value={designId} onChange={id=>{chooseDesign(id);setModal(null);}}/>}
      {modal==='history'&&!activeTask&&<button className="button secondary branch-export" onClick={exportRun}><ArrowDownToLine size={15}/>{t("导出当前演示记录")}</button>}
      {modal==='history'&&activeTask&&<p className="section-caption">{t('此任务尚无运行版本。')}</p>}
      {modal==='history'&&!activeTask&&<><p className="section-caption">{t("{lens} 的全部本地演示版本，旧掩膜与意见保持可查看。",{lens:lensId})}</p><div className="run-history branch-history">{branches.map(({run:r,version,depth,parentVersion})=><div className="branch-entry" key={r.id} data-depth={depth} style={{marginLeft:Math.min(depth,4)*18}}><button className={r.id===run.id?'selected':''} aria-current={r.id===run.id?'true':undefined} onClick={()=>{setRunId(r.id);setModal(null);}}><span className="run-icon"><GitBranch size={19}/></span><div><strong>Version {String(version).padStart(2,'0')}<span className="tag">{r.status==='complete'?t("演示完成"):r.status==='running'?t("模拟中"):t("已中断")}</span></strong><small className="branch-origin">{parentVersion?t('从 Version {version} 分支',{version:String(parentVersion).padStart(2,'0')}):t('初始分支')}</small><p>{runComment(r)}</p><small>{r.requestedStages?`${prettyDate(r.createdAt,language)} · ${r.requestedStages.map(id=>stageNavigationTitle(getStage(id))).join(', ')}`:t("{date} · 从 {stage} 开始",{date:prettyDate(r.createdAt,language),stage:getStage(r.from).code})}</small></div><ChevronRight size={16}/></button></div>)}</div></>}
      {modal==='manual'&&<ParameterManual stages={stages} onSelect={(s,p)=>{setStageId(s.id);setParameterKey(p.key);setModal('parameter');}}/>}
      {modal==='parameter'&&parameter&&<ParameterDetail parameter={parameter}/>}
      {modal==='settings'&&<><div className="connection-preview"><span className="connection-large"><Cpu size={27}/></span><h3>{t("本地交互预览")}</h3><p>{t("服务器 API 尚未接入。现在可以体验 Stage、mask 编辑、参数查看和版本流程。")}</p></div><div className="config-details"><div><span>{t("计划连接方式")}</span><strong>{t("本地代理 + SSH 隧道")}</strong></div><div><span>{t("SSH 别名")}</span><strong>gpu</strong></div><div><span>{t("计算执行端")}</span><strong>{t("远程 TinyLens pipeline")}</strong></div><div><span>{t("GPU 状态")}</span><strong>{t("未查询")}</strong></div><div><span>{t("当前存储")}</span><strong>{storageError?t("不可用，请导出记录"):t("浏览器 localStorage")}</strong></div></div><button className="button secondary" onClick={exportRun}><ArrowDownToLine size={15}/>{t("导出当前演示记录")}</button></>}
      {modal==='guide'&&<><p className="guide-intro">{t("一个围绕科学证据、逐阶段协作的透镜建模工作台。")}</p><div className="guide-steps">{[['01',t("切换 Stage"),t("沿顶部流程查看每个阶段的用途、参数与结果。")],['02',t("调整与评论"),t("在 B 中编辑弧区域，在右侧记录科学判断。")],['03',t("历史记录"),t("通过左侧历史记录查看已有版本，消息只保存在本地会话。")]].map(([n,t,d])=><div key={n}><span>{n}</span><div><h3>{t}</h3><p>{d}</p></div></div>)}</div><div className="notice"><FlaskConical size={18}/>{t("这是本地原型。图像为合成透镜，参数为虚构样例，未执行真实 Agent 审查或 GPU 计算。")}</div><button className="button primary" onClick={()=>{setModal(null);chooseStage('b');}}>{t("试试编辑 mask")}<ArrowRight size={15}/></button></>}
    </div></dialog>
    {toast&&<div className="toast" role="status"><Info size={17}/><span>{t(toast)}</span><button aria-label={t("关闭提示")} onClick={()=>setToast('')}><X size={15}/></button></div>}
  </div>;
}
