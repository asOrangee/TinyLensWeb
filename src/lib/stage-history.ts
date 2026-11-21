import { stages, type StageId } from '../data/stages.ts';
import { runKey, type StageAttempt } from './stage-attempts.ts';

export type HistoryReference = {
  stage: StageId;
  attempt: number | null;
  run_id: string;
  run_path: string;
};

const rows = new Map(stages.map((stage, index) => [stage.id, index]));
const referenceKey = (path: string, id: string, stage: StageId, attempt: number | null) =>
  JSON.stringify([path, id, stage, attempt]);

type Entry = {
  value: StageAttempt;
  row: number;
  parent?: Entry;
  lane: number;
};

function chronologicalRow(entries: Entry[]) {
  const times = entries.map(({ value }) => Date.parse(value.firstReportedAt ?? ''));
  const dated = entries.flatMap((entry, index) => Number.isFinite(times[index]) ? [{ entry, time: times[index] }] : [])
    .sort((a, b) => a.time - b.time);
  let nextDated = 0;
  // Old records without a timestamp keep their slots among the dated records.
  const ordered = entries.map((entry, index) => Number.isFinite(times[index]) ? dated[nextDated++] : { entry, time: null });
  const ties = new Map<string, Entry[]>();
  const tieKey = ({ entry, time }: typeof ordered[number]) => JSON.stringify([time, runKey(entry.value.identity)]);
  for (const item of ordered) {
    const key = tieKey(item);
    const tied = ties.get(key) ?? [];
    tied.push(item.entry);
    ties.set(key, tied);
  }
  for (const tied of ties.values()) tied.sort((a, b) => (b.value.identity.attempt ?? -1) - (a.value.identity.attempt ?? -1));
  return ordered.map(item => ties.get(tieKey(item))!.pop()!);
}

function placeRow(entries: Entry[]) {
  const siblingGroups = new Map<Entry, Entry[]>();
  for (const entry of entries) {
    if (!entry.parent) continue;
    const siblings = siblingGroups.get(entry.parent) ?? [];
    siblings.push(entry);
    siblingGroups.set(entry.parent, siblings);
  }
  const preferred = new Map(entries.map((entry, index) => [entry, index - (entries.length - 1) / 2]));
  for (const [parent, siblings] of siblingGroups) {
    siblings.forEach((entry, index) => preferred.set(entry, parent.lane + index - (siblings.length - 1) / 2));
  }

  // Subtract the minimum spacing before merging overlapping groups in chronological order.
  const groups: { start: number; count: number; total: number }[] = [];
  for (const [index, entry] of entries.entries()) {
    const group = { start: index, count: 1, total: preferred.get(entry)! - index };
    while (groups.length) {
      const previous = groups.at(-1)!;
      if (previous.total / previous.count <= group.total / group.count) break;
      groups.pop();
      group.start = previous.start;
      group.total += previous.total;
      group.count += previous.count;
    }
    groups.push(group);
  }
  for (const { start, count, total } of groups) {
    for (let index = start; index < start + count; index++) entries[index].lane = index + total / count;
  }
}

export function stageHistoryLayout(
  attempts: readonly StageAttempt[],
  sources: ReadonlyMap<string, readonly HistoryReference[]>,
) {
  const entries: Entry[] = [...new Map(attempts.map(value => [value.identity.key, value])).values()]
    .map(value => ({ value, row: rows.get(value.identity.stage)!, lane: 0 }));
  const byReference = new Map<string, Entry>();
  for (const entry of entries) {
    const { runPath, runId, stage, attempt } = entry.value.identity;
    if (runId) byReference.set(referenceKey(runPath, runId, stage, attempt), entry);
  }

  for (const entry of entries) {
    const references = sources.get(entry.value.identity.key) ?? [];
    const parents = new Set<Entry>();
    let nearestRow = -1;
    for (const { run_path, run_id, stage, attempt } of references) {
      const candidate = byReference.get(referenceKey(run_path, run_id, stage, attempt));
      if (!candidate || candidate.row >= entry.row || candidate.row < nearestRow) continue;
      if (candidate.row > nearestRow) {
        parents.clear();
        nearestRow = candidate.row;
      }
      parents.add(candidate);
    }
    if (parents.size !== 1) continue;
    entry.parent = [...parents][0];
  }

  const orderedRows = stages.map((_, row) => chronologicalRow(entries.filter(entry => entry.row === row)));
  orderedRows.forEach(placeRow);

  const ordered = orderedRows.flat();
  const firstLane = Math.min(0, ...ordered.map(entry => entry.lane));
  const nodes = ordered
    .map(({ lane, value }) => ({ id: value.identity.key, stage: value.identity.stage, lane: lane - firstLane, value }));
  const edges = ordered.flatMap(({ parent, value }) => parent
    ? [{ parent: parent.value.identity.key, child: value.identity.key }] : []);
  return { nodes, edges };
}
