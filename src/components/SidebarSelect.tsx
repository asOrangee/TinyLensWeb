import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import type { DesignId } from '../lib/designs';

type Option = { value:string; label:string; colors?:string[] };
type Props = { label:string; ariaLabel:string; icon:LucideIcon; value:string; options:Option[]; design:DesignId; open:boolean; onOpenChange:(open:boolean)=>void; onChange:(value:string)=>void };
export default function SidebarSelect({label,ariaLabel,icon:Icon,value,options,design,open,onOpenChange,onChange}:Props) {
  const id=useId(), trigger=useRef<HTMLButtonElement>(null), menu=useRef<HTMLDivElement>(null);
  const items=useRef<(HTMLButtonElement|null)[]>([]);
  const [anchor,setAnchor]=useState({left:72,top:20,maxHeight:500});
  const current=options.find(option=>option.value===value);
  function close(restoreFocus=false){onOpenChange(false);if(restoreFocus)trigger.current?.focus({preventScroll:true});}
  useLayoutEffect(()=>{
    if(!open)return;
    function measure(){const r=trigger.current?.getBoundingClientRect();if(!r)return;const height=menu.current?.scrollHeight??160;setAnchor({left:Math.max(12,Math.min(r.right+8,window.innerWidth-244)),top:Math.max(12,Math.min(r.top,window.innerHeight-height-12)),maxHeight:window.innerHeight-24});}
    measure();const observer=new ResizeObserver(measure);if(trigger.current)observer.observe(trigger.current);
    window.addEventListener('resize',measure);
    const dismiss=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',dismiss,true);
    items.current[Math.max(0,options.findIndex(option=>option.value===value))]?.focus({preventScroll:true});
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);document.removeEventListener('pointerdown',dismiss,true);};
  },[open]);
  function navigate(event:KeyboardEvent<HTMLDivElement>){
    const index=items.current.findIndex(item=>item===document.activeElement);
    const next=event.key==='ArrowDown'?(index+1)%options.length:event.key==='ArrowUp'?(index+options.length-1)%options.length:event.key==='Home'?0:event.key==='End'?options.length-1:null;
    if(next!==null){event.preventDefault();items.current[next]?.focus();}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
    if(event.key==='Tab')close(true);
  }
  return <><button className="sidebar-menu-trigger" type="button" ref={trigger} aria-label={ariaLabel} title={`${label} · ${current?.label??''}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>onOpenChange(!open)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();onOpenChange(true);}}}><Icon size={21}/><span className="lens-shortcut-label">{label}</span><span className="lens-setting-value">{current?.label}</span><ChevronRight className="sidebar-menu-chevron" size={12}/></button>{open&&createPortal(<div className="sidebar-select-menu" data-design={design} style={anchor} id={id} ref={menu} role="menu" aria-label={label} onKeyDown={navigate}><div className="sidebar-menu-heading">{label}</div>{options.map((option,index)=><button key={option.value} ref={element=>{items.current[index]=element;}} type="button" role="menuitemradio" aria-checked={option.value===value} tabIndex={-1} onClick={()=>{onChange(option.value);close(true);}}>{option.colors&&<span className="sidebar-option-swatches" aria-hidden="true">{option.colors.slice(0,3).map((color,i)=><i key={i} style={{background:color}}/>)}</span>}<span>{option.label}</span>{option.value===value&&<Check size={14}/>}</button>)}</div>,document.body)}</>;
}
