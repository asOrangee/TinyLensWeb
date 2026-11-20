import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentWorkspace from './AgentWorkspace';
import BatchWorkspace from './BatchWorkspace';
import { AgentTaskContext } from '../lib/agent-task-context';
import { hideTask, parseDeletedTaskIds, restoreTask } from '../lib/deleted-tasks';
import { clearLiveTaskStorage, defaultLiveTaskId, liveTaskSelectionKey, parseLiveTasks, validLiveTaskId, type LiveTask } from '../lib/live-tasks';
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
  const [batchWindow, setBatchWindow] = useState<{ id?: string }>();
  const creationLock = useRef(false);
  const catalogSequence = useRef(0);
  const visibleTasks = useMemo(() => tasks.filter(task => !deletedIds.includes(task.id)), [tasks, deletedIds]);
  const task = visibleTasks.find(item => item.id === selected) ?? (ready ? visibleTasks.find(item => !item.batchId) : undefined);
  const sidebarTasks = useMemo(() => visibleTasks.filter(item => !item.batchId || item.id === task?.id), [visibleTasks, task?.id]);
  const thumbnails = useLiveTaskThumbnails(sidebarTasks, ready);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++catalogSequence.current;
    const response = await fetch('/api/agent/tasks', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`任务服务暂不可用（${response.status}）。`);
    const next = parseLiveTasks(await response.json());
    if (!signal?.aborted && sequence === catalogSequence.current) { setTasks(next); setReady(true); setError(''); }
    return next;
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const reload = () => { void refresh(abort.signal).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取任务列表。'); }); };
    reload();
    window.addEventListener('focus', reload);
    const poll = setInterval(reload, 15000);
    return () => { abort.abort(); clearInterval(poll); window.removeEventListener('focus', reload); };
  }, [refresh]);
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
    const id = task?.id ?? null;
    if (ready && id !== selected) activate(id);
  }, [ready, task?.id, selected]);
  function select(id: string) {
    if (visibleTasks.some(task => task.id === id)) activate(id);
  }
  async function openBatchTask(id: string) {
    if (deletedIds.includes(id) || readDeletedTasks().includes(id)) throw Error('该任务已移入「已删除任务」，请先恢复。');
    const item = tasks.find(task => task.id === id) ?? (await refresh()).find(task => task.id === id);
    if (!item?.batchId) throw Error('无法打开该批次任务。');
    setTasks(previous => previous.some(task => task.id === id) ? previous : [...previous, item]);
    setBatchWindow(undefined);
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
      activate(result.task.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法新建任务。'); }
    finally { creationLock.current = false; setCreating(false); }
  }
  async function permanentlyDeleteTask(id: string) {
    const response = await fetch('/api/agent/tasks/' + encodeURIComponent(id), { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok && response.status !== 404) throw Error(result.error || '暂时无法彻底删除任务。');
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
  if (!ready && !task) return null;
  return <AgentTaskContext.Provider value={task?.id ?? defaultLiveTaskId}>
    <AgentWorkspace key={task?.id ?? 'empty'} task={task}
      tasks={sidebarTasks.map(item => ({ ...item, image: thumbnails[item.id]?.src }))}
      deletedTasks={tasks.filter(item => deletedIds.includes(item.id))}
      taskError={error} taskCreationDisabled={!ready || creating}
      onNewTask={() => void createTask()} onSelectTask={select}
      onDeleteTask={id => setTaskDeleted(id, true)} onRestoreTask={id => setTaskDeleted(id, false)}
      onPermanentlyDeleteTask={permanentlyDeleteTask}
      onBatches={id => setBatchWindow({ id: id ?? task?.batchId })}
      batchPanel={batchWindow && <BatchWorkspace initialId={batchWindow.id} onClose={() => setBatchWindow(undefined)} onOpenTask={openBatchTask}/>}
      onTaskActivity={() => void refresh().catch(() => {})}/>
  </AgentTaskContext.Provider>;
}
