import {useEffect,useState} from 'react';
import type {LegacyFitDomain,LiveResult} from './live-results';
import {scaleImagePlane,hasNumericRaster,lensedSourceFitPlane,scalablePlanes,type ImageScale} from './image-scale';
import {demoModelRasters} from './demo-rasters';
export {hasNumericRaster} from './image-scale';
export function useScaledPlanes(base:LiveResult['planes'],scale:ImageScale|'original',live:boolean,linkedPlanes:readonly (typeof scalablePlanes[number])[]=scalablePlanes,
 {showFitExcluded=false,fullObservationScale=false,clipLensedSourceToFit=false,legacyDomain}:{
  showFitExcluded?:boolean;fullObservationScale?:boolean;clipLensedSourceToFit?:boolean;legacyDomain?:LegacyFitDomain;
 }={}){
 const domainKey=legacyDomain&&[legacyDomain.schema,legacyDomain.fit_support,legacyDomain.fit_mask_base64,legacyDomain.fit_mask_sha256,legacyDomain.statistics?.pixel_count];
 const key=JSON.stringify([live,scale,linkedPlanes,showFitExcluded,fullObservationScale,clipLensedSourceToFit,domainKey,Object.entries(base??{}).map(([name,p])=>[name,p?.values_sha256,p?.mask_base64,p?.mask_scope,p?.color_lut_sha256,p?.color_stops,p?.array_y_direction,p?.shape,p?.bounds_arcsec,p?.input_fits_sha256,p?.vmin,p?.vmax,p?.stretch,p?.asinh_a,p?.unit])]);
 const [loaded,setLoaded]=useState<{key:string;planes:LiveResult['planes']}>();
 const available=!live||linkedPlanes.every(name=>name==='lens-light'||hasNumericRaster(base?.[name]));
 useEffect(()=>{let current=true;void(async()=>{
  const sources=live?base:await demoModelRasters(),next:NonNullable<LiveResult['planes']>={};
  await Promise.allSettled(Object.entries(sources??{}).map(async([name,p])=>{
   const usesSelectedScale = linkedPlanes.some(role=>role===name);
   if (!hasNumericRaster(p)) return;
   const fittedSource = name === 'source-lensed' && clipLensedSourceToFit;
   const plane = fittedSource ? await lensedSourceFitPlane(p, legacyDomain) : p;
   const reference = usesSelectedScale ? sources?.observation : plane;
   if (!hasNumericRaster(reference)) return;
   next[name as keyof typeof next] = await scaleImagePlane(plane, usesSelectedScale ? scale : 'original', reference, {
    showFitExcluded:showFitExcluded && name !== 'source' && !fittedSource,
    fullReference:usesSelectedScale && fullObservationScale,
   });
  }));
  if(current)setLoaded({key,planes:next});
 })().catch(()=>{if(current)setLoaded({key,planes:{}})});return()=>{current=false};},[key]);
 return {planes:loaded?.key===key?loaded.planes:undefined,available};
}
