import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { adaptDisplayEnvelope, DISPLAY_READER, reportedDisplay } from './agent-display.mjs';
import { STAGE_SCOPE_READER } from './stage-reports.mjs';

const base = WORKSPACE + '/output/run/lens/attempts/m3/0/';
const report = { id: 'display', threadId: 'session', kind: 'artifact', stage: 'm3', path: base + 'display-manifest.json' };
const state = { threadId: 'session', updates: [report] };
test('the display reader requires a canonical directory or declaration reported in the same thread and stage', () => {
  assert.equal(reportedDisplay(state, report.id).attempt, 0);
  for (const accepted of [
    { ...report, path: base + 'display' },
    { ...report, path: base + 'display/' },
    { ...report, path: base + 'stage-result.json', kind: 'stage' },
  ]) assert.equal(reportedDisplay({ ...state, updates: [accepted] }, report.id).attempt, 0);
  for (const change of [{ stage: 'm2' }, { threadId: 'other' }, { kind: 'note' },
    { path: base + 'display/StageM3_ModelImage.fits' }, { path: base + 'inspection.json' },
    { path: base + 'diagnostics/stage_m3_model.png' }, { path: base + '../0/display-manifest.json' },
    { path: '/somewhere/attempts/m3/0/display-manifest.json' }]) {
    assert.throws(() => reportedDisplay({ ...state, updates: [{ ...report, ...change }] }, report.id));
  }
});

test('the bridge routes an explicitly reported former run to its archive with its original version', () => {
  const runPath = `${WORKSPACE}/output/run/lens`;
  const scope = { schema: 'tinylens.stage-report.v1', run_id: 'old-run', run_path: runPath, lens_id: 'lens' };
  const old = { ...report, ...scope, kind: 'stage', status: 'accepted', attempt: 0,
    path: `${runPath}/accepted/m3.json`, display_manifest: report.path };
  const marker = { ...old, id: 'archive', kind: 'artifact', stage: 'preflight', attempt: null, display_manifest: undefined,
    path: `${WORKSPACE}/output/run/_archive/lens_old_0/run-manifest.json` };
  const next = { ...old, id: 'fresh', run_id: 'new-run' };
  const versions = { ...state, updates: [old, marker, next] };
  assert.equal(reportedDisplay(versions, old.id).storageRun, `${WORKSPACE}/output/run/_archive/lens_old_0`);
  assert.equal(reportedDisplay(versions, old.id).path, report.path);
  assert.equal(reportedDisplay(versions, next.id).storageRun, undefined);
  assert.equal(reportedDisplay(versions, next.id).runId, 'new-run');
});

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['-B', '-c', 'import astropy,numpy']).status === 0;
const fixture = [
  'import hashlib,json,pickle,shutil,sys',
  'from pathlib import Path',
  'from types import SimpleNamespace',
  'from astropy.io import fits',
  'import numpy as np',
  'from lens_agent.workbench_display import DISPLAY_REFERENCE,image_bounds,publish_display,record_prediction',
  'root=Path(sys.argv[1]); run=root/"output"/"test-run"/"lens"; lens=root/"input"/"lens"',
  'lens.mkdir(parents=True); preflight=run/"preflight"; preflight.mkdir(parents=True)',
  'raw=np.arange(1.,21.).reshape(4,5); raw[-1,0]=1000; rms=raw/2; psf=np.full((3,3),1/9)',
  'native=lens/"lens.fits"; flux_hdu=fits.ImageHDU(raw,name="VIS_FLUX"); flux_hdu.header["BUNIT"]="electron/s"',
  'fits.HDUList([fits.PrimaryHDU(),flux_hdu,fits.ImageHDU(rms,name="VIS_RMS"),fits.ImageHDU(psf,name="VIS_PSF")]).writeto(native)',
  'data=SimpleNamespace(lens_id="lens",fits_path=native,pixel_scale_arcsec=.1,image=raw[:,::-1],noise=rms[:,::-1],psf=psf[:,::-1])',
  'geometry=dict(pixel_scale_arcsec=.1,input_x_direction="decreasing",input_y_direction="increasing")',
  'def write(path, value): path.write_text(json.dumps(value))',
  'write(run/"run-manifest.json",dict(schema_version="lens_run_manifest.v1",run_id="first-run",lens_dir=str(lens),input_geometry=geometry,pipeline_release_id="source-reconstruction.v1"))',
  'write(preflight/"inspection.json",dict(schema_version="inspection_packet.v5",lens_id="lens",lens_dir=str(lens),image_shape=[4,5],input_geometry=geometry,display=DISPLAY_REFERENCE,segmentation_detection=dict(threshold_sigma=3,min_connected_pixels=5)))',
  'publish_display(run,preflight,"preflight",None,data)',
  'domain=np.zeros((4,5),dtype=np.uint8); domain[-1,-1]=1',
  'fits.writeto(preflight/"modeling_mask.fits",domain)',
  'stages=[("a",2),("a",0),("b",0),("m0",0),("m1",0),("m2",0),("m2",1),("m3",0)]; upstream={}',
  'for stage, attempt in stages:',
  ' folder=run/"attempts"/stage/str(attempt); artifacts=folder/"artifacts"; artifacts.mkdir(parents=True)',
  ' parents={name:path for name,path in upstream.items() if name!=stage}',
  ' capture=dict(planes={"source":np.arange(4.).reshape(2,2)},source_bounds=[-.3,.1,-.2,.2])',
  ' record_prediction(capture,data.image,data.noise,np.full((4,5),2.),np.full((4,5),float(attempt+1)))',
  ' if stage!="b":',
  '  theta=.15; model=dict(kind="epl-shear" if stage=="m3" else "sie-shear",theta_E=theta,e1_mass=0,e2_mass=0,center_x_mass=0,center_y_mass=0,gamma1=0,gamma2=0)',
  '  if stage=="m3": model["gamma"]=2',
  '  rays=[]; point=lambda x,y: dict(x=float(x),y=float(y))',
  '  for x,y in [(.21,.04),(-.2,.03),(.08,.13),(-.07,-.1),(.19,-.05)]:',
  '   det=1-theta/np.hypot(x,y); rays.append(dict(image=point(x,y),source=point(x*det,y*det),determinant=float(det)))',
  '  critical=[point(theta*np.cos(t),theta*np.sin(t)) for t in np.linspace(0,2*np.pi,17)]; critical[-1]=critical[0]',
  '  capture["mapping"]=dict(model=model,references=rays,curves=[dict(critical=critical,caustic=[point(0,0) for _ in critical],closed=True)],curve_sampling=dict(n_grid=512,bounds_arcsec=image_bounds(data.image.shape,data.pixel_scale_arcsec)))',
  ' if stage=="a": capture["linear_parameters"]={"source_mge_amplitudes":{"values":[1.25,.75]}}',
  ' if stage in ("m0","m2"): capture["mass_parameters"]={"theta_E":1.6}',
  ' summary=dict(lens_id="lens",stage=stage,attempt=attempt,status="success",metrics={},artifacts={},display=DISPLAY_REFERENCE)',
  ' if stage=="a":',
  '  summary["metrics"]["medians"]={key:value for key,value in model.items() if key!="kind"}',
  '  if attempt==0:',
  '   summary["artifacts"]["stage_pickle"]="artifacts/stage_a.pkl"',
  '   (artifacts/"stage_a.pkl").write_bytes(pickle.dumps({"extra": {"lens_light_model": np.full((4,5),2,dtype=np.float32), "input_geometry": dict(geometry,array_frame="canonical",x_direction="increasing",y_direction="increasing")}}))',
  '  if attempt==2: capture.pop("mapping")',
  ' if stage=="b":',
  '  mask=np.ones((4,5),dtype=np.uint8); mask[-1,0]=0; fits.writeto(artifacts/"feature_mask.fits",mask)',
  '  summary.update(metrics=dict(included_arc_pixels=1,masked_pixels=19),artifacts=dict(feature_mask_fits="artifacts/feature_mask.fits"))',
  ' else:',
  '  valid=domain==0 if stage=="a" else (mask==0)&(domain==0)',
  '  capture["valid_domain"]=valid',
  '  summary["metrics"]["residual_diagnostics"]={"pixel_count":int(valid.sum())}',
  ' if stage=="m0": summary["metrics"]["source_grid_spec"]=dict(schema_version="source_grid_spec.v1",nsrc=2,pixel_scale_arcsec=.2)',
  ' write(folder/"stage-result.json",summary); write(folder/"effective-config.json",dict(schema_version="lens_pipeline_config.v5",pipeline_release_id="source-reconstruction.v1",settings={**geometry,"arc_snr_threshold":3.5}))',
  ' if stage=="a" and attempt==0:',
  '  evidence={key:hashlib.sha256((folder/path).read_bytes()).hexdigest() for key,path in [("stage-result.json","stage-result.json"),("artifact:artifacts/stage_a.pkl","artifacts/stage_a.pkl")]}',
  '  write(folder/"decision.json",dict(schema_version="stage_decision.v1",stage="a",attempt=0,decision="accept",evidence_sha256=evidence))',
  ' if stage=="m0": posterior=dict(extra=dict(lambda_grid_coarse=[0,1],log_ev_coarse=[-2,-1],lambda_grid_fine=[.5,.6,.75,.9,1],log_ev_fine=[-1.5,-1.4,-np.inf,-1.1,-1],log_lambda_best=1))',
  ' else: posterior=dict(extra={},samples=[[0],[10],[20]],weights=[.05,.9,.05],param_names=["theta_E"])',
  ' publish_display(run,folder,stage,attempt,data,upstream=parents,capture=capture,domain_mask=domain.astype(bool),result=summary,posterior_payload=posterior)',
  ' upstream[stage]=artifacts',
  'missing=run/"attempts/a/1"; missing.mkdir(); summary=dict(lens_id="lens",stage="a",attempt=1,status="success",metrics={"medians":{"theta_E":1.5}},display=DISPLAY_REFERENCE)',
  'write(missing/"stage-result.json",summary); write(missing/"effective-config.json",dict(pipeline_release_id="source-reconstruction.v1",settings=geometry))',
  'publish_display(run,missing,"a",1,data,result=summary)',
  'accepted=run/"accepted"; accepted.mkdir(); write(accepted/"m2.json",{"attempt":0})',
  'write(accepted/"m3.json",dict(schema_version="accepted_stage_head.v1",stage="m3",accepted_attempt=0,attempt_path="../attempts/m3/0"))',
  'm3=run/"attempts/m3/0"; summary_sha=hashlib.sha256((m3/"stage-result.json").read_bytes()).hexdigest()',
  'write(m3/"decision.json",dict(schema_version="stage_decision.v1",stage="m3",attempt=0,decision="accept",evidence_sha256={"stage-result.json":summary_sha}))',
  'legacy=root/"output"/"legacy-run"/"lens"; pre=(legacy/"preflight"); pre.mkdir(parents=True)',
  '(legacy/"run-manifest.json").write_bytes((run/"run-manifest.json").read_bytes())',
  '(pre/"inspection.json").write_bytes((preflight/"inspection.json").read_bytes())',
  'manifest=json.loads((preflight/"display-manifest.json").read_bytes())',
  'previous=root/"output"/"previous-run"/"lens"; previous.mkdir(parents=True)',
  'shutil.copytree(preflight,previous/"preflight"); shutil.copyfile(run/"run-manifest.json",previous/"run-manifest.json")',
  'manifest.pop("parameters"); write(previous/"preflight/display-manifest.json",{**manifest,"schema":"tinylens.stage-display.v2","run":str(previous)})',
  'manifest.update(schema="tinylens.stage-display.v1",run=str(legacy)); hdus=[fits.PrimaryHDU()]',
  'names=dict(data="DATA",noise="RMS",psf="PSF",snr="SNR")',
  'for role, entry in manifest["planes"].items():',
  ' values, header=fits.getdata(preflight/entry.pop("path"),header=True); entry.pop("sha256")',
  ' entry["extension"]=names[role]; hdus.append(fits.ImageHDU(values,header=header,name=names[role]))',
  'fits.HDUList(hdus).writeto(pre/"display.fits")',
  'manifest["fits"]=dict(path="display.fits",sha256=hashlib.sha256((pre/"display.fits").read_bytes()).hexdigest())',
  'write(pre/"display-manifest.json",manifest)',
].join('\n');

test('named FITS and parameters round-trip every stage and bind M3 to the exact upstream M2 attempt', { skip: !available }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'tinylens-stage-display-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const run = join(root, 'output/test-run/lens');
  const env = { ...process.env, PYTHONPATH: fileURLToPath(new URL('../pipeline/src', import.meta.url)) };
  const prepared = spawnSync(python, ['-B', '-c', fixture, root], { encoding: 'utf8', env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const request = (stage, attempt, anchor = 'display') => ({ root, run, runId: 'first-run', stage, attempt,
    path: join(run, attempt === null ? 'preflight' : 'attempts/' + stage + '/' + attempt, anchor) });
  const read = spec => spawnSync(python, ['-B', '-c', DISPLAY_READER], { input: JSON.stringify(spec) + '\n', encoding: 'utf8' });
  const pack = spec => {
    const output = read(spec);
    assert.equal(output.status, 0, output.stderr);
    const envelope = JSON.parse(output.stdout);
    return { envelope, payload: adaptDisplayEnvelope(envelope, spec) };
  };

  const { payload: input } = pack(request('preflight', null));
  assert.deepEqual((await readdir(request('preflight', null).path)).sort(),
    ['DataPreview_DataImage.fits','DataPreview_NoiseImage.fits','DataPreview_PSFImage.fits','DataPreview_Parameters.json','DataPreview_SNRImage.fits']);
  assert.deepEqual(input.summary.config.settings, { detection_threshold: 3, minimum_connected_pixels: 5 });
  assert.equal(input.input.pixel_scale_arcsec, .1);
  assert.deepEqual(input.input.planes.map(p => p.id), ['data', 'noise', 'snr', 'psf']);
  const first = Buffer.from(input.input.planes[0].numeric.values_base64, 'base64').readDoubleLE();
  assert.equal(first, 20);
  assert.equal(pack(request('preflight', null, 'inspection.json')).payload.input.planes.length, 4);
  const legacy = join(root, 'output/legacy-run/lens');
  const {payload: legacyInput} = pack({...request('preflight', null), run:legacy, path:join(legacy,'preflight/display-manifest.json')});
  assert.deepEqual(legacyInput.input.planes.map(plane => plane.numeric), input.input.planes.map(plane => plane.numeric));
  const previous = join(root, 'output/previous-run/lens');
  const { payload: previousInput } = pack({ ...request('preflight', null), run: previous, path: join(previous, 'preflight/display') });
  assert.deepEqual(previousInput.input.planes.map(plane => plane.numeric), input.input.planes.map(plane => plane.numeric));
  const { payload: b } = pack(request('b', 0));
  assert.deepEqual((await readdir(request('b', 0).path)).sort(),
    ['StageB_ArcMask.fits','StageB_DataImage.fits','StageB_LensedSource.fits','StageB_Parameters.json','StageB_ValidDomain.fits']);
  assert.equal(b.summary.config.settings.arc_snr_threshold, 3.5);
  assert.equal(b.summary.result.metrics.included_arc_pixels, 1);
  assert.equal(b.posterior, undefined);
  assert.deepEqual(b.mask.shape, [4, 5]);
  assert.equal(Buffer.from(b.mask.included_base64, 'base64')[0], 1);
  assert.equal(Buffer.from(b.mask.domain_base64, 'base64')[4], 0);
  assert.equal(Buffer.from(b.mask.lensed_source_plane.values_base64, 'base64').readDoubleLE(), 1);
  for (const plane of [b.mask.plane, b.mask.lensed_source_plane]) {
    const pixels = Buffer.from(plane.mask_base64, 'base64');
    assert.equal(pixels[19], 0);
    assert.equal(pixels[15], 1);
    assert.equal(plane.array_y_direction, 'increasing');
  }

  for (const stage of ['a', 'm0', 'm1', 'm2', 'm3']) {
    const spec = request(stage, 0);
    const { envelope, payload } = pack(spec);
    const suffixes = ['ChiSquare.fits','DataImage.fits','LensLight.fits','LensMapping.json','LensedSource.fits','ModelImage.fits','NormalizedResidual.fits','Parameters.json','UnlensedSource.fits','ValidDomain.fits'];
    if (stage === 'a') suffixes.splice(2, 0, 'JointPosterior.json');
    assert.deepEqual((await readdir(spec.path)).sort(), suffixes.map(name=>'Stage'+stage.toUpperCase()+'_'+name));
    const mapping = payload.summary.display_mapping;
    assert.equal(mapping.schema, 'tinylens.lens-mapping.v2');
    assert.equal(mapping.mapping_source.path, join(spec.path, 'Stage'+stage.toUpperCase()+'_LensMapping.json'));
    assert.equal(mapping.frames.source.fits_sha256, envelope.manifest.planes.source.sha256);
    assert.deepEqual(mapping.curves, envelope.mapping_packet.curves);
    assert.equal(payload.summary.parameter_source.path, join(spec.path, 'Stage'+stage.toUpperCase()+'_Parameters.json'));
    assert.equal(payload.summary.parameter_source.sha256, payload.posterior.sha256);
    assert.equal(Object.values(payload.summary.planes).length, 7);
    assert.ok(Object.values(payload.summary.planes).every(p => p.src === '' && p.colormap_src === ''));
    const fitPixels = Buffer.from(Array.from({ length: 20 }, (_, i) => Number(stage === 'a' ? i !== 19 : i === 15)));
    for (const [name, plane] of Object.entries(payload.summary.planes)) {
      assert.deepEqual(Buffer.from(plane.mask_base64, 'base64'), name === 'source' ? Buffer.alloc(4, 1) : fitPixels);
      assert.equal(plane.mask_scope, name === 'source-lensed' ? 'likelihood-fit' : undefined);
    }
    const withoutDomain = {
      ...envelope, fits_files: { ...envelope.fits_files },
      manifest: { ...envelope.manifest, planes: { ...envelope.manifest.planes } },
    };
    delete withoutDomain.manifest.planes.domain;
    delete withoutDomain.fits_files.domain;
    const fullGrid = adaptDisplayEnvelope(withoutDomain, spec).summary.planes['source-lensed'];
    assert.equal(fullGrid.mask_scope, undefined);
    assert.deepEqual(Buffer.from(fullGrid.mask_base64, 'base64'), Buffer.alloc(20, 1));
    assert.equal(payload.summary.planes.observation.data_max, 20);
    assert.equal(payload.summary.planes.observation.data_min, stage === 'a' ? 1 : 20);
    assert.deepEqual(payload.summary.planes.source.bounds_arcsec, [-.3, .1, -.2, .2]);
    assert.equal(Buffer.from(payload.summary.planes.model.values_base64, 'base64').readDoubleLE(), 3);
    assert.equal(Buffer.from(payload.summary.planes['lens-light'].values_base64, 'base64').readDoubleLE(), 2);
    assert.equal(payload.posterior.kind, stage === 'm0' ? 'evidence_scan' : 'weighted_posterior');
    if (stage === 'a') {
      assert.deepEqual(payload.summary.linear_parameters.source_mge_amplitudes.values, [1.25, .75]);
      const parameter = payload.posterior.parameters[0];
      assert.ok(parameter.q16 < parameter.q50 && parameter.q50 < parameter.q84);
      assert.equal(parameter.error_minus, parameter.q50 - parameter.q16);
      assert.equal(parameter.error_plus, parameter.q84 - parameter.q50);
      assert.deepEqual(payload.posterior.quantile_levels, [.16, .5, .84]);
    } else assert.deepEqual(payload.summary.linear_parameters.source_brightness.shape, [2, 2]);
    if (stage === 'm0') {
      assert.deepEqual(payload.posterior.scan.fine.log_evidence, [-1.5, -1.4, null, -1.1, -1]);
      assert.equal(payload.summary.fixed_parameters.theta_E, 1.6);
    }
    if (stage === 'm3') assert.equal(envelope.manifest.upstream.find(ref => ref.stage === 'm2').attempt, 1);
  }

  const withoutImages = pack(request('a', 1)).payload;
  assert.equal(withoutImages.summary.planes, undefined);
  assert.equal(withoutImages.summary.result.metrics.medians.theta_E, 1.5);
  assert.equal(withoutImages.summary.display_mapping_from_parameters, undefined);

  const historicalA = request('a', 2);
  const { envelope: historical, payload: replayed } = pack(historicalA);
  assert.equal(replayed.summary.display_mapping, undefined);
  assert.equal(replayed.summary.display_mapping_from_parameters, true);
  const packet = historical.parameter_packet;
  const inconsistent = { ...packet, metrics: { medians: { ...packet.metrics.medians, gamma1: .2 } } };
  for (const parameter_packet of [undefined, inconsistent]) {
    const payload = adaptDisplayEnvelope({ ...historical, parameter_packet }, historicalA);
    assert.equal(payload.summary.display_mapping_from_parameters, undefined);
    assert.equal(Object.keys(payload.summary.planes).length, 7);
  }
  const namedA = request('a', 0);
  const withoutMappingPacket = { ...pack(namedA).envelope, mapping_packet: undefined };
  assert.equal(adaptDisplayEnvelope(withoutMappingPacket, namedA).summary.display_mapping_from_parameters, undefined);

  const m3 = request('m3', 0);
  await t.test('older attempts recover native lens light only from their verified Stage A array', async () => {
    const specs = [namedA, m3];
    const manifestPaths = specs.map(spec => join(spec.path, '..', 'display-manifest.json'));
    const originals = await Promise.all(manifestPaths.map(path => readFile(path)));
    const savedPath = join(namedA.path, '..', 'artifacts/stage_a.pkl');
    const saved = await readFile(savedPath);
    try {
      await Promise.all(manifestPaths.map((path, idx) => {
        const entries = JSON.parse(originals[idx]);
        delete entries.planes['lens-light'];
        return writeFile(path, JSON.stringify(entries));
      }));
      for (const spec of specs) {
        const {envelope, payload} = pack(spec);
        const light = payload.summary.planes['lens-light'];
        assert.equal(envelope.manifest.planes['lens-light'], undefined);
        assert.equal(Buffer.from(light.values_base64, 'base64').readDoubleLE(), 2);
        assert.equal(light.unit, payload.summary.planes.observation.unit);
        const wrong = Buffer.from(envelope.legacy_lens_light, 'base64');
        wrong.writeDoubleLE(5);
        assert.equal(adaptDisplayEnvelope({ ...envelope, legacy_lens_light: wrong.toString('base64') }, spec)
          .summary.planes['lens-light'], undefined);
      }
      await writeFile(savedPath, Buffer.concat([saved, Buffer.from('\n')]));
      for (const spec of specs) {
        const { payload } = pack(spec);
        assert.equal(payload.summary.planes['lens-light'], undefined);
        assert.ok(payload.summary.planes.model);
      }
    } finally {
      await Promise.all(manifestPaths.map((path, idx) => writeFile(path, originals[idx])));
      await writeFile(savedPath, saved);
    }
  });
  await t.test('model planes preserve verified FITS units and omit undeclared units', () => {
    const { payload } = pack(m3);
    const units = Object.fromEntries(Object.entries(payload.summary.planes).map(([name, plane]) => [name, plane.unit]));
    assert.deepEqual(units, {
      observation: 'electron/s', model: 'electron/s', 'lens-light': 'electron/s', 'source-lensed': 'electron/s',
      residual: '1', 'chi-square': '1', source: undefined,
    });
    assert.deepEqual(input.input.planes.map(plane => plane.unit), ['electron/s', undefined, '1', undefined]);
  });
  const readScope = attempt => spawnSync(python, ['-B', '-c', STAGE_SCOPE_READER, JSON.stringify({
    root, storage: run, lens_id: 'lens', stage: 'm3', accepted: true, attempt,
  })], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readScope(0).stdout), { run_id: 'first-run', attempt: 0 });
  assert.notEqual(readScope(1).status, 0);
  const m2 = join(run, 'attempts/m2/1/stage-result.json');
  const original = await readFile(m2);
  await writeFile(m2, Buffer.concat([original, Buffer.from('\n')]));
  const changed = read(m3);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /checksum mismatch/);
  await writeFile(m2, original);
  const { envelope } = pack(m3);
  assert.equal(adaptDisplayEnvelope({ ...envelope, summary: { ...envelope.summary,
    metrics: { residual_diagnostics: { pixel_count: 20 } } } }, m3).summary.planes, undefined);
  const frozenMask = join(run, 'preflight/modeling_mask.fits');
  const frozenMaskBytes = await readFile(frozenMask);
  await writeFile(frozenMask, Buffer.concat([frozenMaskBytes, Buffer.from('\n')]));
  assert.equal(pack(m3).payload.summary.planes, undefined);
  await writeFile(frozenMask, frozenMaskBytes);
  const mappingPath = join(m3.path, 'StageM3_LensMapping.json');
  const manifestPath = join(m3.path, '..', 'display-manifest.json');
  const mappingBytes = await readFile(mappingPath);
  const manifestBytes = await readFile(manifestPath);
  await writeFile(mappingPath, Buffer.concat([mappingBytes, Buffer.from('\n')]));
  const badMapping = pack(m3).payload;
  assert.equal(badMapping.summary.display_mapping, undefined);
  assert.equal(badMapping.summary.display_mapping_from_parameters, undefined);
  assert.equal(Object.keys(badMapping.summary.planes).length, 7);
  assert.equal(badMapping.posterior.kind, 'weighted_posterior');
  const otherAttempt = JSON.stringify({ ...JSON.parse(mappingBytes), attempt: 1 });
  const claims = JSON.parse(manifestBytes);
  claims.mapping_file.sha256 = createHash('sha256').update(otherAttempt).digest('hex');
  await writeFile(mappingPath, otherAttempt);
  await writeFile(manifestPath, JSON.stringify(claims));
  assert.equal(pack(m3).payload.summary.display_mapping, undefined);
  await writeFile(mappingPath, mappingBytes);
  await writeFile(manifestPath, manifestBytes);
  const legacyEnvelope = { ...envelope, manifest: { ...envelope.manifest,
    mapping: { model: envelope.mapping_packet.model, references: envelope.mapping_packet.references } } };
  delete legacyEnvelope.manifest.mapping_file;
  delete legacyEnvelope.mapping_packet;
  assert.equal(adaptDisplayEnvelope(legacyEnvelope, m3).summary.display_mapping.schema, 'tinylens.lens-mapping.v1');
  const renamed = join(m3.path, 'Unexpected.fits');
  const expected = join(m3.path, 'StageM3_ModelImage.fits');
  await rename(expected, renamed);
  const imagesMissing = pack(m3).payload;
  assert.equal(imagesMissing.summary.planes, undefined);
  assert.equal(imagesMissing.posterior.kind, 'weighted_posterior');
  await rename(renamed, expected);
  const lensLightPath = join(m3.path, 'StageM3_LensLight.fits');
  await rename(lensLightPath, renamed);
  try {
    const { summary } = pack(m3).payload;
    assert.equal(summary.planes['lens-light'], undefined);
    assert.ok(summary.planes.model);
  } finally {
    await rename(renamed, lensLightPath);
  }
  const parameterPath = join(m3.path, 'StageM3_Parameters.json');
  const parameterBytes = await readFile(parameterPath);
  await writeFile(parameterPath, Buffer.concat([parameterBytes, Buffer.from('\n')]));
  const parametersMissing = pack(m3).payload;
  assert.equal(Object.keys(parametersMissing.summary.planes).length, 7);
  assert.deepEqual(parametersMissing.summary.result.metrics, {});
  assert.equal(parametersMissing.summary.config.pipeline_release_id, 'source-reconstruction.v1');
  assert.equal(parametersMissing.posterior, undefined);
  await writeFile(parameterPath, parameterBytes);

  const m0 = request('m0', 0);
  const scanParameters = join(m0.path, 'StageM0_Parameters.json');
  const scanBytes = await readFile(scanParameters);
  await writeFile(scanParameters, Buffer.concat([scanBytes, Buffer.from('\n')]));
  const scanMissing = pack(m0).payload;
  assert.deepEqual(scanMissing.summary.result.metrics, {
    source_grid_spec: { schema_version: 'source_grid_spec.v1', nsrc: 2, pixel_scale_arcsec: .2 },
  });
  assert.equal(scanMissing.posterior, undefined);
  await writeFile(scanParameters, scanBytes);

  const configPath = join(m3.path, '..', 'effective-config.json');
  const configBytes = await readFile(configPath);
  const savedConfig = JSON.parse(configBytes);
  await writeFile(configPath, Buffer.concat([configBytes, Buffer.from('\n')]));
  const configMissing = pack(m3);
  assert.equal(configMissing.envelope.configuration, null);
  assert.equal(configMissing.payload.summary.config, undefined);
  assert.equal(Object.keys(configMissing.payload.summary.planes).length, 7);
  assert.equal(configMissing.payload.posterior.kind, 'weighted_posterior');
  const wrongRelease = JSON.stringify({ ...savedConfig, pipeline_release_id: 'input-geometry.v1' });
  const wrongConfigManifest = JSON.parse(manifestBytes);
  wrongConfigManifest.configuration.sha256 = createHash('sha256').update(wrongRelease).digest('hex');
  await writeFile(configPath, wrongRelease);
  await writeFile(manifestPath, JSON.stringify(wrongConfigManifest));
  assert.equal(pack(m3).payload.summary.config, undefined);
  await writeFile(configPath, configBytes);
  await writeFile(manifestPath, manifestBytes);
  const oldCachedEnvelope = { ...envelope };
  delete oldCachedEnvelope.configuration;
  assert.deepEqual(adaptDisplayEnvelope(oldCachedEnvelope, m3).summary.config, savedConfig);
  const declaration = pack(request('m3', 0, 'stage-result.json')).payload;
  assert.equal(declaration.summary.planes.model.values_sha256, pack(m3).payload.summary.planes.model.values_sha256);
  envelope.fits_files.model = Buffer.from('invalid data').toString('base64');
  assert.equal(adaptDisplayEnvelope(envelope, m3).summary.planes, undefined);

  const archived = join(root, 'output/test-run/_archive/lens_old_0');
  await mkdir(join(archived, '..'), { recursive: true });
  await rename(run, archived);
  const archivedSpec = { ...m3, runId: 'first-run', storageRun: archived };
  const moved = pack(archivedSpec).payload.summary;
  assert.equal(moved.planes.model.values_sha256, declaration.summary.planes.model.values_sha256);
  assert.deepEqual(moved.display_mapping.curves, declaration.summary.display_mapping.curves);
  assert.notEqual(read({ ...archivedSpec, runId: 'next-run' }).status, 0);
  assert.notEqual(read({ ...archivedSpec, runId: undefined }).status, 0);
});
