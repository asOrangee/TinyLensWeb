import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, FileText, FolderOpen, Layers3, LayoutDashboard, Link2, LoaderCircle, Menu, MessageSquare, Orbit, Radio, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, X } from 'lucide-react';
import { DesignPicker } from './DesignPicker';
import { designs, isDesign, readDesign, type DesignId } from '../lib/designs';
import { stages, type StageId, type Parameter } from '../data/stages';
import { EMPTY_AGENT_STATE, parseAgentState, type AgentActivity, type AgentQuestion, type AgentQuestionAnswer, type AgentRequest, type AgentState, type AgentUpdate } from '../lib/agent-types';
import PositionLikelihoodEditor from './PositionLikelihoodEditor';
import ConversationRail from './ConversationRail';
import ConnectionStatusBar from './ConnectionStatusBar';
import { stageIndicators, serverLinkConnected, replyPending } from '../lib/workbench-status';
import DemoSidebar from './DemoSidebar';
import LiveStageData, { useLiveStageData } from './LiveStageData';
import StageWorkbench, { type StageTab } from './StageWorkbench';
import ScienceViewer from './ScienceViewer';
import LivePreflightViewer from './LivePreflightViewer';
import { useReportedInput } from '../lib/use-reported-input';
import { usePreflightScale } from '../lib/use-preflight-scale';
import {useImageScale} from '../lib/use-image-scale';
import { inputPositionContext, positionContextForTarget, positionDraftForInput } from '../lib/input-position-context';
import LiveMaskEditor from './LiveMaskEditor';
import {mergeMaskPrompt} from '../lib/mask-user-input';
import ParameterManual from './ParameterManual';
import BlankTaskWorkspace from './BlankTaskWorkspace';
import { agentTaskUrl, defaultLiveTaskId, liveTaskPreferenceKey, type LiveTask } from '../lib/live-tasks';
import { catalogParameters } from '../lib/parameter-catalog';
import { ParameterDetail } from './ParameterTable';
import { resultIdentity, selectStageResults } from '../lib/live-results';
import { useDemoI18n } from '../lib/demo-i18n';
import { stageNavigationTitle, workbenchStageCopy } from '../lib/stage-navigation';
import { emptyPositionDraft, mergePositionPrompt, positionError, positionPrompt, validStoredPositionDraft, type PositionContext, type PositionDraft } from '../lib/position-likelihood';
import './agent-workspace.css';
import './live-workbench.css';

const connectionNames = { disconnected: '尚未连接', connecting: '正在连接', connected: 'AI 已连接', error: '连接异常' };
const turnNames = { idle: '等待你的指令', running: 'AI 正在处理', waiting: '等待你的答复', completed: 'AI 回合已结束', failed: 'AI 回合异常', interrupted: 'AI 回合已中断' };
const stageNames: Record<string, string> = { pending: '等待', not_started: '尚未开始', running: '运行中', preparing: '准备中', prepared: '准备完成', awaiting_review: '等待审查', reviewing: '审查中', accepted: '已接受', completed: '已完成', complete: '已完成', success: '执行成功', failed: '失败', human_review: '需要人工判断', retry: '重试', interrupted: '已中断', blocked: '受阻', preparation_blocked: '准备受阻', paused: '已暂停', queued: '等待资源', awaiting_user: '等待你的答复', awaiting_input: '等待你的答复', awaiting_approval: '等待批准', waiting: '等待你的答复', retrying: '正在重试', error: '失败', rejected: '未通过审查' };
const hiddenReasoning = (kind: string | undefined) => /reasoning|chain.?of.?thought|(^|[\s_/-])analysis([\s_/-]|$)/i.test(kind ?? '');
const normalStage = (value?: string) => {
  const stage = value?.trim().toLowerCase().replace(/^stage[\s_-]+/, '');
  return stage === 'p' ? 'preflight' : stage;
};
const sessionStageDescriptions: Partial<Record<StageId, string>> = {
  a: '联合拟合透镜星系光、背景源光与透镜质量模型，建立初始成像关系。模型选择与实际配置以 Pipeline AI 的报告为准。',
  b: '根据扣除透镜星系光后的信号，检查透镜弧的拟合区域、遗漏成分与边界，并把调整意见交给 AI。',
};
const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
type WorkbenchTab = StageTab;
function readPreferences(taskId: string): { stageId: StageId; draft?: string; position?: PositionDraft; positionPrompt?: string;maskPrompt?:string } {
  try {
    const saved = JSON.parse(localStorage.getItem(liveTaskPreferenceKey(taskId)) ?? 'null');
    if (saved && typeof saved === 'object') return {
      stageId: stages.some(stage => stage.id === saved.stageId) ? saved.stageId : 'preflight',
      draft: typeof saved.draft === 'string' ? saved.draft : undefined,
      position: validStoredPositionDraft(saved.position) ? saved.position : undefined,
      positionPrompt: typeof saved.positionPrompt === 'string' ? saved.positionPrompt : undefined,
      maskPrompt:typeof saved.maskPrompt==='string'?saved.maskPrompt:undefined,
    };
  } catch { /* The workspace remains usable when storage is unavailable. */ }
  return { stageId: 'preflight' };
}
const reportKey = (update: AgentUpdate, index: number) => update.id ?? `${index}-${update.kind}-${update.path ?? update.title ?? ''}`;
const stageLabel = (update?: AgentUpdate) => update ? stageNames[update.status ?? ''] ?? update.status ?? 'AI 已报告' : 'AI 尚未报告';
const reportTime = (time?: string) => time && Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : time;


function initialDesign(): DesignId {
  const requested = new URLSearchParams(location.search).get('design');
  if (isDesign(requested)) return requested;
  try { if (localStorage.getItem('tinylens-design-v1')) return readDesign(); } catch { /* Optional preference. */ }
  return 'studio';
}

export default function AgentWorkspace({ task, tasks, taskError, taskCreationDisabled, onNewTask, onSelectTask, onRenameTask, onTaskActivity }: {
  task: LiveTask; tasks: LiveTask[]; taskError: string; taskCreationDisabled: boolean;
  onNewTask: () => void; onSelectTask: (id: string) => void; onRenameTask: (name: string) => void; onTaskActivity: () => void;
}) {
  const { t, language } = useDemoI18n();
  const preferenceKey = liveTaskPreferenceKey(task.id);
  const api = (path: string) => agentTaskUrl(path, task.id);
  const [taskName, setTaskName] = useState(task.name);
  const [stateReady, setStateReady] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<'history' | 'guide' | 'manual' | 'parameter' | null>(null);
  const [state, setState] = useState<AgentState>(() => task.id === defaultLiveTaskId ? EMPTY_AGENT_STATE : { ...EMPTY_AGENT_STATE, datasetPath: '' });
  const [viewerToolbarTarget, setViewerToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [parameterKey, setParameterKey] = useState('');
  const [savedPreferences] = useState(() => readPreferences(task.id));
  const [draft, setDraft] = useState(savedPreferences.draft ?? '');
  const answerLocks = useRef(new Set<string>());
  const questionKey = (id: string) => `${state.threadId ?? ''}:${id}`;
  const messageSending = useRef(false);
  const [position, setPosition] = useState<PositionDraft>(savedPreferences.position ?? emptyPositionDraft());
  const [generatedPositionPrompt, setGeneratedPositionPrompt] = useState(savedPreferences.positionPrompt ?? '');
  const [generatedMaskPrompt,setGeneratedMaskPrompt]=useState(savedPreferences.maskPrompt??'');
  const draftTouched = useRef(savedPreferences.draft !== undefined);
  const initialStateLoaded = useRef(false);
  const [stageId, setStageId] = useState<StageId>(savedPreferences.stageId);
  const [tab, setTab] = useState<WorkbenchTab>('results');
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [focusReports, setFocusReports] = useState(false);
  const stageReportPanel = useRef<HTMLElement>(null);
  const stageTrack = useRef<HTMLDivElement>(null);
  const [designId, setDesignId] = useState<DesignId>(initialDesign);
  const [showDesigns, setShowDesigns] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'open' | 'retrying'>('connecting');
  const [showAllActivities, setShowAllActivities] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinConversation = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const selectedStage = stages.find(stage => stage.id === stageId)!;
  const stageData = useLiveStageData(selectedStage, state.updates);
  const parameter = stageData.parameters.find(item => item.key === parameterKey)??catalogParameters(selectedStage).find(item=>item.key===parameterKey);
  const showParameter = (item: Parameter) => { setParameterKey(item.key); setWorkspacePanel('parameter'); };
  const input=useReportedInput(state.updates,stageId==='preflight');
  const [preflightScale,setPreflightScale]=usePreflightScale('live',task.id===defaultLiveTaskId?undefined:task.id);
  const [imageScale,setImageScale]=useImageScale('live',stageId,task.id===defaultLiveTaskId?undefined:task.id);
  function updateMaskPrompt(next:string){draftTouched.current=true;setDraft(previous=>mergeMaskPrompt(previous,generatedMaskPrompt,next));setGeneratedMaskPrompt(next);}
  const inputContext=inputPositionContext(input.display,input.report,state.datasetPath,preflightScale);
  const positionValue=positionDraftForInput(position,inputContext,state.datasetPath);
  const positionContext: PositionContext = positionContextForTarget(inputContext,positionValue.target);
  const positionManual = !!generatedPositionPrompt && !draft.includes(generatedPositionPrompt);
  function updatePositions(next: PositionDraft, force = false) {
    const context=positionContextForTarget(inputContext,next.target);
    if(!next.points.length)next={...next,inputFitsSha256:undefined};
    else if(context.source)next={...next,target:next.target??context.target,inputFitsSha256:next.inputFitsSha256??context.source.fits_sha256};
    const prompt = positionError(next,context.frame,context.source?.fits_sha256) ? '' : positionPrompt(next, context);
    const merged = mergePositionPrompt(draft, generatedPositionPrompt, prompt, force);
    draftTouched.current = true;
    setPosition(next); setDraft(merged.text);
    if (!merged.manual) setGeneratedPositionPrompt(prompt);
  }
  const isBusy = state.status === 'running' || state.status === 'waiting';
  const blankWorkspace = task.id !== defaultLiveTaskId && state.messages.length === 0 && state.updates.length === 0;
  const canInitialize = stateReady && task.id !== defaultLiveTaskId && !state.threadId && state.messages.length === 0;
  const messages = state.messages.filter(message => !hiddenReasoning(message.phase));
  const activities = state.activities.filter(activity => !hiddenReasoning(activity.type));
  const visibleActivities = showAllActivities ? activities : activities.slice(-8);
  const stageUpdates = state.updates.filter(update => update.kind === 'stage');
  const selectedStageUpdate = stageUpdates.filter(update => normalStage(update.stage) === stageId).at(-1);
  const lastStageUpdate = stageUpdates.at(-1);
  const stageReports = state.updates.filter(update => normalStage(update.stage) === stageId);
  const runReports = state.updates.filter(update => !stages.some(stage => stage.id === normalStage(update.stage)));
  const stageRunning = selectedStageUpdate?.status === 'running';
  const openQuestions = state.questions.filter(question => question.status !== 'answered' && question.status !== 'superseded');
  const archivedQuestions = state.questions.filter(question => question.status === 'answered' || question.status === 'superseded');

  function receiveState(next: AgentState) {
    // Restore an existing conversation without inserting a second full-run request.
    // Never replace a draft the user has already started editing.
    if (!draftTouched.current) {
      if (next.messages.length) setDraft('');
      else if (!initialStateLoaded.current) setDraft('');
    }
    initialStateLoaded.current = true;
    setStateReady(true);
    setState(next);
  }

  useEffect(() => {
    const abort = new AbortController();
    let sawEvent = false;
    let active = true;
    const events = new EventSource(api('/api/agent/events'));
    events.addEventListener('state', event => {
      try { const next = parseAgentState(JSON.parse((event as MessageEvent).data)); sawEvent = true; if (active) { receiveState(next); setStreamStatus('open'); } }
      catch (error) { if (active) setLocalError(error instanceof Error ? error.message : '无法读取 AI 状态更新。'); }
    });
    events.onopen = () => { if (active) setStreamStatus('open'); };
    events.onerror = () => { if (active) setStreamStatus('retrying'); };
    fetch(api('/api/agent/state'), { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error(`AI 会话服务暂不可用（${response.status}）。`);
      const next = parseAgentState(await response.json());
      if (active && !sawEvent) receiveState(next);
    }).catch(error => { if (active && !abort.signal.aborted) setLocalError(error instanceof Error ? error.message : '无法连接 AI 会话服务。'); });
    return () => { active = false; abort.abort(); events.close(); };
  }, [task.id]);

  useEffect(() => { setTaskName(task.name); }, [task.name]);
  useEffect(() => { document.title = `TinyLens · ${task.name}`; }, [task.name]);

  useEffect(() => { const openManual = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); setWorkspacePanel('manual'); } }; window.addEventListener('keydown', openManual); return () => window.removeEventListener('keydown', openManual); }, []);
  useEffect(() => { if (showDesigns || workspacePanel) dialog.current?.showModal(); else dialog.current?.close(); }, [showDesigns, workspacePanel]);
  useEffect(() => { if (pinConversation.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.messages, tab]);
  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ stageId, draft, position, positionPrompt: generatedPositionPrompt,maskPrompt:generatedMaskPrompt })); setStorageUnavailable(false); }
    catch { setStorageUnavailable(true); }
  }, [stageId, draft, position, generatedPositionPrompt,generatedMaskPrompt]);
  useEffect(() => {
    const track = stageTrack.current;
    const selected = track?.querySelector<HTMLElement>('[aria-current="step"]');
    if (track && selected && track.scrollWidth > track.clientWidth + 1) {
      const current = selected.getBoundingClientRect(); const container = track.getBoundingClientRect();
      track.scrollLeft += current.left - container.left - (track.clientWidth - current.width) / 2;
    }
  }, [stageId, designId]);
  useEffect(() => { if (!copyNotice) return; const timeout = setTimeout(() => setCopyNotice(''), 3500); return () => clearTimeout(timeout); }, [copyNotice]);
  useEffect(() => {
    if (tab !== 'results' || !focusReports) return;
    stageReportPanel.current?.focus({ preventScroll: true });
    stageReportPanel.current?.scrollIntoView({ block: 'start' });
    setFocusReports(false);
  }, [tab, focusReports]);

  async function perform(name: string, body: Record<string, unknown> = {}) {
    if (action) return false;
    setAction(name); setLocalError(null);
    try {
      const response = await fetch(api(`/api/agent/${name}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : null;
        throw new Error(typeof failure === 'string' ? failure : `AI 会话请求未完成（${response.status}）。`);
      }
      // Actions may return the state directly, or only acknowledge the request.
      if (payload && typeof payload === 'object' && 'connection' in payload) receiveState(parseAgentState(payload));
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'AI 会话请求失败。');
      return false;
    } finally { setAction(null); }
  }

  async function sendMessage() {
    const text = draft;
    if (!text.trim() || !stateReady || state.connection !== 'connected' && !canInitialize || action || messageSending.current || isBusy) return;
    pinConversation.current = true;
    messageSending.current = true;
    try {
      if (state.connection !== 'connected' && !await perform('connect')) return;
      const sent = await perform('message', { text });
      if (sent) {
        // A user can navigate away while delivery is in flight. Clear only the
        // confirmed message's matching saved draft, even if this view unmounted.
        try {
          const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
          if (saved?.draft === text) localStorage.setItem(preferenceKey, JSON.stringify({ ...saved, draft: '', positionPrompt: '' }));
        } catch { /* The in-memory draft still follows the delivery receipt. */ }
        draftTouched.current = true;
        setDraft(previous => previous === text ? '' : previous);
        setGeneratedPositionPrompt('');
        onTaskActivity();
      }
    } finally { messageSending.current = false; }
  }

  async function answerQuestion(questionId: string, answer: AgentQuestionAnswer): Promise<QuestionSubmission> {
    if (action || answerLocks.current.has(questionKey(questionId))) return { status: 'rejected', error: '该答复正在提交或等待送达确认，请勿重复提交。' };
    answerLocks.current.add(questionKey(questionId));
    setAction('answer');
    let result: QuestionSubmission;
    try {
      const response = await fetch(api('/api/agent/answer'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId, ...answer }) });
      const payload: unknown = await response.json().catch(() => null);
      if (payload && typeof payload === 'object' && 'connection' in payload) receiveState(parseAgentState(payload));
      if (response.ok) result = { status: 'accepted' };
      else {
        const error = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `答复请求未完成（${response.status}）。`;
        result = { status: response.status >= 500 ? 'unknown' : 'rejected', error };
      }
    } catch {
      result = { status: 'unknown', error: '连接中断，暂时无法确认答复是否送达。请等待会话状态恢复；不要重复提交。' };
    }
    // A transport acknowledgement is not proof that the AI received the answer.
    // Refresh only the server state, and never retry a submission automatically.
    try {
      const response = await fetch(api('/api/agent/state'));
      if (response.ok) receiveState(parseAgentState(await response.json()));
    } catch { /* SSE will restore the authoritative delivery status when available. */ }
    if (result.status === 'rejected') answerLocks.current.delete(questionKey(questionId));
    setAction(null);
    return result;
  }

  function chooseDesign(id: DesignId) {
    if (!isDesign(id)) return;
    setDesignId(id); setShowDesigns(false); setMenuOpen(false);
    const url = new URL(location.href); url.searchParams.set('design', id); history.replaceState(null, '', url);
    try { localStorage.setItem('tinylens-design-v1', id); } catch { /* Visual preference is optional. */ }
  }

  function chooseStage(id: StageId) { setStageId(id); setTab('results'); setExpanded(false); setMenuOpen(false); }
  function chooseTab(value: WorkbenchTab) { setTab(value); setMenuOpen(false); }
  function viewStageReports() { setTab('results'); setFocusReports(true); setMenuOpen(false); }
  function addPrompt(text: string) { draftTouched.current = true; setDraft(previous => previous.trim() ? `${previous}\n\n${text}` : text); composer.current?.focus(); }
  async function copyPath(path: string) { try { await navigator.clipboard.writeText(path); setCopyNotice('已复制 AI 报告的文件路径。'); } catch { setCopyNotice('无法访问剪贴板，请选中文件路径复制。'); } }

  const selectedResults = selectStageResults(state.updates, stageId);
  const historyAttempts = [...new Map(state.updates.map(update => { const identity = resultIdentity(update); return identity&&identity.attempt!==null ? [identity.key, identity] as const : null; }).filter((item): item is NonNullable<typeof item> => !!item)).values()];
  const displayTitle = (id: StageId) => t(workbenchStageCopy[id]?.title ?? stages.find(stage => stage.id === id)!.title);
  const indicators = stageIndicators(state);
  const closePanel = () => { setShowDesigns(false); setWorkspacePanel(null); };
  return <div className="app-shell demo-workspace live-workbench live-prototype-workbench" data-design={designId} data-demo-language={language}>
    <DemoSidebar live lenses={tasks.map(item=>({...item,...(item.id===defaultLiveTaskId?{}:{kind:'task' as const})}))} selected={task.id} open={menuOpen} onClose={() => setMenuOpen(false)} onSelect={onSelectTask} onNewTask={onNewTask} taskCreationDisabled={taskCreationDisabled} onDelete={() => {}} onTrash={() => {}} deletedCount={0} onHistory={() => setWorkspacePanel('history')} onManual={() => setWorkspacePanel('manual')} onGuide={() => setWorkspacePanel('guide')} design={designId} onDesignChange={chooseDesign}/>
    <div className="workspace"><main className={`main-content${blankWorkspace?' live-task-empty':''}`}>
      {!blankWorkspace&&<div className="workbench-heading"><div className="lens-identity"><h1>{task.name}</h1></div>
        <div ref={stageTrack} className="stage-track" aria-label={t('建模阶段')}>{stages.map(stage => {
          const indicator = indicators.get(stage.id)!;
          const label = indicator.waitingForUser ? '等待你的答复' : stageLabel(indicator.report);
          return <div className="stage-nav-item" key={stage.id}><div className="stage-name-line"><button className={`stage-step ${stage.id === stageId ? 'current' : ''} ${indicator.report?.status === 'accepted' ? 'done' : ''}`} data-stage-status={indicator.state} aria-current={stage.id === stageId ? 'step' : undefined} aria-busy={indicator.state === 'running' || undefined} aria-label={`${stageNavigationTitle(stage)} ${displayTitle(stage.id)}`} aria-description={label} title={label} onClick={() => chooseStage(stage.id)}><span className="step-dot stage-initial">{stage.id === 'preflight' ? 'D' : stage.code}</span><span className="stage-description">{displayTitle(stage.id)}</span></button></div></div>;
        })}</div>
      </div>}
      <div className="workbench-grid">{blankWorkspace?<BlankTaskWorkspace name={taskName} placeholder={t('新任务')} onNameChange={setTaskName} onNameBlur={()=>onRenameTask(taskName)}/>:<StageWorkbench title={displayTitle(stageId)} tab={tab} onTabChange={chooseTab} parameterCount={stageData.parameters.length} toolbarRef={setViewerToolbarTarget} showParameters={stageId!=='preflight'&&stageId!=='b'} showConfig={stageId!=='preflight'&&stageId!=='b'} showPositions={stageId==='preflight'} resultsLabel={stageId==='preflight'?'输入预览':'结果预览'}>
        {stageId==='preflight'&&<>
          <div className="tab-panel" role="tabpanel" aria-label="输入预览" hidden={tab!=='results'}><LivePreflightViewer input={input} toolbarTarget={tab==='results'?viewerToolbarTarget:null} scale={preflightScale} onScaleChange={setPreflightScale}/></div>
          <div className="tab-panel" role="tabpanel" aria-label="位置约束" hidden={tab!=='positions'}><PositionLikelihoodEditor value={positionValue} context={positionContext} onChange={updatePositions} onReplacePrompt={() => updatePositions(positionValue, true)} manualPrompt={positionManual} promptPresent={!!generatedPositionPrompt && !positionManual} disabled={isBusy || action !== null||!!input.loading} toolbarTarget={tab==='positions'?viewerToolbarTarget:null} scale={preflightScale} onScaleChange={setPreflightScale}/></div>
        </>}
        {tab === 'results' && stageId!=='preflight' && <div className="tab-panel" role="tabpanel" aria-label="结果预览">
          {stageId === 'b' ? <LiveMaskEditor report={stageData.reports.summary} threadId={state.threadId??''} summary={stageData.summary} toolbarTarget={viewerToolbarTarget} scale={imageScale} onScaleChange={setImageScale} onPromptChange={updateMaskPrompt} disabled={isBusy||action!==null}/> : <ScienceViewer stageId={stageId} toolbarTarget={viewerToolbarTarget} missingLayers="—" displayPlanes={stageData.modelPlanes} modelResult={stageData.modelResult} imageScale={imageScale} onScaleChange={setImageScale}/>}
        </div>}
        {tab === 'parameters' && <div className="tab-panel" role="tabpanel" aria-label="参数后验"><LiveStageData stage={selectedStage} data={stageData} view="parameters" onDetail={showParameter}/></div>}
        {tab === 'config' && stageId!=='preflight' && stageId!=='b' && <div className="tab-panel" role="tabpanel" aria-label="模型配置"><LiveStageData stage={selectedStage} data={stageData} view="config" onDetail={showParameter} connection={connectionNames[state.connection]}/></div>}
      </StageWorkbench>}
        <ConversationRail aiName="Codex" conversationId={task.id} newTask={blankWorkspace} replyPending={replyPending(state, streamStatus, messages)} connectionAction={state.connection !== 'connected' && <button type="button" className="conversation-connect" disabled={state.connection === 'connecting' || action !== null} onClick={() => void perform('connect')}>{state.connection === 'connecting' ? '连接中' : '连接 AI'}</button>} messages={messages} value={draft} onChange={text=>{draftTouched.current=true;setDraft(text);}} onSubmit={()=>void sendMessage()} textareaId="pipeline-message" inputRef={composer} disabled={!stateReady||state.connection!=='connected'&&!canInitialize||action!==null} busy={isBusy} error={localError??state.error??(taskError||null)??(storageUnavailable?'草稿暂存在页面内':'')} interruptAvailable={isBusy} onInterrupt={()=>perform('interrupt')} attentionCount={openQuestions.length+state.requests.length} attention={(openQuestions.length > 0 || state.requests.length > 0) && <section id="agent-pending-questions" className="agent-question-deck live-attention-deck" aria-label="等待你的决定">
          {openQuestions.map(question => <QuestionCard key={`${question.threadId}:${question.id}`} question={question} connected={state.connection === 'connected'} busy={action !== null || answerLocks.current.has(questionKey(question.id))} onAnswer={answer => answerQuestion(question.id, answer)}/>)}
          {state.requests.map(request => <RequestCard key={`${state.threadId}:${typeof request.id}:${request.id}`} request={request} busy={action !== null || state.connection !== 'connected'} reply={result => perform('reply', { requestId: request.id, result })}/>)}
        </section>}/>
      </div>
    </main></div>
    <ConnectionStatusBar connected={serverLinkConnected(state.connection, streamStatus)}/>
    <dialog ref={dialog} className={`modal modal-${workspacePanel ?? 'design'}`} onCancel={closePanel} onClick={event => { if (event.target === dialog.current) closePanel(); }} aria-labelledby="agent-panel-title"><div className="modal-header"><div>{workspacePanel !== 'parameter' && <span className="eyebrow">TINYLENS WORKSPACE</span>}<h2 id="agent-panel-title">{workspacePanel === 'history' ? `${task.name} 的运行历史` : workspacePanel === 'manual' ? '参数手册' : workspacePanel === 'parameter' ? t(parameter?.name??'') : workspacePanel === 'guide' ? '欢迎来到 TinyLens' : '工作台外观'}</h2></div><button aria-label="关闭窗口" onClick={closePanel}><X size={19}/></button></div><div className="modal-body">
      {workspacePanel === 'manual' && <ParameterManual stages={stages} onSelect={(next, item) => { setStageId(next.id); setParameterKey(item.key); setWorkspacePanel('parameter'); }}/> }
      {workspacePanel === 'parameter' && parameter && <ParameterDetail parameter={parameter} live/>}
      {workspacePanel === 'history' && <div className="run-history branch-history">{historyAttempts.map(item => <div className="branch-entry" key={item.key}><button disabled={selectStageResults(state.updates,item.stage).identity?.key !== item.key} onClick={() => { chooseStage(item.stage as StageId); closePanel(); }}><span className="run-icon"><Layers3 size={19}/></span><div><strong>Stage {item.stage.toUpperCase()} · attempt {item.attempt}</strong><small className="branch-origin">{item.key.split('/').slice(-5, -3).join('/')}</small></div><ChevronRight size={16}/></button></div>)}</div>}
      {workspacePanel === 'guide' && <div className="live-guide-copy"><p>使用与原型相同的 Stage 导航、页签、主题和对话分栏，展示 0946 mock 的真实结果。</p><p>当前展示已有诊断图、参数摘要、带权后验和 M0 证据扫描。缺少的产物先略过；图像及后验不使用合成样例补齐。</p><p>问题与审批位于右侧会话栏。修改意见作为普通消息交给 Pipeline AI，不直接调度科学阶段。</p><p>连接状态：{connectionNames[state.connection]}；{turnNames[state.status]}</p>{state.connection !== 'connected' && <button className="button secondary" onClick={() => void perform('connect')}>连接 Pipeline AI</button>}</div>}
      {showDesigns && <div className="agent-design-options">{designs.map(design => <button key={design.id} onClick={() => chooseDesign(design.id)}>{design.name}</button>)}</div>}
    </div></dialog>
    {copyNotice && <div className="agent-notice" role="status">{copyNotice}</div>}
  </div>;
}

type QuestionSubmission = { status: 'accepted' | 'rejected' | 'unknown'; error?: string };
type QuestionDraft = { optionId: string; text: string; delivery: 'idle' | 'sending' | 'awaiting' | 'unknown' };
const questionDraftKey = (question: AgentQuestion) => `tinylens-question-draft-v1:${encodeURIComponent(question.threadId)}:${encodeURIComponent(question.id)}`;

function readQuestionDraft(question: AgentQuestion): QuestionDraft {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(questionDraftKey(question)) ?? 'null');
    if (value && typeof value === 'object') {
      const stored = value as Record<string, unknown>;
      return { optionId: typeof stored.optionId === 'string' ? stored.optionId : '', text: typeof stored.text === 'string' ? stored.text : '', delivery: ['sending', 'awaiting', 'unknown'].includes(String(stored.delivery)) ? 'unknown' : 'idle' };
    }
  } catch { /* Session storage is optional; keep an editable in-memory draft. */ }
  return { optionId: '', text: '', delivery: 'idle' };
}

function QuestionCard({ question, connected, busy, onAnswer }: { question: AgentQuestion; connected: boolean; busy: boolean; onAnswer: (answer: AgentQuestionAnswer) => Promise<QuestionSubmission> }) {
  const [draft, setDraft] = useState<QuestionDraft>(() => readQuestionDraft(question));
  const [localError, setLocalError] = useState('');
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const submitting = useRef(false);
  const storageKey = questionDraftKey(question);
  const answered = question.status === 'answered';
  const superseded = question.status === 'superseded';
  const archived = answered || superseded;
  const locked = question.status !== 'pending' || draft.delivery !== 'idle';
  const selectedOption = question.options.find(option => option.id === draft.optionId);
  const canSubmit = connected && !busy && !locked && (!!selectedOption || !!draft.text.trim());
  const answerOption = question.options.find(option => option.id === question.answer?.optionId);

  useEffect(() => {
    try {
      if (archived) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageUnavailable(false);
    } catch { setStorageUnavailable(true); }
  }, [draft, archived, storageKey]);

  async function submit() {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setLocalError('');
    setDraft(previous => ({ ...previous, delivery: 'sending' }));
    const result = await onAnswer({ ...(selectedOption ? { optionId: selectedOption.id } : {}), ...(draft.text.trim() ? { text: draft.text } : {}) });
    setDraft(previous => ({ ...previous, delivery: result.status === 'accepted' ? 'awaiting' : result.status === 'unknown' ? 'unknown' : 'idle' }));
    setLocalError(result.error ?? '');
    if (result.status === 'rejected') submitting.current = false;
  }

  const deliveryUnknown = question.status === 'delivery_unknown' || draft.delivery === 'unknown';
  const sending = question.status === 'sending' || draft.delivery === 'sending' || draft.delivery === 'awaiting';
  return <article className={`agent-question-card ${archived ? 'archived' : ''}`} aria-label={question.title}>
    <div className="agent-question-heading"><span><Sparkles size={14}/>Pipeline AI 的问题{question.stage && <small>{question.stage}</small>}</span><span>{superseded ? '已由新版本替代' : answered ? <><Check size={13}/>已答复</> : deliveryUnknown ? '送达待确认' : sending ? <><LoaderCircle size={13} className="agent-spin"/>正在确认答复</> : '等待你的决定'}</span></div>
    <h2>{question.title}</h2>
    <MessageBody text={question.question}/>
    {question.context && <details className="agent-question-context"><summary>AI 提供的背景<ChevronDown size={13}/></summary><MessageBody text={question.context}/></details>}
    {superseded ? <div className="agent-question-superseded"><p>此问题已由新版本替代，原文保留供回看。它没有被提交为用户答复。</p>{question.options.length > 0 && <details><summary>查看原问题的选项</summary><ul>{question.options.map(option => <li key={option.id}><strong>{option.label}</strong>{option.description && <p>{option.description}</p>}</li>)}</ul></details>}</div> : answered ? <div className="agent-question-answer"><strong><Check size={14}/>你的答复</strong>{question.answer?.optionId && <p>{answerOption?.label ?? question.answer.optionId}</p>}{question.answer?.text && <p>{question.answer.text}</p>}{!question.answer?.optionId && !question.answer?.text && <p>AI 会话已确认收到答复。</p>}</div> : <>
      {question.options.length > 0 && <fieldset className="agent-question-options" disabled={locked}><legend>请选择，也可以直接填写其他意见</legend>{question.options.map(option => <label key={option.id} className={selectedOption?.id === option.id ? 'selected' : ''}><input type="radio" name={`question-${question.threadId}-${question.id}`} value={option.id} checked={selectedOption?.id === option.id} onChange={() => setDraft(previous => ({ ...previous, optionId: option.id }))}/><span><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span></label>)}</fieldset>}
      <label className="agent-question-free"><span>补充说明或直接填写答复{selectedOption && <button type="button" disabled={locked} onClick={() => setDraft(previous => ({ ...previous, optionId: '' }))}>取消所选项</button>}</span><textarea rows={3} value={draft.text} maxLength={20000} disabled={locked} onChange={event => setDraft(previous => ({ ...previous, text: event.target.value }))} placeholder="写下你的决定或补充意见；填写不会自动发送。"/></label>
      {(question.error || localError) && <p className="agent-question-error" role="alert">{question.error || localError}</p>}
      {deliveryUnknown && <p className="agent-question-delivery" role="status">答复可能已经发送，送达状态尚未确认。暂时禁止重复提交；此问题不会因 AI 回合结束而自动解决。</p>}
      <div className="agent-question-footer"><span>{!connected ? '连接 Pipeline AI 后可以提交；当前草稿仍会保留。' : storageUnavailable ? '浏览器未允许保存草稿，请暂时保留此页面。' : '选择和草稿保留在本标签页；只有点击提交才会发送。'}</span><button className="agent-button primary" type="button" disabled={!canSubmit} onClick={() => void submit()}>{sending ? <LoaderCircle size={14} className="agent-spin"/> : <Send size={14}/>}提交给 Pipeline AI</button></div>
    </>}
  </article>;
}

function MessageBody({ text }: { text: string }) {
  return <div className="agent-message-text">{messageBlocks(text.replace(/\r\n?/g, '\n').split('\n'))}</div>;
}

function messageInline(text: string, depth = 0): ReactNode[] {
  if (depth > 8) return [text];
  const parts: ReactNode[] = [];
  const tokens = /(`[^`\n]+`|\*\*.+?\*\*|__.+?__|\[[^\]\n]+\]\([^\n)]*\))/g;
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index!;
    if (index > end) parts.push(text.slice(end, index));
    const token = match[0];
    if (token.startsWith('`')) parts.push(<code key={index}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) parts.push(<strong key={index}>{messageInline(token.slice(2, -2), depth + 1)}</strong>);
    else {
      const link = /^\[([^\]\n]+)\]\((.*)\)$/.exec(token)!;
      const label = messageInline(link[1], depth + 1);
      const destination = link[2].trim().replace(/^<(.*)>$/, '$1');
      let webLink = false;
      try { const url = new URL(destination); webLink = url.protocol === 'http:' || url.protocol === 'https:'; } catch { /* Non-web references remain inert. */ }
      if (webLink) parts.push(<a key={index} href={destination} target="_blank" rel="noopener noreferrer">{label}</a>);
      else if (destination.startsWith('/') && !destination.startsWith('//')) parts.push(<MessagePath key={index} path={destination}>{label}</MessagePath>);
      else parts.push(<span key={index}>{label} ({destination})</span>);
    }
    end = index + token.length;
  }
  if (end < text.length) parts.push(text.slice(end));
  return parts;
}

function MessagePath({ path, children }: { path: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(path); setCopied(true); }
    catch { setCopied(false); }
  }
  return <span className="agent-inline-reference"><button type="button" title={`远程文件路径：${path}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{children}<FileText size={11}/></button>{expanded && <span className="agent-inline-reference-path"><span>AI 提供的远程文件路径</span><code>{path}</code><button type="button" onClick={copy}>{copied ? '已复制路径' : '复制路径'}</button></span>}</span>;
}

/** A small React-only Markdown renderer: raw HTML is always ordinary text. */
function messageBlocks(lines: string[], depth = 0): ReactNode[] {
  if (depth > 8) return [<p key="plain">{lines.join('\n')}</p>];
  const blocks: ReactNode[] = [];
  const listMatch = (line: string) => /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  const startsBlock = (line: string) => /^ {0,3}(?:`{3,}|~{3,}|#{1,6}\s|>\s?)/.test(line) || !!listMatch(line);
  let index = 0;
  while (index < lines.length) {
    const key = index;
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index++;
      const closes = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (index < lines.length && !closes.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push(<h3 key={key} className="agent-message-heading">{messageInline(heading[2])}</h3>); index++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}>\s?/, ''));
      blocks.push(<blockquote key={key}>{messageBlocks(quote, depth + 1)}</blockquote>);
      continue;
    }
    const firstItem = listMatch(line);
    if (firstItem) {
      const indent = firstItem[1].length;
      const ordered = /^\d/.test(firstItem[2]);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const itemKey = index;
        const content = [item[3]];
        index++;
        while (index < lines.length) {
          const nextItem = listMatch(lines[index]);
          if (nextItem && nextItem[1].length <= indent) break;
          if (!lines[index].trim()) {
            let next = index + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const following = next < lines.length ? listMatch(lines[next]) : null;
            const continuation = next < lines.length && /^ */.exec(lines[next])![0].length > indent;
            if (following && following[1].length === indent) { index = next; break; }
            if (!continuation) break;
          }
          if (startsBlock(lines[index]) && /^ */.exec(lines[index])![0].length <= indent) break;
          content.push(lines[index++].replace(new RegExp(`^ {0,${indent + 2}}`), ''));
        }
        items.push(<li key={itemKey} value={ordered ? Number.parseInt(item[2], 10) : undefined}>{messageBlocks(content, depth + 1)}</li>);
      }
      blocks.push(ordered ? <ol key={key} start={Number.parseInt(firstItem[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={key}>{messageInline(paragraph.join('\n'))}</p>);
  }
  return blocks;
}

function ActivityCard({ activity }: { activity: AgentActivity }) {
  const live = ['running', 'inProgress', 'in_progress', 'started'].includes(activity.status);
  return <details className="agent-activity"><summary><span className={`agent-activity-dot ${live ? 'active' : ''}`}/><span className="agent-activity-title">{activity.title}</span><span className="agent-activity-status">{live ? '进行中' : ({ completed: '已结束', complete: '已结束', failed: '失败', declined: '已拒绝', pending: '等待' }[activity.status] ?? activity.status)}</span><ChevronDown size={13}/></summary><div className="agent-activity-detail"><div><span>活动类型</span><code>{activity.type}</code></div>{activity.detail && <pre>{activity.detail}</pre>}{activity.output ? <pre className="agent-activity-output">{activity.output}</pre> : <p>本条活动尚未返回输出。</p>}</div></details>;
}

function ReportCard({ update, copyPath }: { update: AgentUpdate; copyPath: (path: string) => void }) {
  return <article className={`agent-report report-${update.kind}`}><div><span>{update.kind === 'artifact' ? '产物引用' : update.kind === 'stage' ? `阶段 ${update.stage ?? ''}` : 'AI 说明'}</span>{update.status && <small>{stageNames[update.status] ?? update.status}</small>}</div>{update.title && <h3>{update.title}</h3>}{update.message && <p>{update.message}</p>}{update.at && <time dateTime={update.at}>{reportTime(update.at)}</time>}{update.path && <><code className="agent-path">{update.path}</code><button onClick={() => copyPath(update.path!)}>复制 AI 提供的路径</button></>}</article>;
}

type InputQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[] };
function requestQuestions(request: AgentRequest): InputQuestion[] {
  const questions = request.params.questions;
  if (!Array.isArray(questions)) return [];
  return questions.filter(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.question === 'string').map(item => ({ id: item.id, header: typeof item.header === 'string' ? item.header : '', question: item.question, options: Array.isArray(item.options) ? item.options.filter((option: unknown): option is { label: string; description?: unknown } => !!option && typeof option === 'object' && 'label' in option && typeof option.label === 'string').map((option: { label: string; description?: unknown }) => ({ label: option.label, description: typeof option.description === 'string' ? option.description : '' })) : [] }));
}

function RequestCard({ request, busy, reply }: { request: AgentRequest; busy: boolean; reply: (result: Record<string, unknown>) => Promise<boolean> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const responding = useRef(false);
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval'].includes(request.method);
  const userInput = ['item/tool/requestUserInput', 'requestUserInput'].includes(request.method);
  const questions = userInput ? requestQuestions(request) : [];
  const oneTimeDecisions = ['accept', 'decline', 'cancel'] as const;
  const offeredDecisions = request.params.availableDecisions;
  // Match the existing server's one-time decisions. An explicit list is
  // authoritative; do not add choices or expose session/policy amendments.
  const approvalDecisions = offeredDecisions == null ? [...oneTimeDecisions]
    : Array.isArray(offeredDecisions) ? oneTimeDecisions.filter(decision => offeredDecisions.includes(decision)) : [];
  const disabled = busy || submitted;
  async function respond(result: Record<string, unknown>) {
    if (disabled || responding.current) return;
    responding.current = true;
    if (await reply(result)) setSubmitted(true);
    else responding.current = false;
  }
  return <section className="agent-request"><div className="agent-request-heading"><CircleHelp size={17}/><h3>{approval ? 'AI 请求你的批准' : userInput ? 'AI 需要你的判断' : '待支持的 AI 请求'}</h3>{submitted && <span>答复已发送</span>}</div>
    {approval ? <><p>请检查本次操作。批准仅适用于这一次请求。</p><ApprovalSummary request={request}/><div className="agent-request-actions">{approvalDecisions.map(decision => <button key={decision} className={`agent-button ${{ accept: 'primary', decline: 'secondary', cancel: 'quiet' }[decision]}`} disabled={disabled} onClick={() => respond({ decision })}>{{ accept: '批准这一次', decline: '拒绝', cancel: '取消请求' }[decision]}</button>)}</div>{!approvalDecisions.length && <p className="agent-approval-unavailable">当前请求没有可用的单次决定选项；不会自动批准。</p>}</> : userInput && questions.length ? <form onSubmit={event => { event.preventDefault(); const result = Object.fromEntries(questions.map(question => [question.id, { answers: [answers[question.id].trim()] }])); void respond({ answers: result }); }}>{questions.map(question => <fieldset key={question.id}><legend>{question.header && <small>{question.header} · </small>}{question.question}</legend>{question.options.map(option => <label className="agent-answer-option" key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} disabled={disabled}/><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<label className="agent-answer-free"><span>你的答复</span><input value={answers[question.id] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} disabled={disabled} placeholder="选择上面的选项，或直接填写" required/></label></fieldset>)}<button className="agent-button primary" type="submit" disabled={disabled || questions.some(question => !answers[question.id]?.trim())}>提交答复</button></form> : <><p>前端尚不支持处理这个请求；不会自动批准或代填答复。</p><code>{request.method}</code><details><summary>查看原始请求</summary><pre>{jsonText(request.params)}</pre></details></>}
  </section>;
}


function ApprovalSummary({ request }: { request: AgentRequest }) {
  const params = request.params;
  const commandApproval = ['item/commandExecution/requestApproval', 'execCommandApproval'].includes(request.method);
  const hasCommand = typeof params.command === 'string' || Array.isArray(params.command);
  // Keep unfamiliar/file-change operations fully visible; a command summary
  // must never hide the changes a user is being asked to approve.
  if (!commandApproval || !hasCommand) return <pre>{jsonText(params)}</pre>;
  const originalText = (value: unknown) => typeof value === 'string' ? value : jsonText(value);
  return <div className="agent-approval-summary">
    {params.reason != null && <div className="agent-approval-reason"><strong>请求原因</strong><p>{originalText(params.reason)}</p></div>}
    <div className="agent-approval-command"><strong>执行命令</strong><pre><code>{originalText(params.command)}</code></pre></div>
    <div className="agent-approval-cwd"><strong>工作目录</strong><code>{params.cwd != null ? originalText(params.cwd) : 'AI 未提供工作目录'}</code></div>
    {params.additionalPermissions != null && <div className="agent-approval-permissions"><strong>请求的附加权限</strong><pre>{originalText(params.additionalPermissions)}</pre></div>}
    {params.networkApprovalContext != null && <div className="agent-approval-permissions"><strong>网络访问说明</strong><pre>{originalText(params.networkApprovalContext)}</pre></div>}
    <details className="agent-approval-metadata"><summary>查看完整请求与技术信息<ChevronDown size={13}/></summary><pre>{jsonText(params)}</pre></details>
  </div>;
}
