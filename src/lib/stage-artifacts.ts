import { useEffect, useState } from 'react';
import type { AgentUpdate } from './agent-types';
import { isNamedDisplaySchema } from './display-report';
import { agentTaskUrl } from './live-tasks';
import { resultIdentity, workbenchStage, type AttemptIdentity } from './stage-attempts';
import type { HistoryReference } from './stage-history';
import { useAgentTaskId } from './agent-task-context';
import type { LiveResult } from './live-results';

export type RawArtifact = { name: string; src: string };
export const preflightRawFilenames = ['preflight_6panel.png', 'preflight_2panel.png'] as const;
export type PreflightRawReports = readonly [AgentUpdate | undefined, AgentUpdate | undefined];

export function preflightImageReports(reports: readonly AgentUpdate[], identity: AttemptIdentity): PreflightRawReports {
  const match = (name: typeof preflightRawFilenames[number]) => reports.filter(report =>
    report.kind === 'artifact' && report.id && !report.display_manifest
    && report.path === `${identity.runPath}/preflight/${name}` && resultIdentity(report)?.key === identity.key).at(-1);
  return [
    match(preflightRawFilenames[0]),
    match(preflightRawFilenames[1]),
  ];
}

export const maskLayerNames = ['aperture', 'contamination', 'arc'] as const;
export type MaskLayerName = typeof maskLayerNames[number];
export type MaskLayers = { shape: [number, number]; bounds_arcsec: number[]; array_y_direction: 'decreasing' }
  & Partial<Record<MaskLayerName, string>>;
export type JointParameters = { names: string[]; sample_count: number };
type Point = [number, number];
export type JointDensity = {
  method: 'getdist'; parameters: [string, string]; bounds: [number, number, number, number]; sample_count: number;
  contours: { probability: number; level: number; polygons: Point[][][] }[];
};
type InheritedConfiguration = {
  run_id: string; source_run_id: string; stage: 'a'; attempt: number; summary_sha256: string;
  config: NonNullable<LiveResult['config']>; mass_model?: string;
};
type DisplayViews = { raw_artifacts: RawArtifact[]; mask_layers: MaskLayers; joint_parameters: JointParameters;
  joint_density: JointDensity; inherited_configuration: InheritedConfiguration;
  history_lineage: { upstream: HistoryReference[] } };
const jointRequests = new Map<string, Promise<JointParameters | JointDensity | undefined>>();
const jointCacheLimit = 40;

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
function maskPlane(value: unknown, count: number) {
  if (typeof value !== 'string' || !base64.test(value) || value.length !== Math.ceil(count / 3) * 4) return false;
  try {
    const pixels = atob(value);
    return pixels.length === count && !/[^\x00\x01]/.test(pixels);
  } catch { return false; }
}

export function parseStageView<K extends keyof DisplayViews>(kind: K, value: unknown): DisplayViews[K] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (kind === 'raw_artifacts') {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is RawArtifact => item && typeof item.name === 'string'
      && /^[\w.-]+\.png$/i.test(item.name) && typeof item.src === 'string'
      && item.src.startsWith('data:image/png;base64,') && base64.test(item.src.slice(22))) as DisplayViews[K];
  }
  if (kind === 'mask_layers') {
    const { shape, bounds_arcsec, array_y_direction } = value as MaskLayers;
    if (!Array.isArray(shape) || shape.length !== 2 || !shape.every(n => Number.isInteger(n) && n > 0 && n <= 512)
        || !Array.isArray(bounds_arcsec) || bounds_arcsec.length !== 4 || !bounds_arcsec.every(Number.isFinite)
        || bounds_arcsec[0] >= bounds_arcsec[1] || bounds_arcsec[2] >= bounds_arcsec[3] || array_y_direction !== 'decreasing') return undefined;
    const layers = { shape, bounds_arcsec, array_y_direction } as MaskLayers;
    for (const name of maskLayerNames) {
      const layer = (value as MaskLayers)[name];
      if (maskPlane(layer, shape[0] * shape[1])) layers[name] = layer;
    }
    return layers as DisplayViews[K];
  }
  if (kind === 'joint_parameters') {
    const { names, sample_count } = value as JointParameters;
    if (!Array.isArray(names) || names.length < 2 || new Set(names).size !== names.length
        || names.some(name => typeof name !== 'string' || !name) || !Number.isSafeInteger(sample_count) || sample_count < 2) return undefined;
    return { names, sample_count } as DisplayViews[K];
  }
  if (kind === 'inherited_configuration') {
    const inherited = value as InheritedConfiguration;
    if (inherited.stage !== 'a' || !Number.isSafeInteger(inherited.attempt) || inherited.attempt < 0
        || typeof inherited.run_id !== 'string' || !inherited.run_id
        || typeof inherited.source_run_id !== 'string' || !inherited.source_run_id || inherited.source_run_id === inherited.run_id
        || !/^[a-f0-9]{64}$/.test(inherited.summary_sha256) || !inherited.config?.settings
        || typeof inherited.config.settings !== 'object' || Array.isArray(inherited.config.settings)
        || (inherited.mass_model !== undefined && typeof inherited.mass_model !== 'string')) return undefined;
    return inherited as DisplayViews[K];
  }
  if (kind === 'history_lineage') {
    const { upstream } = value as DisplayViews['history_lineage'];
    if (!Array.isArray(upstream) || upstream.length > 6 || upstream.some(reference => {
      if (!reference || typeof reference.stage !== 'string' || workbenchStage(reference.stage) !== reference.stage) return true;
      return (reference.stage === 'preflight' ? reference.attempt !== null
        : reference.attempt === null || !Number.isSafeInteger(reference.attempt) || reference.attempt < 0)
        || typeof reference.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reference.run_id)
        || typeof reference.run_path !== 'string' || !reference.run_path.startsWith('/') || /[\0\r\n]/.test(reference.run_path)
        || reference.run_path.slice(1).split('/').some(part => ['', '.', '..'].includes(part));
    }) || new Set(upstream.map(reference => reference.stage)).size !== upstream.length) return undefined;
    return { upstream } as DisplayViews[K];
  }
  const { method, parameters, bounds, contours, sample_count } = value as JointDensity;
  if (method !== 'getdist' || !Array.isArray(parameters) || parameters.length !== 2 || parameters[0] === parameters[1]
      || parameters.some(name => typeof name !== 'string' || !name) || !Number.isSafeInteger(sample_count) || sample_count < 2
      || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
      || bounds[0] >= bounds[1] || bounds[2] >= bounds[3] || !Array.isArray(contours) || contours.length !== 2
      || ![.68, .95].every(probability => contours.some(contour => contour?.probability === probability))) return undefined;
  for (const contour of contours) {
    if (!Number.isFinite(contour.level) || contour.level < 0 || !Array.isArray(contour.polygons) || !contour.polygons.length) return undefined;
    for (const polygon of contour.polygons) {
      if (!Array.isArray(polygon) || !polygon.length) return undefined;
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return undefined;
      }
    }
  }
  return { method, parameters, bounds, contours, sample_count } as DisplayViews[K];
}

function stageViewResponse<K extends keyof DisplayViews>(kind: K, data: Record<string, unknown>, report: AgentUpdate,
  pair?: readonly [string, string]): DisplayViews[K] | undefined {
  const identity = resultIdentity(report);
  if (!identity || !data || typeof data.schema !== 'string'
      || (!isNamedDisplaySchema(data.schema) && data.schema !== 'tinylens.stage-display.v1')
      || data.report_path !== report.path || data.stage !== identity.stage || data.attempt !== identity.attempt
      || (identity.runId && data.run_id !== undefined && data.run_id !== identity.runId)) return undefined;
  const value = parseStageView(kind, data[kind]);
  if (kind === 'joint_density' && value && pair && (value as JointDensity).parameters.some((name, axis) => name !== pair[axis])) return undefined;
  if (kind === 'inherited_configuration' && value && (!identity.runId || data.run_id !== identity.runId
      || (value as InheritedConfiguration).run_id !== identity.runId)) return undefined;
  if (kind === 'history_lineage' && (!identity.runId || data.run_id !== identity.runId)) return undefined;
  return value;
}

export async function readStageView<K extends keyof DisplayViews>(kind: K, report: AgentUpdate, task: string,
  signal?: AbortSignal, pair?: readonly [string, string]): Promise<DisplayViews[K] | undefined> {
  if (!report.id || !report.path || !resultIdentity(report)) return undefined;
  const params = new URLSearchParams({ updateId: report.id, view: kind });
  if (pair) { params.set('x', pair[0]); params.set('y', pair[1]); }
  try {
    const response = await fetch(agentTaskUrl(`/api/agent/display?${params}`, task), { signal });
    if (!response.ok) return undefined;
    return stageViewResponse(kind, await response.json(), report, pair);
  } catch { return undefined; }
}

export async function readStageHistoryBatch(reports: readonly AgentUpdate[], task: string,
  signal: AbortSignal, publish: (report: AgentUpdate, upstream: HistoryReference[]) => void) {
  const params = new URLSearchParams({ view: 'history_lineage', updateIds: reports.map(report => report.id).join(',') });
  try {
    const response = await fetch(agentTaskUrl(`/api/agent/display?${params}`, task), { signal });
    if (response.ok) {
      const { results }: { results?: Record<string, Record<string, unknown>> } = await response.json();
      if (!results || typeof results !== 'object' || Array.isArray(results)) return;
      for (const report of reports) {
        if (signal.aborted) return;
        if (!report.id || !Object.hasOwn(results, report.id)) continue;
        const value = stageViewResponse('history_lineage', results[report.id], report);
        if (value) publish(report, value.upstream);
      }
      return;
    }
    // Older local bridges only expose the individual read.
    if (response.status !== 400 && response.status !== 404) return;
  } catch { return; }

  const remaining = reports.values();
  async function readNext() {
    for (const report of remaining) {
      if (signal.aborted) return;
      const value = await readStageView('history_lineage', report, task, signal);
      if (value && !signal.aborted) publish(report, value.upstream);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, reports.length) }, readNext));
}

export function useStageView<K extends keyof DisplayViews>(kind: K, report?: AgentUpdate, pair?: readonly [string, string]) {
  const task = useAgentTaskId();
  const id = report?.id;
  const path = report?.path;
  const identity = report && resultIdentity(report);
  const signature = id && identity ? JSON.stringify([task, id, path, identity.key, kind, pair]) : undefined;
  const [loaded, setLoaded] = useState<{ signature: string; value?: DisplayViews[K] }>();
  useEffect(() => {
    if (!report || !signature || !path) return;
    const controller = new AbortController();
    const joint = kind === 'joint_parameters' || kind === 'joint_density';
    const cached = joint ? jointRequests.get(signature) as Promise<DisplayViews[K] | undefined> | undefined : undefined;
    const request = cached ?? readStageView(kind, report, task, joint ? undefined : controller.signal, pair);
    if (joint && !cached) {
      const entry = request as Promise<JointParameters | JointDensity | undefined>;
      if (jointRequests.size >= jointCacheLimit) jointRequests.delete(jointRequests.keys().next().value!);
      jointRequests.set(signature, entry);
      void entry.then(value => { if (!value && jointRequests.get(signature) === entry) jointRequests.delete(signature); });
    }
    void request.then(value => {
      if (!controller.signal.aborted) setLoaded({ signature, value });
    });
    return () => controller.abort();
  }, [signature]);
  return { value: loaded?.signature === signature ? loaded?.value : undefined, loading: !!signature && loaded?.signature !== signature };
}
