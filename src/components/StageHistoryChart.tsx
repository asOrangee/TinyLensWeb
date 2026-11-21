import { useId, type CSSProperties, type ReactNode } from 'react';
import { stages, type StageId } from '../data/stages';
import './stage-history-chart.css';

export type StageHistoryNode<T> = { id: string; stage: StageId; lane: number; value: T };
export type StageHistoryEdge = { parent: string; child: string };

type NodePosition = { row: number; lane: number };
type ChildRoute = { position: NodePosition; lane: number };
const stageRows = new Map(stages.map(({ id }, row) => [id, row]));
const laneStart = (lane: number) => `calc(var(--stage-history-side-gutter) + ${lane} * var(--stage-history-lane-step))`;
const laneX = (lane: number) => `calc(var(--stage-history-first-center) + ${lane} * var(--stage-history-lane-step))`;
const rowY = (row: number) => `calc(${row} * var(--stage-history-row-step))`;

function dropLane(parent: NodePosition, child: NodePosition, positions: ReadonlyMap<string, NodePosition>) {
  if (child.row === parent.row + 1) return child.lane;
  const skipped = [...positions.values()].filter(({ row }) => row > parent.row && row < child.row);
  const clear = (lane: number) => skipped.every(position => Math.abs(position.lane - lane) + 1e-9 >= 0.5);
  if (clear(child.lane)) return child.lane;
  return skipped.flatMap(({ lane }) => [lane - 0.5, lane + 0.5]).filter(clear)
    .sort((a, b) => Math.abs(a - child.lane) - Math.abs(b - child.lane))[0];
}

function StageHistoryLinks({ positions, edges }: {
  positions: ReadonlyMap<string, NodePosition>;
  edges: readonly StageHistoryEdge[];
}) {
  const branches = new Map<string, { parent: NodePosition; children: Map<string, ChildRoute> }>();
  for (const edge of edges) {
    const parent = positions.get(edge.parent);
    const child = positions.get(edge.child);
    if (!parent || !child || child.row <= parent.row) continue;
    const branch = branches.get(edge.parent) ?? { parent, children: new Map<string, ChildRoute>() };
    branch.children.set(edge.child, { position: child, lane: dropLane(parent, child, positions) });
    branches.set(edge.parent, branch);
  }

  return <div className="stage-history-chart__links" aria-hidden="true">
    {[...branches].map(([id, { parent, children }]) => {
      const lanes = [parent.lane, ...[...children.values()].map(child => child.lane)];
      const first = Math.min(...lanes);
      const last = Math.max(...lanes);
      const parentBottom = `calc(${rowY(parent.row)} + var(--stage-history-card-height))`;
      const junction = `calc(${parentBottom} + var(--stage-history-junction-gap))`;
      return <div className="stage-history-chart__branch" key={id}>
        <span className="stage-history-chart__stem" style={{ insetInlineStart: laneX(parent.lane), insetBlockStart: parentBottom }}/>
        {first !== last && <span className="stage-history-chart__crossbar" style={{
          insetInlineStart: laneX(first), insetBlockStart: junction,
          inlineSize: `calc(${last - first} * var(--stage-history-lane-step))`,
        }}/>}
        {[...children].map(([childId, { position: child, lane }]) => {
          const bent = lane !== child.lane;
          const end = bent ? `calc(${rowY(child.row)} - var(--stage-history-junction-gap))` : rowY(child.row);
          return <div key={childId}>
            <span className="stage-history-chart__drop" style={{
              insetInlineStart: laneX(lane), insetBlockStart: junction, blockSize: `calc(${end} - ${junction})`,
            }}/>
            {bent && <>
              <span className="stage-history-chart__crossbar" style={{
                insetInlineStart: laneX(Math.min(lane, child.lane)), insetBlockStart: end,
                inlineSize: `calc(${Math.abs(lane - child.lane)} * var(--stage-history-lane-step))`,
              }}/>
              <span className="stage-history-chart__drop" style={{
                insetInlineStart: laneX(child.lane), insetBlockStart: end, blockSize: 'var(--stage-history-junction-gap)',
              }}/>
            </>}
          </div>;
        })}
      </div>;
    })}
  </div>;
}

export default function StageHistoryChart<T>({ nodes, edges, renderNode, stageLabel }: {
  nodes: readonly StageHistoryNode<T>[];
  edges: readonly StageHistoryEdge[];
  renderNode: (value: T, node: StageHistoryNode<T>) => ReactNode;
  stageLabel: (stage: StageId) => string;
}) {
  const chartId = useId();
  const positions = new Map(nodes.map(({ id, stage, lane }) => [id, { row: stageRows.get(stage)!, lane }]));
  const lastLane = nodes.reduce((last, node) => Math.max(last, node.lane), 0);
  const columns = { '--stage-history-last-lane': lastLane } as CSSProperties;

  return <div className="stage-history-chart">
    <div className="stage-history-chart__surface" style={columns}>
      <StageHistoryLinks positions={positions} edges={edges}/>
      {stages.map(({ id: stage }) => {
        const labelId = `${chartId}-${stage}`;
        const row = nodes.filter(node => node.stage === stage).sort((first, second) => first.lane - second.lane);
        return <div className="stage-history-chart__row" key={stage} data-stage={stage} role="group" aria-labelledby={labelId}>
          <div className="stage-history-chart__label" id={labelId}>{stageLabel(stage)}</div>
          {row.map(node => <div className="stage-history-chart__node" key={node.id}
            data-lane={node.lane} style={{ insetInlineStart: laneStart(node.lane) }}>{renderNode(node.value, node)}</div>)}
        </div>;
      })}
    </div>
  </div>;
}
