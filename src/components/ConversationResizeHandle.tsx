import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { useDemoI18n } from '../lib/demo-i18n';

const preferenceKey = 'tinylens-conversation-width-v1';
const minimum = 280;
const clamp = (value: number, maximum: number) => Math.round(Math.max(minimum, Math.min(maximum, value)));
function readWidth(): number | null {
  try { const raw=localStorage.getItem(preferenceKey); const value=Number(raw); return raw && Number.isFinite(value) && value>=minimum && value<=640 ? value : null; }
  catch { return null; }
}
export default function ConversationResizeHandle() {
  const { t } = useDemoI18n();
  const handle = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number | null>(readWidth);
  const [limits, setLimits] = useState({ maximum:640, defaultWidth:window.innerWidth>1350?352:320 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId:number; x:number; width:number; preferred:number|null } | null>(null);
  const width = clamp(preferred ?? limits.defaultWidth, limits.maximum);

  useLayoutEffect(()=>{
    const root=handle.current?.closest<HTMLElement>('.app-shell');
    const workspace=root?.querySelector<HTMLElement>('.workspace');
    function measure(){
      const viewport=document.documentElement.clientWidth;
      const left=workspace?.getBoundingClientRect().left ?? 64;
      const maximum=Math.min(640,Math.max(minimum,viewport-left-480));
      const defaultWidth=window.innerWidth>1350?352:320;
      setLimits(previous=>previous.maximum===maximum && previous.defaultWidth===defaultWidth ? previous : {maximum,defaultWidth});
    }
    measure();window.addEventListener('resize',measure);
    const observer=new ResizeObserver(measure);if(workspace)observer.observe(workspace);
    return()=>{window.removeEventListener('resize',measure);observer.disconnect();};
  },[]);
  useLayoutEffect(()=>{
    const root=handle.current?.closest<HTMLElement>('.app-shell');if(!root)return;
    const previous=root.style.getPropertyValue('--conversation-width');
    root.style.setProperty('--conversation-width',`${width}px`);
    return()=>{if(previous)root.style.setProperty('--conversation-width',previous);else root.style.removeProperty('--conversation-width');};
  },[width]);
  useEffect(()=>{try{if(preferred===null)localStorage.removeItem(preferenceKey);else localStorage.setItem(preferenceKey,String(preferred));}catch{/* The divider remains usable without persistence. */}},[preferred]);
  useEffect(()=>{
    if(!dragging)return;
    const cursor=document.body.style.cursor, selection=document.body.style.userSelect;
    document.body.style.cursor='col-resize';document.body.style.userSelect='none';
    const stop=()=>{drag.current=null;setDragging(false);};window.addEventListener('blur',stop);
    return()=>{document.body.style.cursor=cursor;document.body.style.userSelect=selection;window.removeEventListener('blur',stop);};
  },[dragging]);
  function end(event: PointerEvent<HTMLDivElement>){
    drag.current=null;setDragging(false);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'&&drag.current){setPreferred(drag.current.preferred);drag.current=null;setDragging(false);return;}
    const step=event.shiftKey?40:16;
    const next=event.key==='ArrowLeft'?width+step:event.key==='ArrowRight'?width-step:event.key==='Home'?minimum:event.key==='End'?limits.maximum:null;
    if(next!==null){event.preventDefault();setPreferred(clamp(next,limits.maximum));}
    if(event.key==='Enter'){event.preventDefault();setPreferred(null);}
  }
  return <div ref={handle} className="conversation-resize-handle" role="separator" tabIndex={0} aria-label={t('调整对话栏宽度')} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={limits.maximum} aria-valuenow={width} aria-valuetext={`${width} px`} title={t('拖动调整宽度，双击恢复默认')} data-resizing={dragging||undefined}
    onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});drag.current={pointerId:event.pointerId,x:event.clientX,width,preferred};setDragging(true);event.currentTarget.setPointerCapture(event.pointerId);}}
    onPointerMove={event=>{const current=drag.current;if(current&&event.pointerId===current.pointerId)setPreferred(clamp(current.width+current.x-event.clientX,limits.maximum));}}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={()=>{drag.current=null;setDragging(false);}} onDoubleClick={()=>setPreferred(null)} onKeyDown={keyboard}/>;
}
