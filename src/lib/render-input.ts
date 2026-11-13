import {hasNumericRaster,imageScaleOptions,imageScaleStretch,scaleImagePlane} from './image-scale';
import type {InputPlane} from './input-display';

export async function renderInputDisplay<T extends {planes:InputPlane[];log_a:number}>(display:T){
 let gradient='';
 const planes=await Promise.all(display.planes.map(async plane=>{
  const numeric=plane.numeric;if(!hasNumericRaster(numeric))throw Error('The input preview requires numerical arrays.');
  const variants=Object.fromEntries(await Promise.all(imageScaleOptions.map(async ([scale])=>{
   const definition=plane.variants[scale==='asinh'?'linear':scale];
   const {stretch,parameter}=imageScaleStretch(scale,display.log_a);
   const rendered=await scaleImagePlane({...numeric,vmin:definition.vmin,vmax:definition.vmax,stretch,asinh_a:parameter},'original');
   gradient=rendered.colormap_src;
   const constant_color=definition.vmin===definition.vmax?'#'+Array.from(atob(numeric.color_lut_base64).slice(127*4,127*4+3),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join(''):undefined;
   return [scale,{...definition,src:rendered.src,constant_color,rendered_from:'numeric-array' as const}];
  }))) as InputPlane['variants'];
  return {...plane,variants};
 }));
 return {...display,planes,colormap_src:gradient,rendered_from:'numeric-array' as const};
}
