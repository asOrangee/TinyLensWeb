import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedInput, readReportedInput, serveReportedInput, REMOTE_INPUT_READER } from './agent-inputs.mjs';
import { numericalInput } from './numeric-payload.mjs';
import { WORKSPACE } from './agent-state.mjs';
import { connectionConfig } from './connection-config.mjs';

const path = WORKSPACE + '/output/run/lens/input-provenance.json';
const auditPath = WORKSPACE + '/output/run/lens/preflight/preflight_6panel.png';
const state = { threadId: 'thread', updates: [{ id: 'input', threadId: 'thread', kind: 'artifact', stage: 'preflight', path }] };
const hash = value => createHash('sha256').update(value).digest('hex');
// Transport fixtures only; never used by the live viewer.
const fits = Buffer.from('transport FITS fixture');
const envelope = () => ({ display: { schema: 'tinylens.input-display.v1', source: { report_path: path, provenance_path: path, provenance_sha256: hash('provenance'), fits_path: path.replace('input-provenance.json', 'input.fits'), fits_sha256: hash(fits) }, planes: ['data', 'noise', 'snr', 'psf'].map(id => ({ id, variants: { linear: { src: '', vmin: 0, vmax: 1 }, log: { src: '', vmin: 0, vmax: 1 }, zscale: { src: '', vmin: 0, vmax: 1 } } })) }, fits_base64: fits.toString('base64') });
function fakeSsh(payload, inspect = () => {}) {
  return (command, args) => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    let input = ''; proc.stdin.on('data', chunk => { input += chunk; });
    proc.stdin.on('finish', () => { inspect(command, args, JSON.parse(input)); proc.stdout.end(JSON.stringify(payload)); proc.emit('close', 0); });
    return proc;
  };
}
test('input access requires a canonical preflight artifact owned by the current thread', () => {
  assert.equal(reportedInput(state, 'input').path, path);
  for (const candidate of [auditPath, auditPath.replace('6panel', '2panel'), auditPath.replace('preflight_6panel.png', 'inspection.json')]) {
    assert.equal(reportedInput({ ...state, updates: [{ ...state.updates[0], path: candidate }] }, 'input').path, candidate);
  }
  for (const update of [{ ...state.updates[0], threadId: 'other' }, { ...state.updates[0], kind: 'note' }, { ...state.updates[0], stage: 'm1' }, { ...state.updates[0], path: '/tmp/input-provenance.json' }, { ...state.updates[0], path: WORKSPACE + '/output/../../input-provenance.json' }, { ...state.updates[0], path: auditPath.replace('/preflight/', '/diagnostics/') }]) assert.throws(() => reportedInput({ ...state, updates: [update] }, 'input'));
  assert.throws(() => reportedInput(state, 'missing'));
});
test('verified input bytes persist offline and corrupt FITS cache is never reused', async t => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'tinylens-input-'));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  let reads = 0;
  const spawnProcess = fakeSsh(envelope(), (command, args, input) => {
    reads++; assert.equal(command, 'ssh'); assert.ok(args.includes(connectionConfig.sshHost)); assert.equal(input.path, path);
    assert.equal(input.root, WORKSPACE); assert.equal(args.at(-1).includes(path), false); assert.match(args.at(-1), /CUDA_VISIBLE_DEVICES= /);
  });
  const first = await readReportedInput(state, 'input', { cacheDirectory, spawnProcess });
  assert.equal(first.cache.from_cache, false);
  const offline = () => { throw new Error('offline'); };
  const cached = await readReportedInput(state, 'input', { cacheDirectory, spawnProcess: offline });
  assert.equal(cached.cache.from_cache, true); assert.equal(cached.source.fits_sha256, hash(fits)); assert.equal(reads, 1);
  const stored = (await readdir(cacheDirectory)).find(file => file.endsWith('.fits'));
  await writeFile(join(cacheDirectory, stored), 'corrupted');
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: offline }), /offline/);
  await readReportedInput(state, 'input', { cacheDirectory, spawnProcess }); assert.equal(reads, 2);
  await assert.rejects(readReportedInput({ ...state, threadId: 'other' }, 'input', { cacheDirectory, spawnProcess: offline }));
});
test('an unrelated report, invalid range or wrong FITS checksum is never cached', async t => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'tinylens-input-'));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  const badFits = envelope(); badFits.fits_base64 = Buffer.from('different').toString('base64');
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: fakeSsh(badFits) }), /FITS checksum/);
  const wrongReport = envelope(); wrongReport.display.source.report_path = auditPath;
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: fakeSsh(wrongReport) }), /identity mismatch/);
  const badRange = envelope(); badRange.display.planes[0].variants.linear.vmax = -1;
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: fakeSsh(badRange) }), /input display range/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const astropy = spawnSync(python, ['-B', '-c', 'import astropy, numpy']).status === 0;
test('reported preflight audit reads its frozen Euclid-style FITS with the actual pixel orientation and RMS', { skip: !astropy }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tinylens-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const fixture = [
    'import sys,json,hashlib,numpy as np',
    'from pathlib import Path',
    'from astropy.io import fits',
    'root=Path(sys.argv[1]); run=root/"output"/"run"/"lens"; preflight=run/"preflight"; lens=root/"output"/"inputs"/"lens"',
    'lens.mkdir(parents=True); preflight.mkdir(parents=True)',
    'geometry=dict(pixel_scale_arcsec=.1,input_x_direction="decreasing",input_y_direction="increasing")',
    'path=lens/"lens.fits"',
    'header=fits.Header({"CTYPE1":"RA---TAN","CTYPE2":"DEC--TAN","CUNIT1":"deg","CUNIT2":"deg","CRPIX1":7240.,"CRPIX2":2769.,"CRVAL1":156.3,"CRVAL2":73.,"CDELT1":1.,"CDELT2":1.,"PC1_1":-.1/3600,"PC2_2":.1/3600,"CD1_1":-.1/3600,"CD2_2":.1/3600,"CD1_2":0.,"CD2_1":0.})',
    'data=np.arange(1,17,dtype=np.float32).reshape(4,4); noise=data/2+1; psf=np.arange(1,10,dtype=np.float32).reshape(3,3)/128',
    'fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(data,header=header,name="VIS_BGSUB"),fits.ImageHDU(noise,header=header,name="VIS_RMS"),fits.ImageHDU(psf,name="VIS_PSF"),fits.ImageHDU(data,header=header,name="VIS_FLUX")]).writeto(path)',
    'sha=lambda payload: hashlib.sha256(payload).hexdigest()',
    'with fits.open(path) as hdus:',
    ' checks={ext:dict(source_extension=orig,shape=list(hdus[orig].data.shape),dtype=str(hdus[orig].data.dtype),array_sha256=sha(hdus[orig].data.tobytes())) for ext,orig in [("VIS_FLUX","VIS_BGSUB"),("VIS_RMS","VIS_RMS"),("VIS_PSF","VIS_PSF")]}',
    '(lens/"input-provenance.json").write_text(json.dumps(dict(adapted_fits=str(path),adapted_sha256=sha(path.read_bytes()),input_geometry=geometry,aliases={"VIS_FLUX":"VIS_BGSUB"},checks=checks)))',
    '(run/"run-manifest.json").write_text(json.dumps(dict(schema_version="lens_run_manifest.v1",lens_dir=str(lens),input_geometry=geometry)))',
    'audit=preflight/"preflight_6panel.png";audit.write_bytes(bytes.fromhex("89504e470d0a1a0a"))',
    'frame=dict(origin="image_center",center_pixel_zero_based=[1.5,1.5],x_direction="increasing_with_column",y_direction="increasing_with_row",units="arcsec")',
    '(preflight/"inspection.json").write_text(json.dumps(dict(schema_version="inspection_packet.v5",lens_id="lens",lens_dir=str(lens),image_shape=[4,4],coordinate_frame=frame,input_geometry=geometry,artifacts={"human_audit_png":str(audit)})))'
  ].join('\n');
  const prepared = spawnSync(python, ['-B', '-c', fixture, root], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const report = join(root, 'output/run/lens/preflight/preflight_6panel.png');
  const inspection = join(root, 'output/run/lens/preflight/inspection.json');
  const provenance = join(root, 'output/inputs/lens/input-provenance.json');
  const read = path => spawnSync(python, ['-B', '-c', REMOTE_INPUT_READER], { input: JSON.stringify({ root, path }) + '\n', encoding: 'utf8' });
  const supported = read(report);
  assert.equal(supported.status, 0, supported.stderr);
  const { display, fits_base64 } = JSON.parse(supported.stdout);
  const payload = numericalInput(display, Buffer.from(fits_base64, 'base64'));
  assert.equal(payload.source.report_path, report);
  assert.equal(payload.source.provenance_path, provenance);
  assert.equal(payload.pixel_scale_arcsec, .1);
  assert.equal(payload.psf_sum, 45 / 128);
  assert.deepEqual(payload.planes[0].numeric.bounds_arcsec, [-.2, .2, -.2, .2]);
  const first = payload.planes.map(plane => Buffer.from(plane.numeric.values_base64, 'base64').readDoubleLE());
  assert.deepEqual(first, [16, 9, 16 / 9, 9 / 128]);

  const packet = JSON.parse(await readFile(inspection, 'utf8'));
  packet.artifacts.human_audit_png = report.replace('6panel', '2panel');
  await writeFile(inspection, JSON.stringify(packet));
  const rejected = read(report);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match the frozen preflight input/);
});
test('input route rejects arbitrary paths, duplicate reports and invalid refresh flags', async () => {
  for (const query of ['?path=/tmp/private.fits', '?updateId=input&updateId=input', '?updateId=input&refresh=0']) {
    let status, body;
    await serveReportedInput({ url: '/api/agent/input' + query }, { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } }, state, { spawnProcess() { assert.fail('must not read'); } });
    assert.equal(status, 404); assert.ok(body.error);
  }
});
