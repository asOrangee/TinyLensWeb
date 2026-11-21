import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {displayScalePixels,hasNumericRaster,imageScaleValues,lensedSourceFitPlane,maskOverlayPixels,numericPixels} from '../src/lib/image-scale.ts';
import type {LegacyFitDomain} from '../src/lib/live-results.ts';
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
test('full-grid result rendering uses saved excluded pixels while preserving fit-domain normalization',()=>{
 const values=[-.5,1.5,2.5,-12],mask=[0,1,1,0],shape=[2,2] as const;
 const limits={vmin:-3,vmax:3,stretch:'linear',parameter:1};
 const displayed=numericPixels(values,mask,shape,'increasing',limits,colors,undefined,true);
 const savedFull=numericPixels(values,[1,1,1,1],shape,'increasing',limits,colors);
 const fitted=numericPixels(values,mask,shape,'increasing',limits,colors);
 assert.deepEqual(displayed,savedFull);
 assert.deepEqual(Array.from(displayed.slice(8,12)),[106,106,106,255]);
 assert.deepEqual(Array.from(fitted.slice(8,12)),[0,0,0,0]);
 assert.deepEqual(displayScalePixels(values,mask,shape,'increasing'),[2.5,1.5]);
 assert.deepEqual(mask,[0,1,1,0]);
 assert.throws(()=>numericPixels(values,[0,1,1,2],shape,'increasing',limits,colors,undefined,true));
});
test('full observation scale and pixels are stable across different stage fitting masks', () => {
  const shape = [8, 8] as const;
  const values = Array.from({ length: 64 }, (_, i) => i / 30);
  const stageA = values.map(() => 1);
  const pixelized = values.map((_, i) => i % 8 >= 2 && i % 8 < 6 && i >= 16 && i < 48 ? 1 : 0);
  for (const scale of ['linear', 'log', 'asinh', 'zscale'] as const) {
    const fullPixels = displayScalePixels(values, undefined, shape, 'increasing');
    const limits = imageScaleValues(fullPixels, scale);
    const fitLimits = imageScaleValues(displayScalePixels(values, pixelized, shape, 'increasing'), scale);
    assert.notDeepEqual(fitLimits, limits);
    const first = numericPixels(values, stageA, shape, 'increasing', limits, colors, undefined, true);
    const later = numericPixels(values, pixelized, shape, 'increasing', limits, colors, undefined, true);
    assert.deepEqual(later, first);
  }
});
test('lensed source uses the full observation scale while drawing only fitted pixels', async () => {
  const mask = [1, 1, 1, 1, 0, 0];
  const values = [0, 1, 2, 3, 40, 80];
  const raw = Buffer.alloc(values.length * 8);
  values.forEach((value, i) => raw.writeDoubleLE(value, i * 8));
  const source = {
    ...numericalFixture([2, 3]),
    mask_base64: Buffer.from(mask).toString('base64'),
    values_base64: raw.toString('base64'),
    values_sha256: createHash('sha256').update(raw).digest('hex'),
  };
  const fitted = await lensedSourceFitPlane(source);
  const fitMask = Buffer.from(fitted.mask_base64, 'base64');
  for (const scale of ['linear', 'log', 'asinh', 'zscale'] as const) {
    const dataLimits = imageScaleValues([0, 40, 62, 83, 1_000, 2_000], scale);
    const sourceLimits = imageScaleValues(displayScalePixels(values, fitMask, fitted.shape, fitted.array_y_direction), scale);
    assert.ok(dataLimits.vmax > sourceLimits.vmax);
    const shown = numericPixels(values, fitMask, fitted.shape, fitted.array_y_direction, dataLimits, colors);
    const independentlyScaled = numericPixels(values, fitMask, fitted.shape, fitted.array_y_direction, sourceLimits, colors);
    assert.notDeepEqual(shown, independentlyScaled);
    assert.deepEqual([shown[7], shown[11]], [0, 0]);
    assert.deepEqual([shown[3], shown[15], shown[19], shown[23]], [255, 255, 255, 255]);
  }
});
test('historical model packets use their verified separate fit mask', async () => {
  const source = numericalFixture([2, 3]);
  const fit = Buffer.from([0, 1, 0, 1, 0, 0]);
  const legacyDomain: LegacyFitDomain = {
    schema: 'tinylens.model-display-derivation.v1',
    fit_support: 'actual_likelihood_mask',
    fit_mask_base64: fit.toString('base64'),
    fit_mask_sha256: createHash('sha256').update(fit).digest('hex'),
    statistics: { pixel_count: 2 },
  };
  const plane = await lensedSourceFitPlane(source, legacyDomain);
  assert.equal(plane.mask_base64, fit.toString('base64'));
  assert.equal(plane.values_base64, source.values_base64);
  assert.ok(Buffer.from(source.mask_base64, 'base64').every(pixel => pixel === 1));
  for (const change of [{ fit_mask_sha256: '0'.repeat(64) }, { statistics: { pixel_count: 3 } },
    { fit_mask_base64: Buffer.from([1, 2, 0]).toString('base64') }]) {
    await assert.rejects(lensedSourceFitPlane(source, { ...legacyDomain, ...change }),
      /Invalid lensed-source fit domain/);
  }
});
test('lensed source distinguishes an explicitly published full fit domain from unknown support', async () => {
  const source = numericalFixture();
  await assert.rejects(lensedSourceFitPlane(source), /Missing lensed-source fit domain/);
  const fullFit = { ...source, mask_scope: 'likelihood-fit' as const };
  assert.equal(await lensedSourceFitPlane(fullFit), fullFit);
});
test('selectable masks fill every excluded pixel white and leave kept pixels transparent', () => {
  const shape = [2, 3] as const;
  const excluded = [true, false, true, true, false, true];
  const expected = excluded.flatMap(pixel => pixel ? [255, 255, 255, 255] : [0, 0, 0, 0]);
  for (const polarity of [0, 1] as const) {
    const encoded = Buffer.from(excluded.map(pixel => pixel ? polarity : 1 - polarity)).toString('base64');
    assert.deepEqual(maskOverlayPixels(encoded, shape, polarity), new Uint8ClampedArray(expected));
  }

  const uniform = Buffer.alloc(6).toString('base64');
  assert.deepEqual(maskOverlayPixels(uniform, shape, 0), new Uint8ClampedArray(24).fill(255));
  assert.deepEqual(maskOverlayPixels(uniform, shape, 1), new Uint8ClampedArray(24));
  assert.equal(maskOverlayPixels(uniform, [2, 2], 1), undefined);
  assert.equal(maskOverlayPixels(Buffer.from([1, 2]).toString('base64'), [1, 2], 1), undefined);
});
test('a numerical image cannot render corrupted masks, nonfinite values, wrong shapes or invalid limits',()=>{
 const draw=(v:number[],m:number[],shape=[2,2],lo=0,hi=3)=>numericPixels(v,m,shape,'decreasing',{vmin:lo,vmax:hi,stretch:'linear',parameter:1},colors);
 assert.throws(()=>draw([1,NaN,2,3],[1,1,1,1]));assert.throws(()=>draw([0,1,2,3],[1,2,1,1]));assert.throws(()=>draw([0,1,2,3],[1,1,1,1],[1,1]));assert.throws(()=>draw([0,1,2,3],[1,1,1,1],[2,2],2,1));
});
