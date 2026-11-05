import { useDemoI18n } from '../lib/demo-i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Eraser, Expand, Shrink, Undo2, Redo2, RotateCcw, Eye, EyeOff } from 'lucide-react';
import './mask-editor.css';
import {maskGrid} from '../lib/mask-grid';
import {imageLabelRasterEvent} from '../lib/adaptive-image-labels';

export const MASK_GRID_SIZE = 96;
const N = MASK_GRID_SIZE;
const COUNT = N * N;
type Tool = 'paint' | 'erase';
type Point = { x: number; y: number };

const equal = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Included pixels, not FITS exclusion-mask polarity. This is a synthetic UI fixture. */
export function createInitialMask(): number[] {
  return Array.from({ length: COUNT }, (_, i) => {
    const x = i % N + 0.5 - N / 2;
    const y = Math.floor(i / N) + 0.5 - N / 2;
    const radius = Math.hypot(x, y / 0.88);
    const angle = Math.atan2(y, x);
    const arc = (angle > -2.9 && angle < -0.35) || (angle > 0.3 && angle < 2.5);
    return Number(radius > 18.2 && radius < 24.8 && arc);
  });
}

interface Props {
  value: number[];
  onChange: (value: number[]) => void;
  disabled?: boolean;
  unavailable?: string;
  statistics?: { included: number; excluded: number };
  geometry?:{size:number;domain:number[];backgroundSrc:string;halfExtent:number;initialPixels:number[];radius:number|null};
  initialValue?:number[];
  backgroundSrc?:string;
  toolbarTarget?:HTMLDivElement|null;
}

interface Gesture {
  before: number[];
  last: Point;
  pointerId: number;
  tool: Tool;
}

export default function MaskEditor({ value, onChange, disabled = false, unavailable, statistics,geometry,initialValue,backgroundSrc,toolbarTarget }: Props) {
  const {t}=useDemoI18n();
  const N=geometry?.size??MASK_GRID_SIZE,COUNT=N*N;
  const operations=useMemo(()=>maskGrid(N,geometry?.domain),[N,geometry?.domain]);
  const {inDomain,cleanMask,morph}=operations,DOMAIN_PIXELS=operations.domainCount;
  const initial = useMemo(() => cleanMask(value), []);
  const [pixels, setPixels] = useState(initial);
  const pixelsRef = useRef(initial);
  const [tool, setTool] = useState<Tool>('paint');
  const [brushSize, setBrushSize] = useState(5);
  const [showOverlay, setShowOverlay] = useState(true);
  const [hover, setHover] = useState<Point | null>(null);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historyLength, setHistoryLength] = useState(1);
  const history = useRef<number[][]>([initial]);
  const indexRef = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const currentOnChange = useRef(onChange);
  currentOnChange.current = onChange;

  // A parent can restore a different saved run. Do not carry another run's undo history.
  useEffect(() => {
    const next = cleanMask(value);
    if (equal(next, pixelsRef.current)) return;
    if (gesture.current && equal(next, gesture.current.before)) return;
    gesture.current = null;
    pixelsRef.current = next;
    setPixels(next);
    history.current = [next];
    indexRef.current = 0;
    setHistoryIndex(0);
    setHistoryLength(1);
  }, [value]);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(N, N);
    if (showOverlay) {
      for (let i = 0; i < COUNT; i++) {
        if (!pixels[i]) continue;
        const x = i % N;
        const y = Math.floor(i / N);
        const edge = x === 0 || y === 0 || x === N - 1 || y === N - 1 ||
          !pixels[i - 1] || !pixels[i + 1] || !pixels[i - N] || !pixels[i + N];
        image.data[i * 4] = edge ? 110 : 25;
        image.data[i * 4 + 1] = edge ? 250 : 222;
        image.data[i * 4 + 2] = edge ? 203 : 164;
        image.data[i * 4 + 3] = edge ? 225 : 92;
      }
    }
    ctx.putImageData(image, 0, 0);
    if(geometry){ctx.fillStyle='rgba(186,203,225,.65)';for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(inDomain(x,y)&&(!inDomain(x-1,y)||!inDomain(x+1,y)||!inDomain(x,y-1)||!inDomain(x,y+1))&&(x+y)%3!==0)ctx.fillRect(x,y,1,1);}
    canvas.current?.dispatchEvent(new Event(imageLabelRasterEvent,{bubbles:true}));
  }, [pixels, showOverlay,geometry]);

  const preview = (next: number[]) => {
    pixelsRef.current = next;
    setPixels(next);
  };

  const commit = (next: number[], before = pixelsRef.current) => {
    if (disabled || equal(next, before)) return;
    const entries = [...history.current.slice(0, indexRef.current + 1), next].slice(-40);
    history.current = entries;
    indexRef.current = entries.length - 1;
    setHistoryIndex(indexRef.current);
    setHistoryLength(entries.length);
    preview(next);
    currentOnChange.current(next);
  };

  const undo = () => {
    if (disabled || gesture.current || indexRef.current === 0) return;
    const index = --indexRef.current;
    const next = history.current[index];
    setHistoryIndex(index);
    preview(next);
    currentOnChange.current(next);
  };

  const redo = () => {
    if (disabled || gesture.current || indexRef.current >= history.current.length - 1) return;
    const index = ++indexRef.current;
    const next = history.current[index];
    setHistoryIndex(index);
    preview(next);
    currentOnChange.current(next);
  };

  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * N / rect.width, y: (event.clientY - rect.top) * N / rect.height };
  };

  const paint = (from: Point, to: Point, erase: boolean) => {
    const next = [...pixelsRef.current];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance * 2));
    const radius = brushSize / 2;
    for (let step = 0; step <= steps; step++) {
      const x = from.x + (to.x - from.x) * step / steps;
      const y = from.y + (to.y - from.y) * step / steps;
      for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(N - 1, Math.ceil(y + radius)); py++) {
        for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(N - 1, Math.ceil(x + radius)); px++) {
          if (inDomain(px, py) && Math.hypot(px + 0.5 - x, py + 0.5 - y) <= radius) next[py * N + px] = erase ? 0 : 1;
        }
      }
    }
    preview(next);
  };

  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    gesture.current = { before: [...pixelsRef.current], last: point, pointerId: event.pointerId, tool };
    setShowOverlay(true);
    setHover(point);
    paint(point, point, tool === 'erase');
  };

  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    setHover(point);
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId || disabled) return;
    paint(active.last, point, active.tool === 'erase');
    active.last = point;
  };

  const pointerEnd = (event: PointerEvent<HTMLCanvasElement>, cancel = false) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (cancel) preview(active.before);
    else commit([...pixelsRef.current], active.before);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (!event.metaKey && !event.ctrlKey) {
      if (event.key.toLowerCase() === 'p') setTool('paint');
      if (event.key.toLowerCase() === 'e') setTool('erase');
    }
  };

  const included = useMemo(() => pixels.reduce((a, b) => a + b, 0), [pixels]);
  const selectTool = (next: Tool) => { setTool(next); setShowOverlay(true); };
  const renderToolbar = (toolbar: ReactNode) => toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar;

  if (unavailable&&!geometry) return <section className="mask-editor mask-unavailable" aria-label={t('透镜弧拟合区域编辑器')}>
    {renderToolbar(<div className="mask-toolbar" role="toolbar" aria-label={t('掩膜编辑工具')}><div className="mask-toolgroup">{[{name:'画笔',icon:Brush},{name:'擦除',icon:Eraser}].map(item=><button disabled key={item.name} title={unavailable}><item.icon size={15}/><span>{t(item.name)}</span></button>)}</div><span className="mask-toolbar-divider"/>{[{name:'扩大',icon:Expand},{name:'收缩',icon:Shrink}].map(item=><button disabled key={item.name} title={unavailable}><item.icon size={15}/><span>{t(item.name)}</span></button>)}<div className="mask-history-tools"><button disabled aria-label={t('撤销 mask 编辑')}><Undo2 size={16}/></button><button disabled aria-label={t('重做 mask 编辑')}><Redo2 size={16}/></button></div></div>)}
    <div className="mask-workarea"><figure className="mask-figure"><div className="mask-image-area is-unavailable"><div className="science-plane-unavailable">—</div></div></figure><div className="mask-inspector"><div className="mask-inspector-section"><span className="mask-field-label">{t('画笔直径')}</span><div className="mask-brush-value"><strong>—</strong><span>px</span></div><input type="range" disabled aria-label={t('画笔直径（像素）')}/></div><div className="mask-inspector-section"><span className="mask-field-label">{t('拟合区域覆盖')}</span><div className="mask-coverage"><strong>—</strong></div><div className="mask-coverage-track"><span style={{width:'0%'}}/></div><p className="mask-pixel-count">—</p></div><div className="mask-legend"><p><i className="mask-legend-included"/>{t('参与拟合')}</p><p><i className="mask-legend-excluded"/>{t('不参与拟合')}</p></div><button className="button secondary mask-reset" disabled><RotateCcw size={16}/>{t('恢复初始掩膜')}</button></div></div>
  </section>;

  return <section className={`mask-editor${disabled ? ' mask-disabled' : ''}`} onKeyDown={onKeyDown} aria-label={t("透镜弧拟合区域编辑器")}>
    {renderToolbar(<div className="mask-toolbar" role="toolbar" aria-label={t("掩膜编辑工具")}>
      <div className="mask-toolgroup">
        <button type="button" className={tool === 'paint' ? 'mask-selected' : ''} aria-pressed={tool === 'paint'} disabled={disabled} onClick={() => selectTool('paint')} title={t("画笔 · P")}><Brush size={15}/><span>{t("画笔")}</span></button>
        <button type="button" className={tool === 'erase' ? 'mask-selected' : ''} aria-pressed={tool === 'erase'} disabled={disabled} onClick={() => selectTool('erase')} title={t("擦除 · E")}><Eraser size={15}/><span>{t("擦除")}</span></button>
      </div>
      <span className="mask-toolbar-divider"/>
      <button type="button" disabled={disabled} onClick={() => commit(morph(pixelsRef.current, true))} title={t("向外扩展 1 像素")}><Expand size={15}/><span>{t("扩大")}</span></button>
      <button type="button" disabled={disabled} onClick={() => commit(morph(pixelsRef.current, false))} title={t("向内收缩 1 像素")}><Shrink size={15}/><span>{t("收缩")}</span></button>
      <div className="mask-history-tools">
        <button type="button" disabled={disabled || historyIndex === 0} onClick={undo} title={t("撤销 · ⌘Z")} aria-label={t("撤销 mask 编辑")}><Undo2 size={16}/></button>
        <button type="button" disabled={disabled || historyIndex === historyLength - 1} onClick={redo} title={t("重做 · ⇧⌘Z")} aria-label={t("重做 mask 编辑")}><Redo2 size={16}/></button>
      </div>
    </div>)}
    <div className="mask-workarea">
      <figure className="mask-figure">
        <div className="mask-image-area" data-render-origin="browser-array">
          <img className="mask-background" src={geometry?.backgroundSrc||backgroundSrc||undefined} alt={geometry?'本次掩膜对应的观测图像':t("用于交互演示的合成透镜图像")} draggable={false}/>
          <canvas ref={canvas} width={N} height={N} className={`mask-canvas mask-tool-${tool}`} tabIndex={disabled ? -1 : 0} aria-label={geometry?'编辑透镜弧拟合区域。画笔添加，擦除删除。':t("编辑合成透镜的拟合区域。画笔添加，擦除删除。")} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={event => pointerEnd(event, true)} onLostPointerCapture={event => pointerEnd(event, true)} onPointerLeave={() => { if (!gesture.current) setHover(null); }}/>
          {!geometry&&<div className="mask-domain-boundary" aria-hidden="true"/>}
          {hover && !disabled && <div className={`mask-brush-cursor${tool === 'erase' ? ' mask-brush-erase' : ''}`} style={{ left: `${hover.x / N * 100}%`, top: `${hover.y / N * 100}%`, width: `${brushSize / N * 100}%`, height: `${brushSize / N * 100}%` }} aria-hidden="true"/>}
          {!geometry&&<span className="mask-image-label">{t("合成图像 · 非科学结果")}</span>}
          <span className="mask-scalebar" style={geometry?{width:`${100/(2*geometry.halfExtent)}%`}:undefined}>1″</span>
          <button type="button" className="mask-overlay-button" onClick={() => setShowOverlay(v => !v)} title={showOverlay ? t("隐藏拟合区域") : t("显示拟合区域")} aria-label={showOverlay ? t("隐藏 mask 叠层") : t("显示 mask 叠层")} aria-pressed={showOverlay}>{showOverlay ? <Eye size={15}/> : <EyeOff size={15}/>}</button>
        </div>
      </figure>
      <div className="mask-inspector">
        <div className="mask-inspector-section">
          <span className="mask-field-label">{t("画笔直径")}</span>
          <div className="mask-brush-value"><strong>{brushSize}</strong><span>px</span></div>
          <input type="range" min="1" max="20" step="1" value={brushSize} disabled={disabled} onChange={event => setBrushSize(Number(event.target.value))} aria-label={t("画笔直径（像素）")}/>
        </div>
        <div className="mask-inspector-section">
          <span className="mask-field-label">{t("拟合区域覆盖")}</span>
          <div className="mask-coverage"><strong>{(included / DOMAIN_PIXELS * 100).toFixed(1)}<small>%</small></strong></div>
          <div className="mask-coverage-track"><span style={{ width: `${included / DOMAIN_PIXELS * 100}%` }}/></div>
          <p className="mask-pixel-count">{included.toLocaleString()} / {DOMAIN_PIXELS.toLocaleString()} {t("像素")}</p>
        </div>
        <div className="mask-legend">
          <p><i className="mask-legend-included"/>{t("参与拟合")}</p>
          <p><i className="mask-legend-excluded"/>{t("不参与拟合")}</p>
          <p><i className="mask-legend-boundary"/>{geometry?`${geometry.radius??'—'}″ 有效域边界`:t("4″ 有效域边界")}</p>
        </div>
        <button type="button" className="button secondary mask-reset" disabled={disabled} onClick={() => commit(cleanMask(initialValue??geometry?.initialPixels??createInitialMask()))}><RotateCcw size={16}/>{t("恢复初始掩膜")}</button>
      </div>
    </div>
  </section>;
}
