import { batchJobProgress, batchMessage, maxBatchParallelism, openBatchQuestion, sameRuntime } from './agent-batches.mjs';
import { hasBlockingRequest } from './agent-state.mjs';

/** Only confirmed queue entries can create turns. The stage runner owns GPU leases. */
export function createBatchQueue({ batches, session, setDispatch, config, logger = console, intervalMs = 1200 }) {
  const inFlight = new Map();
  const reconciled = new Set();
  const released = new Set();
  let ticking = false;
  let stopped = false;
  let timer;

  function start(batch, job) {
    const operation = (async () => {
      let bridge;
      try {
        if (job.dispatch === 'queued' && !await setDispatch(batch.id, job, 'starting')) return;
        if (stopped) return;
        bridge = await session(job.taskId);
        if (stopped) return;
        const hasUserMessage = bridge.state.messages.some(message => message.role === 'user');
        if (job.dispatch === 'submitted' || hasUserMessage) {
          // The bridge persists the delivery journal before dispatching turn/start.
          // An existing entry can be inspected and reconciled, but is never replayed.
          if (bridge.state.threadId && (bridge.state.needsReconcile || bridge.state.status === 'interrupted')) {
            reconciled.add(job.taskId);
            await bridge.connect();
          }
        } else {
          await bridge.connect();
          if (stopped) return;
          await bridge.submitMessage({ text: batchMessage(batch, job) });
        }
        if (!stopped) await setDispatch(batch.id, job, 'submitted');
      } catch (error) {
        if (stopped) return;
        const attemptedDelivery = job.dispatch === 'submitted' || bridge?.state.messages.some(message => message.role === 'user');
        await setDispatch(batch.id, job, attemptedDelivery ? 'submitted' : 'start_failed', error.message);
      }
    })().catch(error => logger.error('Could not save batch dispatch state:', error.message)).finally(() => {
      inFlight.delete(job.taskId);
      wake();
    });
    inFlight.set(job.taskId, operation);
  }

  async function tick() {
    if (stopped || !timer || ticking) return;
    ticking = true;
    try {
      const compatible = batches().filter(batch => sameRuntime(batch, config));
      const jobs = compatible.flatMap(batch => batch.jobs.map(job => ({ batch, job })));
      const states = await Promise.all(jobs.map(async ({ batch, job }) => {
        if (!['starting', 'submitted'].includes(job.dispatch) || inFlight.has(job.taskId)) return { batch, job };
        try { return { batch, job, bridge: await session(job.taskId) }; }
        catch { return { batch, job }; } // The batch detail exposes this journal failure.
      }));
      if (stopped) return;
      const active = new Map();
      const ready = [];
      for (const { batch, job, bridge } of states) {
        const state = bridge?.state;
        const running = state?.connection === 'connected' && (state.turnId || state.remoteActive) && state.status !== 'waiting'
          && !hasBlockingRequest(state) && !openBatchQuestion(state);
        if (inFlight.has(job.taskId) || running) {
          active.set(batch.id, (active.get(batch.id) ?? 0) + 1);
          continue;
        }
        if (job.dispatch === 'starting' || (job.dispatch === 'queued' && !batch.paused)) ready.push({ batch, job });
        if (job.dispatch !== 'submitted' || !state) continue;
        if (state.connection !== 'connected' && state.threadId && (state.status === 'interrupted' || state.needsReconcile)
            && !reconciled.has(job.taskId)) ready.push({ batch, job });
        if (state.connection === 'connected' && state.status === 'completed' && !released.has(job.taskId)
            && ['accepted', 'human_review'].includes(batchJobProgress(batch, job, state).status)) {
          released.add(job.taskId);
          void bridge.disconnectCompleted().catch(error => logger.error('Could not release completed batch connection:', error.message));
        }
      }
      let activeTotal = [...active.values()].reduce((total, count) => total + count, 0);
      // Restore submitted work before initiating new turns.
      ready.sort((first, second) => Number(first.job.dispatch === 'queued') - Number(second.job.dispatch === 'queued'));
      for (const { batch, job } of ready) {
        if (activeTotal >= maxBatchParallelism) break;
        const count = active.get(batch.id) ?? 0;
        if (count >= batch.parallelism) continue;
        start(batch, job);
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
    async settled() { await Promise.all(inFlight.values()); },
  };
}
