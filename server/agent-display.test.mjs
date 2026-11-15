import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { adaptDisplayEnvelope, DISPLAY_READER, reportedDisplay } from './agent-display.mjs';

const base = WORKSPACE + '/output/run/lens/attempts/m3/0/';
const report = { id: 'display', threadId: 'session', kind: 'artifact', stage: 'm3', path: base + 'display-manifest.json' };
const state = { threadId: 'session', updates: [report] };
test('the display reader requires a canonical manifest explicitly reported in this thread and stage', () => {
  assert.equal(reportedDisplay(state, report.id).attempt, 0);
  for (const change of [{ stage: 'm2' }, { threadId: 'other' }, { kind: 'note' },
    { path: base + 'diagnostics/stage_m3_model.png' }, { path: base + '../0/display-manifest.json' },
    { path: '/somewhere/attempts/m3/0/display-manifest.json' }]) {
    assert.throws(() => reportedDisplay({ ...state, updates: [{ ...report, ...change }] }, report.id));
  }
});

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['-B', '-c', 'import astropy,numpy']).status === 0;
const fixture = [
  'import json,sys',
  'from pathlib import Path',
  'from types import SimpleNamespace',
  'from astropy.io import fits',
  'import numpy as np',
  'from lens_agent.workbench_display import publish_display,record_prediction',
  'root=Path(sys.argv[1]); run=root/"output"/"test-run"/"lens"; lens=root/"input"/"lens"',
  'lens.mkdir(parents=True); preflight=run/"preflight"; preflight.mkdir(parents=True)',
  'raw=np.arange(1.,17.).reshape(4,4); rms=raw/2; psf=np.arange(1.,10.).reshape(3,3)/90',
  'native=lens/"lens.fits"; fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(raw,name="VIS_FLUX"),fits.ImageHDU(rms,name="VIS_RMS"),fits.ImageHDU(psf,name="VIS_PSF")]).writeto(native)',
  'data=SimpleNamespace(lens_id="lens",fits_path=native,pixel_scale_arcsec=.1,image=raw[:,::-1],noise=rms[:,::-1],psf=psf[:,::-1])',
  'geometry=dict(pixel_scale_arcsec=.1,input_x_direction="decreasing",input_y_direction="increasing")',
  'def write(path, value): path.write_text(json.dumps(value))',
  'write(run/"run-manifest.json",dict(schema_version="lens_run_manifest.v1",lens_dir=str(lens),input_geometry=geometry))',
  'write(preflight/"inspection.json",dict(schema_version="inspection_packet.v5",lens_id="lens",lens_dir=str(lens),image_shape=[4,4],input_geometry=geometry))',
  'publish_display(run,preflight,"preflight",None,data)',
  'domain=np.zeros((4,4),dtype=np.uint8); domain[-1,-1]=1',
  'fits.writeto(preflight/"modeling_mask.fits",domain)',
  'stages=[("a",0),("b",0),("m0",0),("m1",0),("m2",0),("m2",1),("m3",0)]; upstream={}',
  'for stage, attempt in stages:',
  ' folder=run/"attempts"/stage/str(attempt); artifacts=folder/"artifacts"; artifacts.mkdir(parents=True)',
  ' parents={name:path for name,path in upstream.items() if name!=stage}',
  ' capture=dict(planes={"source":np.arange(4.).reshape(2,2)},source_bounds=[-.3,.1,-.2,.2])',
  ' record_prediction(capture,data.image,data.noise,np.full((4,4),2.),np.full((4,4),float(attempt+1)))',
  ' summary=dict(lens_id="lens",stage=stage,attempt=attempt,status="success",metrics={},artifacts={})',
  ' if stage=="b":',
  '  mask=np.ones((4,4),dtype=np.uint8); mask[-1,0]=0; fits.writeto(artifacts/"feature_mask.fits",mask)',
  '  summary.update(metrics=dict(included_arc_pixels=1,masked_pixels=15),artifacts=dict(feature_mask_fits="artifacts/feature_mask.fits"))',
  ' write(folder/"stage-result.json",summary); write(folder/"effective-config.json",dict(settings=geometry))',
  ' if stage=="m0": posterior=dict(extra=dict(lambda_grid_coarse=[0,1],log_ev_coarse=[-2,-1],lambda_grid_fine=[.5,1],log_ev_fine=[-1.5,-1],log_lambda_best=1))',
  ' else: posterior=dict(extra={},samples=[[0],[10],[20]],weights=[.05,.9,.05],param_names=["theta_E"])',
  ' publish_display(run,folder,stage,attempt,data,upstream=parents,capture=capture,domain_mask=domain.astype(bool),result=summary,posterior_payload=posterior)',
  ' upstream[stage]=artifacts',
  'accepted=run/"accepted"; accepted.mkdir(); write(accepted/"m2.json",{"attempt":0})',
].join('\n');

test('fixed FITS packages round-trip every stage and bind M3 to M2/1 despite other M2 reports and heads', { skip: !available }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'tinylens-stage-display-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const run = join(root, 'output/test-run/lens');
  const env = { ...process.env, PYTHONPATH: fileURLToPath(new URL('../pipeline/src', import.meta.url)) };
  const prepared = spawnSync(python, ['-B', '-c', fixture, root], { encoding: 'utf8', env });
  assert.equal(prepared.status, 0, prepared.stderr);
  const request = (stage, attempt) => ({ root, run, stage, attempt,
    path: join(run, attempt === null ? 'preflight' : 'attempts/' + stage + '/' + attempt, 'display-manifest.json') });
  const read = spec => spawnSync(python, ['-B', '-c', DISPLAY_READER], { input: JSON.stringify(spec) + '\n', encoding: 'utf8' });
  const pack = spec => {
    const output = read(spec);
    assert.equal(output.status, 0, output.stderr);
    const envelope = JSON.parse(output.stdout);
    return { envelope, payload: adaptDisplayEnvelope(envelope, spec) };
  };

  const { payload: input } = pack(request('preflight', null));
  assert.equal(input.input.pixel_scale_arcsec, .1);
  assert.deepEqual(input.input.planes.map(p => p.id), ['data', 'noise', 'snr', 'psf']);
  const first = Buffer.from(input.input.planes[0].numeric.values_base64, 'base64').readDoubleLE();
  assert.equal(first, 16);
  const { payload: b } = pack(request('b', 0));
  assert.equal(Buffer.from(b.mask.included_base64, 'base64')[0], 1);
  assert.equal(Buffer.from(b.mask.domain_base64, 'base64')[3], 0);

  for (const stage of ['a', 'm0', 'm1', 'm2', 'm3']) {
    const spec = request(stage, 0);
    const { envelope, payload } = pack(spec);
    assert.equal(Object.values(payload.summary.planes).length, 6);
    assert.ok(Object.values(payload.summary.planes).every(p => p.src === '' && p.colormap_src === ''));
    assert.deepEqual(payload.summary.planes.source.bounds_arcsec, [-.3, .1, -.2, .2]);
    assert.equal(Buffer.from(payload.summary.planes.model.values_base64, 'base64').readDoubleLE(), 3);
    assert.equal(payload.posterior.kind, stage === 'm0' ? 'evidence_scan' : 'weighted_posterior');
    if (stage === 'm3') assert.equal(envelope.manifest.upstream.find(ref => ref.stage === 'm2').attempt, 1);
  }

  const m3 = request('m3', 0);
  const m2 = join(run, 'attempts/m2/1/stage-result.json');
  const original = await readFile(m2);
  await writeFile(m2, Buffer.concat([original, Buffer.from('\n')]));
  const changed = read(m3);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /checksum mismatch/);
  await writeFile(m2, original);
  const { envelope } = pack(m3);
  envelope.fits_base64 = Buffer.from('invalid data').toString('base64');
  assert.throws(() => adaptDisplayEnvelope(envelope, m3), /FITS checksum mismatch/);
});
