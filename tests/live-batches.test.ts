import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_AGENT_STATE, parseAgentState } from '../src/lib/agent-types.ts';

const preview = {
  id: 'batch-12ab3456-0000-0000-0000-123456789abc', status: 'preview', inputDir: '/data/lenses',
  outputDir: '/srv/pipeline/output/batch', parallelism: 4, targets: [{ lensId: 'lens-001', existing: true }], message: '第一条用户消息',
};

test('only structured server-side batch plans appear alongside the original conversation', () => {
  const messages = [{ id: 'u-1', role: 'user', text: '把同一组观测交给独立任务建模，请保留已有结果。' }];
  const state = parseAgentState({ ...EMPTY_AGENT_STATE, messages, batchPlan: preview });
  assert.deepEqual(state.batchPlan, preview);
  assert.equal(state.messages[0].text, messages[0].text);
  assert.equal(parseAgentState({ ...EMPTY_AGENT_STATE, messages }).batchPlan, undefined);
  assert.equal(parseAgentState({ ...EMPTY_AGENT_STATE, batchPlan: { ...preview, id: '../bad', targets: [] } }).batchPlan, undefined);
});
