export type PositionPoint = { id: string; x: string; y: string };
export type PositionDraft = { points: PositionPoint[]; threshold: string; strength: string; target?: string; inputFitsSha256?:string };
export type PositionFrame = {
  shape: [number, number]; pixelScale: number;
  xDirection: 'increasing' | 'decreasing'; yDirection: 'increasing' | 'decreasing';
};
export type PositionView={zoom:number;pan:{x:number;y:number}};
export type PositionSource={report_id:string;provenance_path:string;provenance_sha256:string;fits_path:string;fits_sha256:string};
export type PositionContext = { target: string; synthetic: boolean; stage: string; frame?: PositionFrame; coordinateFrame?:PositionFrame; image?: string; imageReference?:string; source?:PositionSource };
export const emptyPositionDraft = (): PositionDraft => ({ points: [], threshold: '0.1', strength: '10000000000' });
export const positionStart = '[TinyLens position likelihood]';
export const positionEnd = '[/TinyLens position likelihood]';
const finite = (value: string) => value.trim() !== '' && Number.isFinite(Number(value));
const sign = (direction: PositionFrame['xDirection']) => direction === 'increasing' ? 1 : -1;
const precise = (value: number) => Number(value.toPrecision(12));

/** Fractions refer to pixel edges, while the coordinate origin is at the geometric centre. */
export function pointFromImage(u: number, v: number, frame: PositionFrame, view?:PositionView) {
  if(view){u=(u-.5-view.pan.x/100)/view.zoom+.5;v=(v-.5-view.pan.y/100)/view.zoom+.5;}
  const column = Math.max(0, Math.min(frame.shape[1] - 1, u * frame.shape[1] - .5));
  const row = Math.max(0, Math.min(frame.shape[0] - 1, v * frame.shape[0] - .5));
  return {
    x: precise((column - (frame.shape[1] - 1) / 2) * frame.pixelScale * sign(frame.xDirection)),
    y: precise((row - (frame.shape[0] - 1) / 2) * frame.pixelScale * sign(frame.yDirection)),
  };
}
export function pointToImage(x: number, y: number, frame: PositionFrame, view?:PositionView) {
  const point={
    u: (x / (frame.pixelScale * sign(frame.xDirection)) + (frame.shape[1] - 1) / 2 + .5) / frame.shape[1],
    v: (y / (frame.pixelScale * sign(frame.yDirection)) + (frame.shape[0] - 1) / 2 + .5) / frame.shape[0],
  };
  return view?{u:(point.u-.5)*view.zoom+.5+view.pan.x/100,v:(point.v-.5)*view.zoom+.5+view.pan.y/100}:point;
}
export function positionError(value: PositionDraft, frame?: PositionFrame, inputFitsSha256?:string): string | null {
  if (value.target !== undefined && !value.target.trim()) return '请填写目标系统或数据目录。';
  if (value.points.length&&value.inputFitsSha256&&inputFitsSha256&&value.inputFitsSha256!==inputFitsSha256) return '输入图像已变化，请清空旧位置点后重新选择。';
  if (value.points.length < 2) return '至少指定两个不同的点。';
  if (value.points.length > 32) return '最多指定 32 个点。';
  if (value.points.some(point => !finite(point.x) || !finite(point.y))) return '请填写每个点的有效 x、y 坐标。';
  const positions = value.points.map(point => [Number(point.x), Number(point.y)]);
  if (positions.some((p, i) => positions.slice(i + 1).some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-8))) return '位置点不能重复。';
  if (frame && positions.some(([x, y]) => {
    const { u, v } = pointToImage(x, y, frame);
    return u < .5 / frame.shape[1] - 1e-10 || u > 1 - .5 / frame.shape[1] + 1e-10 || v < .5 / frame.shape[0] - 1e-10 || v > 1 - .5 / frame.shape[0] + 1e-10;
  })) return '位置点必须位于图像范围内。';
  if (!finite(value.threshold) || Number(value.threshold) <= 0) return '源平面容差必须大于 0。';
  if (!finite(value.strength) || Number(value.strength) < 0) return '惩罚强度必须是非负有限数。';
  return null;
}
export function positionRequest(value: PositionDraft, context: PositionContext) {
  const error = positionError(value, context.frame,context.source?.fits_sha256);
  if (error) throw new Error(error);
  if(context.source&&value.target!==undefined&&value.target.trim()!==context.target)throw new Error('位置约束目标与图像来源不一致。');
  const coordinateFrame=context.coordinateFrame??context.frame;
  return {
    schema: 'tinylens.position-likelihood-user-input.v1', kind: 'user_input', synthetic: context.synthetic,
    target: value.target?.trim() || context.target, stage: context.stage,
    coordinate_system: {
      name: 'centered_image_plane_arcsec', unit: 'arcsec', origin: 'geometric_image_center',
      x_direction: coordinateFrame?.xDirection ?? 'increasing', y_direction: coordinateFrame?.yDirection ?? 'increasing',
      x_axis: 'column', y_axis: 'row',
      ...(coordinateFrame ? { image_shape: coordinateFrame.shape, pixel_scale_arcsec: coordinateFrame.pixelScale, preview: context.imageReference??context.image } : {}),
      ...(context.coordinateFrame&&context.frame?{array_frame:'canonical',preview_frame:{x_direction:context.frame.xDirection,y_direction:context.frame.yDirection}}:{}),
    },
    ...(context.source?{source:context.source}:{}),
    position_likelihood: {
      positions: value.points.map(point => [Number(point.x), Number(point.y)]),
      threshold_arcsec: Number(value.threshold), min_log_like: Number(value.strength) === 0 ? 0 : -Number(value.strength),
    },
  };
}
export type PositionRequest = ReturnType<typeof positionRequest>;
export function draftFromPositionRequest(request: PositionRequest): PositionDraft {
  return { points: request.position_likelihood.positions.map(([x, y], i) => ({ id: `saved-${i}`, x: String(x), y: String(y) })), threshold: String(request.position_likelihood.threshold_arcsec), strength: String(Math.abs(request.position_likelihood.min_log_like)), target: request.target };
}
export function positionPrompt(value: PositionDraft, context: PositionContext, language: 'zh' | 'en' = 'zh'): string {
  const request = positionRequest(value, context);
  const introduction = language === 'en'
    ? 'These points are my proposed multiple-image positions of the same background-source feature. Please verify the target, coordinate frame, image bounds and compatibility with the current workflow before applying this position-likelihood request. Decide any rerun through your existing workflow and preserve previous results. Do not overwrite an accepted Stage-A predicted-image family. Ask me if the constraints conflict with the current run.'
    : '以下点是我指定的同一背景源特征的多重像位置。请先核对目标数据、坐标系、图像范围及当前工作流的兼容性，再处理这组 position likelihood 请求。需要重跑时请按现有流程安排并保留旧结果，不要直接覆盖已接受的 Stage A predicted-image family；如有冲突请询问我。';
  const demo = context.synthetic ? (language === 'en' ? '\nThese are synthetic demo coordinates; do not apply them to real data.' : '\n这些是合成演示坐标，不可用于真实数据。') : '';
  return `${positionStart}\n${introduction}${demo}\n\n${JSON.stringify(request, null, 2)}\n${positionEnd}`;
}
/** Only replace text that we generated. A manually edited block is preserved until explicit replacement. */
export function mergePositionPrompt(text: string, previous: string, next: string, force = false) {
  if (previous && text.includes(previous)) return { text: text.replace(previous, next), manual: false };
  if (previous && !force) return { text, manual: true };
  if (force) {
    const start = text.indexOf(positionStart), end = text.indexOf(positionEnd, start);
    if (start >= 0 && end >= start) return { text: text.slice(0, start) + next + text.slice(end + positionEnd.length), manual: false };
  }
  return { text: next ? `${text}${text ? '\n\n' : ''}${next}` : text, manual: false };
}
export function validStoredPositionDraft(value: unknown): value is PositionDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as PositionDraft;
  return typeof d.threshold === 'string' && typeof d.strength === 'string' && (d.target === undefined || typeof d.target === 'string') && (d.inputFitsSha256===undefined||typeof d.inputFitsSha256==='string'&&/^[a-f0-9]{64}$/.test(d.inputFitsSha256)) && Array.isArray(d.points) && d.points.length <= 32 && d.points.every(p => p && typeof p.id === 'string' && typeof p.x === 'string' && typeof p.y === 'string');
}
