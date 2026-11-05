import test from 'node:test';
import assert from 'node:assert/strict';
import {fittedImageBox,imageLabelContrast} from '../src/lib/image-label-contrast.ts';
const raster=(...pixels:number[][])=>Uint8ClampedArray.from(pixels.flat());
const ink=(...alpha:number[])=>raster(...alpha.map(a=>[0,0,0,a]));

test('annotation ink selects black on white and white on black',()=>{
 const light=imageLabelContrast(raster([255,255,255,255]),ink(255))!;
 const dark=imageLabelContrast(raster([0,0,0,255]),ink(255))!;
 assert.equal(light.color,'#000000');assert.equal(light.blackContrast,21);
 assert.equal(dark.color,'#ffffff');assert.equal(dark.whiteContrast,21);
});
test('sRGB color contrast uses linear luminance rather than RGB brightness',()=>{
 for(const [rgb,color] of [[[255,0,0],'#000000'],[[0,255,0],'#000000'],[[0,0,255],'#ffffff'],[[117,117,117],'#ffffff'],[[118,118,118],'#000000']] as const){
  const chosen=imageLabelContrast(raster([...rgb,255]),ink(255))!;assert.equal(chosen.color,color);
  assert.ok(color==='#000000'?chosen.blackContrast>=chosen.whiteContrast:chosen.whiteContrast>=chosen.blackContrast);
 }
});
test('only the background underneath glyphs participates, regardless of the rest of an image',()=>{
 const white=raster([255,255,255,255],[255,255,255,255],[0,0,0,255],[255,255,255,255]);
 const black=raster([0,0,0,255],[0,0,0,255],[255,255,255,255],[0,0,0,255]);
 const mask=ink(0,0,255,0),before=white.slice();
 assert.equal(imageLabelContrast(white,mask)?.color,'#ffffff');
 assert.equal(imageLabelContrast(black,mask)?.color,'#000000');assert.deepEqual(white,before);
});
test('anti-aliased glyph coverage weights contrast and empty or transparent regions do not invent samples',()=>{
 const background=raster([0,0,0,255],[255,255,255,255]);
 assert.equal(imageLabelContrast(background,ink(255,25))?.color,'#ffffff');
 assert.equal(imageLabelContrast(background,ink(25,255))?.color,'#000000');
 assert.equal(imageLabelContrast(background,ink(0,0)),undefined);
 assert.equal(imageLabelContrast(raster([0,0,0,0]),ink(255)),undefined);
 assert.throws(()=>imageLabelContrast(background,ink(255)),/Invalid annotation raster/);
});
test('image fitting preserves the displayed cover crop, letterbox and transformed image box',()=>{
 const box={x:-50,y:20,width:200,height:200};
 assert.deepEqual(fittedImageBox(200,100,box,'cover'),{x:-150,y:20,width:400,height:200});
 assert.deepEqual(fittedImageBox(200,100,box,'contain'),{x:-50,y:70,width:200,height:100});
 assert.deepEqual(fittedImageBox(200,100,box,'fill'),box);
 assert.deepEqual(fittedImageBox(200,100,box,'contain','0% 0%'),{x:-50,y:20,width:200,height:100});
});
