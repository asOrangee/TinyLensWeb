import type {LivePlane,LiveResult} from './live-results';
import type {InputPlane} from './input-display';
import luts from '../data/color-luts.json';
const encode=(bytes:Uint8Array)=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};
type Entry={offset:number;byte_length:number;values_sha256:string;plane:LivePlane};
let pending:Promise<{models:LiveResult['planes'];input:{planes:InputPlane[];log_a:number;pixel_scale_arcsec:number;synthetic:true}}>;
function load(){return pending??=(async()=>{
 const [info,binary]=await Promise.all([fetch('/demo/numeric-display.json').then(r=>{if(!r.ok)throw Error('Demo numerical metadata unavailable.');return r.json();}),fetch('/demo/numeric-display.bin').then(r=>{if(!r.ok)throw Error('Demo numerical arrays unavailable.');return r.arrayBuffer();})]);
 if(info.schema!=='tinylens.demo-numeric.v1'||info.synthetic!==true||info.byte_length!==binary.byteLength)throw Error('Invalid synthetic numerical fixture.');
 const attach=(entry:Entry):LivePlane=>{
  const p=entry.plane,count=p.shape[0]*p.shape[1],lut=luts[p.colormap as keyof typeof luts];
  if(!lut||entry.byte_length!==count*8||entry.offset<0||entry.offset+entry.byte_length>binary.byteLength)throw Error('Invalid demo numerical plane.');
  return {...p,src:'',colormap_src:'',values_base64:encode(new Uint8Array(binary,entry.offset,entry.byte_length)),values_sha256:entry.values_sha256,mask_base64:encode(new Uint8Array(count).fill(1)),array_y_direction:'decreasing',color_lut_base64:lut.rgba_base64,color_lut_sha256:lut.sha256};
 };
 const models=Object.fromEntries(Object.entries(info.models).map(([name,entry])=>[name,attach(entry as Entry)])) as LiveResult['planes'];
 const input={...info.input,synthetic:true as const,planes:info.input.planes.map((p:InputPlane&{numeric_entry:Entry})=>({...p,numeric:attach(p.numeric_entry)}))};
 return {models,input};
})();}
export async function demoModelRasters(){return (await load()).models;}
export async function demoInputRasters(){return (await load()).input;}
