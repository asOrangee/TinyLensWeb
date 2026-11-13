import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {displayScalePixels,imageScaleValues,scalablePlanes,zscaleLimits} from '../src/lib/image-scale.ts';
import {colorbarTicks,formatScaleNumber} from '../src/lib/display-scale.ts';
const reference=JSON.parse(readFileSync(new URL('./fixtures/zscale-reference.json',import.meta.url),'utf8'));
test('ZScale samples valid pixels in the same display order for native and canonical rasters',()=>{
 assert.deepEqual(displayScalePixels([0,1,2,3,4,5],[1,0,1,1,1,0],[2,3],'increasing'),[3,4,0,2]);
 assert.deepEqual(displayScalePixels([3,4,5,0,1,2],[1,1,0,1,0,1],[2,3],'decreasing'),[3,4,0,2]);
});
test('frontend ZScale agrees with actual Astropy defaults including outlier rejection',()=>{
 const cases={ramp:Array.from({length:2000},(_,i)=>Math.sin(i*.15)+i/170),outliers:Array.from({length:2400},(_,i)=>i%47===0?10000+i:Math.cos(i*.2)*.3+i/1900),constant:Array(40).fill(.23),small:[-1,3,10]};
 for(const [key,values] of Object.entries(cases)){const limits=zscaleLimits(values);for(let i=0;i<2;i++)assert.ok(Math.abs(limits[i]-reference.limits[key][i])<1e-10,`${key} ${limits} != ${reference.limits[key]}`);}
});
test('only three image-plane intensity layers are scalable and all scales retain exactly five two-decimal ticks',()=>{
 assert.deepEqual([...scalablePlanes],['observation','model','source-lensed']);
 for(const scale of ['linear','log','asinh','zscale'] as const){const values=[-.0173,.01,.3,1.2,5.91],copy=[...values],limits=imageScaleValues(values,scale);assert.deepEqual(values,copy);const ticks=colorbarTicks(limits.vmin,limits.vmax,limits.stretch,limits.parameter);assert.equal(ticks.length,5);assert.ok(ticks.every(t=>/^-?\d+\.\d{2}$/.test(formatScaleNumber(t.value))));}
 assert.throws(()=>imageScaleValues([], 'linear'));assert.throws(()=>imageScaleValues([NaN], 'log'));
});

test('Asinh selects the existing stretch over the full signed Data range', () => {
  const limits = imageScaleValues([-.02, 0, .01, 5.91], 'asinh');
  assert.deepEqual(limits, { vmin: -.02, vmax: 5.91, stretch: 'asinh', parameter: 25 });
  for (const tick of colorbarTicks(limits.vmin, limits.vmax, limits.stretch, limits.parameter)) {
    const color = Math.asinh(25 * (tick.value - limits.vmin)) / Math.asinh(25 * (limits.vmax - limits.vmin));
    assert.ok(Math.abs(color - tick.fraction) < 1e-12);
  }
});
