import type { AgentUpdate } from './agent-types';
import { resultIdentity } from './live-results.ts';

export type FormattedNativeColorbar={gradient_src:string;top:number;height:number;ticks:{position:number;value:number;source_text?:string;interpolated?:boolean}[]};
export type NativePanel = { kind: 'reported-raster'; src: string; colorbar_src: string; pixel_shape: number[]; colorbar_top: number; colorbar_height: number; intrinsic_curves: boolean; image_box_px: number[]; colorbar_box_px: number[];formatted_colorbar?:FormattedNativeColorbar };
export type NativePanels = Partial<Record<'source-lensed' | 'residual' | 'source', NativePanel>>;
export type ReportedPanels = { schema: 'tinylens.reported-panels.v1'; stage: string; attempt: number; path: string; updateId: string; source_sha256: string; panels: NativePanels };

export function parseReportedPanels(value: unknown, report: AgentUpdate): ReportedPanels {
  const data = value as ReportedPanels, identity = resultIdentity(report);
  if (!identity || report.kind!=='artifact' || !report.path?.endsWith(`/diagnostics/stage_${identity.stage}_model.png`) || data?.schema !== 'tinylens.reported-panels.v1' || data.path !== report.path || data.updateId !== report.id || data.stage !== identity.stage || data.attempt !== identity.attempt || !/^[a-f0-9]{64}$/.test(data.source_sha256 ?? '')) throw new Error('原诊断图与当前阶段不匹配。');
  if (!data.panels || Object.keys(data.panels).sort().join() !== 'residual,source,source-lensed') throw new Error('原诊断图面板不完整。');
  for (const panel of Object.values(data.panels)) {
    if (!panel || panel.kind !== 'reported-raster' || ![panel.src, panel.colorbar_src].every(src => /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)) || !Array.isArray(panel.pixel_shape) || panel.pixel_shape.length !== 2 || !panel.pixel_shape.every(n => Number.isInteger(n) && n >= 32 && n <= 2048) || !Number.isFinite(panel.colorbar_top) || Math.abs(panel.colorbar_top) > 1 || !Number.isFinite(panel.colorbar_height) || panel.colorbar_height < .2 || panel.colorbar_height > 2) throw new Error('原诊断图像素格式无效。');
    const bar=panel.formatted_colorbar;
    if(bar&&(!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(bar.gradient_src)||![bar.top,bar.height].every(Number.isFinite)||Math.abs(bar.top)>1||bar.height<=0||bar.height>2||!Array.isArray(bar.ticks)||bar.ticks.length<3||bar.ticks.length>16||bar.ticks.some((tick,i)=>![tick.value,tick.position].every(Number.isFinite)||tick.position<-.2||tick.position>1.2||i>0&&(tick.position<=bar.ticks[i-1].position||tick.value>=bar.ticks[i-1].value))))throw new Error('原图色条刻度格式无效。');
  }
  return data;
}
