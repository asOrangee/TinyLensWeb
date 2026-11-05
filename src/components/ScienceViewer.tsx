import { useDemoI18n } from '../lib/demo-i18n';
import { useEffect,useMemo, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, RotateCcw, ZoomIn } from 'lucide-react';
import displayManifest from '../data/science-demo.json';
import mappingData from '../data/lens-mapping-demo.json';
import { displayImageFamily, isInPlaneView, isInside, planeToScreen, screenToPlane, verifiedDemoMapping, type Point, type PlaneFrame, type PlaneView } from '../lib/lens-mapping';
import {verifiedLiveMapping} from '../lib/live-mapping';
import {useScaledPlanes} from '../lib/use-scaled-planes';
import type {ImageScale} from '../lib/image-scale';
import ImageScaleControls from './ImageScaleControls';
import ScienceColorbar from './ScienceColorbar';
import type { LiveResult } from '../lib/live-results';
import './science-viewer.css';

type CoordinateSpace = 'image' | 'source';
type Hover = {from:CoordinateSpace;source:Point;images:Point[]};
const files = ['observation', 'model', 'source-lensed', 'source', 'residual', 'chi-square'] as const;
const planeTitles = {observation:'Data image',model:'Model image',residual:'Normalized residual','source-lensed':'Lensed source',source:'Unlensed source','chi-square':'Chi-square'};
const displayNumber=(value:number)=>value===0?'0':Math.abs(value)<.001?value.toExponential(2):Number(value.toPrecision(3)).toString();
const fixedSource:PlaneView={zoom:1,pan:{x:0,y:0}};
const mapping=verifiedDemoMapping(mappingData,displayManifest);
function curvePath(points:Point[],closed:boolean,frame:PlaneFrame,view:PlaneView){
  return points.map((point,index)=>{const p=planeToScreen(point,frame,view);return `${index?'L':'M'}${(p.x*1000).toFixed(3)},${(p.y*1000).toFixed(3)}`;}).join(' ')+(closed?' Z':'');
}
const coordinateNumber=(value:number)=>value!==0&&Math.abs(value)<.001?value.toExponential(2):value.toFixed(3);

export default function ScienceViewer({stageId,toolbarTarget,missingLayers,displayPlanes,modelResult,imageScale='original',onScaleChange=()=>{}}:{stageId:string;toolbarTarget:HTMLDivElement|null;missingLayers?:string;displayPlanes?:LiveResult['planes'];modelResult?:LiveResult;imageScale?:ImageScale;onScaleChange?:(scale:ImageScale)=>void}){
  const {t}=useDemoI18n();
  const live=missingLayers!==undefined;
  const activeMapping=useMemo(()=>live?verifiedLiveMapping(modelResult?.display_mapping,{stage:stageId,attempt:modelResult?.attempt??-1,path:modelResult?.path??'',sha256:modelResult?.sha256??'',fitsSha256:displayPlanes?.observation?.input_fits_sha256}):mapping,[live,modelResult,stageId,displayPlanes?.observation?.input_fits_sha256]);
  const basePlanes=live?displayPlanes:Object.fromEntries(Object.entries(displayManifest.planes).map(([name,plane])=>[name,{...plane,bounds_arcsec:[-plane.half_extent_arcsec,plane.half_extent_arcsec,-plane.half_extent_arcsec,plane.half_extent_arcsec],colormap_src:''}])) as LiveResult['planes'];
  const scaled=useScaledPlanes(basePlanes,imageScale,live);
  const [zoom,setZoom]=useState(1),[pan,setPan]=useState<Point>({x:0,y:0});
  const [showMapping,setShowMapping]=useState(true),[hover,setHover]=useState<Hover|null>(null);
  const [showCurves,setShowCurves]=useState(true);
  const [showCrosshair,setShowCrosshair]=useState(false),[cursor,setCursor]=useState<{space:CoordinateSpace;point:Point}|null>(null);
  const curves=useMemo(()=>activeMapping?.criticalCurves()??[],[activeMapping]);
  const criticalPaths=useMemo(()=>activeMapping?curves.map(curve=>curvePath(curve.critical,curve.closed,activeMapping.frames.image,{zoom,pan})):[],[activeMapping,curves,zoom,pan]);
  const causticPaths=useMemo(()=>activeMapping?curves.map(curve=>curvePath(curve.caustic,curve.closed,activeMapping.frames.source,fixedSource)):[],[activeMapping,curves]);
  const dragging=useRef<{x:number;y:number;pan:Point}|null>(null);
  useEffect(()=>{setHover(null);setCursor(null);dragging.current=null;},[stageId,activeMapping]);
  const planes=files.map(file=>({file,title:planeTitles[file],bounds_arcsec:undefined as number[]|undefined,colormap_src:undefined as string|undefined,...{src:'',half_extent_arcsec:0,shape:[0,0],vmin:0,vmax:0,stretch:'linear',asinh_a:1,colormap:'magma',data_min:0,data_max:0,...scaled.planes?.[file]}}));
  const hasPlanes=planes.some(plane=>!!plane.src),hasImagePlanes=planes.some(plane=>plane.file!=='source'&&!!plane.src);
  function reset(){setZoom(1);setPan({x:0,y:0});setHover(null);setCursor(null);dragging.current=null;}
  function down(event:PointerEvent<HTMLDivElement>,space:CoordinateSpace){
    if(!hasImagePlanes||space==='source'||zoom<=1||event.button!==0)return;
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current={x:event.clientX,y:event.clientY,pan};setHover(null);setCursor(null);
  }
  function move(event:PointerEvent<HTMLDivElement>,space:CoordinateSpace,frame:PlaneFrame){
    if(frame.half_extent_arcsec<=0)return;
    const rect=event.currentTarget.getBoundingClientRect(),drag=dragging.current;
    const width=rect.width-2*event.currentTarget.clientLeft,height=rect.height-2*event.currentTarget.clientTop;
    if(drag&&space==='image'){
      const limit=(zoom-1)*50;
      setPan({x:Math.max(-limit,Math.min(limit,drag.pan.x+(event.clientX-drag.x)/width*100)),y:Math.max(-limit,Math.min(limit,drag.pan.y+(event.clientY-drag.y)/height*100))});
      return;
    }
    const point=screenToPlane({x:(event.clientX-rect.left-event.currentTarget.clientLeft)/width,y:(event.clientY-rect.top-event.currentTarget.clientTop)/height},frame,space==='source'?fixedSource:{zoom,pan});
    if(showCrosshair)setCursor({space,point});
    if(!showMapping||!activeMapping)return;
    if(space==='image')setHover({from:space,images:[point],source:activeMapping.sourceFor(point)});
    else setHover({from:space,source:point,images:activeMapping.imagesFor(point)});
  }
  function stop(){dragging.current=null;}
  function changeZoom(next:number){const limit=(next-1)*50;setZoom(next);setPan(p=>({x:Math.max(-limit,Math.min(limit,p.x)),y:Math.max(-limit,Math.min(limit,p.y))}));setHover(null);setCursor(null);}
  function coordinate(value:number){return `${value>=0?'+':'−'}${displayNumber(Math.abs(value))}″`;}
  const family=hover&&activeMapping?displayImageFamily(hover.images,activeMapping.magnificationFor,hover.from==='image'):{points:[],hiddenWeakCount:0};
  const visibleImageCount=activeMapping?family.points.filter(point=>isInPlaneView(point,activeMapping.frames.image,{zoom,pan})).length:0;
  const boundaryText=!hover||!showMapping||!activeMapping?'':hover.from==='image'&&!isInside(hover.source,activeMapping.frames.source)?t('对应源位置超出当前源平面视野。'):hover.from==='source'&&!hover.images.length?t('当前图像视野内没有找到对应像点。'):hover.from==='source'&&family.points.length===0&&family.hiddenWeakCount?t('对应解均为极弱像，当前未显示。'):hover.from==='source'&&visibleImageCount<family.points.length?t('{count} 个对应像点在当前图像视野外，可缩小或重置视图。',{count:family.points.length-visibleImageCount}):'';
  const imagePositions=hover?.from==='image'?hover.images:family.points;
  const imageCoordinateSlots=Array.from({length:Math.max(4,imagePositions.length)},(_,index)=>({number:index+1,point:imagePositions[index]}));
  const toolbar=<div className="science-toolbar" role="toolbar" aria-label={t('图像显示工具')}>
    <button className="plane-link-toggle science-icon-button" type="button" aria-label={t('十字标线')} aria-pressed={showCrosshair} disabled={!hasPlanes} title={t('显示同一平面内联动的十字标线')} onClick={()=>{setShowCrosshair(value=>!value);setCursor(null);}}><Crosshair size={17}/></button>
    <button className="plane-link-toggle science-icon-button" type="button" aria-label={t('平面位置联动')} aria-pressed={showMapping&&!!activeMapping} disabled={!activeMapping} title={activeMapping?t('悬停查看 image/source plane 的对应位置'):t('当前结果缺少匹配的透镜映射')} onClick={()=>{setShowMapping(value=>!value);setHover(null);}}><svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2 5L9 2V15L2 18ZM15 9L22 6V19L15 22Z"/><path d="M5.5 10L18.5 14" strokeDasharray="2 2"/><circle cx="5.5" cy="10" r="1.2" fill="currentColor"/><circle cx="18.5" cy="14" r="1.2" fill="currentColor"/></svg></button>
    <button className="plane-link-toggle science-icon-button" type="button" aria-label={t('显示临界曲线与焦散线')} aria-pressed={showCurves&&!!activeMapping} disabled={!activeMapping} title={t('同时显示或隐藏图像平面的临界曲线与源平面的焦散线')} onClick={()=>setShowCurves(value=>!value)}><svg width="18" height="18" viewBox="0 0 15 12" aria-hidden="true"><path d="M1 6Q7.5 6 7.5 1Q7.5 6 14 6Q7.5 6 7.5 11Q7.5 6 1 6Z" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg></button>
    <ImageScaleControls value={imageScale} onChange={onScaleChange} disabled={!scaled.available||!hasImagePlanes}/>
    <div className="science-tools"><ZoomIn size={14} aria-hidden="true"/><input type="range" disabled={!hasImagePlanes} aria-label={t('图像缩放')} min="1" max="3" step=".25" value={zoom} onChange={event=>changeZoom(Number(event.target.value))}/><span className="science-zoom-label">{zoom.toFixed(2)}×</span><button type="button" onClick={reset} disabled={!hasPlanes} title={t('重置视图')} aria-label={t('重置视图')}><RotateCcw size={14}/></button></div>
  </div>;
  return <section className="science-viewer model-viewer" aria-label={t('科学图像查看器')} data-viewer="model" data-stage={stageId}>
    {toolbarTarget&&createPortal(toolbar,toolbarTarget)}
    <div className="science-panels">{planes.map(plane=>{
      const space:CoordinateSpace=plane.file==='source'?'source':'image',view=space==='source'?fixedSource:{zoom,pan};
      const unavailable=!plane.src,bounds=plane.bounds_arcsec,centerY=bounds?(bounds[2]+bounds[3])/2:0;
      const frame:PlaneFrame={half_extent_arcsec:plane.half_extent_arcsec,shape:plane.shape,bounds_arcsec:bounds};
      const points=!unavailable&&hover&&showMapping?(space==='source'?[hover.source]:family.points):[];
      const crosshair=showCrosshair&&cursor?.space===space&&!unavailable?planeToScreen(cursor.point,frame,view):null;
      return <figure className="science-plane" key={plane.file} data-plane={plane.file} data-coordinate-space={space} data-source-format={plane.src?'numeric':undefined} data-render-origin={plane.src?'browser-array':undefined} data-numeric-sha256={plane.values_sha256}>
        <figcaption className="science-plane-heading"><strong>{plane.title}</strong></figcaption>
        <div className="science-plane-body">
          <div className={'science-image-area'+(unavailable?' is-unavailable':'')+(view.zoom>1?' is-zoomed':'')} onPointerDown={event=>down(event,space)} onPointerMove={event=>move(event,space,frame)} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onPointerLeave={()=>{setHover(null);setCursor(null);}}>
            {!unavailable&&<img src={plane.src} alt={live?`${plane.title}，来自本次已保存结果`:`${plane.title}, synthetic demonstration image`} draggable={false} style={{transform:`translate(${view.pan.x}%, ${view.pan.y}%) scale(${view.zoom})`}}/>}
            {!unavailable&&activeMapping&&showCurves&&<svg className={`science-lens-curves ${space==='source'?'caustics':'critical-curves'}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={t(space==='source'?'焦散线':'临界曲线')}>
              {(space==='source'?causticPaths:criticalPaths).map((path,index)=><g key={index} data-curve={index}><path d={path} className="curve-halo" vectorEffect="non-scaling-stroke"/><path d={path} className="curve-line" vectorEffect="non-scaling-stroke"/></g>)}
            </svg>}
            {unavailable?<div className="science-plane-unavailable">—</div>:<><div className="science-ticks"><span>{coordinate(centerY+plane.half_extent_arcsec*(1+view.pan.y/50)/view.zoom)}</span><span>{coordinate(centerY+plane.half_extent_arcsec*(-1+view.pan.y/50)/view.zoom)}</span></div>
            <span className="science-scale" style={{width:`${(space==='source' ? .2 : 1)/(bounds?bounds[1]-bounds[0]:2*plane.half_extent_arcsec)*100*view.zoom}%`}}><span>{space==='source'?'0.2':'1'}″</span></span></>}
            {crosshair&&crosshair.x>=0&&crosshair.x<=1&&crosshair.y>=0&&crosshair.y<=1&&<div className="science-crosshair" data-crosshair-space={space} aria-hidden="true"><i style={{left:`${crosshair.x*100}%`}}/><b style={{top:`${crosshair.y*100}%`}}/></div>}
            {!unavailable&&hover&&showMapping&&(plane.file==='observation'||plane.file==='source')&&<div className={`science-coordinate-readout${space==='image'?' is-image-grid':''}`} data-coordinate-readout={space} aria-label={t(space==='image'?'图像平面坐标':'源平面坐标')}>
              {space==='source'?<span data-coordinate-x={hover.source.x} data-coordinate-y={hover.source.y}>({coordinateNumber(hover.source.x)}, {coordinateNumber(hover.source.y)})″</span>:imageCoordinateSlots.map(({number,point})=><span key={number} className="science-coordinate-cell" data-coordinate-slot={number} data-coordinate-x={point?.x} data-coordinate-y={point?.y}><b>{number}</b><span className="science-coordinate-value">{point?<>({coordinateNumber(point.x)},<wbr/>{coordinateNumber(point.y)})″</>:'—'}</span></span>)}
            </div>}
            {points.map((point,index)=>{const screen=planeToScreen(point,frame,view),weak='weak' in point&&!!point.weak;return screen.x>=0&&screen.x<=1&&screen.y>=0&&screen.y<=1?<span key={index} className={`science-mapped-marker${weak?' is-weak':''}`} data-map-x={point.x} data-map-y={point.y} data-magnification={'magnification' in point?point.magnification:undefined} style={{left:`${screen.x*100}%`,top:`${screen.y*100}%`}} aria-label={t('对应位置 ({x}, {y}) arcsec',{x:coordinateNumber(point.x),y:coordinateNumber(point.y)})}>{space==='image'&&points.length>1&&<small>{index+1}{weak?` · ${t('弱')}`:''}</small>}</span>:null;})}
          </div>
          {unavailable?<div className="science-colorbar-unavailable" aria-label="暂无数值色阶">—</div>:<ScienceColorbar min={plane.vmin} max={plane.vmax} stretch={plane.stretch==='asinh'?'asinh':plane.stretch==='log'?'log':'linear'} parameter={plane.asinh_a??1} redBlue={plane.colormap==='blue-white-red'} gradient={plane.colormap_src} title={t('数组极值：{min} 至 {max}',{min:displayNumber(plane.data_min),max:displayNumber(plane.data_max)})}/>}
        </div>
      </figure>;
    })}</div>
    {boundaryText&&<p className="plane-link-boundary">{boundaryText}</p>}
  </section>;
}
