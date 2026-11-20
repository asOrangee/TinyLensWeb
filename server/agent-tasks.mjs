import http from 'node:http';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgentServer } from './agent-server.mjs';
import { connectionConfig } from './connection-config.mjs';
import { batchJobProgress, batchPlanView, batchRequest, isBatchConfirmation, prepareBatchTool, publicBatch, readBatchPlan,
  resultPath, restoreBatches, sameRuntime, validBatchId, validatedBatchPlan } from './agent-batches.mjs';
import { createBatchQueue } from './batch-queue.mjs';

const defaultDirectory = fileURLToPath(new URL('../.local/', import.meta.url));
export const DEFAULT_TASK_ID = 'default';
const validId = id => id === DEFAULT_TASK_ID || /^task-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const json = (response, code, value) => {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
async function readBody(request, maxSize) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) { text += chunk; if (text.length > maxSize) throw new Error('Request is too large'); }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}
async function body(request) {
  const value = await readBody(request, 8192);
  if (Object.keys(value).some(key => key !== 'name')) throw new Error('Only a task name is accepted');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim().length > 120)) throw new Error('Invalid task name');
  return value;
}

/** Each task owns an unchanged single-thread bridge. Navigating or creating a
 * task never connects, sends a message, interrupts, or transfers approvals. */
export async function createAgentTaskServer({ stateDirectory = defaultDirectory, remoteProxyPort = connectionConfig.remoteProxyPort,
  batchInventory = readBatchPlan, batchConfig = connectionConfig, batchPollMs, ...options } = {}) {
  const registryPath = resolve(stateDirectory, 'agent-tasks.json');
  let tasks;
  let batches = [];
  let pendingDeletions = [];
  let nextProxyOffset;
  try {
    const saved = JSON.parse(await readFile(registryPath, 'utf8'));
    if (saved.schema !== 'tinylens.tasks.v1' || !Array.isArray(saved.tasks)
      || saved.tasks.some(task => !validId(task.id) || typeof task.name !== 'string' || task.name.length > 120
        || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isInteger(task.proxyOffset) || task.proxyOffset < 0
        || remoteProxyPort + task.proxyOffset > 65535)
      || new Set(saved.tasks.map(task => task.id)).size !== saved.tasks.length
      || new Set(saved.tasks.map(task => task.proxyOffset)).size !== saved.tasks.length
      || saved.tasks.some(task => task.id === DEFAULT_TASK_ID && task.proxyOffset !== 0)) throw new Error('Invalid saved task registry');
    tasks = saved.tasks;
    batches = restoreBatches(saved.batches ?? [], tasks);
    pendingDeletions = saved.pendingDeletions ?? [];
    nextProxyOffset = saved.nextProxyOffset ?? Math.max(0, ...tasks.map(task => task.proxyOffset)) + 1;
    if (!Array.isArray(pendingDeletions) || pendingDeletions.some(id => !validId(id) || tasks.some(task => task.id === id))
        || !Number.isSafeInteger(nextProxyOffset) || nextProxyOffset <= Math.max(0, ...tasks.map(task => task.proxyOffset))) {
      throw new Error('Invalid saved task deletion state');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    tasks = [{ id: DEFAULT_TASK_ID, name: 'Lens workspace', createdAt: new Date().toISOString(), proxyOffset: 0 }];
    nextProxyOffset = 1;
  }
  const sessions = new Map();
  const deleting = new Set();
  let mutations = Promise.resolve(), closed = false;
  const directory = task => task.id === DEFAULT_TASK_ID ? stateDirectory : resolve(stateDirectory, 'tasks', task.id);
  const getBatch = id => batches.find(batch => batch.id === id);
  function ownedBatch(id, taskId, threadId) {
    const batch = getBatch(id);
    return batch?.sourceTaskId === taskId && batch.sourceThreadId === threadId ? batch : undefined;
  }
  function session(task) {
    if (!sessions.has(task.id)) {
      const batch = getBatch(task.batchId);
      const job = batch?.jobs.find(job => job.taskId === task.id);
      sessions.set(task.id, createAgentServer({ ...options, stateDirectory: directory(task),
        remoteProxyPort: remoteProxyPort === 0 ? 0 : remoteProxyPort + task.proxyOffset,
        ...(task.id === DEFAULT_TASK_ID ? {} : { datasetPath: job?.inputPath ?? '' }),
        ...(job ? { batchRunPath: resultPath(batch, job) } : { batchToolAccess: {
          call: (params, state, assertCurrent) => handleBatchTool(task.id, params, state, assertCurrent),
          view: draft => {
            try { return batchPlanView(draft, batchConfig, !!ownedBatch(draft.id, task.id, draft.threadId)); }
            catch { return undefined; }
          },
        } }) }));
    }
    return sessions.get(task.id);
  }
  // Eagerly restore only the legacy journal, at its original path, without connecting.
  async function persist(next = tasks, deletions = pendingDeletions, offset = nextProxyOffset, nextBatches = batches) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(`${registryPath}.tmp`, JSON.stringify({ schema: 'tinylens.tasks.v1', tasks: next,
      nextProxyOffset: offset, pendingDeletions: deletions, batches: nextBatches }), { mode: 0o600 });
    await rename(`${registryPath}.tmp`, registryPath);
  }
  async function removeTaskFiles(id) {
    if (id !== DEFAULT_TASK_ID) {
      await rm(resolve(stateDirectory, 'tasks', id), { recursive: true, force: true });
      return;
    }
    // The legacy task shares the state root with the other task directories.
    for (const name of ['agent-state.json', 'agent-state.json.tmp', 'display-publications.json',
      'input-cache', 'result-cache', 'model-cache', 'mask-cache', 'display-cache', 'panel-cache']) {
      await rm(resolve(stateDirectory, name), { recursive: true, force: true });
    }
  }
  if (pendingDeletions.length) {
    for (const id of pendingDeletions) await removeTaskFiles(id);
    await persist(tasks, []);
    pendingDeletions = [];
  }
  const legacyTask = tasks.find(task => task.id === DEFAULT_TASK_ID);
  const legacy = legacyTask ? await session(legacyTask) : undefined;
  function mutate(operation) {
    const result = mutations.catch(() => {}).then(() => { if (closed) throw new Error('Task service is closed'); return operation(); });
    mutations = result;
    return result;
  }
  async function writeBatch(batch) {
    const next = batches.map(item => item.id === batch.id ? batch : item);
    await persist(tasks, pendingDeletions, nextProxyOffset, next);
    batches = next;
  }
  function setDispatch(id, job, dispatch, error) {
    return mutate(async () => {
      const batch = getBatch(id);
      const stored = batch?.jobs.find(item => item.taskId === job.taskId);
      if (!stored || stored.dispatch === 'removed' || (dispatch === 'starting' && (stored.dispatch !== 'queued' || batch.paused))) return false;
      const updated = { ...stored, dispatch, error };
      await writeBatch({ ...batch, jobs: batch.jobs.map(item => item === stored ? updated : item) });
      return true;
    });
  }
  const queue = createBatchQueue({ batches: () => batches, setDispatch, config: batchConfig, logger: options.logger,
    intervalMs: batchPollMs, session: id => session(tasks.find(task => task.id === id)) });

  function previousClaim(plan) {
    const paths = plan.targets.map(job => resultPath(plan, job));
    const occupied = batches.filter(batch => sameRuntime(batch, batchConfig)).flatMap(batch =>
      batch.jobs.filter(job => job.dispatch !== 'removed').map(job => resultPath(batch, job)));
    return paths.find(path => occupied.some(other => path === other || path.startsWith(other + '/') || other.startsWith(path + '/')));
  }
  async function handleBatchTool(taskId, params, state, assertCurrent) {
    const { threadId, turnId, callId, tool, arguments: args } = params;
    const lastUser = () => state.messages.findLast(message => message.role === 'user');
    const source = lastUser();
    if (tool === prepareBatchTool.name) {
      if (!source || source.delivery !== 'delivered' || source.questionId) throw Error('批次计划需要源自当前对话里已送达的用户消息。');
      let draft = state.batchDraft;
      if (draft?.threadId !== threadId || draft.turnId !== turnId || draft.callId !== callId) {
        const request = batchRequest(args, batchConfig.workspace);
        const plan = validatedBatchPlan(request, await batchInventory(request, batchConfig));
        assertCurrent();
        if (lastUser() !== source) throw Error('用户补充了消息，请根据最新要求重新整理批次。');
        assertUnclaimed(plan);
        draft = { id: `batch-${randomUUID()}`, threadId, turnId, callId, sourceMessageId: source.id, request, plan,
          workspace: batchConfig.workspace, sshHost: batchConfig.sshHost };
        state.batchDraft = draft;
      }
      return { id: draft.id, count: draft.plan.targets.length, inputDir: draft.plan.inputDir, outputDir: draft.plan.outputDir,
        parallelism: draft.request.parallelism, existing: draft.plan.targets.filter(job => job.runId !== null).length,
        status: 'awaiting_user_confirmation', message: '完整名单已放在对话里。请等用户对这份名单明确回复「确认提交这批」后再派发。' };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !validBatchId(args.id)) {
      throw Error('请提供当前对话中批次计划的 id。');
    }
    const receipt = ownedBatch(args.id, taskId, threadId);
    if (receipt) return { id: receipt.id, count: receipt.jobs.length, status: 'queued' };
    const draft = state.batchDraft;
    if (draft?.id !== args.id || draft.threadId !== threadId || !sameRuntime(draft, batchConfig)) {
      throw Error('请使用当前对话和当前 GPU 服务器配置下最新的批次名单。');
    }
    const before = state.messages.findIndex(message => message.id === draft.sourceMessageId && message.role === 'user');
    function assertConsent() {
      assertCurrent();
      if (state.batchDraft !== draft || before < 0 || state.messages.indexOf(source) <= before || lastUser() !== source
          || source?.seenBatchPlanId !== draft.id || !isBatchConfirmation(source)) {
        throw Error('请等用户在对话中核对这份名单后，明确回复「确认提交这批」。');
      }
    }
    assertConsent();
    const request = batchRequest(draft.request, batchConfig.workspace);
    const checked = validatedBatchPlan(request, await batchInventory(request, batchConfig));
    const batch = await confirmBatch(draft, taskId, request, checked, assertConsent);
    return { id: batch.id, count: batch.jobs.length, status: 'queued' };
  }
  function assertUnclaimed(plan) {
    const conflict = previousClaim(plan);
    if (conflict) throw Error(`该结果目录已属于一个网页批次：${conflict}`);
  }
  async function confirmBatch(draft, sourceTaskId, request, checked, assertConsent) {
    const { id, workspace, sshHost, threadId: sourceThreadId } = draft;
    return mutate(async () => {
      const saved = ownedBatch(id, sourceTaskId, sourceThreadId);
      if (saved) return saved;
      assertConsent();
      if (getBatch(id) || JSON.stringify(checked) !== JSON.stringify(validatedBatchPlan(request, draft.plan))) {
        throw Error('服务器上的名单或运行已变化，请重新预览并核对。');
      }
      assertUnclaimed(checked);
      const nextOffset = nextProxyOffset + checked.targets.length;
      if (remoteProxyPort + nextOffset - 1 > 65535) throw Error('批次所需的任务数量超过可用范围。');
      const createdAt = new Date().toISOString();
      const children = checked.targets.map((target, index) => ({ id: `task-${randomUUID()}`, name: target.lensId,
        batchId: id, createdAt, proxyOffset: nextProxyOffset + index }));
      const { targets, ...plan } = checked;
      const batch = { ...plan, id, workspace, sshHost, sourceTaskId, sourceThreadId, createdAt, paused: false,
        calibration: request.calibration, parallelism: request.parallelism,
        jobs: targets.map((target, index) => ({ ...target, taskId: children[index].id, dispatch: 'queued' })) };
      const nextTasks = [...tasks, ...children];
      const nextBatches = [...batches, batch];
      await persist(nextTasks, pendingDeletions, nextOffset, nextBatches);
      tasks = nextTasks; batches = nextBatches; nextProxyOffset = nextOffset;
      queue.wake();
      return batch;
    });
  }
  async function batchDetails(batch) {
    const jobs = await Promise.all(batch.jobs.map(async job => {
      const task = tasks.find(task => task.id === job.taskId);
      const state = task && ['submitted', 'start_failed'].includes(job.dispatch)
        ? await session(task).then(bridge => bridge.state, () => undefined) : undefined;
      return batchJobProgress(batch, job, state);
    }));
    return { ...publicBatch(batch, batchConfig), jobs };
  }
  async function createTask(data = {}) {
    return mutate(async () => {
      const proxyOffset = nextProxyOffset;
      if (remoteProxyPort + proxyOffset > 65535) throw new Error('Task limit reached');
      const task = { id: `task-${randomUUID()}`, name: data.name?.trim() || `新任务 ${proxyOffset}`,
        createdAt: new Date().toISOString(), proxyOffset };
      const bridge = await session(task);
      await bridge.persist();
      await persist([...tasks, task], pendingDeletions, proxyOffset + 1);
      tasks = [...tasks, task];
      nextProxyOffset = proxyOffset + 1;
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
  async function deleteTask(id) {
    return mutate(async () => {
      const task = tasks.find(task => task.id === id);
      if (!task && !pendingDeletions.includes(id)) {
        throw Object.assign(new Error('Task not found'), { statusCode: 404 });
      }
      deleting.add(id);
      let threadId;
      let taskClosed = false;
      try {
        if (task) {
          const batch = getBatch(task.batchId);
          const job = batch?.jobs.find(item => item.taskId === id);
          if (job && (job.dispatch === 'starting' || queue.isStarting(id))) {
            throw Object.assign(Error('批次正在派发该任务，请等当前发送结束。'), { statusCode: 409 });
          }
          const bridge = await session(task);
          await bridge.close({ onlyIfIdle: true });
          taskClosed = true;
          threadId = bridge.state.threadId;
          const remaining = tasks.filter(item => item.id !== id);
          const pending = [...pendingDeletions, id];
          const nextBatches = batch ? batches.map(item => item === batch ? { ...batch, jobs: batch.jobs.map(candidate =>
            candidate === job ? { ...job, dispatch: 'removed' } : candidate) } : item) : batches;
          await persist(remaining, pending, nextProxyOffset, nextBatches);
          tasks = remaining;
          batches = nextBatches;
          pendingDeletions = pending;
        }
        await removeTaskFiles(id);
        const pending = pendingDeletions.filter(item => item !== id);
        await persist(tasks, pending);
        pendingDeletions = pending;
        return { deleted: id, threadId };
      } finally {
        if (taskClosed) sessions.delete(id);
        deleting.delete(id);
      }
    });
  }
  async function catalog() {
    return Promise.all(tasks.map(async task => {
      const bridge = task.batchId ? await sessions.get(task.id)?.catch(() => undefined) : await session(task);
      const lastMessage = bridge?.state.messages.findLast(message => message.role === 'user');
      return { id: task.id, name: task.name, createdAt: task.createdAt, lastConversationAt: lastMessage?.at, batchId: task.batchId };
    }));
  }
  const server = http.createServer(async (request, response) => {
    const hosts = ['127.0.0.1:5173', 'localhost:5173', `127.0.0.1:${server.address()?.port}`, `localhost:${server.address()?.port}`];
    if (!hosts.includes(request.headers.host) || request.headers.origin && !hosts.some(host => request.headers.origin === `http://${host}`)) return json(response, 403, { error: 'Only local TinyLens requests are allowed' });
    if (closed) return json(response, 503, { error: 'Task service is closed' });
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/agent/batches') {
        if (request.method === 'GET') return json(response, 200, { batches: batches.map(batch => publicBatch(batch, batchConfig)).reverse() });
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname.startsWith('/api/agent/batches/')) {
        const [id, action, extra] = url.pathname.slice('/api/agent/batches/'.length).split('/');
        const batch = validBatchId(id) && getBatch(id);
        if (!batch || extra !== undefined) return json(response, 404, { error: '批次不存在。' });
        if (request.method === 'GET' && action === undefined) return json(response, 200, { batch: await batchDetails(batch) });
        if (request.method === 'POST' && action === 'dispatch') {
          const data = await readBody(request, 1024);
          if (Object.keys(data).length !== 1 || typeof data.paused !== 'boolean') throw Error('批次派发请求无效。');
          const updated = await mutate(async () => {
            const next = { ...getBatch(id), paused: data.paused };
            await writeBatch(next);
            return next;
          });
          queue.wake();
          return json(response, 200, { batch: await batchDetails(updated) });
        }
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname === '/api/agent/tasks') {
        if (request.method === 'GET') return json(response, 200, { tasks: await catalog() });
        if (request.method === 'POST') return json(response, 201, { task: await createTask(await body(request)) });
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname.startsWith('/api/agent/tasks/')) {
        const id = url.pathname.slice('/api/agent/tasks/'.length);
        if (!validId(id)) return json(response, 404, { error: 'Task not found' });
        if (request.method === 'DELETE') return json(response, 200, await deleteTask(id));
        if (!tasks.some(task => task.id === id)) return json(response, 404, { error: 'Task not found' });
        if (request.method !== 'PATCH') return json(response, 405, { error: 'Method not allowed' });
        const data = await body(request);
        if (typeof data.name !== 'string') throw new Error('A task name is required');
        return json(response, 200, { task: await renameTask(id, data.name) });
      }
      if (url.searchParams.getAll('taskId').length > 1) return json(response, 400, { error: 'Ambiguous task id' });
      const id = url.searchParams.get('taskId') ?? DEFAULT_TASK_ID;
      const task = validId(id) && tasks.find(item => item.id === id);
      if (!task) return json(response, 404, { error: 'Task not found' });
      if (deleting.has(id)) return json(response, 409, { error: '任务正在彻底删除。' });
      const batch = getBatch(task.batchId);
      if (batch && !sameRuntime(batch, batchConfig)) return json(response, 409, { error: '批次与当前 GPU 服务器配置不一致。' });
      const job = batch?.jobs.find(item => item.taskId === id);
      if (request.method === 'POST' && job && ['queued', 'starting'].includes(job.dispatch)) {
        return json(response, 409, { error: '该任务由批次队列派发。' });
      }
      const bridge = await session(task);
      // Task scope belongs to this router. Existing readers deliberately reject
      // any query fields besides their own report identifier and refresh flag.
      const originalUrl = request.url;
      url.searchParams.delete('taskId');
      request.url = url.pathname + url.search;
      try { await bridge.routeRequest(request, response); }
      finally { request.url = originalUrl; }
    } catch (error) {
      if (!response.headersSent) json(response, error.statusCode ?? 400, { error: error.message });
      else response.end();
    }
  });
  async function close() {
    queue.stop();
    closed = true;
    await mutations.catch(() => {});
    await Promise.all([...sessions.values()].map(async pending => {
      const bridge = await pending.catch(() => undefined);
      await bridge?.close();
    }));
    await queue.settled();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  // Only the instance that successfully owns the local server can dispatch work.
  server.once('listening', queue.activate);
  return { server, state: legacy?.state, createTask, catalog, close };
}
