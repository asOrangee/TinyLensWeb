import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const colors=JSON.parse(await readFile(new URL('../src/data/color-luts.json',import.meta.url),'utf8'));
export const numericalHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function numericalPlane(plane){
 const count=plane?.shape?.[0]*plane?.shape?.[1],values=Buffer.from(plane?.values_base64??'','base64'),mask=Buffer.from(plane?.mask_base64??'','base64');
 if(!Array.isArray(plane?.shape)||plane.shape.length!==2||!plane.shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||!Number.isInteger(count)||count<1||count>512*512||values.length!==count*8||mask.length!==count||mask.some(v=>v!==0&&v!==1)||numericalHash(values)!==plane.values_sha256||!['increasing','decreasing'].includes(plane.array_y_direction))throw Error('Scientific images require verified numerical arrays.');
 for(let i=0;i<count;i++)if(!Number.isFinite(values.readDoubleLE(i*8)))throw Error('Nonfinite scientific pixels.');
 const lut=colors[plane.colormap];if(!lut)throw Error('Unsupported scientific color lookup table.');
 return {...plane,src:'',colormap_src:'',color_lut_base64:lut.rgba_base64,color_lut_sha256:lut.sha256};
}

/** Read uncompressed FITS image HDUs. The caller verifies the complete FITS hash. */
export function fitsImages(bytes){
 if(bytes.length===0||bytes.length%2880!==0)throw Error('Truncated FITS file.');
 const images=new Map();let offset=0;
 while(offset<bytes.length){
  const header={};let end=-1;
  for(let at=offset;at+80<=bytes.length;at+=80){
   const card=bytes.toString('ascii',at,at+80),key=card.slice(0,8).trim();
   if(key==='END'){end=at+80;break;}
   if(card[8]!=='=')continue;
   const value=card.slice(10).trim();
   if(value.startsWith("'")){const match=value.match(/^'((?:[^']|'')*)'/);if(match)header[key]=match[1].replaceAll("''","'").trim();}
   else{const token=value.split('/')[0].trim();header[key]=token==='T'?true:token==='F'?false:Number(token.replace(/[dD]/,'E'));}
  }
  if(end<0)throw Error('Truncated FITS header.');
  const dataAt=offset+Math.ceil((end-offset)/2880)*2880,naxis=header.NAXIS,bitpix=header.BITPIX;
  if(!Number.isInteger(naxis)||naxis<0||naxis>9||![8,16,32,64,-32,-64].includes(bitpix))throw Error('Unsupported FITS header.');
  let count=naxis===0?0:1;for(let axis=1;axis<=naxis;axis++){const n=header['NAXIS'+axis];if(!Number.isInteger(n)||n<0)throw Error('Invalid FITS dimensions.');count*=n;}
  const size=(count+(header.PCOUNT??0))*(header.GCOUNT??1)*Math.abs(bitpix)/8;
  if(!Number.isSafeInteger(size)||size<0||dataAt+size>bytes.length)throw Error('Truncated FITS pixels.');
  if(naxis===2&&header.XTENSION!=='BINTABLE'&&count<=512*512){
   const values=new Float64Array(count),scale=header.BSCALE??1,zero=header.BZERO??0;
   if(!Number.isFinite(scale)||!Number.isFinite(zero))throw Error('Invalid FITS scaling.');
   for(let i=0;i<count;i++){
    const at=dataAt+i*Math.abs(bitpix)/8;
    const raw=bitpix===8?bytes.readUInt8(at):bitpix===16?bytes.readInt16BE(at):bitpix===32?bytes.readInt32BE(at):bitpix===64?Number(bytes.readBigInt64BE(at)):bitpix===-32?bytes.readFloatBE(at):bytes.readDoubleBE(at);
    values[i]=raw*scale+zero;if(!Number.isFinite(values[i])||(header.BLANK!==undefined&&raw===header.BLANK))throw Error('Invalid FITS image pixels.');
   }
   const name=header.EXTNAME??'PRIMARY';if(images.has(name))throw Error('Ambiguous FITS extension.');
   images.set(name,{values,shape:[header.NAXIS2,header.NAXIS1],header});
  }
  offset=dataAt+Math.ceil(size/2880)*2880;
 }
 return images;
}

export function numericalInput(display,fits){
 if(numericalHash(fits)!==display.source.fits_sha256)throw Error('Numerical input FITS checksum mismatch.');
 const hdus=fitsImages(fits),g=display.input_geometry;
 if(!g||!['increasing','decreasing'].includes(g.input_x_direction)||!['increasing','decreasing'].includes(g.input_y_direction))throw Error('Missing frozen input axes.');
 const arrays={};
 for(const [name,extension] of [['data','VIS_FLUX'],['noise','VIS_RMS'],['psf','VIS_PSF']]){
  const hdu=hdus.get(extension);if(!hdu)throw Error('Missing FITS extension.');
  const [height,width]=hdu.shape,values=new Float64Array(hdu.values.length);
  for(let row=0;row<height;row++)for(let col=0;col<width;col++)values[row*width+col]=hdu.values[(g.input_y_direction==='increasing'?height-1-row:row)*width+(g.input_x_direction==='decreasing'?width-1-col:col)];
  arrays[name]={values,shape:hdu.shape};
 }
 if(JSON.stringify(arrays.data.shape)!==JSON.stringify(arrays.noise.shape)||arrays.noise.values.some(v=>v<=0))throw Error('Invalid RMS array.');
 arrays.snr={shape:arrays.data.shape,values:arrays.data.values.map((v,i)=>v/arrays.noise.values[i])};
 return {...display,colormap_src:'',planes:display.planes.map(p=>{
  const a=arrays[p.id];if(!a||JSON.stringify(a.shape)!==JSON.stringify(p.shape))throw Error('Numerical input geometry mismatch.');
  const raw=Buffer.alloc(a.values.length*8);a.values.forEach((v,i)=>raw.writeDoubleLE(v,i*8));
  const halfX=p.half_extent_x_arcsec,halfY=p.half_extent_arcsec,mask=Buffer.alloc(a.values.length,1);
  const numeric=numericalPlane({src:'',shape:p.shape,bounds_arcsec:[-halfX,halfX,-halfY,halfY],half_extent_arcsec:halfY,data_min:p.data_min,data_max:p.data_max,vmin:p.variants.linear.vmin,vmax:p.variants.linear.vmax,stretch:'linear',asinh_a:1,colormap:'magma',colormap_src:'',values_base64:raw.toString('base64'),values_sha256:numericalHash(raw),mask_base64:mask.toString('base64'),array_y_direction:'decreasing',input_fits_sha256:display.source.fits_sha256});
  return {...p,numeric,variants:Object.fromEntries(Object.entries(p.variants).map(([scale,v])=>[scale,{...v,src:'',sha256:undefined}]))};
 })};
}
