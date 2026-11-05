import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';

/** Fit the two input rows to the viewport while keeping each image square. */
export default function PreflightFrame({children,source,label}:{children:ReactNode;source:string;label:string}){
 const root=useRef<HTMLElement>(null),[width,setWidth]=useState<number>();
 useLayoutEffect(()=>{
  const viewer=root.current,pane=viewer?.parentElement;
  if(!viewer||!pane)return;
  let frame=0;
  const number=(value:string)=>Number.parseFloat(value)||0;
  function measure(){
   const grid=viewer!.querySelector<HTMLElement>('.preflight-panels');
   if(!grid||!grid.offsetWidth)return;
   const figures=Array.from(grid.querySelectorAll<HTMLElement>('.science-plane'));
   if(figures.length!==4)return;
   let extraWidth=0,extraHeight=0;
   for(const figure of figures){
    const image=figure.querySelector<HTMLElement>('.science-image-area');
    if(!image)return;
    extraWidth=Math.max(extraWidth,figure.getBoundingClientRect().width-image.getBoundingClientRect().width);
    extraHeight=Math.max(extraHeight,figure.getBoundingClientRect().height-image.getBoundingClientRect().height);
   }
   let below=0;
   for(let element:HTMLElement|null=viewer;element;element=element.parentElement){
    const style=getComputedStyle(element);
    below+=number(style.paddingBottom)+number(style.borderBottomWidth)+number(style.marginBottom);
    if(element===document.body)break;
   }
   const style=getComputedStyle(viewer!),gridStyle=getComputedStyle(grid),paneStyle=getComputedStyle(pane!);
   const horizontal=number(style.paddingLeft)+number(style.paddingRight)+number(style.borderLeftWidth)+number(style.borderRightWidth);
   const availableWidth=pane!.clientWidth-number(paneStyle.paddingLeft)-number(paneStyle.paddingRight)-horizontal;
   const availableHeight=window.innerHeight-grid.getBoundingClientRect().top-window.scrollY-below-2;
   const columnGap=number(gridStyle.columnGap),rowGap=number(gridStyle.rowGap);
   const side=Math.max(1,Math.floor(Math.min((availableWidth-columnGap)/2-extraWidth,(availableHeight-rowGap)/2-extraHeight)));
   const next=Math.min(pane!.clientWidth,Math.floor(2*(side+extraWidth)+columnGap+horizontal));
   setWidth(previous=>previous!==undefined&&Math.abs(previous-next)<.5?previous:next);
  }
  function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);}
  const observer=new ResizeObserver(schedule);
  observer.observe(viewer);observer.observe(pane);
  const workspace=viewer.closest('.stage-workspace'),heading=viewer.closest('.main-content')?.querySelector('.workbench-heading');
  const toolbar=workspace?.querySelector('.stage-content-header');
  if(toolbar)observer.observe(toolbar);
  if(heading)observer.observe(heading);
  window.addEventListener('resize',schedule);
  measure();
  return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);};
 },[]);
 return <section ref={root} className="science-viewer preflight-viewer" aria-label={label} data-viewer="preflight" data-source={source} style={{width}}>{children}</section>;
}
