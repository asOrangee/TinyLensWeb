import { randomUUID } from 'node:crypto';
import { receiveQuestionReport, restoreQuestions, QUESTION_FORMAT } from './agent-questions.mjs';
import { connectionConfig } from './connection-config.mjs';
export const WORKSPACE = connectionConfig.workspace;
export const DATASET = connectionConfig.dataset;
const statuses = ['idle', 'running', 'waiting', 'interrupted', 'completed', 'failed'];
const terminal = ['completed', 'interrupted', 'failed'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? structuredClone(value) : [];
const tail = (text = '', n = 24000) => String(text).slice(-n);
export function initialState(saved = {}) {
  if (!record(saved)) saved = {};
  const messages = list(saved.messages).filter(record);
  for (const message of messages) if (message.delivery === 'pending') message.delivery = 'unknown';
  const questions = restoreQuestions(saved.questions, messages);
  const uncertain = Boolean(saved.needsReconcile || messages.some(m => m.delivery === 'unknown') || questions.some(question => question.status === 'delivery_unknown'));
  return { connection: 'disconnected', threadId: typeof saved.threadId === 'string' ? saved.threadId : null, turnId: null,
    lastTurnId: saved.turnId || saved.lastTurnId || null, finishedTurnIds: list(saved.finishedTurnIds).filter(id => typeof id === 'string').slice(-100),
    status: ['running', 'waiting'].includes(saved.status) ? 'interrupted' : statuses.includes(saved.status) ? saved.status : 'idle',
    messages, questions, activities: list(saved.activities).filter(record).map(activity => ({ ...activity,
      status: activity.status === 'inProgress' ? 'interrupted' : activity.status })), requests: [], updates: list(saved.updates).filter(record),
    remoteActive: false, needsReconcile: uncertain,
    error: uncertain ? 'A previous message has unconfirmed delivery. Reconnect to inspect the existing conversation; it will not be resent automatically.' : null,
    datasetPath: DATASET, workspace: WORKSPACE };
}
export function normalizeStage(value) {
  if (typeof value !== 'string') throw new Error('Unknown stage');
  const stage = value.trim().toUpperCase();
  if (!['PREFLIGHT', 'A', 'B', 'M0', 'M1', 'M2', 'M3'].includes(stage)) throw new Error('Unknown stage');
  return stage === 'PREFLIGHT' ? 'preflight' : stage;
}
export function hasBlockingRequest(state) {
  return state.requests.some(request => request.method !== 'item/tool/requestUserInput' || request.params.isBlocking !== false);
}
function refreshStatus(state) {
  if (hasBlockingRequest(state)) state.status = 'waiting';
  else if (state.turnId || state.remoteActive) state.status = 'running';
}
export function applyTurn(state, turn) {
  if (!record(turn) || typeof turn.id !== 'string') return false;
  if (turn.status === 'inProgress') {
    // An RPC response may arrive after the completion notification for this turn.
    if (state.finishedTurnIds.includes(turn.id) || (state.turnId && state.turnId !== turn.id)) return false;
    state.turnId = turn.id; state.lastTurnId = turn.id; state.remoteActive = true;
    state.requests = state.requests.filter(request => (request.scope?.rootTurnId ?? request.params.turnId) === turn.id);
    state.error = null; refreshStatus(state); return true;
  }
  if (!terminal.includes(turn.status) || (state.turnId && state.turnId !== turn.id)
    || (!state.turnId && state.lastTurnId && state.lastTurnId !== turn.id)) return false;
  state.turnId = null; state.lastTurnId = turn.id; state.remoteActive = false;
  state.finishedTurnIds = [...new Set([...state.finishedTurnIds, turn.id])].slice(-100);
  state.requests = state.requests.filter(request => (request.scope?.rootTurnId ?? request.params.turnId) !== turn.id);
  state.status = turn.status;
  state.error = turn.error?.message || (turn.status === 'failed' ? 'AI turn failed' : null);
  return true;
}
export function receiveNotification(state, method, params = {}) {
  if (!record(params)) return false;
  // Thread-scoped notifications must actually identify the bound thread.
  if (method !== 'error' && (!state.threadId || params.threadId !== state.threadId)) {
    // Only lifecycle events for an already verified pending child request may
    // affect root UI state. Child messages, reports and science status stay separate.
    const before = state.requests.length;
    state.requests = state.requests.filter(request => {
      if (!request.scope || request.params.threadId !== params.threadId) return true;
      if (method === 'serverRequest/resolved') return request.id !== params.requestId;
      if (method === 'turn/completed' && terminal.includes(params.turn?.status)) return request.params.turnId !== params.turn.id;
      if (method === 'thread/status/changed' && ['idle', 'systemError', 'notLoaded'].includes(params.status?.type)) return false;
      return true;
    });
    if (state.requests.length === before) return false;
    refreshStatus(state); return true;
  }
  if (method === 'error' && params.threadId && params.threadId !== state.threadId) return false;
  const item = params.item;
  if (method === 'item/agentMessage/delta') {
    if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') return false;
    let message = state.messages.find(m => m.id === params.itemId);
    if (message?.complete) return false;
    if (!message) { message = { id: params.itemId, role: 'assistant', text: '' }; state.messages.push(message); }
    message.text += params.delta;
  } else if ((method === 'item/started' || method === 'item/completed') && record(item) && typeof item.id === 'string') {
    if (item.type === 'agentMessage') {
      let message = state.messages.find(m => m.id === item.id);
      if (!message) { message = { id: item.id, role: 'assistant', text: '' }; state.messages.push(message); }
      if (message.complete && method === 'item/started') return false;
      if (typeof item.text === 'string') message.text = item.text;
      message.phase = item.phase; message.complete = method === 'item/completed';
    } else if (['commandExecution', 'fileChange', 'collabAgentToolCall', 'dynamicToolCall', 'mcpToolCall', 'webSearch'].includes(item.type)) {
      let activity = state.activities.find(a => a.id === item.id);
      if (activity?.complete && method === 'item/started') return false;
      if (!activity) { activity = { id: item.id, type: item.type }; state.activities.push(activity); }
      Object.assign(activity, { title: item.command || item.tool || item.type,
        status: item.status || (method === 'item/completed' ? 'completed' : 'inProgress'), complete: method === 'item/completed',
        detail: item.cwd || '', output: tail(item.aggregatedOutput ?? activity.output ?? '') });
    } else return false;
  } else if (method === 'item/commandExecution/outputDelta') {
    const activity = state.activities.find(a => a.id === params.itemId);
    if (!activity || activity.complete || typeof params.delta !== 'string') return false;
    activity.output = tail((activity.output || '') + params.delta);
  } else if (method === 'turn/started' || method === 'turn/completed') {
    if (method === 'turn/started' && params.turn?.status !== 'inProgress') return false;
    if (method === 'turn/completed' && !terminal.includes(params.turn?.status)) return false;
    if (!applyTurn(state, params.turn)) return false;
  } else if (method === 'serverRequest/resolved') {
    const index = state.requests.findIndex(r => r.id === params.requestId);
    if (index === -1) return false;
    state.requests.splice(index, 1); refreshStatus(state);
  } else if (method === 'thread/status/changed') {
    if (!record(params.status)) return false;
    state.remoteActive = params.status.type === 'active';
    if (state.remoteActive) refreshStatus(state);
    else if (params.status.type === 'systemError') { state.status = 'failed'; state.error = 'The pipeline AI reported a system error'; }
  } else if (method === 'error') {
    if (params.turnId && params.turnId !== state.turnId) return false;
    state.error = params.error?.message || params.message || 'AI protocol error';
  } else return false;
  state.activities = state.activities.slice(-120);
  return true;
}
export function restoreThread(state, thread, turns = thread?.turns || []) {
  if (!record(thread) || typeof thread.id !== 'string' || (state.threadId && thread.id !== state.threadId)) throw new Error('Unexpected thread in resume response');
  state.threadId = thread.id; state.turnId = null; state.requests = [];
  const orderedTurns = Array.isArray(turns) ? turns : [];
  for (const turn of orderedTurns) {
    for (const item of turn.items || []) {
      if (item.type !== 'agentMessage') continue;
      receiveNotification(state, turn.status === 'inProgress' ? 'item/started' : 'item/completed', { threadId: state.threadId, turnId: turn.id, item });
    }
    if (terminal.includes(turn.status)) state.finishedTurnIds = [...new Set([...state.finishedTurnIds, turn.id])].slice(-100);
  }
  const latest = orderedTurns.at(-1);
  const active = thread.status?.type === 'active';
  state.remoteActive = active;
  if (active) {
    const inProgress = orderedTurns.findLast(turn => turn.status === 'inProgress');
    if (inProgress) {
      state.finishedTurnIds = state.finishedTurnIds.filter(id => id !== inProgress.id);
      state.turnId = inProgress.id; state.lastTurnId = inProgress.id;
    }
    state.status = thread.status.activeFlags?.length ? 'waiting' : 'running';
  } else if (thread.status?.type === 'systemError') {
    state.status = 'failed'; state.error = 'The pipeline AI reported a system error';
  } else if (latest && terminal.includes(latest.status)) {
    state.lastTurnId = latest.id; state.status = latest.status; state.error = latest.error?.message || null;
  } else if (latest?.status === 'inProgress') {
    // A persisted in-progress turn on an idle runtime is interrupted, not running.
    state.lastTurnId = latest.id; state.status = 'interrupted';
  } else if (!latest && ['running', 'waiting'].includes(state.status)) state.status = 'interrupted';
  state.needsReconcile = false;
}
export const reportTool = {
  type: 'function', name: 'tinylens_ui_report',
  description: 'Optionally report verified stage status, an existing artifact path, or a note to the TinyLens interface. This tool only updates the UI. It does not run stages, interpret files, approve results, or change scientific decisions. Never equate command success with scientific acceptance. ' + QUESTION_FORMAT,
  inputSchema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['stage', 'artifact', 'note'] }, stage: { type: 'string' }, status: { type: 'string' },
    title: { type: 'string' }, message: { type: 'string' }, path: { type: 'string' }
  }, required: ['kind', 'message'], additionalProperties: false }
};
export function validateRequestScope(state, params, verifiedScope) {
  if (!record(params) || !state.threadId) throw new Error('Request is outside the connected TinyLens thread');
  if (params.threadId === state.threadId) {
    if (!state.turnId || params.turnId !== state.turnId) throw new Error('Request is outside the active TinyLens turn');
    return;
  }
  // This proof is supplied only by the bridge after fresh app-server reads;
  // never accept a proof from request.params or from a webpage POST body.
  if (!record(verifiedScope) || verifiedScope.rootThreadId !== state.threadId
    || !state.turnId || verifiedScope.rootTurnId !== state.turnId
    || verifiedScope.threadId !== params.threadId || verifiedScope.turnId !== params.turnId) {
    throw new Error('Request is outside the verified active TinyLens session tree');
  }
}
export function receiveReport(state, params) {
  validateRequestScope(state, params);
  if (params.tool !== reportTool.name || (params.namespace !== undefined && params.namespace !== null) || typeof params.callId !== 'string') throw new Error('Unexpected report source');
  const report = params.arguments;
  const keys = ['kind', 'message', 'stage', 'status', 'title', 'path'];
  if (!record(report) || Object.keys(report).some(key => !keys.includes(key)) || !['stage', 'artifact', 'note'].includes(report.kind)
    || typeof report.message !== 'string' || !report.message.trim() || report.message.length > 30000) throw new Error('Invalid UI report');
  for (const key of ['stage', 'status', 'title', 'path']) if (report[key] !== undefined && (typeof report[key] !== 'string' || report[key].length > 4000)) throw new Error(`Invalid ${key}`);
  const questionReport = receiveQuestionReport(state, params, report);
  if (questionReport) return questionReport.created;
  if (report.kind === 'stage' && (!report.stage?.trim() || !report.status?.trim())) throw new Error('Stage reports require a stage and status');
  if (report.kind === 'artifact' && (!report.path?.startsWith('/') || report.path.includes('\0'))) throw new Error('Artifact reports require an absolute path');
  // The report schema permits free-form stage labels (for example "preparation").
  // Preserve the AI's label; the UI's fixed user-feedback selector is a different contract.
  const stage = report.stage;
  // Repeated transport delivery of one tool call must not duplicate the report.
  if (state.updates.some(update => update.callId === params.callId && update.turnId === params.turnId)) return false;
  state.updates.push({ id: randomUUID(), at: new Date().toISOString(), threadId: params.threadId, turnId: params.turnId, callId: params.callId,
    ...Object.fromEntries(keys.filter(key => report[key] !== undefined).map(key => [key, report[key]])), ...(stage === undefined ? {} : { stage }) });
  state.updates = state.updates.slice(-400);
  return true;
}
export function receiveRequest(state, message, verifiedScope) {
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'];
  if (!methods.includes(message.method)) throw new Error(`Unsupported AI request: ${message.method}; no automatic approval was sent`);
  if (!['number', 'string'].includes(typeof message.id)) throw new Error('Missing server request id');
  validateRequestScope(state, message.params, verifiedScope);
  if (message.method === 'item/tool/requestUserInput') {
    const { questions, isBlocking } = message.params;
    if (typeof isBlocking !== 'boolean' || !Array.isArray(questions) || !questions.length
      || questions.some(question => !record(question) || typeof question.id !== 'string' || !question.id)
      || new Set(questions.map(question => question.id)).size !== questions.length) throw new Error('Invalid user input request');
  }
  const existing = state.requests.find(request => request.id === message.id);
  if (existing && (existing.method !== message.method || existing.params.threadId !== message.params.threadId
    || existing.params.turnId !== message.params.turnId || existing.params.itemId !== message.params.itemId
    || JSON.stringify(existing.params) !== JSON.stringify(message.params))) throw new Error('Conflicting server request identity');
  if (!existing) state.requests.push({ id: message.id, method: message.method, params: message.params,
    ...(verifiedScope ? { scope: verifiedScope } : {}) });
  refreshStatus(state);
}
export function validateReply(request, result) {
  if (!record(result)) throw new Error('Missing reply');
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
    if (!['accept', 'decline', 'cancel'].includes(result.decision) || Object.keys(result).some(key => key !== 'decision')) throw new Error('Only a one-time approval or refusal is supported');
    if (request.params.availableDecisions && !request.params.availableDecisions.includes(result.decision)) throw new Error('This decision was not offered by the AI');
    return { decision: result.decision };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const answers = {};
    if (!Array.isArray(request.params.questions) || !request.params.questions.length) throw new Error('Missing questions');
    for (const question of request.params.questions) {
      const values = result.answers?.[question.id]?.answers;
      if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 20000)) throw new Error('Each question requires an answer');
      answers[question.id] = { answers: values };
    }
    return { answers };
  }
  throw new Error('This request needs a supported reply form; no automatic approval was sent');
}
export function disconnected(state, error) {
  if (state.turnId || state.remoteActive || state.status === 'waiting') state.status = 'interrupted';
  state.turnId = null; state.remoteActive = false; state.requests = [];
  state.connection = 'error'; state.error = error;
}
