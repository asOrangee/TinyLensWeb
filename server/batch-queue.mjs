import { batchMessage, batchStartDelivery, maxBatchParallelism, openBatchQuestion, sameRuntime } from './agent-batches.mjs';
import { hasBlockingRequest } from './agent-state.mjs';

const maxReconnectAttempts = 3;
const needsRecovery = state => state.threadId && !state.idleReleased && ['disconnected', 'error'].includes(state.connection)
  && (state.status === 'interrupted' || state.needsReconcile);

/** Only confirmed queue entries can create turns. The stage runner owns GPU leases. */
export function createBatchQueue({ batches, session, existingSession = () => undefined, setDispatch, config,
  canSchedule = () => true, logger = console, intervalMs = 1200 }) {
  const inFlight = new Map();
  const recovery = new Map();
  const releasing = new Map();
  let ticking = false;
  let stopped = false;
  let timer;
  const available = id => !stopped && canSchedule(id);

  function launch(job, operation) {
    const pending = operation().catch(error => logger.error('Could not process batch dispatch state:', error.message)).finally(() => {
      inFlight.delete(job.taskId);
      wake();
    });
    inFlight.set(job.taskId, pending);
  }

  async function start(batch, job) {
    if (job.dispatch === 'queued') job = await setDispatch(batch.id, job, 'starting');
    if (!job || !available(job.taskId)) return;
    let bridge;
    let failure;
    try {
      bridge = await session(job.taskId);
      if (!available(job.taskId)) return;
      if (batchStartDelivery(job, bridge.state) === 'unsent') {
        // Account for a persisted `starting` entry from before the message ID was recorded.
        if (!job.startMessageId) job = await setDispatch(batch.id, job, 'starting');
        if (!job || !available(job.taskId)) return;
        await bridge.connect();
        if (!available(job.taskId)) return;
        if (bridge.state.status !== 'idle' || bridge.state.lastTurnId) throw Error('批次任务的原会话已有回合，请打开原会话核对。');
        await bridge.submitMessage({ text: batchMessage(batch, job), clientMessageId: job.startMessageId,
          expectedThreadId: bridge.state.threadId, expectedTurnId: null });
      }
    } catch (error) {
      failure = error.message;
    }
    if (!available(job.taskId)) return;
    // An uncertain or confirmed submission is inspected in its original thread and never replayed.
    const delivery = bridge ? batchStartDelivery(job, bridge.state) : 'unsent';
    const submitted = ['delivered', 'unknown'].includes(delivery);
    // A failure before the first turn still needs a durable journal for explicit retry.
    if (!submitted && bridge) await bridge.persist();
    await setDispatch(batch.id, job, submitted ? 'submitted' : 'start_failed', failure
      || (!submitted ? 'AI 未接受首条任务消息。' : undefined));
  }

  async function reconnect(job, bridge, attempts) {
    if (!available(job.taskId) || !needsRecovery(bridge.state)) return;
    try {
      await bridge.connect();
      recovery.delete(job.taskId);
    } catch {
      const failures = attempts + 1;
      const delay = Math.min(30000, intervalMs * 2 ** (failures - 1));
      recovery.set(job.taskId, { failures, nextAt: Date.now() + delay });
    }
  }

  function release(job, bridge) {
    if (releasing.has(job.taskId)) return;
    const attempt = bridge.disconnectIdle(() => available(job.taskId)).catch(error => {
      logger.error('Could not release idle batch connection:', error.message);
    }).finally(() => releasing.delete(job.taskId));
    releasing.set(job.taskId, attempt);
  }

  async function tick() {
    if (stopped || !timer || ticking) return;
    ticking = true;
    try {
      const compatible = batches().filter(batch => sameRuntime(batch, config));
      const jobs = compatible.flatMap(batch => batch.jobs.map(job => ({ batch, job })));
      const states = await Promise.all(jobs.map(async ({ batch, job }) => {
        if (!available(job.taskId) || !['starting', 'submitted', 'start_failed'].includes(job.dispatch)
            || inFlight.has(job.taskId)) return { batch, job };
        // A failed job restored from disk has no transport to release. Reading
        // it as a session would replace the saved retry evidence on shutdown.
        try { return { batch, job, bridge: await (job.dispatch === 'start_failed' ? existingSession(job.taskId) : session(job.taskId)) }; }
        catch { return { batch, job }; } // The batch detail exposes this journal failure.
      }));
      if (stopped) return;
      const active = new Map();
      const ready = [];
      for (const { batch, job, bridge } of states) {
        const state = bridge?.state;
        if (state?.connection === 'connected' || job.dispatch !== 'submitted') recovery.delete(job.taskId);
        const running = state?.connection === 'connected' && (state.turnId || state.remoteActive) && state.status !== 'waiting'
          && !hasBlockingRequest(state) && !openBatchQuestion(state);
        if (inFlight.has(job.taskId) || running) {
          active.set(batch.id, (active.get(batch.id) ?? 0) + 1);
          continue;
        }
        if (!available(job.taskId)) continue;
        if (job.dispatch === 'starting' || (job.dispatch === 'queued' && !batch.paused)) ready.push({ batch, job });
        if (!['submitted', 'start_failed'].includes(job.dispatch) || !state) continue;
        const attempt = recovery.get(job.taskId) ?? { failures: 0, nextAt: 0 };
        if (job.dispatch === 'submitted' && needsRecovery(state) && attempt.failures < maxReconnectAttempts) {
          ready.push({ batch, job, bridge, attempt });
        } else if (['connected', 'error'].includes(state.connection) && !state.turnId && !state.remoteActive) {
          release(job, bridge);
        }
      }
      let activeTotal = [...active.values()].reduce((total, count) => total + count, 0);
      // Leave room for work being recovered during backoff before starting fresh turns.
      ready.sort((first, second) => Number(!!second.attempt) - Number(!!first.attempt)
        || Number(first.job.dispatch === 'queued') - Number(second.job.dispatch === 'queued'));
      for (const { batch, job, bridge, attempt } of ready) {
        if (activeTotal >= maxBatchParallelism) break;
        const count = active.get(batch.id) ?? 0;
        if (count >= batch.parallelism || !available(job.taskId)) continue;
        if (!attempt) launch(job, () => start(batch, job));
        else if (attempt.nextAt <= Date.now()) launch(job, () => reconnect(job, bridge, attempt.failures));
        active.set(batch.id, count + 1);
        activeTotal += 1;
      }
    } finally { ticking = false; }
  }

  function wake() {
    void tick().catch(error => logger.error('Could not dispatch batches:', error.message));
  }
  return {
    activate() {
      if (stopped || timer) return;
      timer = setInterval(wake, intervalMs);
      timer.unref();
      wake();
    },
    wake,
    isStarting: id => inFlight.has(id),
    stop() { stopped = true; clearInterval(timer); },
    async settled() { await Promise.all([...inFlight.values(), ...releasing.values()]); },
  };
}
