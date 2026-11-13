import {useEffect,useState} from 'react';
import type {LiveResult} from './live-results';
import {scaleImagePlane,hasNumericRaster,type ImageScale} from './image-scale';
import {demoModelRasters} from './demo-rasters';
export {hasNumericRaster} from './image-scale';
export function useScaledPlanes(base:LiveResult['planes'],scale:ImageScale|'original',live:boolean,names:readonly ('observation'|'model'|'source-lensed')[]=['observation','model','source-lensed']){
 const key=JSON.stringify([live,scale,names,Object.entries(base??{}).map(([name,p])=>[name,p?.values_sha256,p?.mask_base64,p?.color_lut_sha256,p?.color_stops,p?.array_y_direction,p?.shape,p?.bounds_arcsec,p?.input_fits_sha256,p?.vmin,p?.vmax,p?.stretch,p?.asinh_a])]);
 const [loaded,setLoaded]=useState<{key:string;planes:LiveResult['planes']}>();
 const available=!live||names.every(name=>hasNumericRaster(base?.[name]));
 useEffect(()=>{let current=true;void(async()=>{
  const sources=live?base:await demoModelRasters(),next:NonNullable<LiveResult['planes']>={};
  await Promise.allSettled(Object.entries(sources??{}).map(async([name,p])=>{
   const linked=names.includes(name as typeof names[number]),reference=linked?sources?.observation:p;
   if(hasNumericRaster(p)&&hasNumericRaster(reference))next[name as keyof typeof next]=await scaleImagePlane(p,linked?scale:'original',reference);
  }));
  if(current)setLoaded({key,planes:next});
 })().catch(()=>{if(current)setLoaded({key,planes:{}})});return()=>{current=false};},[key]);
 return {planes:loaded?.key===key?loaded.planes:undefined,available};
}
