import http from 'node:http';
import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAgentServer } from './agent-server.mjs';
import { readTaskName, taskNameFile, writeTaskName } from './agent-task-names.mjs';
import { connectionConfig } from './connection-config.mjs';
import { batchJobProgress, batchPlanView, batchRequest, isBatchConfirmation, prepareBatchTool, publicBatch, readBatchPlan,
  resultPath, restoreBatches, sameRuntime, validBatchId, validatedBatchPlan } from './agent-batches.mjs';
import { createBatchQueue } from './batch-queue.mjs';
import { readDisplayPublications, withDisplayPublications } from './display-publications.mjs';
import { deletionCandidates, isolateTaskRuns, remoteTaskRuns } from './agent-task-deletion.mjs';
import { initialState } from './agent-state.mjs';

const defaultDirectory = fileURLToPath(new URL('../.local/', import.meta.url));
const cleanupFile = 'remote-task-cleanup.json';
const invalidDeletionPlan = () => Object.assign(Error('删除清单已失效，请重新核对。'), { statusCode: 409 });
export const DEFAULT_TASK_ID = 'default';
const validId = id => id === DEFAULT_TASK_ID || /^task-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const mayAutoName = task => !!task && task.nameSource === 'default' && !task.batchId && task.id !== DEFAULT_TASK_ID;
function unusedBatchStart(state) {
  return state?.status === 'idle' && ['error', 'disconnected'].includes(state.connection)
    && state.threadId === null && state.turnId === null && state.lastTurnId === null
    && state.remoteActive === false && state.needsReconcile === false
    && [state.messages, state.updates, state.activities, state.questions, state.requests, state.finishedTurnIds]
      .every(items => Array.isArray(items) && items.length === 0);
}
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
  batchInventory = readBatchPlan, batchConfig = connectionConfig, batchPollMs, removeRemoteRuns = remoteTaskRuns, ...options } = {}) {
  const registryPath = resolve(stateDirectory, 'agent-tasks.json');
  let tasks;
  let batches = [];
  let pendingDeletions = [];
  let nextProxyOffset;
  try {
    const saved = JSON.parse(await readFile(registryPath, 'utf8'));
    if (saved.schema !== 'tinylens.tasks.v1' || !Array.isArray(saved.tasks)
      || saved.tasks.some(task => !validId(task.id) || typeof task.name !== 'string' || task.name.length > 120
        || (task.nameSource !== undefined && !['default', 'manual'].includes(task.nameSource))
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
  const deletionPlans = new Map();
  const batchStartGuards = new Set();
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
        taskNameHandler: job ? undefined : (suggestion, assertCurrent) => nameTask(task.id, suggestion, assertCurrent),
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
    for (const name of ['agent-state.json', 'agent-state.json.tmp', 'display-publications.json', taskNameFile, cleanupFile, `${cleanupFile}.tmp`,
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
  async function nameTask(id, { name, threadId }, assertCurrent) {
    return mutate(async () => {
      const task = tasks.find(item => item.id === id);
      if (!mayAutoName(task)) return false;
      assertCurrent();
      return writeTaskName(directory(task), id, threadId, name, assertCurrent);
    });
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
  async function failedBatchStart(batch, job, task) {
    const path = resolve(directory(task), 'agent-state.json');
    try {
      const saved = await persistedJson(path);
      const live = (await sessions.get(task.id))?.state;
      const state = live ?? (Array.isArray(saved?.messages) ? initialState(saved) : undefined);
      // Restoration clears transient fields such as requests and remoteActive.
      // Verify the untouched journal too, and require a completed journal write.
      const verified = unusedBatchStart(saved) && (!live || unusedBatchStart(live))
        && saved.workspace === batch.workspace && saved.datasetPath === job.inputPath
        && await lstat(`${path}.tmp`).then(() => false, error => error.code === 'ENOENT');
      return { state, verified };
    } catch { return {}; }
  }
  async function batchDetails(batch) {
    const compatible = sameRuntime(batch, batchConfig);
    const details = await Promise.all(batch.jobs.map(async job => {
      const task = tasks.find(task => task.id === job.taskId && task.batchId === batch.id);
      const failed = task && job.dispatch === 'start_failed' ? await failedBatchStart(batch, job, task) : undefined;
      const state = task && job.dispatch === 'submitted'
        ? await session(task).then(bridge => bridge.state, () => undefined) : failed?.state;
      const delivered = state?.threadId && state.messages.some(message => message.role === 'user' && message.delivery === 'delivered'
        && (message.threadId === undefined || message.threadId === state.threadId));
      return { job: { ...batchJobProgress(batch, job, state), ...(delivered && { delivered: true }) },
        retryable: compatible && failed?.verified && !batchStartGuards.has(task.id) && !deleting.has(task.id) };
    }));
    return { ...publicBatch(batch, batchConfig), retryableStartCount: details.filter(detail => detail.retryable).length,
      jobs: details.map(detail => detail.job) };
  }
  function retryBatchStart(id) {
    return mutate(async () => {
      const batch = getBatch(id);
      if (!sameRuntime(batch, batchConfig)) {
        throw Object.assign(Error('批次与当前 GPU 服务器配置不一致。'), { statusCode: 409 });
      }
      const candidates = [];
      for (const job of batch.jobs) {
        if (job.dispatch !== 'start_failed' || deleting.has(job.taskId) || queue.isStarting(job.taskId)
            || batchStartGuards.has(job.taskId)) continue;
        const task = tasks.find(task => task.id === job.taskId && task.batchId === id);
        if (!task) continue;
        batchStartGuards.add(task.id);
        candidates.push({ job, task });
      }
      try {
        const checked = await Promise.all(candidates.map(async ({ job, task }) => ({
          job, verified: (await failedBatchStart(batch, job, task)).verified,
        })));
        const retry = new Set(checked.filter(item => item.verified).map(item => item.job));
        const next = retry.size ? { ...batch, jobs: batch.jobs.map(job => {
          if (!retry.has(job)) return job;
          const updated = { ...job, dispatch: 'queued' };
          delete updated.error;
          return updated;
        }) } : batch;
        if (retry.size) await writeBatch(next);
        return { requeued: retry.size, batch: next };
      } finally {
        for (const { task } of candidates) batchStartGuards.delete(task.id);
      }
    });
  }
  async function createTask(data = {}) {
    return mutate(async () => {
      const proxyOffset = nextProxyOffset;
      if (remoteProxyPort + proxyOffset > 65535) throw new Error('Task limit reached');
      const name = data.name?.trim();
      const task = { id: `task-${randomUUID()}`, name: name || `新任务 ${proxyOffset}`, nameSource: name ? 'manual' : 'default',
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
      const title = name.trim();
      if (!title) {
        const bridge = mayAutoName(old) && await session(old);
        const automatic = bridge && await readTaskName(directory(old), id, bridge.state.threadId);
        return automatic ? { ...old, name: automatic } : old;
      }
      const next = { ...old, name: title, nameSource: 'manual' };
      const updated = tasks.map(task => task.id === id ? next : task);
      await persist(updated); tasks = updated; return next;
    });
  }
  async function persistedJson(path) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function taskRunScope(task, bridge) {
    const taskFolder = directory(task);
    const state = bridge?.state ?? (await sessions.get(task.id))?.state ?? await persistedJson(resolve(taskFolder, 'agent-state.json'));
    const publication = await readDisplayPublications(taskFolder, options.logger ?? console);
    const batch = getBatch(task.batchId);
    const job = batch?.jobs.find(candidate => candidate.taskId === task.id);
    const jobScope = job && { path: resultPath(batch, job), inputPath: job.inputPath, runId: job.runId };
    const candidates = deletionCandidates(state && withDisplayPublications(state, publication), batchConfig.workspace, jobScope);
    const others = await Promise.all(tasks.filter(other => other.id !== task.id).map(async other => {
      const saved = (await sessions.get(other.id))?.state ?? await persistedJson(resolve(directory(other), 'agent-state.json'));
      return deletionCandidates(saved, batchConfig.workspace).map(item => item.path);
    }));
    const reserved = batches.filter(batch => sameRuntime(batch, batchConfig)).flatMap(batch => batch.jobs
      .filter(job => job.dispatch !== 'removed' && job.taskId !== task.id).map(job => resultPath(batch, job)));
    if (batch && !sameRuntime(batch, batchConfig)) return { eligible: [], retained: candidates.map(item => item.path) };
    return isolateTaskRuns(candidates, [...others.flat(), ...reserved], jobScope);
  }
  async function performRemoteCleanup(mode, candidates) {
    try { return await removeRemoteRuns(mode, candidates, batchConfig); }
    catch (error) {
      options.logger?.error('GPU result cleanup request failed:', error.message);
      throw Object.assign(Error('暂时无法连接 GPU 服务器清理结果，请重试。'), { statusCode: 502 });
    }
  }
  async function prepareDeletion(id) {
    return mutate(async () => {
      const task = tasks.find(item => item.id === id);
      if (!task) throw Object.assign(Error('Task not found'), { statusCode: 404 });
      const bridge = await session(task);
      const { eligible, retained } = await taskRunScope(task, bridge);
      const journal = await persistedJson(resolve(directory(task), cleanupFile));
      if (journal && (journal.schema !== 'tinylens.remote-task-cleanup.v1' || journal.threadId !== bridge.state.threadId
          || journal.workspace !== batchConfig.workspace || journal.sshHost !== batchConfig.sshHost || !Array.isArray(journal.runs))) {
        throw Object.assign(Error('待清理的任务结果与当前 GPU 配置不一致。'), { statusCode: 409 });
      }
      const previous = new Map(journal?.runs.map(run => [run.path, run.fingerprint]));
      const requested = eligible.map(item => previous.has(item.path) ? { ...item, fingerprint: previous.get(item.path) } : item);
      const result = await performRemoteCleanup('preview', requested);
      const verified = new Map(result.runs.map(run => [run.path, run.fingerprint]));
      const token = randomUUID();
      const runs = requested.filter(item => verified.has(item.path)).map(item => ({ ...item, fingerprint: verified.get(item.path) }));
      deletionPlans.set(id, { token, threadId: bridge.state.threadId, runs, scope: JSON.stringify({ eligible, retained }) });
      return { token, runs: runs.map(run => run.path),
        retained: [...new Set([...retained, ...result.retained.filter(item => item.reason !== 'missing').map(item => item.path)])] };
    });
  }
  async function deleteTask(id, token) {
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
          const plan = deletionPlans.get(id);
          if (!plan || token !== plan.token) throw invalidDeletionPlan();
          const batch = getBatch(task.batchId);
          const job = batch?.jobs.find(item => item.taskId === id);
          if (job && (job.dispatch === 'starting' || queue.isStarting(id))) {
            throw Object.assign(Error('批次正在派发该任务，请等当前发送结束。'), { statusCode: 409 });
          }
          const bridge = await session(task);
          if (bridge.state.threadId !== plan.threadId) throw invalidDeletionPlan();
          await bridge.close({ onlyIfIdle: true });
          taskClosed = true;
          threadId = bridge.state.threadId;
          if (JSON.stringify(await taskRunScope(task, bridge)) !== plan.scope) throw invalidDeletionPlan();
          if (plan.runs.length) {
            const path = resolve(directory(task), cleanupFile);
            const record = { schema: 'tinylens.remote-task-cleanup.v1', threadId,
              workspace: batchConfig.workspace, sshHost: batchConfig.sshHost, runs: plan.runs };
            await writeFile(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
            await rename(`${path}.tmp`, path);
            const result = await performRemoteCleanup('delete', plan.runs);
            if (result.retained.length || result.runs.length !== plan.runs.length) {
              throw Object.assign(Error('服务器结果已变化或暂时无法清理，请重新核对删除清单。'), { statusCode: 409 });
            }
          }
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
        deletionPlans.delete(id);
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
      const automatic = mayAutoName(task) && await readTaskName(directory(task), task.id, bridge?.state.threadId);
      return { id: task.id, name: automatic || task.name, createdAt: task.createdAt,
        lastConversationAt: lastMessage?.at, batchId: task.batchId };
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
        if (request.method === 'POST' && action === 'retry-start') {
          const data = await readBody(request, 1024);
          if (url.search || Object.keys(data).length) throw Error('批次重派请求无效。');
          const result = await retryBatchStart(id);
          if (result.requeued) queue.wake();
          return json(response, 200, { requeued: result.requeued, batch: await batchDetails(result.batch) });
        }
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname === '/api/agent/tasks') {
        if (request.method === 'GET') return json(response, 200, { tasks: await catalog() });
        if (request.method === 'POST') return json(response, 201, { task: await createTask(await body(request)) });
        return json(response, 405, { error: 'Method not allowed' });
      }
      if (url.pathname.startsWith('/api/agent/tasks/')) {
        const [id, action, extra] = url.pathname.slice('/api/agent/tasks/'.length).split('/');
        if (!validId(id) || extra !== undefined || url.search) return json(response, 404, { error: 'Task not found' });
        if (action === 'deletion-plan' && request.method === 'GET') return json(response, 200, await prepareDeletion(id));
        if (action !== undefined) return json(response, 404, { error: 'Task not found' });
        if (request.method === 'DELETE') {
          if (!tasks.some(task => task.id === id) && !pendingDeletions.includes(id)) return json(response, 404, { error: 'Task not found' });
          const data = await readBody(request, 1024);
          if (Object.keys(data).length !== 1 || typeof data.token !== 'string') throw invalidDeletionPlan();
          return json(response, 200, await deleteTask(id, data.token));
        }
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
      if (request.method === 'POST' && job && (['queued', 'starting'].includes(job.dispatch) || batchStartGuards.has(id))) {
        return json(response, 409, { error: '该任务由批次队列派发。' });
      }
      // A manual command on a failed task must not overlap a bulk retry check.
      const guarded = request.method === 'POST' && job?.dispatch === 'start_failed';
      if (guarded) batchStartGuards.add(id);
      // Task scope belongs to this router. Existing readers deliberately reject
      // any query fields besides their own report identifier and refresh flag.
      const originalUrl = request.url;
      url.searchParams.delete('taskId');
      request.url = url.pathname + url.search;
      try { await (await session(task)).routeRequest(request, response); }
      finally {
        request.url = originalUrl;
        if (guarded) batchStartGuards.delete(id);
      }
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
