import test from 'node:test';
import assert from 'node:assert/strict';
import {fitsImages,numericalHash,numericalInput,numericalPlane} from './numeric-payload.mjs';
const card=(name,value)=>name==='END'?'END'.padEnd(80):`${name.padEnd(8)}= ${typeof value==='string'?"'"+value+"'":String(value)}`.padEnd(80);
function hdu(name,values,bitpix=-64,scale=1,zero=0){
 const cards=[card(name?'XTENSION':'SIMPLE',name?'IMAGE':'T'),card('BITPIX',bitpix),card('NAXIS',values?2:0)];
 if(values)cards.push(card('NAXIS1',2),card('NAXIS2',2));
 if(name)cards.push(card('EXTNAME',name));cards.push(card('BSCALE',scale),card('BZERO',zero),card('END'));
 const header=Buffer.alloc(Math.ceil(cards.length*80/2880)*2880,32);header.write(cards.join(''));
 if(!values)return header;
 const pixels=Buffer.alloc(2880);values.forEach((v,i)=>{if(bitpix===-64)pixels.writeDoubleBE(v,i*8);else if(bitpix===-32)pixels.writeFloatBE(v,i*4);else pixels.writeInt16BE(v,i*2)});
 return Buffer.concat([header,pixels]);
}
test('FITS numerical transport reads endian/scaled pixels and never reads a diagnostic image',()=>{
 const fits=Buffer.concat([hdu(null),hdu('VIS_FLUX',[1,2,3,4]),hdu('VIS_RMS',[1,2,1,2],16),hdu('VIS_PSF',[1,2,3,4],-32,.1,0)]);
 assert.deepEqual([...fitsImages(fits).get('VIS_PSF').values],[.1,.2,.30000000000000004,.4]);
 const variants=Object.fromEntries(['linear','log','zscale'].map(k=>[k,{src:'data:image/png;base64,legacy',vmin:0,vmax:4}]));
 const display={source:{fits_sha256:numericalHash(fits)},input_geometry:{input_x_direction:'decreasing',input_y_direction:'increasing'},planes:['data','noise','snr','psf'].map(id=>({id,shape:[2,2],half_extent_arcsec:1,half_extent_x_arcsec:1,data_min:0,data_max:4,variants}))};
 const out=numericalInput(display,fits),read=p=>{const raw=Buffer.from(p.numeric.values_base64,'base64');return Array.from({length:4},(_,i)=>raw.readDoubleLE(i*8))};
 assert.deepEqual(read(out.planes[0]),[4,3,2,1]);assert.deepEqual(read(out.planes[2]),[2,3,1,1]);
 assert.equal(JSON.stringify(out).includes('data:image'),false);assert.equal(out.planes[0].numeric.array_y_direction,'decreasing');
 assert.throws(()=>numericalInput({...display,source:{fits_sha256:'0'.repeat(64)}},fits),/checksum/);
 assert.throws(()=>fitsImages(fits.subarray(0,7000)),/Truncated/);
});
test('a numerical payload requires complete finite arrays and masks, and strips server raster sources',()=>{
 const values=Buffer.alloc(32),mask=Buffer.alloc(4,1);[0,1,2,64].forEach((v,i)=>values.writeDoubleLE(v,i*8));
 const plane={src:'data:image/png;base64,not-used',colormap_src:'data:image/png;base64,not-used',shape:[2,2],colormap:'magma',values_base64:values.toString('base64'),values_sha256:numericalHash(values),mask_base64:mask.toString('base64'),array_y_direction:'increasing'};
 const p=numericalPlane(plane);assert.equal(p.src,'');assert.equal(p.colormap_src,'');assert.equal(Buffer.from(p.color_lut_base64,'base64').length,1024);assert.equal(JSON.stringify(p).includes('data:image'),false);
 for(const change of [{values_base64:''},{values_sha256:'0'.repeat(64)},{mask_base64:Buffer.from([1,2,1,1]).toString('base64')},{shape:[4,1,1]},{colormap:'unknown'}])assert.throws(()=>numericalPlane({...plane,...change}));
 values.writeDoubleLE(NaN,0);assert.throws(()=>numericalPlane({...plane,values_base64:values.toString('base64'),values_sha256:numericalHash(values)}),/Nonfinite/);
});
