import { useCallback, useEffect, useRef, useState } from 'react';
import AgentWorkspace from './AgentWorkspace';
import { AgentTaskContext } from '../lib/agent-task-context';
import { defaultLiveTaskId, liveTaskSelectionKey, parseLiveTasks, validLiveTaskId, type LiveTask } from '../lib/live-tasks';

function initialSelection() {
  const requested = new URLSearchParams(location.search).get('task');
  if (requested && validLiveTaskId(requested)) return requested;
  try { const saved = localStorage.getItem(liveTaskSelectionKey); if (saved && validLiveTaskId(saved)) return saved; } catch { /* Optional preference. */ }
  return defaultLiveTaskId;
}
export default function LiveTaskWorkspace() {
  const [tasks, setTasks] = useState<LiveTask[]>([{ id: defaultLiveTaskId, name: 'Lens workspace', createdAt: '' }]);
  const [selected, setSelected] = useState(initialSelection);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const creationLock = useRef(false);
  const catalogSequence = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++catalogSequence.current;
    const response = await fetch('/api/agent/tasks', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`任务服务暂不可用（${response.status}）。`);
    const next = parseLiveTasks(await response.json());
    if (signal?.aborted || sequence !== catalogSequence.current) return;
    setTasks(next); setReady(true); setError('');
    setSelected(previous => next.some(task => task.id === previous) ? previous : defaultLiveTaskId);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const reload = () => { void refresh(abort.signal).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取任务列表。'); }); };
    reload();
    window.addEventListener('focus', reload);
    const poll = setInterval(reload, 15000);
    return () => { abort.abort(); clearInterval(poll); window.removeEventListener('focus', reload); };
  }, [refresh]);
  function select(id: string) {
    if (!tasks.some(task => task.id === id)) return;
    setSelected(id); setError('');
    try { localStorage.setItem(liveTaskSelectionKey, id); } catch { /* Current task remains usable. */ }
    const url = new URL(location.href);
    if (id === defaultLiveTaskId) url.searchParams.delete('task'); else url.searchParams.set('task', id);
    history.replaceState(null, '', url);
  }
  async function createTask() {
    if (creationLock.current) return;
    creationLock.current = true; setCreating(true); setError('');
    try {
      const response = await fetch('/api/agent/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法新建任务。');
      if (!result.task || !validLiveTaskId(result.task.id)) throw new Error('任务返回格式无效。');
      ++catalogSequence.current;
      setTasks(previous => [...previous.filter(item => item.id !== result.task.id), result.task]);
      const id = result.task.id as string;
      setSelected(id);
      try { localStorage.setItem(liveTaskSelectionKey, id); } catch { /* Optional preference. */ }
      const url = new URL(location.href); url.searchParams.set('task', id); history.replaceState(null, '', url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法新建任务。'); }
    finally { creationLock.current = false; setCreating(false); }
  }
  async function renameTask(id: string, name: string) {
    if (!name.trim() || name.trim() === tasks.find(task => task.id === id)?.name) return;
    try {
      const response = await fetch(`/api/agent/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法保存任务名称。');
      setTasks(previous => previous.map(task => task.id === id ? { ...task, ...result.task } : task));
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存任务名称。'); }
  }
  const task = tasks.find(item => item.id === selected);
  return task ? <AgentTaskContext.Provider value={task.id}><AgentWorkspace key={task.id} task={task} tasks={tasks} taskError={error} taskCreationDisabled={!ready || creating} onNewTask={() => void createTask()} onSelectTask={select} onRenameTask={name => void renameTask(task.id, name)} onTaskActivity={() => void refresh().catch(() => {})}/></AgentTaskContext.Provider> : null;
}
