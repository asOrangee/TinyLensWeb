import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgentServer } from './agent-server.mjs';
import { connectionConfig } from './connection-config.mjs';

const defaultDirectory = fileURLToPath(new URL('../.local/', import.meta.url));
export const DEFAULT_TASK_ID = 'default';
const validId = id => id === DEFAULT_TASK_ID || /^task-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const json = (response, code, value) => {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > 8192) throw new Error('Request is too large'); }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'name')) throw new Error('Only a task name is accepted');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim().length > 120)) throw new Error('Invalid task name');
  return value;
}

/** Each task owns an unchanged single-thread bridge. Navigating or creating a
 * task never connects, sends a message, interrupts, or transfers approvals. */
export async function createAgentTaskServer({ stateDirectory = defaultDirectory, remoteProxyPort = connectionConfig.remoteProxyPort, ...options } = {}) {
  const registryPath = resolve(stateDirectory, 'agent-tasks.json');
  let tasks;
  try {
    const saved = JSON.parse(await readFile(registryPath, 'utf8'));
    if (saved.schema !== 'tinylens.tasks.v1' || !Array.isArray(saved.tasks) || !saved.tasks.length
      || saved.tasks.some(task => !validId(task.id) || typeof task.name !== 'string' || task.name.length > 120
        || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isInteger(task.proxyOffset) || task.proxyOffset < 0
        || remoteProxyPort + task.proxyOffset > 65535)
      || new Set(saved.tasks.map(task => task.id)).size !== saved.tasks.length
      || new Set(saved.tasks.map(task => task.proxyOffset)).size !== saved.tasks.length
      || !saved.tasks.some(task => task.id === DEFAULT_TASK_ID && task.proxyOffset === 0)) throw new Error('Invalid saved task registry');
    tasks = saved.tasks;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    tasks = [{ id: DEFAULT_TASK_ID, name: 'Lens workspace', createdAt: new Date().toISOString(), proxyOffset: 0 }];
  }
  const sessions = new Map();
  let mutations = Promise.resolve(), closed = false;
  const directory = task => task.id === DEFAULT_TASK_ID ? stateDirectory : resolve(stateDirectory, 'tasks', task.id);
  function session(task) {
    if (!sessions.has(task.id)) sessions.set(task.id, createAgentServer({ ...options, stateDirectory: directory(task),
      remoteProxyPort: remoteProxyPort === 0 ? 0 : remoteProxyPort + task.proxyOffset,
      ...(task.id === DEFAULT_TASK_ID ? {} : { datasetPath: '' }) }));
    return sessions.get(task.id);
  }
  // Eagerly restore only the legacy journal, at its original path, without connecting.
  const legacy = await session(tasks.find(task => task.id === DEFAULT_TASK_ID));
  async function persist(next = tasks) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(`${registryPath}.tmp`, JSON.stringify({ schema: 'tinylens.tasks.v1', tasks: next }), { mode: 0o600 });
    await rename(`${registryPath}.tmp`, registryPath);
  }
  function mutate(operation) {
    const result = mutations.catch(() => {}).then(() => { if (closed) throw new Error('Task service is closed'); return operation(); });
    mutations = result;
    return result;
  }
  async function createTask(data = {}) {
    return mutate(async () => {
      const proxyOffset = Math.max(...tasks.map(task => task.proxyOffset)) + 1;
      if (remoteProxyPort + proxyOffset > 65535) throw new Error('Task limit reached');
      const task = { id: `task-${randomUUID()}`, name: data.name?.trim() || `新任务 ${proxyOffset}`,
        createdAt: new Date().toISOString(), proxyOffset };
      const bridge = await session(task);
      await bridge.persist();
      await persist([...tasks, task]);
      tasks = [...tasks, task];
      return task;
    });
  }
  async function renameTask(id, name) {
    return mutate(async () => {
      const old = tasks.find(task => task.id === id);
      if (!old) throw new Error('Task not found');
      const next = { ...old, name: name.trim() || old.name };
      const updated = tasks.map(task => task.id === id ? next : task);
      await persist(updated); tasks = updated; return next;
    });
  }
  async function catalog() {
    return Promise.all(tasks.map(async task => {
      const bridge = await session(task);
      const lastMessage = bridge.state.messages.filter(message => message.role === 'user').at(-1);
      return { id: task.id, name: task.name, createdAt: task.createdAt, lastConversationAt: lastMessage?.at };
    }));
  }
  const server = http.createServer(async (request, response) => {
    const hosts = ['127.0.0.1:5173', 'localhost:5173', `127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
    if (!hosts.includes(request.headers.host) || request.headers.origin && !hosts.some(host => request.headers.origin === `http://${host}`)) return json(response, 403, { error: 'Only local TinyLens requests are allowed' });
    if (closed) return json(response, 503, { error: 'Task service is closed' });
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/agent/tasks') {
        if (request.method === 'GET') return json(response, 200, { tasks: await catalog() });
        if (request.method === 'POST') return json(response, 201, { task: await createTask(await body(request)) });
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname.startsWith('/api/agent/tasks/')) {
        const id = url.pathname.slice('/api/agent/tasks/'.length);
        if (!validId(id) || !tasks.some(task => task.id === id)) return json(response, 404, { error: 'Task not found' });
        if (request.method !== 'PATCH') return json(response, 405, { error: 'Method not allowed' });
        const data = await body(request);
        if (typeof data.name !== 'string') throw new Error('A task name is required');
        return json(response, 200, { task: await renameTask(id, data.name) });
      }
      if (url.searchParams.getAll('taskId').length > 1) return json(response, 400, { error: 'Ambiguous task id' });
      const id = url.searchParams.get('taskId') ?? DEFAULT_TASK_ID;
      const task = validId(id) && tasks.find(item => item.id === id);
      if (!task) return json(response, 404, { error: 'Task not found' });
      const bridge = await session(task);
      // Task scope belongs to this router. Existing readers deliberately reject
      // any query fields besides their own report identifier and refresh flag.
      const originalUrl = request.url;
      url.searchParams.delete('taskId');
      request.url = url.pathname + url.search;
      try { await bridge.routeRequest(request, response); }
      finally { request.url = originalUrl; }
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error.message });
      else response.end();
    }
  });
  async function close() {
    closed = true;
    await mutations.catch(() => {});
    await Promise.all([...sessions.values()].map(async pending => (await pending).close()));
    await new Promise(resolveClose => server.close(resolveClose));
  }
  return { server, state: legacy.state, createTask, catalog, close };
}
