import test from 'node:test';
import assert from 'node:assert/strict';
import { inputPositionContext, positionContextForTarget, positionDraftForInput } from '../src/lib/input-position-context.ts';
import { pointFromImage, positionError, positionPrompt, positionRequest, validStoredPositionDraft } from '../src/lib/position-likelihood.ts';
import type { InputDisplay } from '../src/lib/input-display.ts';
import type { PositionDraft } from '../src/lib/position-likelihood.ts';

const report={id:'reported-input',kind:'artifact' as const,stage:'preflight',path:'/run/input/input-provenance.json'};
const png='data:image/png;base64,iVBORw0KGgo=';
const display={rendered_from:'numeric-array',schema:'tinylens.input-display.v1',pixel_scale_arcsec:.05,x_direction:'increasing',y_direction:'decreasing',source:{provenance_path:report.path,provenance_sha256:'b'.repeat(64),fits_path:'/run/input/lens.fits',fits_sha256:'a'.repeat(64)},planes:[{id:'data',shape:[151,151],variants:{linear:{src:png},log:{src:png+'log'},asinh:{src:png+'asinh'},zscale:{src:png+'zscale'}}},{id:'noise',shape:[151,151],variants:{linear:{src:'wrong-noise'}}}]} as InputDisplay;
const draft:PositionDraft={points:[{id:'first',x:'1.8875',y:'1.8875'},{id:'second',x:'-1',y:'-.7'}],threshold:'.1',strength:'10000000000',inputFitsSha256:'a'.repeat(64)};

test('all display scales share the exact point coordinates, FITS identity and outgoing request',()=>{
 const original=structuredClone(draft),reference=inputPositionContext(display,report,'/fallback','linear');
 for(const scale of ['linear','log','asinh','zscale'] as const){
  const context=inputPositionContext(display,report,'/fallback',scale);
  assert.equal(context.image,display.planes[0].variants[scale]?.src);
  assert.deepEqual(context.frame,reference.frame);assert.deepEqual(context.source,reference.source);
  assert.deepEqual(positionRequest(draft,context),positionRequest(draft,reference));
 }
 assert.deepEqual(draft,original);
});

test('the old empty dataset default gains the real picker without relabeling existing points or a custom target',()=>{
 const context=inputPositionContext(display,report,'/broad/dataset');
 const empty={...draft,points:[],target:'/broad/dataset'};
 assert.equal(positionDraftForInput(empty,context,'/broad/dataset').target,undefined);assert.equal(empty.target,'/broad/dataset');
 const selected={...draft,target:'/broad/dataset'};assert.equal(positionDraftForInput(selected,context,'/broad/dataset'),selected);
 const custom={...empty,target:'/another/lens'};assert.equal(positionDraftForInput(custom,context,'/broad/dataset'),custom);
 assert.equal(positionDraftForInput(empty,{target:'/fallback',synthetic:false,stage:'preflight'},'/broad/dataset'),empty);
});

test('position picking uses the reported Data FITS preview and its native .05 arcsec calibration',()=>{
 const context=inputPositionContext(display,report,'/broad/dataset');
 assert.equal(context.target,'/run/input');assert.equal(context.image,png);assert.equal(context.synthetic,false);
 assert.deepEqual(context.frame,{shape:[151,151],pixelScale:.05,xDirection:'increasing',yDirection:'decreasing'});
 assert.deepEqual(pointFromImage(.75,.25,context.frame!),{x:1.8875,y:1.8875});
 assert.equal(positionError({...draft,points:[draft.points[0],{...draft.points[1],x:'3.76'}]},context.frame), '位置点必须位于图像范围内。');
});
test('live requests distinguish preview rows from canonical coordinates and carry hashes without embedding image bytes',()=>{
 const context=inputPositionContext(display,report,'/broad/dataset'),request=positionRequest(draft,context);
 assert.equal(request.coordinate_system.y_direction,'increasing');assert.equal(request.coordinate_system.array_frame,'canonical');
 assert.equal(request.coordinate_system.preview_frame?.y_direction,'decreasing');
 assert.equal(request.coordinate_system.preview,'/run/input/lens.fits#VIS_FLUX');assert.equal(request.source?.fits_sha256,'a'.repeat(64));
 assert.equal(request.source?.report_id,report.id);assert.deepEqual(request.position_likelihood.positions,[[1.8875,1.8875],[-1,-.7]]);
 const prompt=positionPrompt(draft,context);assert.equal(prompt.includes('data:image'),false);assert.equal(prompt.includes('/demo/'),false);assert.match(prompt,/不要直接覆盖已接受的 Stage A/);
});
test('missing input, an unrelated report, or a user-selected different target never borrows a calibrated image',()=>{
 assert.equal(inputPositionContext(undefined,report,'/fallback').image,undefined);
 assert.equal(inputPositionContext(display,{...report,path:'/another/input-provenance.json'},'/fallback').frame,undefined);
 const context=inputPositionContext(display,report,'/fallback');
 const manual=positionContextForTarget(context,'/another/lens');assert.equal(manual.target,'/another/lens');assert.equal(manual.image,undefined);assert.equal(manual.frame,undefined);assert.equal(manual.source,undefined);
 assert.throws(()=>positionRequest({...draft,target:'/another/lens'},context));
 assert.equal(positionRequest({...draft,target:'/another/lens'},manual).source,undefined);
});
test('old points cannot silently acquire a different FITS identity and bound drafts survive storage',()=>{
 const context=inputPositionContext(display,report,'/fallback');
 assert.equal(positionError(draft,context.frame,'a'.repeat(64)),null);
 assert.match(positionError(draft,context.frame,'c'.repeat(64))!,/输入图像已变化/);
 assert.throws(()=>positionRequest({...draft,inputFitsSha256:'c'.repeat(64)},context));
 assert.equal(validStoredPositionDraft(JSON.parse(JSON.stringify(draft))),true);
 assert.equal(validStoredPositionDraft({...draft,inputFitsSha256:'not-a-hash'}),false);
});
