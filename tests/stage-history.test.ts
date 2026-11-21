import assert from 'node:assert/strict';
import test from 'node:test';
import type { StageId } from '../src/data/stages.ts';
import type { StageAttempt } from '../src/lib/stage-attempts.ts';
import { stageHistoryLayout, type HistoryReference } from '../src/lib/stage-history.ts';

function attempt(stage: StageId, index: number | null, runId?: string, runPath = '/results/lens', status?: string,
  firstReportedAt?: string): StageAttempt {
  return { identity: { key: JSON.stringify([runPath, runId, stage, index]), runPath, runId,
    lensId: 'lens', stage, attempt: index }, archived: false, status, firstReportedAt };
}

function reference({ identity }: StageAttempt): HistoryReference {
  return { stage: identity.stage, attempt: identity.attempt, run_id: identity.runId!, run_path: identity.runPath };
}

const key = (item: StageAttempt) => item.identity.key;

test('one parent fans out across attempts in the same stage and an inherited run branches from the exact accepted B', () => {
  const preview = attempt('preflight', null, 'initial');
  const a = attempt('a', 0, 'initial');
  const initialB = attempt('b', 0, 'initial', undefined, 'human_review', '2026-01-10T10:10:00Z');
  const acceptedB = attempt('b', 1, 'initial', undefined, 'accepted', '2026-01-10T10:30:00Z');
  const initialM0 = attempt('m0', 0, 'initial');
  const inheritedM0 = attempt('m0', 0, 'inherited', '/next/lens');
  const inheritedM1 = attempt('m1', 0, 'inherited', '/next/lens');
  const sources = new Map([
    [key(a), [reference(preview)]],
    [key(initialB), [reference(a)]],
    [key(acceptedB), [reference(a)]],
    [key(initialM0), [reference(a), reference(acceptedB)]],
    [key(inheritedM0), [reference(a), reference(acceptedB)]],
    [key(inheritedM1), [reference(acceptedB), reference(inheritedM0)]],
  ]);
  const { nodes, edges } = stageHistoryLayout([preview, a, acceptedB, initialB, initialM0, inheritedM0, inheritedM1], sources);
  const lane = (item: StageAttempt) => nodes.find(node => node.id === key(item))!.lane;

  assert.deepEqual(nodes.map(node => node.stage), ['preflight', 'a', 'b', 'b', 'm0', 'm0', 'm1']);
  assert.ok(lane(initialB) < lane(acceptedB));
  assert.equal(lane(a), (lane(initialB) + lane(acceptedB)) / 2);
  assert.equal(lane(preview), lane(a));
  assert.ok(lane(initialM0) < lane(inheritedM0));
  assert.equal(lane(acceptedB), (lane(initialM0) + lane(inheritedM0)) / 2);
  assert.equal(lane(inheritedM0), lane(inheritedM1));
  assert.deepEqual(edges.filter(edge => edge.parent === key(acceptedB)).map(edge => edge.child), [key(initialM0), key(inheritedM0)]);
  assert.deepEqual(edges.find(edge => edge.child === key(inheritedM1)), { parent: key(inheritedM0), child: key(inheritedM1) });
});

test('unreported ancestors are skipped, while version/path mismatches and same-row retries cannot masquerade as parents', () => {
  const a = attempt('a', 0, 'source');
  const b = attempt('b', 0, 'source');
  const wrongPath = attempt('b', 1, 'source', '/elsewhere/lens');
  const wrongVersion = attempt('b', 1, 'replacement');
  const legacy = attempt('b', 1);
  const m1 = attempt('m1', 0, 'source');
  const retry = attempt('m1', 1, 'source');
  const sources = new Map([
    [key(m1), [reference(a), reference(attempt('b', 1, 'source'))]],
    [key(retry), [reference(m1)]],
  ]);
  const { nodes, edges } = stageHistoryLayout([retry, m1, b, wrongPath, wrongVersion, legacy, a], sources);
  assert.equal(nodes.length, 7);
  assert.equal(new Set(nodes.filter(node => node.stage === 'b').map(node => node.lane)).size, 4);
  assert.deepEqual(edges, [{ parent: key(a), child: key(m1) }]);
});

test('several different verified references at the nearest row do not pick an arbitrary parent', () => {
  const a = attempt('a', 0, 'source');
  const b0 = attempt('b', 0, 'source');
  const b1 = attempt('b', 1, 'source');
  const m0 = attempt('m0', 0, 'source');
  const m1 = attempt('m1', 0, 'source');
  const { edges } = stageHistoryLayout([a, b0, b1, m0, m1], new Map([
    [key(m0), [reference(a), reference(b0), reference(b1)]],
    [key(m1), [reference(b1), reference(b1)]],
  ]));
  assert.deepEqual(edges, [{ parent: key(b1), child: key(m1) }]);
});

test('a verified dependency across missing stages aligns its two nodes without repositioning an unrelated row', () => {
  const preflight = attempt('preflight', null, 'left');
  const m2 = attempt('m2', 0, 'left');
  const a = attempt('a', 0, 'right');
  const m3 = attempt('m3', 0, 'right');
  const sources = new Map([[key(m2), [reference(preflight)]]]);
  const { nodes, edges } = stageHistoryLayout([preflight, a, m2, m3], sources);
  assert.deepEqual(nodes.map(node => node.lane), [0, 0, 0, 0]);
  assert.deepEqual(edges, [{ parent: key(preflight), child: key(m2) }]);
});

test('same-row retries on different branches keep their fork spans separate', () => {
  const b = attempt('b', 1, 'initial');
  const leftM0 = attempt('m0', 0, 'initial');
  const rightM0 = attempt('m0', 0, 'inherited', '/next/lens');
  const leftM1 = attempt('m1', 0, 'initial');
  const rightM1 = attempt('m1', 0, 'inherited', '/next/lens');
  const leftAccepted = attempt('m2', 1, 'initial', undefined, 'accepted', '2026-01-10T10:30:00Z');
  const leftRetry = attempt('m2', 0, 'initial', undefined, 'retry', '2026-01-10T10:10:00Z');
  const rightAccepted = attempt('m2', 1, 'inherited', '/next/lens', 'accepted', '2026-01-10T11:30:00Z');
  const rightRetry = attempt('m2', 0, 'inherited', '/next/lens', 'retry', '2026-01-10T11:10:00Z');
  const sources = new Map([
    [key(leftM0), [reference(b)]], [key(rightM0), [reference(b)]],
    [key(leftM1), [reference(leftM0)]], [key(rightM1), [reference(rightM0)]],
    [key(leftAccepted), [reference(leftM1)]], [key(leftRetry), [reference(leftM1)]],
    [key(rightAccepted), [reference(rightM1)]], [key(rightRetry), [reference(rightM1)]],
  ]);
  const { nodes } = stageHistoryLayout([b, leftM0, rightM0, leftM1, rightM1, leftAccepted, leftRetry, rightAccepted, rightRetry], sources);
  const lane = (item: StageAttempt) => nodes.find(node => node.id === key(item))!.lane;
  assert.ok(lane(leftRetry) <= lane(leftM1) && lane(leftM1) <= lane(leftAccepted));
  assert.ok(lane(rightRetry) <= lane(rightM1) && lane(rightM1) <= lane(rightAccepted));
  assert.ok(lane(leftRetry) < lane(leftAccepted));
  assert.ok(lane(leftAccepted) < lane(rightRetry));
  assert.ok(lane(rightRetry) < lane(rightAccepted));
});

test('a chain continues below the exact upstream attempt after a three-way fork at any stage', () => {
  for (const [parentStage, forkStage, childStage, leafStage] of [
    ['a', 'b', 'm0', 'm1'], ['b', 'm0', 'm1', 'm2'], ['m0', 'm1', 'm2', 'm3'],
  ] as const) {
    const parent = attempt(parentStage, 0, 'run');
    const siblings = [0, 1, 2].map(index => attempt(forkStage, index, 'run', undefined,
      index === 1 ? 'accepted' : 'retry', `2026-01-10T10:${index}0:00Z`));
    const child = attempt(childStage, 0, 'run');
    const leaf = attempt(leafStage, 0, 'run');
    const { nodes } = stageHistoryLayout([leaf, siblings[2], parent, child, siblings[1], siblings[0]], new Map([
      ...siblings.map(item => [key(item), [reference(parent)]] as const),
      [key(child), [reference(siblings[2])]],
      [key(leaf), [reference(child)]],
    ]));
    const lane = (item: StageAttempt) => nodes.find(node => node.id === key(item))!.lane;
    assert.deepEqual(siblings.map(lane), [0, 1, 2]);
    assert.equal(lane(parent), 1);
    assert.equal(lane(child), 2);
    assert.equal(lane(leaf), 2);
  }
});

test('mixed report times sort chronologically across runs while undated records keep their report slots', () => {
  const lastDated = attempt('m0', 0, 'run-a', undefined, 'accepted', '2026-01-10T12:30:00Z');
  const firstDated = attempt('m0', 9, 'run-b', undefined, undefined, '2026-01-10T19:10:00+08:00');
  const undatedSecond = attempt('m0', 2, 'run-c');
  const undatedFirst = attempt('m0', 1, 'run-c', undefined, undefined, 'invalid');
  const legacy = attempt('m0', 3, undefined, '/legacy/lens');
  const { nodes } = stageHistoryLayout([lastDated, undatedSecond, legacy, firstDated, undatedFirst], new Map());
  assert.deepEqual(nodes.map(node => node.id), [firstDated, undatedFirst, legacy, lastDated, undatedSecond].map(key));
});

test('equal timestamps order attempts of the same run numerically within their original run slots', () => {
  const when = '2026-01-10T10:10:00Z';
  const own0 = attempt('a', 0, 'run-a', undefined, undefined, when);
  const own1 = attempt('a', 1, 'run-a', undefined, 'accepted', when);
  const other = attempt('a', 0, 'run-b', undefined, 'accepted', when);
  const { nodes } = stageHistoryLayout([own1, other, own0], new Map());
  assert.deepEqual(nodes.map(node => node.id), [own0, other, own1].map(key));
});
