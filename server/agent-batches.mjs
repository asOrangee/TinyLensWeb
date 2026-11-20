import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { connectionConfig, shellQuote } from './connection-config.mjs';
import { archiveForReport, stageReportSchema } from './stage-reports.mjs';

export const maxBatchSize = 500;
export const maxBatchParallelism = 16;
export const validBatchId = id => typeof id === 'string' && /^batch-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const validLensId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(id);
const validRunId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const absolute = path => typeof path === 'string' && path.length <= 3900 && posix.isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const integerIn = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;
const execute = promisify(execFile);
const reader = await readFile(new URL('./read-batch-plan.py', import.meta.url), 'utf8');

export const prepareBatchTool = {
  type: 'function', name: 'tinylens_prepare_batch',
  description: 'Prepare a read-only TinyLensWeb plan when the user requests an independently scheduled batch of strong-lens targets. Use the conversation to obtain the server input and output directories and an exact ID list or selection rule. Ask about missing information. The plan uses the standard workflow through M3 and continues compatible existing runs. This tool displays the validated targets in the conversation. Describe the plan and wait for the user to confirm it in a later message, for example 确认提交这批 or Confirm batch. Prepare a new plan for changed scope. Use tinylens_dispatch_batch to dispatch the confirmed plan.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['inputDir', 'outputDir', 'selection'], properties: {
      inputDir: { type: 'string', description: 'Absolute server directory containing the lens directories.' },
      outputDir: { type: 'string', description: 'Absolute batch directory under the Pipeline output directory.' },
      selection: { type: 'object', additionalProperties: false, description: 'Use either ids, or count with an optional prefix. The count selects the first N matching IDs in lexical order.', properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: maxBatchSize },
        count: { type: 'integer', minimum: 1, maximum: maxBatchSize }, prefix: { type: 'string' },
      } },
      parallelism: { type: 'integer', minimum: 1, maximum: maxBatchParallelism, description: 'Maximum active dispatch slots for this batch. Defaults to 4.' },
      calibration: { type: 'string', description: 'Input calibration information provided by the user, to be verified by the workflow.' },
    },
  },
};

export const dispatchBatchTool = {
  type: 'function', name: 'tinylens_dispatch_batch',
  description: 'Queue the current validated plan from tinylens_prepare_batch after the user explicitly confirms that plan in a later message in this conversation. A confirmation such as 确认提交这批 or Confirm batch is sufficient. This creates an independent TinyLens task per lens and uses the existing GPU runner. It cannot answer scientific questions, change the selected targets, or approve commands.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
};

const confirmations = new Set(['确认提交', '确认提交这批', '确认这批名单', '确认这个批次', '就按这个名单跑', '按这个名单提交',
  '按这份名单开始', '按这个批次开始', 'confirm batch', 'submit this batch', 'go ahead with this batch']);

export function isBatchConfirmation(message) {
  return message?.role === 'user' && message.delivery === 'delivered' && !message.questionId && typeof message.text === 'string'
    && confirmations.has(message.text.normalize('NFKC').trim().toLowerCase().replace(/[.!。！]+$/u, '').trim());
}

export function batchRequest(value, workspace = connectionConfig.workspace) {
  if (!keys(value, ['inputDir', 'outputDir', 'selection', 'parallelism', 'calibration'])) throw Error('批次请求格式无效。');
  if (!absolute(value.inputDir) || !absolute(value.outputDir)) throw Error('请填写服务器上的绝对路径。');
  const outputDir = posix.normalize(value.outputDir).replace(/\/$/, '');
  const root = workspace + '/output';
  if ((outputDir !== root && !outputDir.startsWith(root + '/')) || outputDir.split('/').includes('_archive') || outputDir.length > 3800) {
    throw Error(`批次输出目录须位于 ${root} 下。`);
  }
  const selection = value.selection;
  if (keys(selection, ['ids'])) {
    if (!Array.isArray(selection.ids) || !integerIn(selection.ids.length, maxBatchSize)
        || !selection.ids.every(validLensId) || new Set(selection.ids).size !== selection.ids.length) {
      throw Error(`请输入 1 至 ${maxBatchSize} 个不同的 lens ID。`);
    }
  } else if (!keys(selection, ['count', 'prefix']) || !integerIn(selection.count, maxBatchSize)
      || (selection.prefix !== undefined && selection.prefix !== '' && !validLensId(selection.prefix))) {
    throw Error(`请输入有效的 ID 前缀与目标数量（1 至 ${maxBatchSize}）。`);
  }
  const parallelism = value.parallelism ?? 4;
  if (!integerIn(parallelism, maxBatchParallelism)) throw Error(`并发任务上限须为 1 至 ${maxBatchParallelism}。`);
  const calibration = value.calibration ?? '';
  if (typeof calibration !== 'string' || calibration.length > 4000 || calibration.includes('\0')) throw Error('输入标定说明过长或格式无效。');
  return { inputDir: value.inputDir, outputDir, selection, parallelism, calibration: calibration.trim() };
}

export async function readBatchPlan(request, config = connectionConfig) {
  let response;
  try {
    const query = { inputDir: request.inputDir, outputDir: request.outputDir, selection: request.selection, workspace: config.workspace };
    const command = [shellQuote(config.python), '-B', '-c', shellQuote(reader), shellQuote(JSON.stringify(query))].join(' ');
    const { stdout } = await execute('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.sshHost, command],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    response = JSON.parse(stdout);
  } catch {
    throw Object.assign(Error('无法读取 GPU 服务器上的批次目录。请检查连接后重试。'), { statusCode: 503 });
  }
  if (typeof response?.error === 'string') throw Error(response.error);
  return response?.plan;
}

export function validatedBatchPlan(request, plan) {
  const count = request.selection.ids?.length ?? request.selection.count;
  if (!object(plan) || !absolute(plan.inputDir) || plan.outputDir !== request.outputDir || !absolute(plan.python)
      || !Array.isArray(plan.targets) || plan.targets.length !== count || !plan.targets.every(validTarget)
      || plan.targets.some((target, index) => request.selection.ids
        ? target.lensId !== request.selection.ids[index] : !target.lensId.startsWith(request.selection.prefix ?? ''))
      || new Set(plan.targets.map(target => target.lensId)).size !== count) throw Error('服务器返回的批次清单与请求不一致。');
  return { inputDir: plan.inputDir, outputDir: plan.outputDir, python: plan.python,
    targets: plan.targets.map(({ lensId, inputPath, runId }) => ({ lensId, inputPath, runId })) };
}

function validTarget(target) {
  return object(target) && validLensId(target.lensId) && absolute(target.inputPath)
    && posix.basename(target.inputPath) === target.lensId && (target.runId === null || validRunId(target.runId));
}

export const resultPath = (batch, job) => posix.join(batch.outputDir, job.lensId);
export const sameRuntime = (batch, config) => batch.workspace === config.workspace && batch.sshHost === config.sshHost;

export function restoreBatches(value, tasks) {
  const known = new Map(tasks.map(task => [task.id, task.batchId]));
  const usedTasks = new Set();
  const usedBatches = new Set();
  if (!Array.isArray(value)) throw Error('Invalid saved batch registry');
  for (const batch of value) {
    if (!object(batch) || !validBatchId(batch.id) || usedBatches.has(batch.id) || !Number.isFinite(Date.parse(batch.createdAt))
        || !absolute(batch.workspace) || !absolute(batch.inputDir) || !absolute(batch.outputDir) || !absolute(batch.python)
        || typeof batch.calibration !== 'string' || typeof batch.sshHost !== 'string' || typeof batch.paused !== 'boolean'
        || !integerIn(batch.parallelism, maxBatchParallelism) || !Array.isArray(batch.jobs) || !integerIn(batch.jobs.length, maxBatchSize)) {
      throw Error('Invalid saved batch');
    }
    usedBatches.add(batch.id);
    const lenses = new Set();
    for (const job of batch.jobs) {
      if (!validTarget(job) || lenses.has(job.lensId) || !['queued', 'starting', 'submitted', 'start_failed', 'removed'].includes(job.dispatch)
          || typeof job.taskId !== 'string' || usedTasks.has(job.taskId)
          || (job.dispatch === 'removed' ? known.has(job.taskId) : known.get(job.taskId) !== batch.id)) throw Error('Invalid saved batch task');
      usedTasks.add(job.taskId);
      lenses.add(job.lensId);
    }
  }
  if (tasks.some(task => task.batchId !== undefined && !usedTasks.has(task.id))) throw Error('Invalid saved batch task membership');
  return value;
}

export function batchMessage(batch, job) {
  const output = resultPath(batch, job);
  const python = shellQuote(batch.python);
  const runner = shellQuote(`${batch.workspace}/scripts/run_lens_stage_on_idle_gpu.sh`);
  return [
    `请使用 $lens-model-orchestrator 为 ${job.lensId} 执行单目标强引力透镜建模。这是我在网页确认的批次 ${batch.id} 中的一项。`,
    `Repository Root: ${batch.workspace}`,
    `Input Lens Directory: ${job.inputPath}`,
    `Lens ID: ${job.lensId}`,
    `Batch Output Directory: ${batch.outputDir}`,
    `Lens Result Directory: ${output}`,
    `Lens Agent Command: ${python} -m lens_agent.cli`,
    `GPU Stage Command: ${runner} --python ${python}`,
    job.runId ? `请核对并继续 run_id 为 ${job.runId} 的已有运行，保留其已接受阶段。`
      : '清单确认时没有现行运行，请按新运行预检。',
    '先核对该 lens 的 FITS、目录、标定和运行清单。若运行标识或输入与确认的计划不符，或已有另一个活动工作流，请报告冲突并等待我的决定。保留科学门槛、原始输入、已有结果和运行几何，沿用当前审批和工作流。',
    batch.calibration && `我提供的输入标定说明（须与数据核对）：\n${batch.calibration}`,
    '只处理这个 lens，按现有工作流走到 M3 或正式人工审查。请把本 lens 的总结放在对话中，避免多个会话同时写共享批次目录的 summary.csv。',
    '请用 tinylens_ui_report 报告预检、A、B、M0 至 M3 的进度与已有产物，带 run_id、run_path、lens_id、stage 和 attempt。GPU runner 确认在等待空闲 GPU 时报告 queued，开始计算报告 running，计算完成与科学审查分别上报。核验后用正式接受头报告 accepted。若正式转人工审查，请报告 human_review 和对应的 preflight/inspector.json 或 attempts/<stage>/<attempt>/decision.json。恢复已达终态的运行时，也请核验并上报其现有终态。遇到需要我决定的事项，请在本会话提问。',
  ].filter(Boolean).join('\n');
}

export function openBatchQuestion(state) {
  return state.questions.some(question => question.threadId === state.threadId && ['pending', 'sending', 'delivery_unknown'].includes(question.status));
}

export function batchJobProgress(batch, job, state) {
  const base = { taskId: job.taskId, lensId: job.lensId, runPath: resultPath(batch, job),
    existing: job.runId !== null, canOpen: !['queued', 'starting', 'removed'].includes(job.dispatch) };
  if (job.dispatch === 'queued' || job.dispatch === 'removed') return { ...base, status: job.dispatch };
  if (job.dispatch === 'starting') return { ...base, status: 'starting' };
  if (!state) return { ...base, status: 'attention', message: job.error || '无法读取该任务的会话记录。' };
  const reports = state.updates.filter(report => report.threadId === state.threadId && report.schema === stageReportSchema
    && report.run_path === base.runPath && report.lens_id === job.lensId);
  const archives = new Set(reports.filter(archiveForReport).map(report => report.run_id));
  const current = reports.filter(report => report.kind === 'stage' && !archives.has(report.run_id));
  const latest = current.at(-1);
  const terminal = latest && current.findLast(report => report.run_id === latest.run_id
    && (report.status === 'human_review' || (report.stage === 'm3' && report.status === 'accepted')));
  const waiting = state.status === 'waiting' || state.requests.length > 0 || openBatchQuestion(state);
  const active = state.remoteActive || !!state.turnId;
  const uncertain = state.needsReconcile || state.messages.some(message => message.role === 'user' && message.delivery === 'unknown');
  let status;
  if (waiting) status = 'waiting_user';
  else if (terminal) status = terminal.status;
  else if (uncertain && state.connection !== 'connected') status = 'unconfirmed';
  else if (active) status = latest?.turnId === state.turnId && latest?.status === 'queued' ? 'waiting_gpu' : 'running';
  else if (uncertain) status = 'unconfirmed';
  else status = state.error || job.error || job.dispatch === 'start_failed' ? 'attention' : 'incomplete';
  const report = (status === 'accepted' || status === 'human_review') ? terminal : latest;
  const detail = (status === 'attention' || status === 'unconfirmed' ? state.error || job.error : undefined) || report?.message;
  return { ...base, status, stage: report?.stage, stageStatus: report?.status, updatedAt: report?.at,
    message: typeof detail === 'string' && detail.length > 320 ? `${detail.slice(0, 319)}…` : detail };
}

export function publicBatch(batch, config) {
  return { id: batch.id, name: posix.basename(batch.outputDir), createdAt: batch.createdAt, size: batch.jobs.length,
    inputDir: batch.inputDir, outputDir: batch.outputDir, parallelism: batch.parallelism, paused: batch.paused, compatible: sameRuntime(batch, config) };
}

export function batchPlanView(draft, config, submitted = false) {
  if (!object(draft) || !validBatchId(draft.id) || !sameRuntime(draft, config)) return undefined;
  const request = batchRequest(draft.request, config.workspace);
  const plan = validatedBatchPlan(request, draft.plan);
  return { id: draft.id, status: submitted ? 'submitted' : 'preview', inputDir: plan.inputDir, outputDir: plan.outputDir,
    parallelism: request.parallelism, targets: plan.targets.map(({ lensId, runId }) => ({ lensId, existing: runId !== null })),
    ...(!submitted && { message: batchMessage({ ...plan, id: draft.id, workspace: draft.workspace, calibration: request.calibration }, plan.targets[0]) }) };
}
