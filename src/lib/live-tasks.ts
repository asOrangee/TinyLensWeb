export const defaultLiveTaskId = 'default';
export const liveTaskSelectionKey = 'tinylens-live-active-task-v1';
export type LiveTask = { id: string; name: string; createdAt: string; lastConversationAt?: string; batchId?: string };
export function validLiveTaskId(id: string) {
  return id === defaultLiveTaskId || /^task-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
}
export function parseLiveTasks(value: unknown): LiveTask[] {
  if (!value || typeof value !== 'object' || !('tasks' in value) || !Array.isArray(value.tasks)) throw new Error('无法读取任务列表。');
  const tasks = value.tasks as LiveTask[];
  if (tasks.some(task => !task || typeof task.id !== 'string' || !validLiveTaskId(task.id)
    || typeof task.name !== 'string' || !Number.isFinite(Date.parse(task.createdAt)))
    || new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('任务列表格式无效。');
  return tasks;
}
export const liveTaskPreferenceKey = (id: string) => id === defaultLiveTaskId ? 'tinylens-live-workbench-v1' : `tinylens-live-workbench-v1:${id}`;
export const agentTaskUrl = (path: string, id: string) => id === defaultLiveTaskId ? path : `${path}${path.includes('?') ? '&' : '?'}taskId=${encodeURIComponent(id)}`;

export function clearLiveTaskStorage(storage: Storage, id: string, threadId?: string | null) {
  const preferences = liveTaskPreferenceKey(id);
  const scale = 'tinylens-live-image-scale-v2' + (id === defaultLiveTaskId ? '' : ':' + id);
  const questionPrefix = threadId ? 'tinylens-question-draft-v1:' + encodeURIComponent(threadId) + ':' : undefined;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (!key) continue;
    let maskForThread = false;
    if (threadId && key.startsWith('tinylens-mask-draft-v1:')) {
      try { maskForThread = JSON.parse(key.slice('tinylens-mask-draft-v1:'.length))[0] === threadId; }
      catch { /* Another draft's key is outside this task. */ }
    }
    if (key === preferences || key === scale || maskForThread || (questionPrefix && key.startsWith(questionPrefix))
        || (key === liveTaskSelectionKey && storage.getItem(key) === id)) storage.removeItem(key);
  }
}
