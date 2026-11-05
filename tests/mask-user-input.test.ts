import {numericalFixture} from './fixtures/numerical-plane.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {maskGrid} from '../src/lib/mask-grid.ts';
import {canonicalMaskRuns,encodeMaskDraft,maskDraftKey,maskPrompt,mergeMaskPrompt,parseMaskSource,restoreMaskDraft,type MaskSource} from '../src/lib/mask-user-input.ts';
const report={id:'b-report',kind:'artifact' as const,stage:'b',path:'/frozen/attempts/b/0/stage-result.json'},hash='a'.repeat(64);
const value={schema:'tinylens.mask-edit.v1',stage:'b',attempt:0,path:report.path,sha256:hash,mask_path:'/frozen/attempts/b/0/artifacts/mask.fits',mask_sha256:hash,domain_path:'/frozen/preflight/modeling_mask.fits',domain_sha256:hash,input_fits_sha256:hash,pixel_scale_arcsec:1,modeling_radius_arcsec:null,shape:[3,3],included:2,domain_pixels:6,included_base64:encodeMaskDraft([0,1,0,0,0,0,1,0,0]),domain_base64:encodeMaskDraft([0,1,0,1,1,1,1,1,0]),display_y_direction:'decreasing',plane:{...numericalFixture([3,3]),src:'',input_fits_sha256:hash,shape:[3,3],half_extent_arcsec:1.5}} as MaskSource;
test('real masks preserve asymmetrical valid domains, original resolution and included polarity',()=>{
 const source=parseMaskSource(value,report),grid=maskGrid(3,source.domain);assert.equal(grid.domainCount,6);assert.deepEqual(grid.cleanMask(Array(9).fill(1)),source.domain);assert.deepEqual(grid.translated(source.pixels,1,0),[0,0,0,0,0,0,0,1,0]);
 const enlarged=grid.morph(source.pixels,true);assert.ok(enlarged.reduce((a,b)=>a+b,0)>2);assert.ok(enlarged.every((v,i)=>v<=source.domain[i]));assert.deepEqual(grid.morph(source.pixels,false),Array(9).fill(0));
});
test('mask drafts flip display rows once into canonical RLE and never contain a FITS write command',()=>{
 assert.deepEqual(canonicalMaskRuns([0,1,0,0,0,0,1,0,0],3),[[0,1],[7,1]]);
 const source=parseMaskSource(value,report),next=[...source.pixels];next[4]=1;const text=maskPrompt(next,source,'thread','b-report'),request=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
 assert.equal(request.kind,'user_input');assert.equal(request.mask_kind,'arc_support');assert.equal(request.mask.included_pixel_count,3);assert.deepEqual(request.mask.runs,[[0,1],[4,1],[7,1]]);assert.equal(request.coordinate_system.y_direction,'increasing');assert.equal(request.mask.fits_exclusion_mask_included_value,0);assert.doesNotMatch(text,/run_stage|write_fits|system_prompt/);assert.equal(maskPrompt(source.pixels,source,'thread','b-report'),'');
});
test('stored drafts are bound to reports and reject malformed grids or out-of-domain pixels',()=>{
 const source=parseMaskSource(value,report);assert.deepEqual(restoreMaskDraft(encodeMaskDraft(source.pixels),source),source.pixels);assert.deepEqual(restoreMaskDraft('bad!',source),source.pixels);assert.deepEqual(restoreMaskDraft(encodeMaskDraft(Array(9).fill(1)),source),source.pixels);assert.notEqual(maskDraftKey(source,'one','id'),maskDraftKey(source,'two','id'));assert.notEqual(maskDraftKey(source,'one','id'),maskDraftKey({...source,input_fits_sha256:'b'.repeat(64)},'one','id'));
 for(const change of [{attempt:1},{shape:[96,96]},{included:3},{included_base64:encodeMaskDraft([1,1,0,0,0,0,1,0,0])},{plane:{...source.plane,input_fits_sha256:'b'.repeat(64)}}])assert.throws(()=>parseMaskSource({...value,...change},report));
});
test('mask feedback replaces only untouched generated text and retains ordinary handwritten messages',()=>{
 const old='[TinyLens mask edit]\nold\n[/TinyLens mask edit]',next=old.replace('old','next');assert.equal(mergeMaskPrompt('意见\n'+old,old,next),'意见\n'+next);assert.equal(mergeMaskPrompt('意见\n'+old,old,''),'意见\n');assert.equal(mergeMaskPrompt('新的意见',old,next),'新的意见\n\n'+next);assert.equal(mergeMaskPrompt(old.replace('old','my edit'),old,next),old.replace('old','my edit'));
});
