import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp, FileText, FolderOpen, LayoutDashboard, Link2, LoaderCircle, Menu, MessageSquare, Orbit, Radio, Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, X } from 'lucide-react';
import { DesignPicker } from './DesignPicker';
import { designs, isDesign, readDesign, type DesignId } from '../lib/designs';
import { stages, type StageId, type Parameter } from '../data/stages';
import { EMPTY_AGENT_STATE, parseAgentState, type AgentActivity, type AgentQuestion, type AgentRequest, type AgentState, type AgentUpdate } from '../lib/agent-types';
import { postMessageSubmission, restoreMessageSubmissions, type MessageDelivery, type MessageSubmission } from '../lib/message-delivery';
import { questionAnswerControls, restoreQuestionDraft, type QuestionDraft, type QuestionSubmission } from '../lib/question-answer';
import PositionLikelihoodEditor from './PositionLikelihoodEditor';
import ConversationRail from './ConversationRail';
import ConnectionStatusBar from './ConnectionStatusBar';
import { stageIndicators, serverLinkConnected, replyPending } from '../lib/workbench-status';
import DemoSidebar from './DemoSidebar';
import DeletedTaskList from './DeletedTaskList';
import LiveRunHistory, { useLiveRunHistory } from './LiveRunHistory';
import LiveStageData, { useLiveStageData } from './LiveStageData';
import StageWorkbench from './StageWorkbench';
import WorkbenchTaskName from './WorkbenchTaskName';
import ScienceViewer from './ScienceViewer';
import LivePreflightViewer from './LivePreflightViewer';
import { useReportedInput } from '../lib/use-reported-input';
import {useImageScale} from '../lib/use-image-scale';
import { inputPositionContext, positionContextForTarget, positionDraftForInput } from '../lib/input-position-context';
import LiveMaskEditor from './LiveMaskEditor';
import { RawResults } from './StageArtifactViews';
import { FinalParameterCard, ModelingComment } from './ModelingCompletion';
import { preflightImageReports, useStageView, type MaskLayerName } from '../lib/stage-artifacts';
import { useVerifiedCompletion } from '../lib/verified-completion';
import {mergeMaskPrompt} from '../lib/mask-user-input';
import ParameterManual from './ParameterManual';
import BlankTaskWorkspace from './BlankTaskWorkspace';
import { agentTaskUrl, defaultLiveTaskId, liveTaskPreferenceKey, type LiveTask, type TaskDeletionPlan } from '../lib/live-tasks';
import { stageDisplayCandidates } from '../lib/live-results';
import { BatchPlanCard } from './BatchWorkspace';
import { catalogParameters } from '../lib/parameter-catalog';
import { ParameterDetail } from './ParameterTable';
import { attemptStatus, stageAttempts } from '../lib/stage-attempts';
import { useDemoI18n } from '../lib/demo-i18n';
import { stageNavigationTitle, supportsStageTab, workbenchStageCopy, type StageTab } from '../lib/stage-navigation';
import { emptyPositionDraft, mergePositionPrompt, positionError, positionPrompt, restorePositionDraft, type PositionContext, type PositionDraft } from '../lib/position-likelihood';
import './agent-workspace.css';
import './live-workbench.css';

const connectionNames = { disconnected: '尚未连接', connecting: '正在连接', connected: 'AI 已连接', error: '连接异常' };
const turnNames = { idle: '等待你的指令', running: 'AI 正在处理', waiting: '等待你的答复', completed: 'AI 回合已结束', failed: 'AI 回合异常', interrupted: 'AI 回合已中断' };
const stageNames: Record<string, string> = { pending: '等待', not_started: '尚未开始', running: '运行中', preparing: '准备中', prepared: '准备完成', awaiting_review: '等待审查', reviewing: '审查中', accepted: '已接受', executed: '执行完成', failed: '失败', human_review: '需要人工判断', retry: '重试', interrupted: '已中断', blocked: '受阻', preparation_blocked: '准备受阻', paused: '已暂停', queued: '等待资源', awaiting_user: '等待你的答复', awaiting_input: '等待你的答复', awaiting_approval: '等待批准', waiting: '等待你的答复', retrying: '正在重试', rejected: '未通过审查' };
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
function readPreferences(taskId?: string): { stageId: StageId; draft?: string; position?: PositionDraft; positionPrompt?: string;maskPrompt?:string } {
  try {
    const saved = taskId ? JSON.parse(localStorage.getItem(liveTaskPreferenceKey(taskId)) ?? 'null') : null;
    if (saved && typeof saved === 'object') return {
      stageId: stages.some(stage => stage.id === saved.stageId) ? saved.stageId : 'preflight',
      draft: typeof saved.draft === 'string' ? saved.draft : undefined,
      position: restorePositionDraft(saved.position),
      positionPrompt: typeof saved.positionPrompt === 'string' ? saved.positionPrompt : undefined,
      maskPrompt:typeof saved.maskPrompt==='string'?saved.maskPrompt:undefined,
    };
  } catch { /* The workspace remains usable when storage is unavailable. */ }
  return { stageId: 'preflight' };
}
const reportKey = (update: AgentUpdate, index: number) => update.id ?? `${index}-${update.kind}-${update.path ?? update.title ?? ''}`;
const stageLabel = (update?: AgentUpdate) => update ? stageNames[attemptStatus(update.status)] ?? update.status ?? 'AI 已报告' : 'AI 尚未报告';
const reportTime = (time?: string) => time && Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : time;

function StageNavigationLabel({ title, chinese }: { title: string; chinese: boolean }) {
  const midpoint = Math.ceil(title.length / 2);
  return <span className="stage-description" data-characters={chinese ? title.length : undefined}>{chinese && title.length > 3 ? <>
    <span className="stage-label-line">{title.slice(0, midpoint)}</span>
    <span className="stage-label-line">{title.slice(midpoint)}</span>
  </> : title}</span>;
}

function initialDesign(): DesignId {
  const requested = new URLSearchParams(location.search).get('design');
  if (isDesign(requested)) return requested;
  try { if (localStorage.getItem('tinylens-design-v1')) return readDesign(); } catch { /* Optional preference. */ }
  return 'studio';
}

export default function AgentWorkspace({ task, tasks, deletedTasks, taskError, taskListPending, taskCreationDisabled, onNewTask, onSelectTask, onRenameTask, onDeleteTask, onRestoreTask, onGetTaskDeletionPlan, onPermanentlyDeleteTask, onTaskActivity, onVisibleTasks, onBatches, batchPanel }: {
  task?: LiveTask; tasks: (LiveTask & { image?: string; openDisabled?: boolean })[]; deletedTasks: LiveTask[]; taskError: string; taskListPending?: boolean; taskCreationDisabled: boolean;
  onNewTask: () => void; onSelectTask: (id: string) => void; onRenameTask: (id: string, name: string) => Promise<void>;
  onDeleteTask: (id: string) => void; onRestoreTask: (id: string) => void;
  onGetTaskDeletionPlan: (id: string, signal: AbortSignal) => Promise<TaskDeletionPlan>;
  onPermanentlyDeleteTask: (id: string, token: string) => Promise<void>;
  onTaskActivity: () => void;
  onVisibleTasks: (ids: ReadonlySet<string>) => void;
  onBatches: (id?: string) => void; batchPanel?: ReactNode;
}) {
  const { t, language } = useDemoI18n();
  const taskId = task?.id;
  const preferenceKey = taskId ? liveTaskPreferenceKey(taskId) : undefined;
  const api = (path: string) => {
    if (!taskId) throw new Error('请先打开一个任务。');
    return agentTaskUrl(path, taskId);
  };
  const [stateReady, setStateReady] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<'history' | 'guide' | 'manual' | 'parameter' | 'trash' | null>(null);
  const [state, setState] = useState<AgentState>(() => taskId === defaultLiveTaskId ? EMPTY_AGENT_STATE : { ...EMPTY_AGENT_STATE, datasetPath: '' });
  const [viewerToolbarTarget, setViewerToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [parameterKey, setParameterKey] = useState('');
  const [savedPreferences] = useState(() => readPreferences(taskId));
  const submissionKey = taskId && `tinylens-message-submissions-v1:${taskId}`;
  const [submissions] = useState(() => {
    try { return restoreMessageSubmissions(submissionKey ? sessionStorage.getItem(submissionKey) : null); }
    catch { return restoreMessageSubmissions(null); }
  });
  const recoveredDraft = [...submissions.keys()].at(-1);
  const [draft, setDraft] = useState(savedPreferences.draft ?? recoveredDraft ?? '');
  const draftValue = useRef(draft);
  draftValue.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const stateSequence = useRef(0);
  const answerInFlight = useRef(false);
  const messageSending = useRef(false);
  const [position, setPosition] = useState<PositionDraft>(savedPreferences.position ?? emptyPositionDraft());
  const [generatedPositionPrompt, setGeneratedPositionPrompt] = useState(savedPreferences.positionPrompt ?? '');
  const [generatedMaskPrompt,setGeneratedMaskPrompt]=useState(savedPreferences.maskPrompt??'');
  const draftTouched = useRef(savedPreferences.draft !== undefined || recoveredDraft !== undefined);
  const initialStateLoaded = useRef(false);
  const [stageId, setStageId] = useState<StageId>(savedPreferences.stageId);
  const [showComment, setShowComment] = useState(false);
  const [tab, setTab] = useState<StageTab>('results');
  const [selectedMasks, setSelectedMasks] = useState<MaskLayerName[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [focusReports, setFocusReports] = useState(false);
  const stageReportPanel = useRef<HTMLElement>(null);
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
  const [historyAttempt, setHistoryAttempt] = useState<string>();
  const resultReports = state.updates.filter(update => !update.threadId || update.threadId === state.threadId);
  const attempts = stageAttempts(resultReports);
  const runHistory = useLiveRunHistory(taskId, state.threadId, resultReports, workspacePanel === 'history');
  const stageData = useLiveStageData(selectedStage, resultReports, historyAttempt, tab === 'config');
  const completion = useVerifiedCompletion(taskId, attempts, resultReports);
  const assetReport = stageData.reports.published ?? stageData.reports.declaration ?? stageData.reports.summary;
  // Raw image reports can arrive without changing the loaded numerical result.
  const preflightSelection = tab === 'raw' && stageId === 'preflight' && stageData.reports.identity
    ? stageDisplayCandidates(resultReports, 'preflight', stageData.reports.identity.key)[0] : undefined;
  const rawReport = stageId === 'preflight' ? preflightSelection?.published ?? preflightSelection?.declaration : assetReport;
  const directPreflightReports = !rawReport && preflightSelection?.identity
    ? preflightImageReports(preflightSelection.images, preflightSelection.identity) : undefined;
  const showMaskControls = ['a', 'm0', 'm1', 'm2', 'm3'].includes(stageId);
  const layers = useStageView('mask_layers', !showComment && tab === 'results' && showMaskControls ? assetReport : undefined);
  function updateMaskLayer(name: MaskLayerName, enabled: boolean) {
    setSelectedMasks(previous => enabled ? [...new Set([...previous, name])] : previous.filter(item => item !== name));
  }
  const viewed = attempts.find(item => item.identity.key === stageData.reports.identity?.key);
  const parameter = stageData.parameterDetails.find(item => item.key === parameterKey)??catalogParameters(selectedStage).find(item=>item.key===parameterKey);
  const showParameter = (item: Parameter) => { setParameterKey(item.key); setWorkspacePanel('parameter'); };
  const input = useReportedInput(resultReports, stageId === 'preflight', historyAttempt ?? (viewed?.identity.runId ? viewed.identity.key : undefined),
    stageId === 'preflight' ? stageData.reports.published : undefined, stageData.reports.legacyReadable);
  const [imageScale,setImageScale]=useImageScale('live',taskId===defaultLiveTaskId?undefined:taskId??null);
  function updateMaskPrompt(next:string){draftTouched.current=true;setDraft(previous=>mergeMaskPrompt(previous,generatedMaskPrompt,next));setGeneratedMaskPrompt(next);}
  const inputContext=inputPositionContext(input.display,input.report,state.datasetPath,imageScale);
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
  const steerTurnId = state.connection === 'connected' && state.status === 'running' ? state.turnId : null;
  const showTaskWelcome = !!taskId && taskId !== defaultLiveTaskId && !task?.lastConversationAt
    && state.messages.length === 0 && state.updates.length === 0 && state.questions.length === 0 && state.requests.length === 0;
  const blankWorkspace = !taskId || showTaskWelcome;
  const canInitialize = !!taskId && stateReady && taskId !== defaultLiveTaskId && !state.threadId && state.messages.length === 0;
  const messages = state.messages.filter(message => !hiddenReasoning(message.phase));
  const deliveryLabels = { pending: '等待送达确认', unknown: '送达待确认', rejected: '未送达', delivered: undefined };
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
  const messageReceipts = new Map(messages.filter(item => item.role === 'user').map(item => [item.id, item.delivery]));

  function storeSubmissions() {
    if (!submissionKey) return;
    try {
      if (submissions.size) sessionStorage.setItem(submissionKey, JSON.stringify([...submissions.values()]));
      else sessionStorage.removeItem(submissionKey);
    } catch { /* The current page retains the submission when storage is unavailable. */ }
  }

  function settleSubmission(submission: MessageSubmission, delivery: MessageDelivery) {
    if (delivery !== 'delivered' && delivery !== 'rejected') return;
    if (submissions.get(submission.text)?.clientMessageId !== submission.clientMessageId) return;
    submissions.delete(submission.text);
    storeSubmissions();
    if (delivery === 'rejected') return;
    draftTouched.current = true;
    try {
      if (preferenceKey) {
        const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
        if (saved?.draft === submission.text) localStorage.setItem(preferenceKey, JSON.stringify({ ...saved, draft: '', positionPrompt: '' }));
      }
    } catch { /* The in-memory draft also follows the receipt. */ }
    setDraft(previous => previous === submission.text ? '' : previous);
    if (draftValue.current === submission.text) { setGeneratedPositionPrompt(''); setLocalError(null); }
    onTaskActivity();
  }

  function receiveState(next: AgentState) {
    stateSequence.current += 1;
    for (const submission of submissions.values()) {
      const message = next.messages.find(item => item.id === submission.clientMessageId && item.role === 'user');
      if (message?.delivery) settleSubmission(submission, message.delivery);
    }
    try {
      for (const question of next.questions) if (question.status === 'answered' || question.status === 'superseded') {
        sessionStorage.removeItem(questionDraftKey(question));
      }
    } catch { /* Archived questions stay read-only when storage is unavailable. */ }
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
    if (!taskId) return;
    const abort = new AbortController();
    let sawEvent = false;
    let active = true;
    const events = new EventSource(api('/api/agent/events'));
    events.addEventListener('task-name', () => { if (active) onTaskActivity(); });
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
  }, [taskId, onTaskActivity]);

  useEffect(() => { document.title = task ? `TinyLens · ${task.name}` : 'TinyLens'; }, [task?.name]);

  useEffect(() => { const openManual = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); setWorkspacePanel('manual'); } }; window.addEventListener('keydown', openManual); return () => window.removeEventListener('keydown', openManual); }, []);
  useEffect(() => { if (showDesigns || workspacePanel) dialog.current?.showModal(); else dialog.current?.close(); }, [showDesigns, workspacePanel]);
  useEffect(() => { if (pinConversation.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [state.messages, tab]);
  useEffect(() => {
    if (!preferenceKey) return;
    try { localStorage.setItem(preferenceKey, JSON.stringify({ stageId, draft, position, positionPrompt: generatedPositionPrompt,maskPrompt:generatedMaskPrompt })); setStorageUnavailable(false); }
    catch { setStorageUnavailable(true); }
  }, [preferenceKey, stageId, draft, position, generatedPositionPrompt,generatedMaskPrompt]);
  useEffect(() => { if (!copyNotice) return; const timeout = setTimeout(() => setCopyNotice(''), 3500); return () => clearTimeout(timeout); }, [copyNotice]);
  useEffect(() => {
    if (tab !== 'results' || !focusReports) return;
    stageReportPanel.current?.focus({ preventScroll: true });
    stageReportPanel.current?.scrollIntoView({ block: 'start' });
    setFocusReports(false);
  }, [tab, focusReports]);

  async function perform(name: string, body: Record<string, unknown> = {}, onState?: (next: AgentState) => void) {
    if (!taskId || action) return false;
    setAction(name); setLocalError(null);
    const sequence = stateSequence.current;
    try {
      const response = await fetch(api(`/api/agent/${name}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : null;
        throw new Error(typeof failure === 'string' ? failure : `AI 会话请求未完成（${response.status}）。`);
      }
      // Actions may return the state directly, or only acknowledge the request.
      if (payload && typeof payload === 'object' && 'connection' in payload) {
        const next = parseAgentState(payload);
        if (sequence === stateSequence.current) receiveState(next);
        onState?.(next);
      }
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'AI 会话请求失败。');
      return false;
    } finally { setAction(null); }
  }

  async function sendMessage() {
    const text = draft;
    if (!preferenceKey || !text.trim() || !stateReady || state.connection !== 'connected' && !canInitialize
        || action || messageSending.current || (isBusy && !steerTurnId)) return;
    pinConversation.current = true;
    messageSending.current = true;
    try {
      let threadId = state.threadId;
      if (state.connection !== 'connected' && !await perform('connect', {}, next => { threadId = next.threadId; })) return;
      if (!threadId || !mounted.current) return;
      const submission = submissions.get(text) ?? { clientMessageId: crypto.randomUUID(), text, expectedThreadId: threadId,
        expectedTurnId: steerTurnId, seenBatchPlanId: state.batchPlan?.status === 'preview' ? state.batchPlan.id : undefined };
      submissions.set(text, submission);
      storeSubmissions();
      setAction('message'); setLocalError(null);
      const sequence = stateSequence.current;
      const receipt = await postMessageSubmission(api('/api/agent/message'), submission);
      if (!mounted.current) return;
      if (submissions.get(text)?.clientMessageId === submission.clientMessageId) {
        settleSubmission(submission, receipt.delivery);
        if (receipt.delivery !== 'delivered') setLocalError(receipt.error || '消息正在等待送达确认。');
      }
      if (receipt.state && sequence === stateSequence.current) receiveState(parseAgentState(receipt.state));
    } catch (error) {
      if (mounted.current) setLocalError(error instanceof Error ? error.message : 'AI 消息提交未完成。');
    } finally { messageSending.current = false; if (mounted.current) setAction(null); }
  }

  async function answerQuestion(submission: QuestionSubmission): Promise<AnswerReceipt> {
    if (action || answerInFlight.current) return { delivery: 'unknown', error: '已有提交正在处理，请稍后重试原答复。' };
    answerInFlight.current = true;
    setAction('answer');
    const sequence = stateSequence.current;
    try {
      const receipt = await postMessageSubmission(api('/api/agent/answer'), submission);
      if (mounted.current && receipt.state && sequence === stateSequence.current) {
        try { receiveState(parseAgentState(receipt.state)); }
        catch { /* A matching receipt still applies if the state snapshot cannot be read. */ }
      }
      return receipt;
    } finally { answerInFlight.current = false; if (mounted.current) setAction(null); }
  }

  function chooseDesign(id: DesignId) {
    if (!isDesign(id)) return;
    setDesignId(id); setShowDesigns(false); setMenuOpen(false);
    const url = new URL(location.href); url.searchParams.set('design', id); history.replaceState(null, '', url);
    try { localStorage.setItem('tinylens-design-v1', id); } catch { /* Visual preference is optional. */ }
  }

  function chooseStage(id: StageId, attempt?: string) {
    setShowComment(false);
    setHistoryAttempt(attempt);
    setStageId(id);
    setTab(current => supportsStageTab(id, current) ? current : 'results');
    setExpanded(false);
    setMenuOpen(false);
  }
  function chooseTab(value: StageTab) { setTab(value); setMenuOpen(false); }
  function viewStageReports() { setTab('results'); setFocusReports(true); setMenuOpen(false); }
  function addPrompt(text: string) { draftTouched.current = true; setDraft(previous => previous.trim() ? `${previous}\n\n${text}` : text); composer.current?.focus(); }
  async function copyPath(path: string) { try { await navigator.clipboard.writeText(path); setCopyNotice('已复制 AI 报告的文件路径。'); } catch { setCopyNotice('无法访问剪贴板，请选中文件路径复制。'); } }

  const displayTitle = (id: StageId) => t(workbenchStageCopy[id]?.title ?? stages.find(stage => stage.id === id)!.title);
  const indicators = stageIndicators(state);
  const closePanel = () => { setShowDesigns(false); setWorkspacePanel(null); };
  const batchPlan = state.batchPlan;
  const conversation = <ConversationRail aiName="Codex" conversationId={taskId} composerOnly={showTaskWelcome}
    newTask={blankWorkspace} inactive={!taskId} replyPending={replyPending(state, streamStatus, messages)}
    connectionAction={taskId && state.connection !== 'connected' && <button type="button" className="conversation-connect"
      disabled={state.connection === 'connecting' || action !== null} onClick={() => void perform('connect')}>
      {state.connection === 'connecting' ? '连接中' : '连接 AI'}
    </button>}
    messages={messages.map(message => message.role === 'user' && message.delivery ? { ...message, note: deliveryLabels[message.delivery] } : message)}
    finalResult={completion.value && <FinalParameterCard {...completion}/>}
    value={draft} onChange={text => { draftTouched.current = true; setDraft(text); }}
    onSubmit={() => void sendMessage()} textareaId="pipeline-message" inputRef={composer}
    disabled={!stateReady || state.connection !== 'connected' && !canInitialize || action !== null} busy={isBusy} steerAvailable={!!steerTurnId}
    error={localError ?? state.error ?? (taskId ? taskError || null : null) ?? (storageUnavailable ? '草稿暂存在页面内' : '')}
    interruptAvailable={!!state.turnId} onInterrupt={() => perform('interrupt', { expectedThreadId: state.threadId, expectedTurnId: state.turnId })}
    attentionCount={openQuestions.length + state.requests.length + (batchPlan ? 1 : 0)}
    attention={(batchPlan || openQuestions.length > 0 || state.requests.length > 0) && <>
      {batchPlan && <BatchPlanCard plan={batchPlan} onProgress={() => onBatches(batchPlan.id)}/>}
      {(openQuestions.length > 0 || state.requests.length > 0) && <section id="agent-pending-questions" className="agent-question-deck live-attention-deck" aria-label="等待你的决定">
      {openQuestions.map(question => <QuestionCard key={`${question.threadId}:${question.id}`} question={question}
        connected={state.connection === 'connected'} busy={action !== null} messageReceipts={messageReceipts} onAnswer={answerQuestion}/>)}
      {state.requests.map(request => <RequestCard key={request.replyId ?? `${state.threadId}:${typeof request.id}:${request.id}`}
        request={request} busy={action !== null || state.connection !== 'connected'} reply={result => perform('reply', { replyId: request.replyId, result })}/>)}
      </section>}
    </>}/>;
  return <div className="app-shell demo-workspace live-workbench live-prototype-workbench" data-design={designId} data-demo-language={language} data-task-welcome={showTaskWelcome || undefined}>
    <DemoSidebar live lenses={tasks.map(item=>({...item,...(item.id===defaultLiveTaskId?{}:{kind:'task' as const})}))} selected={taskId ?? ''} open={menuOpen} onClose={() => setMenuOpen(false)} onSelect={onSelectTask} onNewTask={onNewTask} onRename={onRenameTask} taskCreationDisabled={taskCreationDisabled} onDelete={onDeleteTask} onTrash={() => setWorkspacePanel('trash')} deletedCount={deletedTasks.length} onHistory={() => setWorkspacePanel(taskId ? 'history' : 'trash')} onManual={() => setWorkspacePanel('manual')} onGuide={() => setWorkspacePanel('guide')} onBatches={onBatches} onVisibleTasks={onVisibleTasks} design={designId} onDesignChange={chooseDesign}/>
    <div className="workspace"><main className="main-content">
      {task&&<div className="workbench-heading"><div className="lens-identity"><WorkbenchTaskName name={task.name}/></div>
        {!blankWorkspace&&<nav className="stage-track" aria-label={t('建模阶段')}>{stages.map(stage => {
          const indicator = indicators.get(stage.id)!;
          const label = indicator.waitingForUser ? '等待你的答复' : stageLabel(indicator.report);
          const title = displayTitle(stage.id);
          return <div className="stage-nav-item" key={stage.id}><div className="stage-name-line"><button className={`stage-step ${!showComment && stage.id === stageId ? 'current' : ''} ${indicator.report?.status === 'accepted' ? 'done' : ''}`} data-stage-status={indicator.state} aria-current={!showComment && stage.id === stageId ? 'step' : undefined} aria-busy={indicator.state === 'running' || undefined} aria-label={`${stageNavigationTitle(stage)} ${title}`} aria-description={label} title={label} onClick={() => chooseStage(stage.id)}><span className="step-dot stage-initial">{stage.id === 'preflight' ? 'D' : stage.code}</span><StageNavigationLabel title={title} chinese={language === 'zh'}/></button></div></div>;
        })}<div className="stage-nav-item"><div className="stage-name-line"><button type="button"
          className={`stage-step ${showComment ? 'current' : ''} ${completion.value?.comment || completion.value?.stage_comments ? 'done' : ''}`} aria-current={showComment ? 'step' : undefined}
          aria-label={t('建模点评')} onClick={() => { setShowComment(true); setMenuOpen(false); }}>
          <span className="step-dot stage-initial"><MessageSquare size={14}/></span><StageNavigationLabel title={t('建模点评')} chinese={language === 'zh'}/>
        </button></div></div></nav>}
      </div>}
      <div className="workbench-grid">{blankWorkspace?<BlankTaskWorkspace composer={showTaskWelcome ? conversation : undefined} onCreate={taskId ? undefined : onNewTask} createDisabled={taskCreationDisabled} taskStatus={taskError || (taskListPending ? '正在加载任务…' : undefined)}/>:showComment ? <ModelingComment {...completion} stageTitle={displayTitle}/> : <StageWorkbench stageId={stageId} title={displayTitle(stageId)} tab={tab} onTabChange={chooseTab} parameterCount={stageData.parameters.length} toolbarRef={setViewerToolbarTarget} rawResults>
        {stageId==='preflight'&&<>
          <div className="tab-panel" role="tabpanel" aria-label="输入预览" hidden={tab!=='results'}><LivePreflightViewer input={input} toolbarTarget={tab==='results'?viewerToolbarTarget:null} scale={imageScale} onScaleChange={setImageScale}/></div>
          <div className="tab-panel" role="tabpanel" aria-label="位置约束" hidden={tab!=='positions'}><PositionLikelihoodEditor value={positionValue} context={positionContext} onChange={updatePositions} onReplacePrompt={() => updatePositions(positionValue, true)} manualPrompt={positionManual} promptPresent={!!generatedPositionPrompt && !positionManual} disabled={isBusy || action !== null||!!input.loading} toolbarTarget={tab==='positions'?viewerToolbarTarget:null} scale={imageScale} onScaleChange={setImageScale}/></div>
        </>}
        {tab === 'results' && stageId!=='preflight' && <div className="tab-panel" role="tabpanel" aria-label="结果预览">
          {stageId === 'b' ? <LiveMaskEditor source={stageData.mask} report={stageData.maskReport} threadId={state.threadId??''} summary={stageData.summary} toolbarTarget={viewerToolbarTarget} scale={imageScale} onScaleChange={setImageScale} onPromptChange={updateMaskPrompt} disabled={isBusy||action!==null||viewed?.archived===true}/> : <ScienceViewer stageId={stageId} toolbarTarget={viewerToolbarTarget} missingLayers="—" displayPlanes={stageData.modelPlanes} modelResult={stageData.modelResult} imageScale={imageScale} onScaleChange={setImageScale} maskLayers={layers.value} selectedMasks={selectedMasks} onMaskChange={showMaskControls ? updateMaskLayer : undefined}/>}
        </div>}
        {tab === 'parameters' && <div className="tab-panel" role="tabpanel" aria-label="参数后验"><LiveStageData stage={selectedStage} data={stageData} view="parameters" onDetail={showParameter}/></div>}
        {tab === 'raw' && <div className="tab-panel" role="tabpanel" aria-label={t('原始结果')}>
          <RawResults report={rawReport} directPreflightReports={directPreflightReports}/>
        </div>}
        {tab === 'config' && <div className="tab-panel" role="tabpanel" aria-label="模型配置"><LiveStageData stage={selectedStage} data={stageData} view="config" onDetail={showParameter} connection={connectionNames[state.connection]}/></div>}
      </StageWorkbench>}
        {!showTaskWelcome && conversation}
      </div>
    </main></div>
    <ConnectionStatusBar connected={serverLinkConnected(state.connection, streamStatus)}/>
    {batchPanel}
    <dialog ref={dialog} className={`modal modal-${workspacePanel ?? 'design'}`} onCancel={closePanel} onClick={event => { if (event.target === dialog.current) closePanel(); }} aria-labelledby="agent-panel-title"><div className="modal-header"><div>{!workspacePanel && <span className="eyebrow">TINYLENS WORKSPACE</span>}<h2 id="agent-panel-title">{workspacePanel === 'trash' ? t('已删除任务') : workspacePanel === 'history' ? t('{lens} 的分支历史', { lens: task?.name ?? '' }) : workspacePanel === 'manual' ? '参数手册' : workspacePanel === 'parameter' ? t(parameter?.name??'') : workspacePanel === 'guide' ? '欢迎来到 TinyLens' : '工作台外观'}</h2></div><button type="button" className="workspace-dialog-close" aria-label={t('关闭窗口')} onClick={closePanel}><X size={19} aria-hidden="true"/></button></div><div className="modal-body">
      {workspacePanel === 'trash' && <DeletedTaskList tasks={deletedTasks} onRestore={onRestoreTask} getDeletionPlan={onGetTaskDeletionPlan} onDelete={onPermanentlyDeleteTask}/>}
      {workspacePanel === 'manual' && <ParameterManual stages={stages} onSelect={(next, item) => { chooseStage(next.id); setParameterKey(item.key); setWorkspacePanel('parameter'); }}/> }
      {workspacePanel === 'parameter' && parameter && <ParameterDetail parameter={parameter} live/>}
      {workspacePanel === 'history' && <LiveRunHistory attempts={attempts} reports={resultReports} history={runHistory} viewed={viewed?.identity.key}
        stageNames={stageNames} onSelect={(stage, key) => { chooseStage(stage, key); closePanel(); }}/>}
      {workspacePanel === 'guide' && <div className="live-guide-copy"><p>使用与原型相同的 Stage 导航、页签、主题和对话分栏，展示当前任务已报告的科学结果。</p><p>当前展示数值图层、参数摘要、带权后验和 M0 证据扫描。缺少的产物先略过；图像及后验不使用合成样例补齐。</p><p>问题与审批位于右侧会话栏。修改意见作为普通消息交给 Pipeline AI，不直接调度科学阶段。</p><p>连接状态：{connectionNames[state.connection]}；{turnNames[state.status]}</p>{taskId && state.connection !== 'connected' && <button className="button secondary" onClick={() => void perform('connect')}>连接 Pipeline AI</button>}</div>}
      {showDesigns && <div className="agent-design-options">{designs.map(design => <button key={design.id} onClick={() => chooseDesign(design.id)}>{design.name}</button>)}</div>}
    </div></dialog>
    {copyNotice && <div className="agent-notice" role="status">{copyNotice}</div>}
  </div>;
}

type AnswerReceipt = { delivery: MessageDelivery; error?: string };
const questionDraftKey = (question: AgentQuestion) => `tinylens-question-draft-v1:${encodeURIComponent(question.threadId)}:${encodeURIComponent(question.id)}`;

function QuestionCard({ question, connected, busy, messageReceipts, onAnswer }: { question: AgentQuestion; connected: boolean; busy: boolean;
  messageReceipts: ReadonlyMap<string, MessageDelivery | undefined>; onAnswer: (answer: QuestionSubmission) => Promise<AnswerReceipt> }) {
  const storageKey = questionDraftKey(question);
  const [draft, setDraft] = useState(() => {
    try { return restoreQuestionDraft(sessionStorage.getItem(storageKey)); }
    catch { return restoreQuestionDraft(null); }
  });
  const [localError, setLocalError] = useState('');
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [sending, setSending] = useState(false);
  const [localReceipt, setLocalReceipt] = useState<{ id: string; delivery: MessageDelivery }>();
  const submitting = useRef(false);
  const answered = question.status === 'answered';
  const superseded = question.status === 'superseded';
  const archived = answered || superseded;
  const delivery = draft.clientMessageId ? messageReceipts.get(draft.clientMessageId) ??
    (localReceipt?.id === draft.clientMessageId ? localReceipt.delivery : undefined) : undefined;
  const controls = questionAnswerControls(question.status, draft, delivery);
  const waiting = sending || question.status === 'sending';
  const locked = sending || controls.fieldsLocked;
  const selectedOption = question.options.find(option => option.id === draft.optionId);
  const canSubmit = connected && !busy && !waiting && controls.maySubmit && (!!selectedOption || !!draft.text.trim());
  const answerOption = question.options.find(option => option.id === question.answer?.optionId);

  useEffect(() => {
    try {
      if (archived) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageUnavailable(false);
    } catch { setStorageUnavailable(true); }
  }, [draft, archived, storageKey]);

  function editDraft(patch: Partial<Pick<QuestionDraft, 'optionId' | 'text'>>) {
    setDraft(previous => ({ ...previous, ...patch, clientMessageId: undefined }));
    setLocalError('');
  }

  async function submit() {
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    setSending(true); setLocalError('');
    try {
      const clientMessageId = controls.clientMessageId ?? crypto.randomUUID();
      const nextDraft = { ...draft, clientMessageId };
      setDraft(nextDraft);
      // Save the identity before POST so reopening the page can reuse it.
      try { sessionStorage.setItem(storageKey, JSON.stringify(nextDraft)); }
      catch { setStorageUnavailable(true); }
      const result = await onAnswer({ clientMessageId, questionId: question.id, expectedThreadId: question.threadId,
        ...(selectedOption ? { optionId: selectedOption.id } : {}), ...(draft.text.trim() ? { text: draft.text } : {}) });
      setLocalReceipt({ id: clientMessageId, delivery: result.delivery });
      if (result.delivery === 'rejected') setDraft(previous => ({ ...previous, clientMessageId: undefined }));
      if (result.delivery === 'rejected') setLocalError(result.error ?? '答复未送达。');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '答复请求未完成。');
    } finally { submitting.current = false; setSending(false); }
  }

  const deliveryUnknown = question.status === 'delivery_unknown' || (!!controls.clientMessageId && !waiting && delivery !== 'delivered');
  return <article className={`agent-question-card ${archived ? 'archived' : ''}`} aria-label={question.title}>
    <div className="agent-question-heading"><span><Sparkles size={14}/>Pipeline AI 的问题{question.stage && <small>{question.stage}</small>}</span><span>{superseded ? '已由新版本替代' : answered || delivery === 'delivered' ? <><Check size={13}/>已答复</> : deliveryUnknown ? '送达待确认' : waiting ? <><LoaderCircle size={13} className="agent-spin"/>正在确认答复</> : '等待你的决定'}</span></div>
    <h2>{question.title}</h2>
    <MessageBody text={question.question}/>
    {question.context && <details className="agent-question-context"><summary>AI 提供的背景<ChevronDown size={13}/></summary><MessageBody text={question.context}/></details>}
    {superseded ? <div className="agent-question-superseded"><p>此问题已由新版本替代，原文保留供回看。它没有被提交为用户答复。</p>{question.options.length > 0 && <details><summary>查看原问题的选项</summary><ul>{question.options.map(option => <li key={option.id}><strong>{option.label}</strong>{option.description && <p>{option.description}</p>}</li>)}</ul></details>}</div> : answered ? <div className="agent-question-answer"><strong><Check size={14}/>你的答复</strong>{question.answer?.optionId && <p>{answerOption?.label ?? question.answer.optionId}</p>}{question.answer?.text && <p>{question.answer.text}</p>}{!question.answer?.optionId && !question.answer?.text && <p>AI 会话已确认收到答复。</p>}</div> : <>
      {question.options.length > 0 && <fieldset className="agent-question-options" disabled={locked}><legend>请选择，也可以直接填写其他意见</legend>{question.options.map(option => <label key={option.id} className={selectedOption?.id === option.id ? 'selected' : ''}><input type="radio" name={`question-${question.threadId}-${question.id}`} value={option.id} checked={selectedOption?.id === option.id} onChange={() => editDraft({ optionId: option.id })}/><span><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span></label>)}</fieldset>}
      <label className="agent-question-free"><span>补充说明或直接填写答复{selectedOption && <button type="button" disabled={locked} onClick={() => editDraft({ optionId: '' })}>取消所选项</button>}</span><textarea rows={3} value={draft.text} maxLength={20000} disabled={locked} onChange={event => editDraft({ text: event.target.value })} placeholder="写下你的决定或补充意见；填写不会自动发送。"/></label>
      {(question.error || localError) && <p className="agent-question-error" role="alert">{question.error || localError}</p>}
      {deliveryUnknown && <p className="agent-question-delivery" role="status">{question.status === 'delivery_unknown'
        ? '桥接尚未确认答复是否送达。请重连并核对原会话。' : '可以重试原答复。桥接会按原提交标识核对送达。'}</p>}
      <div className="agent-question-footer"><span>{!connected ? '连接 Pipeline AI 后可以提交；当前草稿仍会保留。' : storageUnavailable ? '浏览器未允许保存草稿，请暂时保留此页面。' : '选择和草稿保留在本标签页；只有点击提交才会发送。'}</span><button className="agent-button primary" type="button" disabled={!canSubmit} onClick={() => void submit()}>{waiting ? <LoaderCircle size={14} className="agent-spin"/> : <Send size={14}/>} {controls.clientMessageId ? '重试原答复' : '提交给 Pipeline AI'}</button></div>
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
  return <article className={`agent-report report-${update.kind}`}><div><span>{update.kind === 'artifact' ? '产物引用' : update.kind === 'stage' ? `阶段 ${update.stage ?? ''}` : 'AI 说明'}</span>{update.status && <small>{stageLabel(update)}</small>}</div>{update.title && <h3>{update.title}</h3>}{update.message && <p>{update.message}</p>}{update.at && <time dateTime={update.at}>{reportTime(update.at)}</time>}{update.path && <><code className="agent-path">{update.path}</code><button onClick={() => copyPath(update.path!)}>复制 AI 提供的路径</button></>}</article>;
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
  const disabled = busy || submitted || !request.replyId;
  async function respond(result: Record<string, unknown>) {
    if (disabled || responding.current) return;
    responding.current = true;
    if (await reply(result)) setSubmitted(true);
    else responding.current = false;
  }
  return <section className="agent-request"><div className="agent-request-heading"><CircleHelp size={17}/><h3>{approval ? 'AI 请求你的批准' : userInput ? 'AI 需要你的判断' : '待支持的 AI 请求'}</h3>{submitted && <span>答复已发送</span>}</div>
    {!request.replyId && <p className="agent-approval-unavailable">当前桥接服务未提供该请求的唯一标识。请更新桥接服务后重新查看请求。</p>}
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
