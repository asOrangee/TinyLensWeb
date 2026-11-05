import test from 'node:test';
import assert from 'node:assert/strict';
import {colorbarTicks,nativeColorbarTicks,formatScaleNumber} from '../src/lib/display-scale.ts';

test('all native axes render exactly five two-decimal labels inside their verified range',()=>{
 for(const count of [3,5,7,8,16]){
  const anchors=Array.from({length:count},(_,i)=>({position:.04+.92*i/(count-1),value:3-6*i/(count-1)}));
  const before=structuredClone(anchors),ticks=nativeColorbarTicks(anchors);
  assert.equal(ticks.length,5);assert.deepEqual(anchors,before);
  assert.deepEqual(ticks[0],anchors[0]);assert.deepEqual(ticks[4],anchors.at(-1));
  for(const tick of ticks){assert.ok(Math.abs((tick.position-.04)/.92-(3-tick.value)/6)<1e-12);assert.match(formatScaleNumber(tick.value),/^-?\d+\.\d{2}$/);}
 }
 assert.deepEqual(nativeColorbarTicks([3,2,1,0,-1,-2,-3].map((value,i)=>({value,position:i/6}))).map(t=>t.value),[3,1.5,0,-1.5,-3]);
 assert.throws(()=>nativeColorbarTicks([]));assert.throws(()=>nativeColorbarTicks([{position:0,value:0},{position:1,value:NaN}]));
});

test('colorbar labels keep exactly two decimals without changing full-precision tick values',()=>{
 for(const [value,label] of [[0,'0.00'],[-.0001,'0.00'],[-.0172972972972973,'-0.02'],[5.906486486486487,'5.91'],[.006686117230731341,'0.01'],[2.2103349456384163e-12,'0.00'],[104,'104.00']] as const)assert.equal(formatScaleNumber(value),label);
 const ticks=colorbarTicks(-.0172972972972973,5.906486486486487,'log',1000);
 assert.equal(ticks[0].value,-.0172972972972973);assert.equal(ticks[4].value,5.906486486486487);
 assert.ok(ticks.every(tick=>/^-?\d+\.\d{2}$/.test(formatScaleNumber(tick.value))));
});

test('linear residual colorbar retains zero and both signed endpoints',()=>{
  assert.deepEqual(colorbarTicks(-3,3).map(tick=>tick.value),[-3,-1.5,0,1.5,3]);
});
test('Asinh tick values round-trip through the exact fixture generator stretch',()=>{
  const ticks=colorbarTicks(0,.93,'asinh',25);assert.equal(ticks.length,5);
  assert.equal(ticks[0].value,0);assert.equal(ticks[4].value,.93);
  for(const tick of ticks)assert.ok(Math.abs(Math.asinh(tick.value*25)/Math.asinh(25*.93)-tick.fraction)<1e-12);
  assert.ok(ticks[2].value<.2,'mid-color must not be mislabeled with the linear midpoint');
});
test('Log ticks invert Astropy LogStretch after normalization of a signed data range',()=>{
  const min=-.027944574426568117,max=1.1026510757211527;
  for(const tick of colorbarTicks(min,max,'log',1000)){
    const normalized=(tick.value-min)/(max-min);
    assert.ok(Math.abs(Math.log(1+1000*normalized)/Math.log(1001)-tick.fraction)<1e-12);
  }
});
test('constant-noise ticks preserve the true constant without fabricating a range',()=>{
  assert.deepEqual(colorbarTicks(.0065,.0065,'log',1000).map(tick=>tick.value),Array(5).fill(.0065));
  assert.throws(()=>colorbarTicks(1,0));assert.throws(()=>colorbarTicks(0,1,'asinh',0));
});
