import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {potentialMapper,verifiedDemoMapping,screenToPlane,planeToScreen,isInside,displayImageFamily,isInPlaneView,weakImageMagnification} from '../src/lib/lens-mapping.ts';
const data=JSON.parse(readFileSync(new URL('../src/data/lens-mapping-demo.json',import.meta.url),'utf8'));
const display=JSON.parse(readFileSync(new URL('../src/data/science-demo.json',import.meta.url),'utf8'));
const mapper=verifiedDemoMapping(data,display)!;
const distance=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
test('mapping is bound to the same synthetic assets and calibrated frames',()=>{
  assert.ok(mapper);
  for(const invalid of [undefined,{...data,synthetic:false},{...data,coordinates:{...data.coordinates,y:'down'}},{...data,images:{}},{...data,frames:{...data.frames,source:{...data.frames.source,half_extent_arcsec:1}}}])assert.equal(verifiedDemoMapping(invalid,display),null);
  assert.equal(verifiedDemoMapping(data,{planes:{...display.planes,model:{...display.planes.model,sha256:'different-attempt'}}}),null);
});
test('screen coordinates respect pixel edges, the y flip, zoom and translated images',()=>{
  const frame=mapper.frames.image;
  for(const zoom of [1,1.75,3])for(const pan of [{x:0,y:0},{x:35,y:-20}])for(const position of [{x:0,y:0},{x:.5,y:.5},{x:1,y:1},{x:.23,y:.87}]){
    const recovered=planeToScreen(screenToPlane(position,frame,{zoom,pan}),frame,{zoom,pan});assert.ok(distance(recovered,position)<1e-12);
  }
  assert.equal(screenToPlane({x:0,y:0},frame,{zoom:1,pan:{x:0,y:0}}).y,frame.half_extent_arcsec);
  assert.equal(isInside({x:99,y:0},frame),false);
});
test('forward rays agree with the fixture generator rotated-deflection formula',()=>{
  const q=.89,c=Math.cos(.32),s=Math.sin(.32);
  for(const [x,y] of [[1.5,.7],[-1.2,-.3],[.09,.045],[.0001,-.0002]]){
    const xp=x*c+y*s,yp=-x*s+y*c,r=Math.sqrt(q*xp*xp+yp*yp/q+1e-5),axp=1.7*q*xp/r,ayp=1.7*yp/q/r;
    const expected={x:x-(axp*c-ayp*s+.025*x+.015*y),y:y-(axp*s+ayp*c+.015*x-.025*y)};
    assert.ok(distance(mapper.sourceFor({x,y}),expected)<1e-12);
  }
});
test('inverse returns the multiple discrete images and validates every solution',()=>{
  const target={x:.09,y:.045},images=mapper.imagesFor(target);assert.equal(images.length,5);
  for(const image of images){assert.ok(isInside(image,mapper.frames.image));assert.ok(distance(mapper.sourceFor(image),target)<1e-7);}
  for(let i=0;i<images.length;i++)for(let j=i+1;j<images.length;j++)assert.ok(distance(images[i],images[j])>1e-4);
});
test('inverse retains image branches across the field, including the faint central image',()=>{
  for(const radius of [.0002,.3,1,1.6,2.2,3.8])for(let angle=0;angle<8;angle++){
    const image={x:radius*Math.cos(angle*Math.PI/4),y:radius*Math.sin(angle*Math.PI/4)},source=mapper.sourceFor(image);
    assert.ok(mapper.imagesFor(source).some(candidate=>distance(candidate,image)<1e-4),`lost image ${JSON.stringify(image)}`);
  }
});
test('circular softened potential has two outer images and a central image off axis',()=>{
  const circular=potentialMapper({...data.model,potential_axis_ratio:1,shear_gamma1:0,shear_gamma2:0},mapper.frames.image),target={x:.1,y:0},images=circular.imagesFor(target);
  assert.equal(images.length,3);assert.ok(images.some(point=>Math.hypot(point.x,point.y)<.001));
  for(const point of images)assert.ok(distance(circular.sourceFor(point),target)<1e-7);
});
test('missing or out-of-field solutions do not become clamped markers',()=>{
  assert.deepEqual(mapper.imagesFor({x:100,y:100}),[]);
  assert.deepEqual(mapper.imagesFor({x:NaN,y:0}),[]);
  const projected=planeToScreen({x:99,y:0},mapper.frames.source,{zoom:1,pan:{x:0,y:0}});assert.ok(projected.x>1);
});
test('signed magnification agrees with the independently differentiated mapping',()=>{
  for(const p of [{x:0,y:0},{x:1.5,y:.7},{x:-1.2,y:-.3},{x:.0002,y:-.0001}]){
    const h=1e-7,xp=mapper.sourceFor({x:p.x+h,y:p.y}),xm=mapper.sourceFor({x:p.x-h,y:p.y}),yp=mapper.sourceFor({x:p.x,y:p.y+h}),ym=mapper.sourceFor({x:p.x,y:p.y-h});
    const expected=4*h*h/((xp.x-xm.x)*(yp.y-ym.y)-(yp.x-ym.x)*(xp.y-xm.y));
    assert.ok(Math.abs(mapper.magnificationFor(p)/expected-1)<1e-6);
  }
});
test('source hover defaults to the moving main images instead of the soft-core central image',()=>{
  const families=[];
  for(const target of [{x:0,y:0},{x:.09,y:.045},{x:.5,y:.4},{x:-.5,y:.3},{x:-.7,y:-.7},{x:.7,y:.7}]){
    const all=mapper.imagesFor(target),display=displayImageFamily(all,mapper.magnificationFor);
    assert.ok(display.points.length>=2);
    assert.equal(display.hiddenWeakCount,1);
    assert.ok(display.points.every(point=>Math.hypot(point.x,point.y)>.1&&Math.abs(point.magnification)>=weakImageMagnification));
    assert.ok(display.points.some(point=>point.magnification<0),'negative-parity main images must remain visible');
    for(const point of display.points)assert.ok(distance(mapper.sourceFor(point),target)<1e-7);
    families.push(display.points);
  }
  assert.ok(families[0].every(point=>families[3].every(other=>distance(point,other)>.1)),'different source positions must give different main image positions');
});
test('the faint-image switch restores the full mathematical image family without mutating it',()=>{
  const target={x:.09,y:.045},all=mapper.imagesFor(target),before=JSON.stringify(all),display=displayImageFamily(all,mapper.magnificationFor,true);
  assert.equal(display.points.length,5);assert.equal(display.hiddenWeakCount,0);
  assert.equal(display.points.filter(point=>point.weak).length,1);
  assert.equal(JSON.stringify(all),before);
  const center=display.points.find(point=>point.weak)!;assert.ok(Math.hypot(center.x,center.y)<.001&&Math.abs(center.magnification)<1e-5);
});
test('clipped main images are reported outside a zoomed view rather than replaced by a central marker',()=>{
  const display=displayImageFamily(mapper.imagesFor({x:0,y:0}),mapper.magnificationFor);
  assert.equal(display.points.length,4);
  assert.equal(display.points.filter(point=>isInPlaneView(point,mapper.frames.image,{zoom:3,pan:{x:0,y:0}})).length,0);
  assert.equal(display.points.filter(point=>isInPlaneView(point,mapper.frames.image,{zoom:1,pan:{x:0,y:0}})).length,4);
});
test('critical curves satisfy the Jacobian zero and map pointwise to separate caustics',()=>{
  const curves=mapper.criticalCurves();assert.equal(curves.length,2);assert.equal(mapper.criticalCurves(),curves,'geometry is cached across pointer moves');
  for(const curve of curves){
    assert.ok(curve.closed&&curve.critical.length>100);assert.equal(curve.critical.length,curve.caustic.length);
    for(let i=0;i<curve.critical.length;i++){
      const point=curve.critical[i];assert.ok(isInside(point,mapper.frames.image));
      assert.ok(Math.abs(mapper.determinantFor(point))<1e-8);
      assert.ok(distance(mapper.sourceFor(point),curve.caustic[i])<1e-12);
      assert.ok(distance(point,curve.critical[(i+1)%curve.critical.length])<.05,'unrelated curve branches must not be bridged');
    }
  }
  assert.ok(curves[0].caustic.every(point=>isInside(point,mapper.frames.source)));
  assert.ok(curves[1].caustic.every(point=>!isInside(point,mapper.frames.source)),'the radial caustic stays outside the source crop without clamping');
});
test('circular softened lens reproduces both analytic critical radii and the point caustic',()=>{
  const model={...data.model,potential_axis_ratio:1,shear_gamma1:0,shear_gamma2:0},circular=potentialMapper(model,mapper.frames.image),curves=circular.criticalCurves();
  const b=model.normalization_arcsec,s2=model.softening_squared_arcsec2,expected=[Math.sqrt(b*b-s2),Math.sqrt((b*s2)**(2/3)-s2)];
  assert.equal(curves.length,2);
  for(let i=0;i<2;i++){assert.ok(curves[i].closed);for(const point of curves[i].critical)assert.ok(Math.abs(Math.hypot(point.x,point.y)-expected[i])<1e-10);}
  assert.ok(curves[0].caustic.every(point=>Math.hypot(point.x,point.y)<1e-10));
  const radialCaustic=Math.abs(expected[1]*(1-b/Math.sqrt(expected[1]**2+s2)));
  assert.ok(curves[1].caustic.every(point=>Math.abs(Math.hypot(point.x,point.y)-radialCaustic)<1e-10));
});
test('critical curves clipped by the image field remain open rather than closing across the crop',()=>{
  const frame={...mapper.frames.image,half_extent_arcsec:1.3},cropped=potentialMapper({...data.model,potential_axis_ratio:1,shear_gamma1:0,shear_gamma2:0},frame),curves=cropped.criticalCurves();
  assert.equal(curves.filter(curve=>curve.closed).length,1);assert.equal(curves.filter(curve=>!curve.closed).length,4);
  for(const curve of curves){for(const point of curve.critical)assert.ok(isInside(point,frame));if(!curve.closed)for(const endpoint of [curve.critical[0],curve.critical.at(-1)!])assert.ok(Math.abs(Math.max(Math.abs(endpoint.x),Math.abs(endpoint.y))-1.3)<1e-10);}
});
test('subcritical model has no invented critical curves or caustics',()=>{
  const subcritical=potentialMapper({...data.model,normalization_arcsec:.001,potential_axis_ratio:1,shear_gamma1:0,shear_gamma2:0},mapper.frames.image);
  assert.deepEqual(subcritical.criticalCurves(),[]);
});
