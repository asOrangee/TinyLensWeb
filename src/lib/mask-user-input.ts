import type {LivePlane} from './live-results';
import type {AgentUpdate} from './agent-types';
import {hasNumericRaster} from './image-scale.ts';
export type MaskSource={schema:'tinylens.mask-edit.v1';stage:'b';attempt:number;path:string;sha256:string;mask_path:string;mask_sha256:string;domain_path:string;domain_sha256:string;input_fits_sha256:string;pixel_scale_arcsec:number;modeling_radius_arcsec:number|null;shape:number[];included:number;domain_pixels:number;included_base64:string;domain_base64:string;display_y_direction:'decreasing';plane:LivePlane};
const binary=(text:string,size:number)=>{const data=Array.from(atob(text),c=>c.charCodeAt(0));if(data.length!==size||data.some(v=>v!==0&&v!==1))throw Error('Invalid mask pixels');return data;};
export function parseMaskSource(value:unknown,report:AgentUpdate){
 const d=value as MaskSource,attempt=report.path?.match(/\/attempts\/b\/(\d+)\/stage-result\.json$/)?.[1];
 if(!d||d.schema!=='tinylens.mask-edit.v1'||d.stage!=='b'||d.path!==report.path||attempt===undefined||d.attempt!==Number(attempt)||!['sha256','mask_sha256','domain_sha256','input_fits_sha256'].every(k=>/^[a-f0-9]{64}$/.test(d[k as keyof MaskSource] as string))||!Array.isArray(d.shape)||d.shape.length!==2||d.shape[0]!==d.shape[1]||!d.shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||d.display_y_direction!=='decreasing'||!Number.isFinite(d.pixel_scale_arcsec)||d.pixel_scale_arcsec<=0||d.modeling_radius_arcsec!==null&&(!Number.isFinite(d.modeling_radius_arcsec)||d.modeling_radius_arcsec<=0))throw Error('Mask source mismatch');
 const size=d.shape[0]*d.shape[1],pixels=binary(d.included_base64,size),domain=binary(d.domain_base64,size);
 if(pixels.some((v,i)=>v>domain[i])||pixels.reduce((a,b)=>a+b,0)!==d.included||domain.reduce((a,b)=>a+b,0)!==d.domain_pixels||d.domain_pixels<=0||d.plane?.input_fits_sha256!==d.input_fits_sha256||JSON.stringify(d.plane.shape)!==JSON.stringify(d.shape)||d.plane.half_extent_arcsec!==d.shape[0]*d.pixel_scale_arcsec/2||!hasNumericRaster(d.plane)||d.plane.src!==''||d.plane.colormap_src!=='')throw Error('Mask geometry mismatch');
 return {...d,pixels,domain};
}
export const maskDraftKey=(source:MaskSource,threadId:string,reportId:string)=>'tinylens-mask-draft-v1:'+JSON.stringify([threadId,reportId,source.path,source.sha256,source.mask_sha256,source.domain_sha256,source.input_fits_sha256]);
export function restoreMaskDraft(stored:string|null,source:ReturnType<typeof parseMaskSource>){try{if(!stored)return source.pixels;const pixels=binary(stored,source.pixels.length);if(pixels.some((v,i)=>v>source.domain[i]))throw Error('Draft outside modeling domain');return pixels;}catch{return source.pixels;}}
export function encodeMaskDraft(pixels:readonly number[]){let result='';for(let i=0;i<pixels.length;i+=32768)result+=String.fromCharCode(...pixels.slice(i,i+32768));return btoa(result);}
export function canonicalMaskRuns(pixels:readonly number[],size:number){
 if(pixels.length!==size*size||pixels.some(v=>v!==0&&v!==1))throw Error('Invalid draft grid');
 const runs:number[][]=[];let start=-1;
 for(let i=0;i<=pixels.length;i++){const on=i<pixels.length&&pixels[(size-1-Math.floor(i/size))*size+i%size]===1;if(on&&start<0)start=i;if(!on&&start>=0){runs.push([start,i-start]);start=-1;}}
 return runs;
}
export const maskStart='[TinyLens mask edit]',maskEnd='[/TinyLens mask edit]';
export function maskPrompt(pixels:readonly number[],source:ReturnType<typeof parseMaskSource>,threadId:string,reportId:string){
 if(pixels.length!==source.pixels.length||pixels.some((v,i)=>v!==0&&v!==1||v>source.domain[i]))throw Error('Draft outside frozen domain');
 if(pixels.every((v,i)=>v===source.pixels[i]))return '';
 const request={schema:'tinylens.mask-user-input.v1',kind:'user_input',synthetic:false,stage:'b',mask_kind:'arc_support',
  source:{thread_id:threadId,summary_report_id:reportId,summary:source.path,summary_sha256:source.sha256,attempt:source.attempt,mask:source.mask_path,mask_sha256:source.mask_sha256,modeling_domain:source.domain_path,modeling_domain_sha256:source.domain_sha256,input_fits_sha256:source.input_fits_sha256},
  coordinate_system:{array_frame:'canonical',origin:'geometric_image_center',x_axis:'column',y_axis:'row',x_direction:'increasing',y_direction:'increasing',order:'row_major',image_shape:source.shape,pixel_scale_arcsec:source.pixel_scale_arcsec},
  mask:{encoding:'included_pixel_rle',index_base:0,run_fields:['start_index','length'],runs:canonicalMaskRuns(pixels,source.shape[0]),included_value:1,excluded_value:0,fits_exclusion_mask_included_value:0,included_pixel_count:pixels.reduce((a,b)=>a+b,0)}};
 return `${maskStart}\n以下是我在 Stage B 原始网格上编辑的透镜弧支持区域草稿。请先核对数据、attempt、坐标和有效域，再按现有工作流处理；保留已接受的原掩膜和旧结果，需要重跑时由你安排。\n\n${JSON.stringify(request,null,2)}\n${maskEnd}`;
}
/** Manual text remains authoritative; only an untouched generated block is replaced. */
export function mergeMaskPrompt(text:string,previous:string,next:string){
 if(previous&&text.includes(previous))return text.replace(previous,next);
 if(text.includes(maskStart))return text;
 return next?`${text}${text?'\n\n':''}${next}`:text;
}
