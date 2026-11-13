import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {createPortal} from 'react-dom';
import { Crosshair, Download, Plus, RotateCcw, Trash2, ZoomIn } from 'lucide-react';
import { useDemoI18n } from '../lib/demo-i18n';
import { downloadJSON } from '../lib/workspace';
import { pointFromImage, pointToImage, positionError, positionRequest, type PositionContext, type PositionDraft } from '../lib/position-likelihood';
import type {ImageScale} from '../lib/image-scale';
import ImageScaleControls from './ImageScaleControls';
import './position-likelihood.css';

type Props = { value: PositionDraft; context: PositionContext; onChange: (value: PositionDraft) => void; onReplacePrompt: () => void; manualPrompt: boolean; promptPresent: boolean; disabled?: boolean;toolbarTarget?:HTMLDivElement|null;scale?:ImageScale;onScaleChange?:(scale:ImageScale)=>void };
export default function PositionLikelihoodEditor({ value, context, onChange, onReplacePrompt, manualPrompt, promptPresent, disabled = false,toolbarTarget,scale,onScaleChange }: Props) {
  const { t } = useDemoI18n();
  const [imageFailed, setImageFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom,setZoom]=useState(1),[pan,setPan]=useState({x:0,y:0});
  const gesture=useRef<{id:number;x:number;y:number;pan:{x:number;y:number};moved:boolean}|null>(null);
  const imageIdentity=JSON.stringify([context.target,context.source?.fits_sha256,context.frame]);
  useEffect(()=>{setZoom(1);setPan({x:0,y:0});gesture.current=null;},[imageIdentity]);
  useEffect(()=>setImageFailed(false),[context.image]);
  const sourceChanged=!!value.inputFitsSha256&&!!context.source&&value.inputFitsSha256!==context.source.fits_sha256;
  const error = positionError(value, context.frame,context.source?.fits_sha256);
  const canPick = !!context.image && !!context.frame && !imageFailed&&!sourceChanged;
  function reset(){setZoom(1);setPan({x:0,y:0});gesture.current=null;}
  function changeZoom(next:number){const limit=(next-1)*50;setZoom(next);setPan(previous=>({x:Math.max(-limit,Math.min(limit,previous.x)),y:Math.max(-limit,Math.min(limit,previous.y))}));gesture.current=null;}
  function add(x = '', y = '') {
    if (disabled || value.points.length >= 32) return;
    const id = crypto.randomUUID();
    onChange({ ...value, points: [...value.points, { id, x, y }] }); setSelected(id);
  }
  function pick(event: PointerEvent<HTMLDivElement>) {
    if (disabled || imageFailed || sourceChanged || !context.frame || event.button !== 0) return;
    event.preventDefault();
    const el = event.currentTarget, rect = el.getBoundingClientRect();
    const { x, y } = pointFromImage((event.clientX - rect.left - el.clientLeft) / el.clientWidth, (event.clientY - rect.top - el.clientTop) / el.clientHeight, context.frame,{zoom,pan});
    add(String(Number(x.toFixed(6))), String(Number(y.toFixed(6))));
  }
  function down(event:PointerEvent<HTMLDivElement>){
    if(!context.image||!context.frame||imageFailed||event.button!==0||(disabled&&zoom<=1))return;
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,pan:{...pan},moved:false};
  }
  function move(event:PointerEvent<HTMLDivElement>){
    const drag=gesture.current;if(!drag||drag.id!==event.pointerId)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    if(Math.hypot(dx,dy)>=4)drag.moved=true;
    if(!drag.moved||zoom<=1)return;
    const limit=(zoom-1)*50;
    setPan({x:Math.max(-limit,Math.min(limit,drag.pan.x+dx/event.currentTarget.clientWidth*100)),y:Math.max(-limit,Math.min(limit,drag.pan.y+dy/event.currentTarget.clientHeight*100))});
  }
  function finish(event:PointerEvent<HTMLDivElement>,cancel=false){
    const drag=gesture.current;if(!drag||drag.id!==event.pointerId)return;
    gesture.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(!cancel&&!drag.moved&&!disabled)pick(event);
  }
  return <>{toolbarTarget&&scale&&onScaleChange&&createPortal(<div className="science-toolbar" role="toolbar" aria-label={t('图像显示工具')}><ImageScaleControls value={scale} onChange={onScaleChange} disabled={!context.image}/><div className="science-tools"><ZoomIn size={14} aria-hidden="true"/><input type="range" min="1" max="3" step=".25" aria-label={t('图像缩放')} value={zoom} disabled={!context.image||imageFailed} onChange={event=>changeZoom(Number(event.target.value))}/><span className="science-zoom-label">{zoom.toFixed(2)}×</span><button type="button" aria-label={t('重置视图')} title={t('重置视图')} onClick={reset} disabled={!context.image||imageFailed}><RotateCcw size={14}/></button></div></div>,toolbarTarget)}<section className="panel position-editor" aria-label={t('位置约束')}>
    <div className="position-heading"><h3>{t('多重像位置约束')}</h3></div>
    <p className="position-intro">{t('选择同一背景源特征的不同像点，至少两个。模型将它们回溯到源平面后，应落在相近的位置。')}</p>
    <div className={`position-layout${context.image ? '' : ' is-manual'}`}>
      {context.image && context.frame && <div className="position-image-column"><div className={'position-image'+(zoom>1?' is-zoomed':'')} role="group" aria-label={t('在图像上添加位置点')} style={{ aspectRatio: `${context.frame.shape[1]} / ${context.frame.shape[0]}` }} onPointerDown={down} onPointerMove={move} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onLostPointerCapture={event=>finish(event,true)}>
        <img src={context.image} alt={t('用于选择位置点的观测图像')} draggable={false} onError={() => setImageFailed(true)} style={{transform:`translate(${pan.x}%, ${pan.y}%) scale(${zoom})`}}/>
        {imageFailed && <span className="position-image-error" role="alert">{t('图像加载失败，请手动输入坐标。')}</span>}
        {value.points.map((point, i) => {
          if (!point.x.trim() || !point.y.trim() || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
          const { u, v } = pointToImage(Number(point.x), Number(point.y), context.frame!,{zoom,pan});
          if (u < 0 || u > 1 || v < 0 || v > 1) return null;
          return <span key={point.id} className={`position-marker${selected === point.id ? ' selected' : ''}`} style={{ left: `${u * 100}%`, top: `${v * 100}%` }}><Crosshair size={22}/><b>{i + 1}</b></span>;
        })}
      </div></div>}
      <div className="position-form"><div className="position-point-heading"><strong>{t('位置点')} · {value.points.length}</strong>{!canPick && <button className="text-button" type="button" onClick={() => add()} disabled={disabled || value.points.length >= 32}><Plus size={14}/>{t('添加点')}</button>}</div>
        {!context.image && <p className="position-coordinate-note">{t('输入当前运行的 x/y（arcsec）；原点为图像中心，x 随列增加，y 随行增加。请使用已确认的坐标。')}</p>}
        {!value.points.length && <div className="position-empty">{context.image ? t('在图像上点击两个或更多位置点。') : t('点击“添加点”，填写至少两个位置。')}</div>}
        <div className="position-point-list">{value.points.map((point, i) => <div className="position-point-row" key={point.id}>
          <span>{i + 1}</span>{(['x', 'y'] as const).map(axis => <label key={axis}><span>{axis} (″)</span><input type="number" step="any" value={point[axis]} aria-label={t('点 {n} 的 {axis} 坐标', { n: i + 1, axis })} disabled={disabled} onFocus={() => setSelected(point.id)} onChange={event => onChange({ ...value, points: value.points.map(p => p.id === point.id ? { ...p, [axis]: event.target.value } : p) })}/></label>)}
          <button className="icon-button" type="button" aria-label={t('删除点 {n}', { n: i + 1 })} disabled={disabled} onClick={() => onChange({ ...value, points: value.points.filter(p => p.id !== point.id) })}><Trash2 size={14}/></button>
        </div>)}</div>
        <div className="position-penalty-fields"><label><span>{t('源平面容差')} (arcsec)</span><input aria-label={t('源平面容差')} type="number" step="any" min="0" value={value.threshold} disabled={disabled} onChange={event => onChange({ ...value, threshold: event.target.value })}/><small>threshold_arcsec</small></label><label><span>{t('惩罚强度')}</span><input aria-label={t('惩罚强度')} type="number" step="any" min="0" value={value.strength} disabled={disabled} onChange={event => onChange({ ...value, strength: event.target.value })}/><small>min_log_like = −{value.strength || '…'}</small></label></div>
      </div>
    </div>
    {!!value.points.length && error && <div className="position-status" role="status">{t(error)}</div>}
    <div className="position-actions"><button className="text-button" type="button" disabled={disabled || !value.points.length} onClick={() => onChange({ ...value, points: [] })}>{t('清空点')}</button><span/>{(manualPrompt || !promptPresent) && <button className="button secondary" type="button" onClick={onReplacePrompt} disabled={disabled || !!error}>{t('用当前约束更新意见')}</button>}<button className="button secondary" type="button" disabled={disabled || !!error} onClick={() => downloadJSON(positionRequest(value, context), `position-likelihood-${context.synthetic ? 'DEMO-' : ''}request.json`)}><Download size={14}/>{t('下载约束 JSON')}</button></div>
  </section></>;
}
