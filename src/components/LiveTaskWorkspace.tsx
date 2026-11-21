import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentWorkspace from './AgentWorkspace';
import BatchWorkspace from './BatchWorkspace';
import { AgentTaskContext } from '../lib/agent-task-context';
import { hideTask, parseDeletedTaskIds, restoreTask } from '../lib/deleted-tasks';
import { clearLiveTaskStorage, defaultLiveTaskId, liveTaskGroup, liveTaskSelectionKey, parseLiveTasks, parseTaskDeletionPlan, standaloneTaskGroup, validLiveTaskId, type LiveTask } from '../lib/live-tasks';
import { batchFetch, type Batch } from '../lib/live-batches';
import { useLiveTaskThumbnails } from '../lib/use-live-task-thumbnails';

const deletedTaskStorageKey = 'tinylens-live-deleted-tasks-v1';

function readDeletedTasks() {
  try { return parseDeletedTaskIds(localStorage.getItem(deletedTaskStorageKey), validLiveTaskId); }
  catch { return []; }
}

function initialSelection() {
  const requested = new URLSearchParams(location.search).get('task');
  if (requested && validLiveTaskId(requested)) return requested;
  try { const saved = localStorage.getItem(liveTaskSelectionKey); if (saved && validLiveTaskId(saved)) return saved; } catch { /* Optional preference. */ }
  return defaultLiveTaskId;
}
export default function LiveTaskWorkspace() {
  const [tasks, setTasks] = useState<LiveTask[]>([{ id: defaultLiveTaskId, name: 'Lens workspace', createdAt: '' }]);
  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [deletedIds, setDeletedIds] = useState(readDeletedTasks);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [batchWindow, setBatchWindow] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<string>();
  const [batchDetail, setBatchDetail] = useState<{ id: string; batch?: Batch; error?: string }>();
  const [visibleThumbnailIds, setVisibleThumbnailIds] = useState<ReadonlySet<string>>(() => new Set());
  const creationLock = useRef(false);
  const catalogSequence = useRef(0);
  const batchRevision = useRef(0);
  const lastTaskByGroup = useRef(new Map<string, string>());
  const visibleTasks = useMemo(() => tasks.filter(task => !deletedIds.includes(task.id)), [tasks, deletedIds]);
  const requestedTask = visibleTasks.find(item => item.id === selected);
  const activeGroup = selectedGroup ?? liveTaskGroup(tasks.find(item => item.id === selected));
  const standaloneTasks = useMemo(() => visibleTasks.filter(item => !item.batchId), [visibleTasks]);
  const sidebarTasks = useMemo(() => visibleTasks.filter(item => liveTaskGroup(item) === activeGroup), [visibleTasks, activeGroup]);
  const detail = batchDetail?.id === activeGroup ? batchDetail : undefined;
  const batch = detail?.batch;
  const openableIds = batch?.compatible ? batch.jobs.filter(job => job.canOpen).map(job => job.taskId).join(' ') : '';
  const openable = useMemo(() => new Set(openableIds ? openableIds.split(' ') : []), [openableIds]);
  const canOpen = (item: LiveTask) => !item.batchId || openable.has(item.id);
  const scopedTask = liveTaskGroup(requestedTask) === activeGroup && requestedTask && (!batch || canOpen(requestedTask))
    ? requestedTask : ready ? sidebarTasks.find(item => item.id === lastTaskByGroup.current.get(activeGroup) && canOpen(item))
      ?? sidebarTasks.find(canOpen) : undefined;
  // Keep the dialog mounted while its selection changes the sidebar behind it.
  const task = batchWindow ? requestedTask : scopedTask;
  const thumbnailTasks = useMemo(() => sidebarTasks.filter(item => (!item.batchId || openable.has(item.id))
    && (item.id === task?.id || visibleThumbnailIds.has(item.id))), [sidebarTasks, openable, task?.id, visibleThumbnailIds]);
  const thumbnails = useLiveTaskThumbnails(thumbnailTasks, ready);
  const updateVisibleThumbnails = useCallback((ids: ReadonlySet<string>) => {
    setVisibleThumbnailIds(previous => ids.size === previous.size && [...ids].every(id => previous.has(id)) ? previous : ids);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++catalogSequence.current;
    const response = await fetch('/api/agent/tasks', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`任务服务暂不可用（${response.status}）。`);
    const next = parseLiveTasks(await response.json());
    if (!signal?.aborted && sequence === catalogSequence.current) { setTasks(next); setReady(true); setError(''); }
    return next;
  }, []);
  const refreshOnTaskActivity = useCallback(() => { void refresh().catch(() => {}); }, [refresh]);
  useEffect(() => {
    const abort = new AbortController();
    const reload = () => { void refresh(abort.signal).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取任务列表。'); }); };
    reload();
    window.addEventListener('focus', reload);
    const poll = setInterval(reload, 15000);
    return () => { abort.abort(); clearInterval(poll); window.removeEventListener('focus', reload); };
  }, [refresh]);
  useEffect(() => {
    if (activeGroup === standaloneTaskGroup || !ready) return;
    const controller = new AbortController();
    let timer: number;
    async function refreshBatch() {
      const revision = batchRevision.current;
      try {
        const { batch } = await batchFetch<{ batch: Batch }>(`/${activeGroup}`, { signal: controller.signal });
        if (!controller.signal.aborted && revision === batchRevision.current) setBatchDetail({ id: activeGroup, batch });
      } catch (reason) {
        if (!controller.signal.aborted && revision === batchRevision.current) setBatchDetail(previous => ({
          id: activeGroup, batch: previous?.id === activeGroup ? previous.batch : undefined,
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
      if (!controller.signal.aborted) timer = window.setTimeout(refreshBatch, batchWindow ? 2000 : 15000);
    }
    void refreshBatch();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [activeGroup, batchWindow, ready]);
  useEffect(() => {
    function syncDeletedTasks(event: StorageEvent) {
      if (event.key === deletedTaskStorageKey || event.key === null) setDeletedIds(readDeletedTasks());
    }
    window.addEventListener('storage', syncDeletedTasks);
    return () => window.removeEventListener('storage', syncDeletedTasks);
  }, []);
  function activate(id: string | null) {
    setSelected(id); setError('');
    try {
      if (id) localStorage.setItem(liveTaskSelectionKey, id);
      else localStorage.removeItem(liveTaskSelectionKey);
    } catch { /* Current task remains usable. */ }
    const url = new URL(location.href);
    if (id && id !== defaultLiveTaskId) url.searchParams.set('task', id);
    else url.searchParams.delete('task');
    history.replaceState(null, '', url);
  }
  useEffect(() => {
    if (ready && selectedGroup === undefined) setSelectedGroup(activeGroup);
  }, [ready, selectedGroup, activeGroup]);
  useEffect(() => {
    if (requestedTask) lastTaskByGroup.current.set(liveTaskGroup(requestedTask), requestedTask.id);
  }, [requestedTask]);
  useEffect(() => {
    const id = task?.id ?? null;
    if (ready && !batchWindow && (activeGroup === standaloneTaskGroup || batch) && id !== selected) activate(id);
  }, [ready, batchWindow, activeGroup, batch, task?.id, selected]);
  function select(id: string) {
    if (sidebarTasks.some(item => item.id === id && canOpen(item))) activate(id);
  }
  async function openBatchTask(id: string) {
    if (deletedIds.includes(id) || readDeletedTasks().includes(id)) throw Error('该任务已移入「已删除任务」，请先恢复。');
    const item = tasks.find(task => task.id === id) ?? (await refresh()).find(task => task.id === id);
    if (!item || liveTaskGroup(item) !== activeGroup || !canOpen(item)) throw Error('无法打开该批次任务。');
    setTasks(previous => previous.some(task => task.id === id) ? previous : [...previous, item]);
    setBatchWindow(false);
    activate(id);
  }
  function setTaskDeleted(id: string, deleted: boolean) {
    if (!tasks.some(task => task.id === id)) return;
    const update = deleted ? hideTask : restoreTask;
    let next = update(deletedIds, id);
    try {
      const stored = update(parseDeletedTaskIds(localStorage.getItem(deletedTaskStorageKey), validLiveTaskId), id);
      localStorage.setItem(deletedTaskStorageKey, JSON.stringify(stored));
      next = stored;
    } catch { /* Task visibility remains usable for this page. */ }
    setDeletedIds(next);
  }
  async function createTask() {
    if (!ready || creationLock.current) return;
    creationLock.current = true; setCreating(true); setError('');
    try {
      const response = await fetch('/api/agent/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法新建任务。');
      if (!result.task || !validLiveTaskId(result.task.id)) throw new Error('任务返回格式无效。');
      ++catalogSequence.current;
      setTasks(previous => [...previous.filter(item => item.id !== result.task.id), result.task]);
      setSelectedGroup(standaloneTaskGroup);
      activate(result.task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法新建任务。'); }
    finally { creationLock.current = false; setCreating(false); }
  }
  async function getTaskDeletionPlan(id: string, signal: AbortSignal) {
    const response = await fetch('/api/agent/tasks/' + encodeURIComponent(id) + '/deletion-plan', { signal, cache: 'no-store' });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Error(typeof result?.error === 'string' && result.error ? result.error : '无法读取任务的永久删除清单。');
    return parseTaskDeletionPlan(result);
  }
  async function permanentlyDeleteTask(id: string, token: string) {
    const response = await fetch('/api/agent/tasks/' + encodeURIComponent(id), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.deleted !== id) {
      throw Error(typeof result?.error === 'string' && result.error ? result.error : '暂时无法彻底删除任务。');
    }
    ++catalogSequence.current;
    setTasks(previous => previous.filter(item => item.id !== id));
    setDeletedIds(previous => restoreTask(previous, id));
    try {
      const deleted = restoreTask(readDeletedTasks(), id);
      localStorage.setItem(deletedTaskStorageKey, JSON.stringify(deleted));
      clearLiveTaskStorage(localStorage, id, result.threadId);
      clearLiveTaskStorage(sessionStorage, id, result.threadId);
    } catch { /* The server task is already deleted. */ }
  }
  async function renameTask(id: string, name: string) {
    const response = await fetch('/api/agent/tasks/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof result?.error === 'string' && result.error ? result.error : '暂时无法重命名任务。');
    const [saved] = parseLiveTasks({ tasks: [result?.task] });
    if (saved.id !== id || saved.name !== name) throw new Error('任务返回格式无效。');
    // A catalog response fetched before confirmation may still contain the old name.
    ++catalogSequence.current;
    setTasks(previous => previous.map(item => item.id === id ? { ...item, name: saved.name } : item));
  }
  return <AgentTaskContext.Provider value={task?.id ?? defaultLiveTaskId}>
    <AgentWorkspace key={task?.id ?? 'empty'} task={task}
      tasks={sidebarTasks.map(item => ({ ...item, image: thumbnails[item.id]?.src, openDisabled: !canOpen(item) }))}
      onVisibleTasks={updateVisibleThumbnails}
      deletedTasks={tasks.filter(item => deletedIds.includes(item.id))}
      taskError={error} taskListPending={!ready && !error} taskCreationDisabled={!ready || creating}
      onNewTask={() => void createTask()} onSelectTask={select} onRenameTask={renameTask}
      onDeleteTask={id => setTaskDeleted(id, true)} onRestoreTask={id => setTaskDeleted(id, false)}
      onGetTaskDeletionPlan={getTaskDeletionPlan} onPermanentlyDeleteTask={permanentlyDeleteTask}
      onBatches={id => { if (id) setSelectedGroup(id); setBatchWindow(true); }}
      batchPanel={batchWindow && <BatchWorkspace activeId={activeGroup} batch={batch} batchError={detail?.error}
        standaloneTasks={standaloneTasks} onSelectBatch={setSelectedGroup} onClose={() => setBatchWindow(false)} onOpenTask={openBatchTask}
        onBatchUpdate={next => { batchRevision.current += 1; setBatchDetail({ id: next.id, batch: next }); }}/>}
      onTaskActivity={refreshOnTaskActivity}/>
  </AgentTaskContext.Provider>;
}
