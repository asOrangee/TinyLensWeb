import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sieMapper,verifiedLiveMapping,verifiedResultMapping,type LiveMapping} from '../src/lib/live-mapping.ts';
import {screenToPlane,planeToScreen,isInside,type PlaneFrame} from '../src/lib/lens-mapping.ts';
import type { LivePlane, LiveResult } from '../src/lib/live-results.ts';
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

test('named mapping returns the stored paths and retains both exact hover directions', () => {
  const legacy = fixtures.a;
  const path = '/workspace/output/run/lens/attempts/a/0/display';
  const curves = [{ critical: [{ x: .12, y: .24 }, { x: .3, y: .4 }],
    caustic: [{ x: -.15, y: .02 }, { x: .2, y: -.1 }], closed: false }];
  const saved: LiveMapping = { ...legacy, path, run_id: 'original', schema: 'tinylens.lens-mapping.v2', curves,
    mapping_source: { path: path + '/StageA_LensMapping.json', sha256: 'a'.repeat(64) } };
  const sourceBinding = { ...binding(saved), runId: 'original', frames: saved.frames };
  const mapper = verifiedLiveMapping(saved, sourceBinding);
  assert.ok(mapper);
  assert.equal(mapper.criticalCurves(), curves);
  const image = saved.references[0].image;
  const source = mapper.sourceFor(image);
  assert.ok(mapper.imagesFor(source).some(candidate => Math.hypot(candidate.x - image.x, candidate.y - image.y) < 1e-6));
  assert.deepEqual(verifiedLiveMapping({ ...saved, curves: null }, sourceBinding)?.criticalCurves(), []);
  assert.deepEqual(verifiedLiveMapping({ ...saved, curves: [] }, sourceBinding)?.criticalCurves(), []);
  assert.equal(verifiedLiveMapping(saved, { ...sourceBinding, runId: 'rerun' }), null);
  assert.equal(verifiedLiveMapping(saved, { ...sourceBinding, frames: { ...saved.frames,
    source: { ...saved.frames.source, shape: [1, 2] } } }), null);
});

test('historical Stage A restores geometry from validated medians and calibrated FITS of the selected attempt', () => {
  const saved = fixtures.a;
  const directory = '/workspace/output/run/lens/attempts/a/0/display';
  const { kind, ...medians } = saved.model;
  const plane = (frame: PlaneFrame): LivePlane => ({
    ...frame, bounds_arcsec: frame.bounds_arcsec!, src: '', colormap_src: '', colormap: 'magma',
    vmin: 0, vmax: 1, data_min: 0, data_max: 1, stretch: 'linear', asinh_a: 1, input_fits_sha256: saved.fits_sha256,
  });
  const observation = plane(saved.frames.image);
  const source = plane(saved.frames.source);
  const result: LiveResult = {
    schema: 'tinylens.readonly-result.v1', kind: 'summary', stage: 'a', attempt: 0, path: directory,
    sha256: saved.summary_sha256, run_id: 'original', planes: { observation, source },
    result: { lens_id: 'lens', stage: 'a', attempt: 0, status: 'success', metrics: { medians } },
    parameter_contract: 'tinylens.stage-parameters.v1',
    parameter_source: { path: directory + '/StageA_Parameters.json', sha256: 'a'.repeat(64) },
    display_mapping_from_parameters: true,
  };
  const replay = verifiedResultMapping(result);
  assert.ok(replay);
  assert.ok(replay.criticalCurves().length > 0);
  assert.deepEqual(replay.frames.source.bounds_arcsec, saved.frames.source.bounds_arcsec);
  for (const ray of saved.references) {
    const beta = replay.sourceFor(ray.image);
    assert.ok(Math.hypot(beta.x - ray.source.x, beta.y - ray.source.y) < 1e-6);
  }
  const image = saved.references[0].image;
  assert.ok(replay.imagesFor(replay.sourceFor(image)).some(p => Math.hypot(p.x - image.x, p.y - image.y) < 1e-6));
  for (const change of [
    { display_mapping_from_parameters: undefined },
    { display_mapping: { ...saved, attempt: 1 } },
    { path: directory.replace('/a/0/', '/a/1/') },
    { parameter_source: { ...result.parameter_source!, path: directory.replace('/a/0/', '/a/1/') + '/StageA_Parameters.json' } },
    { planes: { observation, source: { ...source, input_fits_sha256: 'b'.repeat(64) } } },
    { result: { ...result.result!, metrics: { medians: { ...medians, gamma1: NaN } } } },
  ]) assert.equal(verifiedResultMapping({ ...result, ...change }), null);
});
