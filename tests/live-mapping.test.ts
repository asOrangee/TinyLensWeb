import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sieMapper,verifiedLiveMapping,type LiveMapping} from '../src/lib/live-mapping.ts';
import {screenToPlane,planeToScreen,isInside} from '../src/lib/lens-mapping.ts';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/reported-mapping.json',import.meta.url),'utf8')) as Record<string,LiveMapping>;
const binding=(d:LiveMapping)=>({stage:d.stage,attempt:d.attempt,path:d.path,sha256:d.summary_sha256,fitsSha256:d.fits_sha256});
test('each real stage agrees with saved TinyLens SIE plus Shear reference rays',()=>{
 for(const d of Object.values(fixtures)){const m=verifiedLiveMapping(d,binding(d));assert.ok(m);for(const r of d.references){const p=m.sourceFor(r.image);assert.ok(Math.hypot(p.x-r.source.x,p.y-r.source.y)<1e-6);}}
});
test('real inverse mapping finds all SIS images at the analytic radii',()=>{
 const model={...fixtures.a.model,theta_E:1,e1_mass:0,e2_mass:0,center_x_mass:0,center_y_mass:0,gamma1:0,gamma2:0},m=sieMapper(model,fixtures.a.frames.image),beta={x:.2,y:.1},images=m.imagesFor(beta),r=Math.hypot(beta.x,beta.y);
 assert.equal(images.length,2);for(const expected of [r+1,r-1])assert.ok(images.some(p=>Math.hypot(p.x-beta.x/r*expected,p.y-beta.y/r*expected)<1e-7));
});
test('all stage inverse solutions ray trace back and their critical curves map pointwise',()=>{
 for(const d of Object.values(fixtures)){const m=verifiedLiveMapping(d,binding(d))!,beta={x:.12,y:-.08},images=m.imagesFor(beta);assert.ok(images.length>=2);for(const p of images){const b=m.sourceFor(p);assert.ok(Math.hypot(b.x-beta.x,b.y-beta.y)<1e-7);}const curves=m.criticalCurves();assert.ok(curves.length);for(const c of curves)for(let i=0;i<c.critical.length;i++){const p=m.sourceFor(c.critical[i]);assert.ok(Math.hypot(p.x-c.caustic[i].x,p.y-c.caustic[i].y)<1e-12);assert.ok(Math.abs(m.determinantFor(c.critical[i]))<1e-5);}}
});
test('offset source frames and zoomed image frames preserve one physical cursor',()=>{
 const source=fixtures.m1.frames.source,image=fixtures.m1.frames.image,view={zoom:2.1,pan:{x:.1,y:-.13}},p={x:.2,y:-.06},screen=planeToScreen(p,image,view),back=screenToPlane(screen,image,view);
 assert.ok(Math.hypot(back.x-p.x,back.y-p.y)<1e-12);
 const center=screenToPlane({x:.5,y:.5},source,{zoom:1,pan:{x:0,y:0}});assert.ok(Math.abs(center.x-.1534663438796997)<1e-7);assert.ok(Math.abs(center.y+.06167599558830261)<1e-7);assert.ok(isInside(center,source));assert.ok(!isInside({x:-.8,y:0},source));
});
test('foreign, stale, nonfinite and uncalibrated mappings never fall back to demo mass',()=>{
 const d=fixtures.m1;
 for(const change of [{synthetic:true},{stage:'m0'},{attempt:2},{fits_sha256:'0'.repeat(64)},{model:{...d.model,kind:'unsupported'}},{frames:{...d.frames,source:undefined}},{references:d.references.map((r,i)=>i===0?{...r,source:{x:NaN,y:0}}:r)},{references:d.references.map((r,i)=>i===0?{...r,source:{x:0,y:0}}:r)}])assert.equal(verifiedLiveMapping({...d,...change} as LiveMapping,binding(d)),null);
});
