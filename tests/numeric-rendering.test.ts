import test from 'node:test';
import assert from 'node:assert/strict';
import {hasNumericRaster,numericPixels} from '../src/lib/image-scale.ts';
import {numericalFixture} from './fixtures/numerical-plane.ts';
const colors=Uint8Array.from(Buffer.from(numericalFixture().color_lut_base64,'base64'));
test('original rendering uses numerical pixels, flips canonical rows once and keeps excluded pixels transparent',()=>{
 const values=[0,1,2,3],mask=[1,1,0,1],copy=[...values];
 const p=numericPixels(values,mask,[2,2],'increasing',{vmin:0,vmax:3,stretch:'linear',parameter:1},colors);
 assert.deepEqual([...p],[0,0,0,0,255,255,255,255,0,0,0,255,85,85,85,255]);
 assert.deepEqual(values,copy);
 const reversed=numericPixels([2,3,0,1],[0,1,1,1],[2,2],'decreasing',{vmin:0,vmax:3,stretch:'linear',parameter:1},colors);
 assert.deepEqual(reversed,p);
});
test('fixed residual and chi-square limits clip only rendering, retaining their full numerical tails',()=>{
 const values=[-64,0,1,64],mask=[1,1,1,1];
 const p=numericPixels(values,mask,[2,2],'decreasing',{vmin:0,vmax:9,stretch:'linear',parameter:1},colors);
 assert.deepEqual([...p.slice(0,4)],[0,0,0,255]);assert.deepEqual([...p.slice(12)],[255,255,255,255]);assert.equal(values[3],64);
 assert.equal(hasNumericRaster({...numericalFixture(),values_base64:undefined}),false);
 assert.equal(hasNumericRaster({...numericalFixture(),color_lut_base64:undefined}),false);
});
test('a numerical image cannot render corrupted masks, nonfinite values, wrong shapes or invalid limits',()=>{
 const draw=(v:number[],m:number[],shape=[2,2],lo=0,hi=3)=>numericPixels(v,m,shape,'decreasing',{vmin:lo,vmax:hi,stretch:'linear',parameter:1},colors);
 assert.throws(()=>draw([1,NaN,2,3],[1,1,1,1]));assert.throws(()=>draw([0,1,2,3],[1,2,1,1]));assert.throws(()=>draw([0,1,2,3],[1,1,1,1],[1,1]));assert.throws(()=>draw([0,1,2,3],[1,1,1,1],[2,2],2,1));
});
