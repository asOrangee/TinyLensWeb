import {fittedImageBox,imageLabelContrast} from './image-label-contrast.ts';

export const imageLabelRasterEvent='tinylens-image-label-raster';
const areas='.science-image-area,.mask-image-area,.position-image';
const labels='.science-ticks>span,.science-scale>span,.mask-scalebar,.mask-image-label,.position-marker b';
const fixedLabels='.science-coordinate-readout>span:not(.science-coordinate-cell),.science-coordinate-cell>b,.science-coordinate-value,.science-mapped-marker small';
const stylesWritten=new WeakMap<HTMLElement,string>();
type Glyph={text:string;rect:DOMRect;font:string;ascent:number;descent:number};

function glyphsFor(label:HTMLElement,ctx:CanvasRenderingContext2D){
 const glyphs:Glyph[]=[],walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT),range=document.createRange();
 for(let node=walker.nextNode();node;node=walker.nextNode()){
  const style=getComputedStyle(node.parentElement!),font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.font=font;const metrics=ctx.measureText('Mg'),ascent=metrics.fontBoundingBoxAscent??metrics.actualBoundingBoxAscent,descent=metrics.fontBoundingBoxDescent??metrics.actualBoundingBoxDescent;
  let offset=0;for(const text of node.textContent??''){
   const start=offset;offset+=text.length;if(!text.trim())continue;
   range.setStart(node,start);range.setEnd(node,offset);const rect=range.getBoundingClientRect();
   if(rect.width&&rect.height)glyphs.push({text,rect,font,ascent,descent});
  }
 }
 return glyphs;
}

function updateArea(area:HTMLElement){
 const targets=Array.from(area.querySelectorAll<HTMLElement>(labels));if(!targets.length||!area.clientWidth||!area.clientHeight)return;
 const images=Array.from(area.querySelectorAll<HTMLImageElement|HTMLCanvasElement>(':scope>img,:scope>canvas'));
 if(images.some(image=>image instanceof HTMLImageElement&&!image.complete))return;
 const rect=area.getBoundingClientRect(),originX=rect.left+area.clientLeft,originY=rect.top+area.clientTop;
 const background=document.createElement('canvas');background.width=Math.ceil(area.clientWidth);background.height=Math.ceil(area.clientHeight);
 const ctx=background.getContext('2d',{willReadFrequently:true})!;ctx.fillStyle='#fff';ctx.fillRect(0,0,background.width,background.height);
 ctx.fillStyle=getComputedStyle(area).backgroundColor;ctx.fillRect(0,0,background.width,background.height);
 for(const image of images){
  const style=getComputedStyle(image);if(style.visibility==='hidden'||style.display==='none')continue;
  if(image instanceof HTMLImageElement&&(!image.naturalWidth||!image.naturalHeight))continue;
  const r=image.getBoundingClientRect(),box={x:r.left-originX,y:r.top-originY,width:r.width,height:r.height};
  const fitted=image instanceof HTMLImageElement?fittedImageBox(image.naturalWidth,image.naturalHeight,box,style.objectFit,style.objectPosition):box;
  ctx.imageSmoothingEnabled=style.imageRendering!=='pixelated';ctx.globalAlpha=Number(style.opacity);
  ctx.drawImage(image,fitted.x,fitted.y,fitted.width,fitted.height);
 }
 ctx.globalAlpha=1;
 const glyphCanvas=document.createElement('canvas'),sampleCanvas=document.createElement('canvas');
 for(const target of targets){
  const glyphs=glyphsFor(target,ctx);if(!glyphs.length)continue;
  const x=Math.max(0,Math.floor(Math.min(...glyphs.map(g=>g.rect.left))-originX)-1),y=Math.max(0,Math.floor(Math.min(...glyphs.map(g=>g.rect.top))-originY)-1);
  const right=Math.min(background.width,Math.ceil(Math.max(...glyphs.map(g=>g.rect.right))-originX)+1),bottom=Math.min(background.height,Math.ceil(Math.max(...glyphs.map(g=>g.rect.bottom))-originY)+1);
  if(right<=x||bottom<=y)continue;
  glyphCanvas.width=sampleCanvas.width=right-x;glyphCanvas.height=sampleCanvas.height=bottom-y;
  const ink=glyphCanvas.getContext('2d',{willReadFrequently:true})!,sample=sampleCanvas.getContext('2d',{willReadFrequently:true})!;
  ink.fillStyle='#000';ink.textBaseline='alphabetic';
  for(const glyph of glyphs){
   ink.font=glyph.font;
   const baseline=glyph.rect.top+(glyph.rect.height-glyph.ascent-glyph.descent)/2+glyph.ascent;
   ink.fillText(glyph.text,glyph.rect.left-originX-x,baseline-originY-y);
  }
  sample.drawImage(background,x,y,right-x,bottom-y,0,0,right-x,bottom-y);
  // Include existing label/readout backplates, excluding the annotation ink itself.
  const backplates:HTMLElement[]=[];for(let el:HTMLElement|null=target;el&&el!==area;el=el.parentElement)backplates.unshift(el);
  for(const element of backplates){const color=getComputedStyle(element).backgroundColor;if(color==='rgba(0, 0, 0, 0)'||color==='transparent')continue;const r=element.getBoundingClientRect();sample.fillStyle=color;sample.fillRect(r.left-originX-x,r.top-originY-y,r.width,r.height);}
  const choice=imageLabelContrast(sample.getImageData(0,0,right-x,bottom-y).data,ink.getImageData(0,0,right-x,bottom-y).data);if(!choice)continue;
  const expected=choice.color==='#000000'?'rgb(0, 0, 0)':'rgb(255, 255, 255)';
  if(target.style.color!==expected)target.style.color=choice.color;
  if(target.style.textShadow!=='none')target.style.textShadow='none';
  target.dataset.imageLabelColor=choice.color;target.dataset.imageLabelWeight=choice.weight.toFixed(2);
  const ruler=target.matches('.mask-scalebar')?target:target.parentElement?.matches('.science-scale')?target.parentElement:null;
  if(ruler&&ruler.dataset.imageRulerColor!==choice.color){ruler.style.borderColor=choice.color;ruler.dataset.imageRulerColor=choice.color;}
  stylesWritten.set(target,target.getAttribute('style')??'');
  if(ruler&&ruler!==target){delete ruler.dataset.imageLabelColor;stylesWritten.set(ruler,ruler.getAttribute('style')??'');}
 }
}

/** A read-only raster sampler; it never writes to images, masks or scientific arrays. */
export function observeImageLabelContrast(scope:HTMLElement){
 let frame=0,stopped=false;const observed=new Set<HTMLElement>();
 const update=()=>{frame=0;if(stopped)return;
  for(const label of scope.querySelectorAll<HTMLElement>(fixedLabels)){if(label.dataset.imageLabelColor){label.style.removeProperty('color');label.style.removeProperty('text-shadow');delete label.dataset.imageLabelColor;delete label.dataset.imageLabelWeight;stylesWritten.set(label,label.getAttribute('style')??'');}}
  const current=new Set(scope.querySelectorAll<HTMLElement>(areas));for(const area of observed)if(!current.has(area)){resize.unobserve(area);observed.delete(area);}for(const area of current){if(!observed.has(area)){observed.add(area);resize.observe(area);}try{updateArea(area);}catch{/* Retain the current label if an image is not readable yet. */}}};
 const schedule=()=>{if(!stopped&&!frame)frame=requestAnimationFrame(update);};
 const resize=new ResizeObserver(schedule);resize.observe(scope);
 const mutations=new MutationObserver(records=>{if(records.some(record=>{
  if(record.type!=='attributes'||!(record.target instanceof HTMLElement))return true;
  if(record.target.matches('.mask-brush-cursor'))return false;
  return record.attributeName!=='style'||stylesWritten.get(record.target)!==(record.target.getAttribute('style')??'');
 }))schedule();});
 mutations.observe(scope,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['src','style','class','hidden','width','height']});
 const shell=scope.closest('.app-shell');if(shell)mutations.observe(shell,{attributes:true,attributeFilter:['data-design','data-demo-language','class']});
 scope.addEventListener('load',schedule,true);scope.addEventListener(imageLabelRasterEvent,schedule);window.addEventListener('resize',schedule);
 document.fonts.ready.then(schedule);document.fonts.addEventListener('loadingdone',schedule);schedule();
 return()=>{stopped=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();scope.removeEventListener('load',schedule,true);scope.removeEventListener(imageLabelRasterEvent,schedule);window.removeEventListener('resize',schedule);document.fonts.removeEventListener('loadingdone',schedule);};
}
