import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AgentWorkspace from './AgentWorkspace';
import { AgentTaskContext } from '../lib/agent-task-context';
import { hideTask, parseDeletedTaskIds, restoreTask } from '../lib/deleted-tasks';
import { defaultLiveTaskId, liveTaskSelectionKey, parseLiveTasks, validLiveTaskId, type LiveTask } from '../lib/live-tasks';
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
  const creationLock = useRef(false);
  const catalogSequence = useRef(0);
  const visibleTasks = useMemo(() => tasks.filter(task => !deletedIds.includes(task.id)), [tasks, deletedIds]);
  const thumbnails = useLiveTaskThumbnails(visibleTasks, ready);
  const task = visibleTasks.find(item => item.id === selected) ?? (ready ? visibleTasks[0] : undefined);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++catalogSequence.current;
    const response = await fetch('/api/agent/tasks', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`任务服务暂不可用（${response.status}）。`);
    const next = parseLiveTasks(await response.json());
    if (signal?.aborted || sequence !== catalogSequence.current) return;
    setTasks(next); setReady(true); setError('');
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
  if (!ready && !task) return null;
  return <AgentTaskContext.Provider value={task?.id ?? defaultLiveTaskId}>
    <AgentWorkspace key={task?.id ?? 'empty'} task={task}
      tasks={visibleTasks.map(item => ({ ...item, image: thumbnails[item.id]?.src }))}
      deletedTasks={tasks.filter(item => deletedIds.includes(item.id))}
      taskError={error} taskCreationDisabled={!ready || creating}
      onNewTask={() => void createTask()} onSelectTask={select}
      onDeleteTask={id => setTaskDeleted(id, true)} onRestoreTask={id => setTaskDeleted(id, false)}
      onTaskActivity={() => void refresh().catch(() => {})}/>
  </AgentTaskContext.Provider>;
}
