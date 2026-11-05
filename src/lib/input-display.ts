import type { AgentUpdate } from './agent-types';
import type {LivePlane} from './live-results';
import {hasNumericRaster} from './image-scale.ts';

export type InputScale = 'linear' | 'log' | 'zscale';
export type InputPlane = {
  id: 'data' | 'noise' | 'snr' | 'psf'; shape: number[]; constant: boolean;
  half_extent_arcsec: number; half_extent_x_arcsec?: number; scale_bar_arcsec: number;
  unit?: string; data_min?: number; data_max?: number;
  numeric?:LivePlane;
  variants: Record<InputScale, { src: string; vmin: number; vmax: number; sha256?: string; constant_color?: string }>;
};
export type InputDisplay = {
  schema: 'tinylens.input-display.v1'; pixel_scale_arcsec: number; log_a: number;
  x_direction: 'increasing'; y_direction: 'decreasing'; psf_sum: number; colormap_src?: string;
  source: { provenance_path: string; provenance_sha256: string; fits_path: string; fits_sha256: string; array_sha256: Record<string, string> };
  planes: InputPlane[]; cache?: { saved_at: string; from_cache: boolean };
  rendered_from?:'numeric-array';
};

export function selectInputReport(updates: AgentUpdate[]) {
  return updates.filter(update => update.id && update.kind === 'artifact' && update.stage?.toLowerCase() === 'preflight' && update.path?.endsWith('/input-provenance.json')).at(-1);
}
const png = (value: unknown): value is string => typeof value === 'string' && /^data:image\/png;base64,[a-zA-Z0-9+/]+=*$/.test(value);
export function parseInputDisplay(value: unknown, report: AgentUpdate): InputDisplay {
  const data = value as InputDisplay;
  if (!data || data.schema !== 'tinylens.input-display.v1' || data.source?.provenance_path !== report.path || !/^[a-f0-9]{64}$/.test(data.source?.fits_sha256 ?? '') || !Number.isFinite(data.pixel_scale_arcsec) || data.pixel_scale_arcsec <= 0 || !Number.isFinite(data.log_a) || data.log_a <= 0 || !Number.isFinite(data.psf_sum) || data.x_direction !== 'increasing' || data.y_direction !== 'decreasing') throw new Error('FITS 预览与已报告的输入不匹配。');
  if (!Array.isArray(data.planes) || data.planes.map(p => p.id).join() !== 'data,noise,snr,psf') throw new Error('FITS 四图预览不完整。');
  for (const plane of data.planes) {
    if (!Array.isArray(plane.shape) || plane.shape.length !== 2 || !plane.shape.every(n => Number.isInteger(n) && n > 0 && n <= 512) || !Number.isFinite(plane.half_extent_arcsec) || plane.half_extent_arcsec <= 0 || !Number.isFinite(plane.scale_bar_arcsec) || plane.scale_bar_arcsec <= 0) throw new Error('FITS 图像几何无效。');
    if (Math.abs(plane.half_extent_arcsec - plane.shape[0] * data.pixel_scale_arcsec / 2) > 1e-10 || !Number.isFinite(plane.half_extent_x_arcsec) || Math.abs(plane.half_extent_x_arcsec! - plane.shape[1] * data.pixel_scale_arcsec / 2) > 1e-10) throw new Error('FITS 标尺与像素尺度不一致。');
    for (const scale of ['linear', 'log', 'zscale'] as const) {
      const image = plane.variants?.[scale];
      if (!image || image.src!=='' || !Number.isFinite(image.vmin) || !Number.isFinite(image.vmax) || image.vmax < image.vmin) throw new Error('FITS 显示尺度无效。');
      if (image.constant_color && !/^#[a-f0-9]{6}$/i.test(image.constant_color)) throw new Error('FITS 常量色阶无效。');
    }
    if(!hasNumericRaster(plane.numeric)||plane.numeric.src!==''||plane.numeric.colormap_src!==''||plane.numeric.input_fits_sha256!==data.source.fits_sha256||plane.numeric.array_y_direction!=='decreasing'||plane.numeric.shape.join()!==plane.shape.join())throw Error('FITS 数值图层缺失或不匹配。');
  }
  if (data.planes.slice(0, 3).some(plane => plane.shape.join() !== data.planes[0].shape.join())) throw new Error('FITS Data、RMS 和 SNR 未对齐。');
  if (data.colormap_src) throw new Error('FITS 色条须从数值色表生成。');
  return data;
}
