import http from 'node:http';
import { serveReportedImage } from './agent-artifacts.mjs';
import { serveReportedResult } from './agent-results.mjs';
import { serveReportedInput } from './agent-inputs.mjs';
import { serveReportedModel } from './agent-models.mjs';
import {serveReportedMask} from './agent-masks.mjs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAiNetworkProxy } from './ai-network-proxy.mjs';
import { prepareQuestionAnswer } from './agent-questions.mjs';
import { initialState, receiveNotification, receiveReport, receiveRequest, validateReply, validateRequestScope,
  restoreThread, applyTurn, hasBlockingRequest, normalizeStage, disconnected, reportTool, WORKSPACE } from './agent-state.mjs';
import { connectionConfig, appServerCommand } from './connection-config.mjs';
const defaultDirectory = fileURLToPath(new URL('../.local/', import.meta.url));
// Injection is solely for local protocol tests; the executable entry point uses SSH.
export async function createAgentServer({ stateDirectory = defaultDirectory, spawnProcess = spawn, rpcTimeoutMs = 60000, logger = console,
  aiNetwork = false, networkProxyFactory = createAiNetworkProxy, remoteProxyPort = connectionConfig.remoteProxyPort, datasetPath } = {}) {
  if (!Number.isInteger(remoteProxyPort) || remoteProxyPort < 1024 || remoteProxyPort > 65535) throw new Error('Invalid remote proxy port');
  const statePath = `${stateDirectory}/agent-state.json`;
  let saved;
  try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') logger.error('Previous UI state could not be read:', error.message); }
  const state = initialState(saved), clients = new Set(), pending = new Map();
  if (typeof datasetPath === 'string') state.datasetPath = datasetPath;
  let transport, sequence = 0, connecting, changing = false, publishTimer, saveTimer, closed = false;
  let saveChain = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(state);
    const operation = saveChain.catch(() => {}).then(async () => {
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await writeFile(`${statePath}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    saveChain = operation;
    return operation;
  }
  function publish() {
    if (closed) return;
    if (!publishTimer) publishTimer = setTimeout(() => {
      publishTimer = null;
      const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
      for (const client of clients) if (!client.destroyed) client.write(event);
    }, 100);
    if (!saveTimer) saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist().catch(error => logger.error('Could not persist UI state:', error.message));
    }, 500);
  }
  function send(message, current = transport) {
    if (!current || current !== transport || current.proc.killed || !current.proc.stdin.writable) return Promise.reject(new Error('AI connection is unavailable'));
    return new Promise((resolveWrite, reject) => {
      current.proc.stdin.write(`${JSON.stringify(message)}\n`, error => error ? reject(error) : resolveWrite());
    });
  }
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out; delivery is unconfirmed. Reconnect to inspect the existing AI state before retrying.`), { deliveryUnknown: true }));
      }, rpcTimeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      send({ id, method, params }).catch(error => {
        if (!pending.has(id)) return;
        clearTimeout(timer); pending.delete(id); error.deliveryUnknown = true; reject(error);
      });
    });
  }
  function rejectPending(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Object.assign(new Error(error), { deliveryUnknown: true })); }
    pending.clear();
  }
  const requestMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput']);
  const diagnosticMethods = new Set([...requestMethods, 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/tool/call']);
  const turnKey = (threadId, turnId) => JSON.stringify([threadId, turnId]);
  const requestKey = (threadId, requestId) => JSON.stringify([threadId, requestId]);
  function remember(set, value) { set.add(value); if (set.size > 256) set.delete(set.values().next().value); }
  function routingError(code, message) { return Object.assign(new Error(message), { routingCode: code }); }
  function routingDiagnostic(event, message, code) {
    // Do not log command text, arguments, prompts, credentials or file contents.
    const identifier = value => typeof value === 'number' ? value : typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value) ? value : null;
    logger.error('TinyLens approval routing', { event, code,
      method: diagnosticMethods.has(message.method) ? message.method : 'unsupported',
      requestId: identifier(message.id), threadId: identifier(message.params?.threadId), turnId: identifier(message.params?.turnId),
      rootThreadId: identifier(state.threadId), rootTurnId: identifier(state.turnId) });
  }
  async function verifiedRequestScope(params, current, expectedScope) {
    if (params?.threadId === state.threadId) { validateRequestScope(state, params); return undefined; }
    const rootThreadId = state.threadId, rootTurnId = state.turnId;
    if (!rootThreadId || !rootTurnId || typeof params?.threadId !== 'string' || !params.threadId
      || typeof params.turnId !== 'string' || !params.turnId) throw routingError('missing_active_scope', 'No active TinyLens scope for this request');
    if (expectedScope && (expectedScope.rootThreadId !== rootThreadId || expectedScope.rootTurnId !== rootTurnId)) {
      throw routingError('root_turn_changed', 'The owning TinyLens turn has changed');
    }
    const inactiveEpoch = current.inactiveThreadEpochs.get(params.threadId) || 0;
    function stillCurrent() {
      if (transport !== current || state.threadId !== rootThreadId || state.turnId !== rootTurnId) throw routingError('root_turn_changed', 'The owning TinyLens turn has changed');
      if ((current.inactiveThreadEpochs.get(params.threadId) || 0) !== inactiveEpoch) throw routingError('child_became_inactive', 'The child AI became inactive during verification');
      if (current.closedTurns.has(turnKey(params.threadId, params.turnId))) throw routingError('child_turn_closed', 'The child AI turn has already ended');
    }
    stillCurrent();
    let cursor = params.threadId, leaf, belongs = false;
    const seen = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (cursor === rootThreadId) { belongs = true; break; }
      if (seen.has(cursor)) throw routingError('ancestry_cycle', 'Invalid AI thread ancestry');
      seen.add(cursor);
      let result;
      try { result = await rpc('thread/read', { threadId: cursor, includeTurns: false }); }
      catch { throw routingError('ancestry_read_failed', 'Could not verify the requesting AI thread'); }
      stillCurrent();
      const thread = result?.thread;
      if (!thread || thread.id !== cursor || typeof thread.parentThreadId !== 'string' || !thread.parentThreadId) {
        throw routingError('unrelated_thread', 'The request is not from this TinyLens session tree');
      }
      if (!leaf) leaf = thread;
      cursor = thread.parentThreadId;
    }
    if (!belongs) throw routingError('ancestry_too_deep', 'Could not establish a bounded TinyLens session ancestry');
    if (leaf.status?.type !== 'active') throw routingError('inactive_child', 'The requesting child AI is not active');
    let turns;
    try { turns = await rpc('thread/turns/list', { threadId: params.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }); }
    catch { throw routingError('turn_read_failed', 'Could not verify the requesting AI turn'); }
    stillCurrent();
    const latest = turns?.data?.[0];
    if (!latest || latest.id !== params.turnId || latest.status !== 'inProgress') throw routingError('inactive_child_turn', 'The request is not from the active child AI turn');
    return { rootThreadId, rootTurnId, threadId: params.threadId, turnId: params.turnId };
  }
  async function onProtocol(message, current) {
    // Old SSH processes can emit exit/data after a new connection has taken over.
    if (transport !== current || !message || typeof message !== 'object') return;
    if (!message.method && message.id !== undefined) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error.message || 'AI request rejected')) : request.resolve(message.result);
      }
      return;
    }
    if (current.bootstrapping) { current.buffer.push(message); return; }
    if (message.method === 'turn/completed' && ['completed', 'failed', 'interrupted'].includes(message.params?.turn?.status)) {
      remember(current.closedTurns, turnKey(message.params.threadId, message.params.turn.id));
    }
    if (message.method === 'serverRequest/resolved') remember(current.resolvedRequests, requestKey(message.params?.threadId, message.params?.requestId));
    if (message.method === 'thread/status/changed' && ['idle', 'systemError', 'notLoaded'].includes(message.params?.status?.type)) {
      const id = message.params.threadId;
      current.inactiveThreadEpochs.set(id, (current.inactiveThreadEpochs.get(id) || 0) + 1);
      if (current.inactiveThreadEpochs.size > 256) current.inactiveThreadEpochs.delete(current.inactiveThreadEpochs.keys().next().value);
    }
    if (message.method && message.id !== undefined) {
      try {
        if (message.method === 'item/tool/call') {
          // A tool failure is acknowledged as such; it never grants permissions.
          try {
            receiveReport(state, message.params);
            await persist();
            const isQuestion = message.params.arguments?.kind === 'note' && message.params.arguments?.status === 'awaiting_user';
            const acknowledgement = isQuestion
              ? 'Question displayed and persisted in the TinyLens webpage. This acknowledgement is not a user answer or approval. Stop actions that depend on the answer and wait for the user to respond in this thread through the webpage.'
              : 'Report received by TinyLens UI.';
            await send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: acknowledgement }], success: true } }, current);
          } catch (error) {
            await send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: error.message }], success: false } }, current);
          }
        } else {
          if (!requestMethods.has(message.method)) throw routingError('unsupported_method', `Unsupported AI request: ${message.method}; no automatic approval was sent`);
          routingDiagnostic('received', message, 'pending_verification');
          let scope;
          if (message.params?.threadId === state.threadId) validateRequestScope(state, message.params);
          else scope = await verifiedRequestScope(message.params, current);
          if (current.resolvedRequests.has(requestKey(message.params?.threadId, message.id))) throw routingError('request_resolved', 'This AI request has already resolved');
          receiveRequest(state, message, scope);
          routingDiagnostic('displayed', message, scope ? 'verified_descendant' : 'active_root');
        }
      } catch (error) {
        routingDiagnostic('rejected', message, error.routingCode || 'invalid_request');
        await send({ id: message.id, error: { code: -32602, message: error.message } }, current);
      }
      publish(); return;
    }
    if (receiveNotification(state, message.method, message.params)) publish();
  }
  async function makeTransport() {
    const networkProxy = aiNetwork ? await networkProxyFactory({ upstreamHost: '127.0.0.1', upstreamPort: connectionConfig.upstreamPort }) : null;
    const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3'];
    if (networkProxy) args.push('-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${remoteProxyPort}:127.0.0.1:${networkProxy.port}`);
    // The one-time proxy credential is delivered on SSH stdin, never in argv or a file.
    const networkBootstrap = networkProxy
      ? 'IFS= read -r TINYLENS_AI_PROXY && export HTTPS_PROXY="$TINYLENS_AI_PROXY" HTTP_PROXY="$TINYLENS_AI_PROXY" ALL_PROXY="$TINYLENS_AI_PROXY" https_proxy="$TINYLENS_AI_PROXY" http_proxy="$TINYLENS_AI_PROXY" all_proxy="$TINYLENS_AI_PROXY" NO_PROXY="127.0.0.1,localhost,::1" no_proxy="127.0.0.1,localhost,::1" && unset TINYLENS_AI_PROXY && '
      : '';
    args.push(connectionConfig.sshHost, appServerCommand(networkBootstrap));
    let proc;
    try { proc = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { await networkProxy?.close(); throw error; }
    const current = { proc, networkProxy, initialized: false, bootstrapping: true, buffer: [], closedTurns: new Set(), resolvedRequests: new Set(), inactiveThreadEpochs: new Map() };
    transport = current;
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', line => {
      if (transport !== current) return;
      let message;
      try { message = JSON.parse(line); } catch { state.error = 'AI returned invalid protocol JSON'; publish(); return; }
      void onProtocol(message, current).catch(error => { if (transport === current) { state.error = `AI protocol: ${error.message}`; publish(); } });
    });
    // Drain logs without mixing them into the JSON protocol or exposing account data.
    proc.stderr.on('data', () => {});
    const lost = error => {
      void networkProxy?.close();
      if (transport !== current) return;
      transport = null; current.buffer = []; lines.close();
      disconnected(state, error); rejectPending(error); publish();
    };
    proc.stdin.on('error', error => lost(`AI input connection failed: ${error.message}`));
    proc.on('error', error => lost(error.message));
    proc.on('exit', code => lost(`AI connection closed (${code ?? 'signal'}). Reconnect to inspect the persisted conversation.`));
    if (networkProxy) await new Promise((resolveWrite, reject) => proc.stdin.write(`${networkProxy.proxyUrlForRemote(remoteProxyPort)}\n`, error => error ? reject(error) : resolveWrite()));
    return current;
  }
  async function connect() {
    if (closed) throw new Error('AI bridge is closed');
    if (state.connection === 'connected' && !state.needsReconcile) return;
    if (connecting) return connecting;
    connecting = (async () => {
      state.connection = 'connecting'; state.error = null; state.requests = []; publish();
      // After a request timeout, inspect the same live transport instead of replaying the task.
      let current;
      try {
        current = transport || await makeTransport();
        current.bootstrapping = true;
        if (!current.initialized) {
          await rpc('initialize', { clientInfo: { name: 'tinylens_frontend', title: 'TinyLens Workbench', version: '0.2.0' }, capabilities: { experimentalApi: true } });
          await send({ method: 'initialized' }, current); current.initialized = true;
        }
        const permissions = { cwd: WORKSPACE, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
        const resuming = Boolean(state.threadId);
        const result = resuming
          ? await rpc('thread/resume', { threadId: state.threadId, excludeTurns: true,
            initialTurnsPage: { limit: 30, sortDirection: 'desc', itemsView: 'full' }, ...permissions })
          : await rpc('thread/start', { ...permissions, ephemeral: false, dynamicTools: [reportTool] });
        const turns = result.initialTurnsPage?.data ? [...result.initialTurnsPage.data].reverse() : result.thread.turns;
        restoreThread(state, result.thread, turns);
        if (transport !== current) throw new Error('AI connection changed during initialization');
        current.bootstrapping = false;
        for (const message of current.buffer.splice(0)) await onProtocol(message, current);
        state.connection = 'connected'; publish(); await persist();
      } catch (error) {
        if (current) { current.bootstrapping = false; current.buffer = []; }
        state.connection = 'error'; state.error = error.message; publish();
        if (current && !current.initialized && transport === current) { transport = null; current.proc.kill(); await current.networkProxy?.close(); rejectPending(error.message); }
        throw error;
      }
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function submitMessage(data, { question } = {}) {
    if (state.connection !== 'connected' || state.needsReconcile) throw new Error('Connect to the pipeline AI first');
    if (changing) throw new Error('Another message is being submitted');
    if (hasBlockingRequest(state)) throw new Error('Answer the pending AI request first');
    if (state.remoteActive && !state.turnId) throw new Error('The existing AI turn is still active; its turn id has not been recovered');
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['text', 'stage'].includes(key))) throw new Error('Messages only accept text and an optional stage; AI configuration cannot be set from the webpage');
    if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > 30000) throw new Error('Message must contain 1–30000 characters');
    // Validate legacy metadata without inserting it into the user's message.
    if (data.stage !== undefined) normalizeStage(data.stage);
    changing = true;
    const text = data.text;
    const input = [{ type: 'text', text }];
    const userMessage = { id: randomUUID(), role: 'user', text, delivery: 'pending', at: new Date().toISOString() };
    if (question) { userMessage.questionId = question.id; question.answerMessageId = userMessage.id; }
    let sent = false;
    try {
      state.messages.push(userMessage); publish();
      // Wait for the durable journal before dispatch; never automatically resend an unknown delivery.
      await persist(); sent = true;
      const result = state.turnId
        ? await rpc('turn/steer', { threadId: state.threadId, expectedTurnId: state.turnId, input, clientUserMessageId: userMessage.id })
        : await rpc('turn/start', { threadId: state.threadId, input, clientUserMessageId: userMessage.id });
      userMessage.delivery = 'delivered';
      state.error = null;
      if (result.turn) applyTurn(state, result.turn);
      publish(); await persist();
      return userMessage;
    } catch (error) {
      if (userMessage.delivery !== 'delivered') userMessage.delivery = sent && error.deliveryUnknown ? 'unknown' : 'rejected';
      if (userMessage.delivery === 'unknown') { state.needsReconcile = true; state.connection = 'error'; }
      state.error = error.message; publish();
      await persist().catch(persistError => logger.error('Could not persist message delivery:', persistError.message));
      error.messageId = userMessage.id; error.messageDelivery = userMessage.delivery;
      throw error;
    } finally { changing = false; }
  }
  async function answerQuestion(data) {
    const { question, answer, message } = prepareQuestionAnswer(state, data);
    // Lock synchronously before the first await so concurrent clicks cannot dispatch twice.
    question.status = 'sending'; question.answer = answer; question.answerStartedAt = new Date().toISOString();
    delete question.error; delete question.answerMessageId;
    publish();
    try {
      const receipt = await submitMessage({ text: message }, { question });
      question.status = 'answered'; question.answerMessageId = receipt.id; question.answeredAt = new Date().toISOString();
      publish(); await persist();
    } catch (error) {
      if (error.messageDelivery === 'delivered' || question.status === 'answered') {
        question.status = 'answered'; question.answeredAt ||= new Date().toISOString();
      } else question.status = error.messageDelivery === 'unknown' || error.deliveryUnknown ? 'delivery_unknown' : 'pending';
      question.error = error.message; publish();
      await persist().catch(persistError => logger.error('Could not persist question answer:', persistError.message));
      throw error;
    }
  }
  async function interrupt() {
    if (state.connection !== 'connected' || !state.turnId) throw new Error('No connected active AI turn');
    await rpc('turn/interrupt', { threadId: state.threadId, turnId: state.turnId });
  }
  async function reply(data) {
    if (state.connection !== 'connected') throw new Error('AI connection is unavailable');
    const request = state.requests.find(item => item.id === data?.requestId);
    if (!request || request.responded || request.replying) throw new Error('This AI request is no longer awaiting a reply');
    validateRequestScope(state, request.params, request.scope);
    const result = validateReply(request, data.result);
    const current = transport;
    request.replying = true;
    try {
      // A child may have completed or changed turns while its approval was visible.
      if (request.scope) await verifiedRequestScope(request.params, current, request.scope);
      validateRequestScope(state, request.params, request.scope);
      if (transport !== current || !state.requests.includes(request) || request.responded
        || current.resolvedRequests.has(requestKey(request.params.threadId, request.id))) throw routingError('request_resolved', 'This AI request is no longer awaiting a reply');
      request.responded = true; publish();
      try { await send({ id: request.id, result }, current); }
      catch (error) { state.needsReconcile = true; state.connection = 'error'; state.error = 'Reply delivery is unconfirmed. Reconnect before trying again.'; publish(); throw error; }
      routingDiagnostic('replied', request, result.decision || 'user_input');
    } finally { delete request.replying; }
    // Retain the request until serverRequest/resolved or terminal/disconnect clears it.
  }
  function json(response, code, data) { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }
  async function body(request) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
    let value = ''; for await (const chunk of request) { value += chunk; if (value.length > 200000) throw new Error('Request is too large'); }
    const data = JSON.parse(value || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
    return data;
  }
  function localRequest(request) {
    const port = server.address()?.port;
    const hosts = ['127.0.0.1:5173', 'localhost:5173', `127.0.0.1:${port}`, `localhost:${port}`];
    return hosts.includes(request.headers.host) && (!request.headers.origin || hosts.some(host => request.headers.origin === `http://${host}`));
  }
  // The task router also calls this handler, after applying its own local-origin guard.
  async function routeRequest(request, response) {
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/api/agent/state') return json(response, 200, state);
    if (request.method === 'GET' && path === '/api/agent/artifact') return serveReportedImage(request, response, state);
    if (request.method === 'GET' && path === '/api/agent/result') return serveReportedResult(request, response, state, { cacheDirectory: resolve(stateDirectory, 'result-cache') });
    if (request.method === 'GET' && path === '/api/agent/model') return serveReportedModel(request, response, state, { cacheDirectory: resolve(stateDirectory, 'model-cache') });
    if (request.method === 'GET' && path === '/api/agent/mask') return serveReportedMask(request, response, state, { cacheDirectory: resolve(stateDirectory, 'mask-cache') });
    if (request.method === 'GET' && path === '/api/agent/input') return serveReportedInput(request, response, state, { cacheDirectory: resolve(stateDirectory, 'input-cache') });
    if (request.method === 'GET' && path === '/api/agent/panels') return json(response,410,{error:'Scientific image panels require numerical outputs.'});
    if (request.method === 'GET' && path === '/api/agent/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`); clients.add(response);
      const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 15000);
      response.on('close', () => { clients.delete(response); clearInterval(heartbeat); }); return;
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'Not found' });
    try {
      const data = await body(request);
      if (path === '/api/agent/connect') await connect();
      else if (path === '/api/agent/message') await submitMessage(data);
      else if (path === '/api/agent/answer') await answerQuestion(data);
      else if (path === '/api/agent/interrupt') await interrupt();
      else if (path === '/api/agent/reply') await reply(data);
      else return json(response, 404, { error: 'Not found' });
      json(response, 200, state);
    } catch (error) { json(response, 400, { error: error.message }); }
  }
  const server = http.createServer((request, response) => {
    if (!localRequest(request)) return json(response, 403, { error: 'Only local TinyLens requests are allowed' });
    return routeRequest(request, response);
  });
  async function close() {
    closed = true; clearTimeout(publishTimer); clearTimeout(saveTimer);
    const current = transport; transport = null; current?.proc.kill(); await current?.networkProxy?.close(); rejectPending('AI bridge closed');
    if (state.turnId || state.remoteActive) disconnected(state, 'AI bridge closed; reconnect to inspect the persisted conversation');
    state.requests = []; state.connection = 'disconnected';
    for (const client of clients) client.end();
    await new Promise(resolveClose => server.close(resolveClose));
    await persist();
  }
  return { server, state, connect, submitMessage, answerQuestion, interrupt, reply, close, persist, routeRequest };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // Finish evaluating this module before loading the router, which imports the
  // session factory above. Awaiting that import at module scope creates a cycle.
  void import('./agent-tasks.mjs').then(async ({ createAgentTaskServer }) => {
    const bridge = await createAgentTaskServer({ aiNetwork: connectionConfig.aiNetwork === 'loopback-proxy' });
    bridge.server.listen(5184, '127.0.0.1', () => console.log('TinyLens AI bridge: http://127.0.0.1:5184 (connects only on explicit request)'));
    let stopping = false;
    const shutdown = () => { if (!stopping) { stopping = true; void bridge.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); } };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
