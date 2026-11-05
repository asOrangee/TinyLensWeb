import type {LivePlane} from './live-results';
export type ImageScale='original'|'linear'|'log'|'zscale';
export type NumericRaster={values_base64:string;values_sha256:string;mask_base64:string;array_y_direction:'increasing'|'decreasing';color_lut_base64:string;color_lut_sha256:string};
export const hasNumericRaster=(plane:LivePlane|undefined):plane is LivePlane&NumericRaster=>!!plane?.values_base64&&/^[a-f0-9]{64}$/.test(plane.values_sha256??'')&&!!plane.mask_base64&&['increasing','decreasing'].includes(plane.array_y_direction??'')&&!!plane.color_lut_base64&&/^[a-f0-9]{64}$/.test(plane.color_lut_sha256??'');
export const scalablePlanes=new Set(['observation','model','source-lensed']);
/** Sample in display order, matching the existing preflight ZScale reader. */
export function displayScalePixels(values:readonly number[],mask:ArrayLike<number>,shape:readonly number[],direction:NumericRaster['array_y_direction']){
 if(shape.length!==2||values.length!==shape[0]*shape[1]||mask.length!==values.length)throw Error('Display raster shape mismatch');
 const result:number[]=[];for(let row=0;row<shape[0];row++)for(let col=0;col<shape[1];col++){const i=(direction==='increasing'?shape[0]-1-row:row)*shape[1]+col;if(mask[i]===1)result.push(values[i]);}return result;
}

/** Astropy ZScaleInterval defaults: 1000 samples, contrast=.25, five rejections. */
export function zscaleLimits(values:readonly number[]):[number,number]{
 const finite=values.filter(Number.isFinite);if(!finite.length)throw Error('No finite display pixels');
 const stride=Math.max(1,Math.floor(finite.length/1000)),samples=finite.filter((_,i)=>i%stride===0).slice(0,1000).sort((a,b)=>a-b),n=samples.length;
 let low=samples[0],high=samples[n-1],good=n,last=n+1,slope=0;const min=Math.max(5,Math.floor(n*.5)),grow=Math.max(1,Math.floor(n*.01));let bad=Array<boolean>(n).fill(false);
 for(let iteration=0;iteration<5;iteration++){
  if(good>=last||good<min)break;
  let sx=0,sy=0,sxx=0,sxy=0,count=0;
  for(let i=0;i<n;i++)if(!bad[i]){sx+=i;sy+=samples[i];sxx+=i*i;sxy+=i*samples[i];count++;}
  const denominator=count*sxx-sx*sx;if(!denominator)break;
  slope=(count*sxy-sx*sy)/denominator;const offset=(sy-slope*sx)/count,flat=samples.map((v,i)=>v-slope*i-offset),clean=flat.filter((_,i)=>!bad[i]),mean=clean.reduce((a,b)=>a+b,0)/clean.length;
  const threshold=2.5*Math.sqrt(clean.reduce((sum,v)=>sum+(v-mean)**2,0)/clean.length);
  bad=bad.map((v,i)=>v||Math.abs(flat[i])>threshold);const rejected=[...bad];
  bad=bad.map((_,i)=>{for(let j=-Math.floor(grow/2);j<Math.ceil(grow/2);j++)if(rejected[i+j])return true;return false;});
  last=good;good=bad.filter(v=>!v).length;
 }
 if(good>=min){const center=Math.floor((n-1)/2),median=(samples[Math.floor(n/2)]+samples[Math.floor((n-1)/2)])/2;slope/=.25;low=Math.max(low,median-(center-1)*slope);high=Math.min(high,median+(n-center)*slope);}
 return low<=high?[low,high]:[samples[0],samples[n-1]];
}
export function imageScaleValues(values:readonly number[],scale:Exclude<ImageScale,'original'>){
 let min=Infinity,max=-Infinity;for(const value of values){if(!Number.isFinite(value))throw Error('Invalid display pixel');min=Math.min(min,value);max=Math.max(max,value);}if(min===Infinity)throw Error('Empty display pixels');
 const [vmin,vmax]=scale==='zscale'?zscaleLimits(values):[min,max];
 return {vmin,vmax,stretch:scale==='log'?'log' as const:'linear' as const,parameter:scale==='log'?1000:1};
}

export type RasterLimits={vmin:number;vmax:number;stretch:string;parameter:number};
/** Numeric pixels only. No decoded observation/diagnostic image enters this renderer. */
export function numericPixels(values:ArrayLike<number>,mask:ArrayLike<number>,shape:readonly number[],direction:NumericRaster['array_y_direction'],limits:RasterLimits,colors:ArrayLike<number>,stops?:number[][]){
 const [height,width]=shape,count=height*width;
 if(shape.length!==2||!shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||values.length!==count||mask.length!==count||colors.length!==1024||!['increasing','decreasing'].includes(direction)||![limits.vmin,limits.vmax,limits.parameter].every(Number.isFinite)||limits.vmax<limits.vmin||!['linear','log','asinh'].includes(limits.stretch)||limits.parameter<=0)throw Error('Invalid numerical display geometry or limits.');
 if(stops&&(stops.length<2||stops.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v)||v<0||v>255))))throw Error('Invalid numerical color stops.');
 const pixels=new Uint8ClampedArray(count*4),range=limits.vmax-limits.vmin;
 for(let row=0;row<height;row++)for(let col=0;col<width;col++){
  const source=(direction==='increasing'?height-row-1:row)*width+col,target=(row*width+col)*4,value=values[source];
  if(!Number.isFinite(value)||(mask[source]!==0&&mask[source]!==1))throw Error('Invalid numerical display pixels.');
  if(!mask[source])continue;
  let normal=range===0?.5:Math.max(0,Math.min(1,(value-limits.vmin)/range));
  if(range!==0&&limits.stretch==='log')normal=Math.log1p(limits.parameter*normal)/Math.log1p(limits.parameter);
  if(range!==0&&limits.stretch==='asinh')normal=Math.asinh(limits.parameter*Math.max(0,Math.min(range,value-limits.vmin)))/Math.asinh(limits.parameter*range);
  if(stops){const at=normal*(stops.length-1),lo=Math.min(stops.length-2,Math.floor(at)),fraction=at-lo;for(let c=0;c<3;c++)pixels[target+c]=Math.floor(stops[lo][c]+fraction*(stops[lo+1][c]-stops[lo][c]));}
  else{const at=(255-Math.min(255,Math.floor(normal*256)))*4;for(let c=0;c<3;c++)pixels[target+c]=colors[at+c];}
  pixels[target+3]=255;
 }
 return pixels;
}
const decode=(text:string)=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const sha=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const decoded=new Map<string,Promise<{values:number[];mask:Uint8Array}>>();
async function raster(plane:LivePlane&NumericRaster){
 const key=plane.values_sha256+plane.mask_base64+plane.shape.join(',');
 if(!decoded.has(key))decoded.set(key,(async()=>{
  const bytes=decode(plane.values_base64),mask=decode(plane.mask_base64),size=plane.shape[0]*plane.shape[1];
  if(bytes.length!==size*8||mask.length!==size||mask.some(v=>v!==0&&v!==1)||await sha(bytes)!==plane.values_sha256)throw Error('Numerical display checksum/shape mismatch.');
  const view=new DataView(bytes.buffer),values=Array.from({length:size},(_,i)=>view.getFloat64(i*8,true));if(values.some(v=>!Number.isFinite(v)))throw Error('Nonfinite numerical display.');
  return {values,mask};
 })());
 return decoded.get(key)!;
}
const palettes=new Map<string,Promise<{colors:Uint8Array;src:string}>>();
async function palette(plane:LivePlane&NumericRaster){
 const key=plane.color_lut_sha256+JSON.stringify(plane.color_stops);
 if(!palettes.has(key))palettes.set(key,(async()=>{
  const colors=decode(plane.color_lut_base64);if(colors.length!==1024||await sha(colors)!==plane.color_lut_sha256)throw Error('Numerical color lookup checksum mismatch.');
  const canvas=document.createElement('canvas');canvas.width=1;canvas.height=256;const ctx=canvas.getContext('2d')!,image=ctx.createImageData(1,256);
  for(let row=0;row<256;row++){
   const stops=plane.color_stops;
   if(stops){const at=(1-row/255)*(stops.length-1),lo=Math.min(stops.length-2,Math.floor(at)),f=at-lo;for(let c=0;c<3;c++)image.data[row*4+c]=Math.floor(stops[lo][c]+f*(stops[lo+1][c]-stops[lo][c]));image.data[row*4+3]=255;}
   else image.data.set(colors.subarray(row*4,row*4+4),row*4);
  }
  ctx.putImageData(image,0,0);return {colors,src:canvas.toDataURL('image/png')};
 })());
 return palettes.get(key)!;
}
const rendered=new Map<string,Promise<{src:string;colormap_src:string;limits:RasterLimits}>>();
/** A shared reference changes only intensity normalization and palette, never science pixels or geometry. */
export async function scaleImagePlane(plane:LivePlane&NumericRaster,scale:ImageScale,reference:LivePlane&NumericRaster=plane):Promise<LivePlane>{
 if(!hasNumericRaster(plane)||!hasNumericRaster(reference))throw Error('A numerical image and display reference are required.');
 const key=JSON.stringify([plane.values_sha256,plane.mask_base64,plane.shape,plane.array_y_direction,scale,reference.values_sha256,reference.mask_base64,reference.shape,reference.array_y_direction,reference.color_lut_sha256,reference.color_stops,reference.vmin,reference.vmax,reference.stretch,reference.asinh_a]);
 if(!rendered.has(key))rendered.set(key,(async()=>{
  const [{values,mask},referencePixels,{colors,src:colormap_src}]=await Promise.all([raster(plane),raster(reference),palette(reference)]);
  const limits:RasterLimits=scale==='original'?{vmin:reference.vmin,vmax:reference.vmax,stretch:reference.stretch,parameter:reference.asinh_a??1}:imageScaleValues(displayScalePixels(referencePixels.values,referencePixels.mask,reference.shape,reference.array_y_direction),scale);
  const pixels=numericPixels(values,mask,plane.shape,plane.array_y_direction,limits,colors,reference.color_stops);
  const canvas=document.createElement('canvas');canvas.width=plane.shape[1];canvas.height=plane.shape[0];const ctx=canvas.getContext('2d')!,image=ctx.createImageData(canvas.width,canvas.height);
  image.data.set(pixels);ctx.putImageData(image,0,0);
  return {src:canvas.toDataURL('image/png'),colormap_src,limits};
 })());
 const result=await rendered.get(key)!;
 return {...plane,src:result.src,colormap_src:result.colormap_src,colormap:reference.colormap,color_lut_base64:reference.color_lut_base64,color_lut_sha256:reference.color_lut_sha256,color_stops:reference.color_stops,vmin:result.limits.vmin,vmax:result.limits.vmax,stretch:result.limits.stretch,asinh_a:result.limits.parameter,rendered_from:'numeric-array'};
}
