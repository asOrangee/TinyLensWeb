import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, RotateCcw, ZoomIn } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import fixtures from '../data/preflight-demo.json';
import type { InputDisplay, InputPlane } from '../lib/input-display';
import { imageScaleStretch, type ImageScale } from '../lib/image-scale';
import ScienceColorbar from './ScienceColorbar';
import ImageScaleControls from './ImageScaleControls';
import PreflightFrame from './PreflightFrame';
import {useDemoInput} from '../lib/use-demo-input';
import './science-viewer.css';
import './preflight-viewer.css';

type Group = 'image' | 'psf';
type Position = { x: number; y: number };
const titles = { data: '观测图像', noise: '噪声 RMS', snr: '信噪比', psf: '点扩散函数' };
const headings = { data: 'Data image', noise: 'Noise', snr: 'SNR', psf: 'PSF' };
const scaleLabels = { linear: '线性', log: 'Log', asinh: 'Asinh', zscale: 'ZScale' };
const zeroPan = (): Record<Group, Position> => ({ image: { x: 0, y: 0 }, psf: { x: 0, y: 0 } });

function number(value: number): string {
  if (value === 0) return '0';
  return Math.abs(value) < 0.001 ? value.toExponential(2) : Number(value.toPrecision(3)).toString();
}

/** Shared input viewer; live mode only renders validated, explicitly reported FITS. */
export default function PreflightViewer({ toolbarTarget, missingLayers, display, scale, onScaleChange }: { toolbarTarget: HTMLDivElement | null; missingLayers?: string; display?: InputDisplay; scale:ImageScale; onScaleChange:(scale:ImageScale)=>void }) {
  const { t } = useDemoI18n();
  const demo=useDemoInput(missingLayers===undefined),shown=display??demo;
  const unavailable = !shown;
  const shownPlanes: InputPlane[] = shown?.planes ?? (['data','noise','snr','psf'] as const).map(id=>({id,shape:[],constant:false,half_extent_arcsec:0,scale_bar_arcsec:0,variants:{linear:{src:'',vmin:0,vmax:0},log:{src:'',vmin:0,vmax:0},zscale:{src:'',vmin:0,vmax:0}}}));
  const stretch = imageScaleStretch(scale, shown?.log_a ?? fixtures.log_a);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(zeroPan);
  const [showCrosshair, setShowCrosshair] = useState(false);
  const [crosshair, setCrosshair] = useState<(Position & { group: Group }) | null>(null);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const dragging = useRef<{ group: Group; start: Position; pan: Position } | null>(null);

  function reset() { setZoom(1); setPan(zeroPan()); setCrosshair(null); }
  function changeZoom(value: number) {
    const limit = (value - 1) * 50;
    const clamp = (v: number) => Math.max(-limit, Math.min(limit, v));
    setZoom(value);
    setPan(previous => ({ image: { x: clamp(previous.image.x), y: clamp(previous.image.y) }, psf: { x: clamp(previous.psf.x), y: clamp(previous.psf.y) } }));
  }
  function down(event: PointerEvent<HTMLDivElement>, group: Group) {
    if(unavailable)return;
    if (zoom <= 1 || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { group, start: { x: event.clientX, y: event.clientY }, pan: pan[group] };
  }
  function move(event: PointerEvent<HTMLDivElement>, group: Group) {
    if(unavailable)return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width=rect.width-2*event.currentTarget.clientLeft,height=rect.height-2*event.currentTarget.clientTop;
    setCrosshair({ group, x: (event.clientX - rect.left-event.currentTarget.clientLeft) / width * 100, y: (event.clientY - rect.top-event.currentTarget.clientTop) / height * 100 });
    const drag = dragging.current;
    if (!drag || drag.group !== group) return;
    const limit = (zoom - 1) * 50;
    const clamp = (value: number) => Math.max(-limit, Math.min(limit, value));
    setPan(previous => ({ ...previous, [group]: {
      x: clamp(drag.pan.x + (event.clientX - drag.start.x) / width * 100),
      y: clamp(drag.pan.y + (event.clientY - drag.start.y) / height * 100),
    } }));
  }
  function stop() { dragging.current = null; }
  function coordinate(value: number): string {
    return Math.abs(value) < 0.0001 ? '0' : `${value > 0 ? '+' : '−'}${number(Math.abs(value))}″`;
  }

  const toolbar = <div className="science-toolbar preflight-toolbar" role="toolbar" aria-label={t('图像显示工具')}>
      <ImageScaleControls value={scale} onChange={onScaleChange} disabled={unavailable}/>
      <div className="science-tools">
        <button disabled={unavailable} className={showCrosshair ? 'active' : ''} onClick={() => setShowCrosshair(!showCrosshair)} title={t('联动十字标记')} aria-label={t('联动十字标记')} aria-pressed={showCrosshair}><Crosshair size={15}/></button>
        <span className="science-tool-divider"/>
        <ZoomIn size={14}/>
        <input type="range" disabled={unavailable} aria-label={t('图像缩放')} min="1" max="3" step=".25" value={zoom} onChange={event => changeZoom(Number(event.target.value))}/>
        <span className="science-zoom-label">{zoom.toFixed(2)}×</span>
        <button disabled={unavailable} onClick={reset} title={t('重置视图')} aria-label={t('重置视图')}><RotateCcw size={14}/></button>
      </div>
    </div>;
  return <PreflightFrame label={t('科学图像查看器')} source={display ? 'reported-fits' : unavailable ? 'unavailable' : 'demo'}>
    {toolbarTarget && createPortal(toolbar, toolbarTarget)}
    <div className="science-panels preflight-panels">
      {shownPlanes.map(plane => {
        const image = plane.variants[scale];
        const src = image?.src;
        const group: Group = plane.id === 'psf' ? 'psf' : 'image';
        const position = pan[group];
        const extent = plane.half_extent_arcsec;
        return <figure className={`science-plane preflight-plane-${plane.id}`} key={plane.id} data-plane={plane.id} data-render-origin={src?'browser-array':undefined} data-numeric-sha256={plane.numeric?.values_sha256}>
          <figcaption className="science-plane-heading"><strong>{headings[plane.id]}</strong></figcaption>
          <div className="science-plane-body"><div className={`science-image-area${!src?' is-unavailable':''}${zoom > 1 ? ' is-zoomed' : ''}`} style={display ? { aspectRatio: `${plane.shape[1]} / ${plane.shape[0]}` } : undefined} onPointerDown={event => down(event, group)} onPointerMove={event => move(event, group)} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onPointerLeave={() => setCrosshair(null)}>
            {src&&<img key={src} src={src} alt={display ? `${t(titles[plane.id])}，来自已报告的 FITS` : t('{title}，合成演示图像', { title: t(titles[plane.id]) })} draggable={false} onError={() => setFailed(previous => ({ ...previous, [src]: true }))} style={{ transform: `translate(${position.x}%, ${position.y}%) scale(${zoom})`, visibility: failed[src] ? 'hidden' : undefined }}/>}
            {src && failed[src] && <span className="preflight-image-error" role="alert">{t('图像加载失败')}</span>}
            {!src?<div className="science-plane-unavailable" title={missingLayers}>—</div>:<><div className="science-ticks"><span>{coordinate(extent * (1 + position.y / 50) / zoom)}</span><span>{coordinate(extent * (-1 + position.y / 50) / zoom)}</span></div>
            <span className="science-scale" style={{ width: `${plane.scale_bar_arcsec / (2 * (plane.half_extent_x_arcsec ?? extent)) * 100 * zoom}%` }}><span>{plane.scale_bar_arcsec}″</span></span></>}
            {showCrosshair && crosshair?.group === group && <div className="science-crosshair" aria-hidden="true"><i style={{ left: `${crosshair.x}%` }}/><b style={{ top: `${crosshair.y}%` }}/></div>}
          </div>
          {image?.src?<ScienceColorbar min={image.vmin} max={image.vmax} {...stretch} constant={plane.constant} gradient={shown?.colormap_src} constantColor={image.constant_color} title={display ? `${headings[plane.id]} (${plane.unit}) · ${scaleLabels[scale]} · ${image.vmin} 至 ${image.vmax}` : undefined}/>:<div className="science-colorbar-unavailable" aria-label="暂无数值色阶">—</div>}</div>
        </figure>;
      })}
    </div>
  </PreflightFrame>;
}
