import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedResult, REMOTE_RESULT_READER, storeReportedResult, readReportedResult } from './agent-results.mjs';
import { WORKSPACE } from './agent-state.mjs';

const report = (path, options = {}) => ({ threadId: 'bound', updates: [{ id: 'id', threadId: 'bound', kind: 'artifact', stage: 'a', path, ...options }] });
test('verified responses survive a local display-service reload and remain bound to their reported thread',async t=>{
 const cacheDirectory=await mkdtemp(join(tmpdir(),'tinylens-result-cache-'));t.after(()=>rm(cacheDirectory,{recursive:true,force:true}));
 const path=WORKSPACE+'/output/run/lens/attempts/a/0/stage-result.json',state=report(path,{kind:'stage'});
 const value={schema:'tinylens.readonly-result.v1',kind:'summary',stage:'a',attempt:0,path,sha256:'a'.repeat(64)};
 await storeReportedResult(state,'id',value,{cacheDirectory});
 assert.deepEqual(await readReportedResult(state,'id',{cacheDirectory}),value);
 await assert.rejects(readReportedResult({...state,threadId:'other'},'id',{cacheDirectory}));
 await assert.rejects(storeReportedResult(state,'id',{...value,path:'/other'},{cacheDirectory}));
});
test('numeric reads require an explicit current-thread report with matching stage and attempt file', () => {
  const path = WORKSPACE + '/output/run/lens/attempts/a/0/artifacts/stage_a.pkl';
  assert.deepEqual(reportedResult(report(path), 'id'), { path, stage: 'a', attempt: 0, kind: 'posterior' });
  for (const candidate of [WORKSPACE + '/output/run/private.pkl', path.replace('stage_a', 'stage_m1'), '/tmp/stage_a.pkl', path.replace('/a/0/', '/a/../')]) assert.throws(() => reportedResult(report(candidate), 'id'));
  assert.throws(() => reportedResult(report(path, { stage: 'm1' }), 'id'));
  assert.throws(() => reportedResult(report(path, { threadId: 'other' }), 'id'));
  assert.throws(() => reportedResult(report(path, { kind: 'note' }), 'id'));
  assert.throws(() => reportedResult(report(path), 'unreported'));
  assert.equal(reportedResult(report(path.replace('artifacts/stage_a.pkl', 'stage-result.json'), { kind: 'stage' }), 'id').kind, 'summary');
});

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const numpyAvailable = spawnSync(python, ['-B', '-c', 'import numpy'], { encoding: 'utf8' }).status === 0;
test('preflight reads recorded detection settings and independent votes without inventing a mask radius or fit', {skip:!numpyAvailable},async t=>{
 const root=await mkdtemp(join(tmpdir(),'tinylens-preflight-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const run=join(root,'output','lens'),preflight=join(run,'preflight');await mkdir(join(preflight,'inspector-votes'),{recursive:true});
 const geometry={pixel_scale_arcsec:.05,input_x_direction:'increasing',input_y_direction:'decreasing'};
 const packet={schema_version:'inspection_packet.v5',lens_id:'lens',lens_dir:'/declared/input',input_geometry:geometry,segmentation_detection:{method:'single_threshold',threshold_sigma:7,min_connected_pixels:9}};
 await writeFile(join(run,'run-manifest.json'),JSON.stringify({schema_version:'lens_run_manifest.v1',lens_dir:'/declared/input',input_geometry:geometry}));
 await writeFile(join(preflight,'inspection.json'),JSON.stringify(packet));await writeFile(join(preflight,'inspector.json'),JSON.stringify({lens_id:'lens',disposition:'model'}));
 for(let i=0;i<3;i++)await writeFile(join(preflight,'inspector-votes',i+'.json'),JSON.stringify({lens_id:'lens',disposition:'model'}));
 const input={root,path:join(preflight,'inspector.json'),kind:'preflight',stage:'preflight',attempt:null};
 const read=()=>spawnSync(python,['-B','-c',REMOTE_RESULT_READER],{input:JSON.stringify(input)+'\n',encoding:'utf8'});
 let result=read();assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
 assert.deepEqual(value.config.settings,{detection_threshold:7,minimum_connected_pixels:9,inspector_count:3});assert.equal(value.config.settings.modeling_radius,undefined);assert.equal(value.result,undefined);assert.equal(value.parameters,undefined);
 packet.lens_dir='/different/input';await writeFile(join(preflight,'inspection.json'),JSON.stringify(packet));result=read();assert.notEqual(result.status,0);
 assert.equal(reportedResult(report(WORKSPACE+'/output/run/lens/preflight/inspector.json',{stage:'preflight',kind:'stage'}),'id').kind,'preflight');
 assert.throws(()=>reportedResult(report(WORKSPACE+'/output/run/lens/preflight/inspector.json',{stage:'a'}),'id'));
});
test('readonly reader preserves weighted non-Gaussian posteriors, M0 scans and result identity', { skip: !numpyAvailable }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinylens-numeric-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output'));
  const path = join(root, 'output', 'a.pkl');
  const fixture = `import pickle,numpy as np,sys
payload={'samples':np.array([[0.],[1.],[10.],[11.]]),'weights':np.array([.1,.1,.4,.4]),'param_names':['theta_E']}
with open(sys.argv[1],'wb') as f:pickle.dump(payload,f)
`;
  assert.equal(spawnSync(python, ['-B', '-c', fixture, path]).status, 0);
  const read = (file, stage = 'a', kind = 'posterior') => spawnSync(python, ['-B', '-c', REMOTE_RESULT_READER], { input: JSON.stringify({ root, path: file, stage, attempt: 0, kind }) + '\n', encoding: 'utf8' });
  let result = read(path);
  assert.equal(result.status, 0, result.stderr);
  const posterior = JSON.parse(result.stdout), parameter = posterior.parameters[0];
  assert.equal(posterior.sample_count, 4);
  assert.ok(Math.abs(posterior.effective_sample_size - 1 / .34) < 1e-12);
  assert.ok(Math.abs(parameter.q50 - 7.75) < 1e-12); // Weighted CDF, not unweighted median 5.5.
  assert.equal(parameter.density.length, 64);
  const area = parameter.density.reduce((sum, density, i) => sum + density * (parameter.edges[i + 1] - parameter.edges[i]), 0);
  assert.ok(Math.abs(area - parameter.shown_probability) < 1e-12);
  assert.ok(parameter.density.filter(value => value > 0).length < 8); // Keep the separated modes.
  const scan = join(root, 'output', 'm0.pkl');
  assert.equal(spawnSync(python, ['-B', '-c', `import sys,pickle,numpy as np
with open(sys.argv[1],'wb') as f:pickle.dump({'samples':None,'weights':None,'extra':{'lambda_grid_coarse':np.array([-2.,0.,2.]),'log_ev_coarse':np.array([1.,4.,2.]),'lambda_grid_fine':np.array([-.1,0.,.1]),'log_ev_fine':np.array([3.,4.,3.]),'log_lambda_best':0.}},f)
`, scan]).status, 0);
  result = read(scan, 'm0');
  assert.equal(result.status, 0, result.stderr);
  const m0 = JSON.parse(result.stdout);
  assert.equal(m0.kind, 'evidence_scan');
  assert.deepEqual(m0.scan.coarse.log_lambda, [-2, 0, 2]);
  assert.equal(m0.parameters, undefined);
  const summary = join(root, 'output', 'stage-result.json');
  await writeFile(summary, JSON.stringify({ stage: 'a', attempt: 1, lens_id: 'test', metrics: {} }));
  assert.notEqual(read(summary, 'a', 'summary').status, 0);
  const outside = join(root, 'outside.pkl');
  await writeFile(outside, 'not a pickle');
  await symlink(outside, join(root, 'output', 'escape.pkl'));
  assert.notEqual(read(join(root, 'output', 'escape.pkl')).status, 0);
  await symlink(path, join(root, 'output', 'other-attempt.pkl'));
  assert.notEqual(read(join(root, 'output', 'other-attempt.pkl')).status, 0);
});

test('restricted pickle reader rejects executable objects without running them', { skip: !numpyAvailable }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinylens-pickle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output'));
  const path = join(root, 'output', 'unsupported.pkl');
  // A built-in callable is rejected by find_class; it is never invoked.
  assert.equal(spawnSync(python, ['-B', '-c', 'import sys,pickle\nwith open(sys.argv[1],"wb") as f:pickle.dump(eval,f)', path]).status, 0);
  const result = spawnSync(python, ['-B', '-c', REMOTE_RESULT_READER], { input: JSON.stringify({ root, path, stage: 'a', attempt: 0, kind: 'posterior' }), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported pickle object/);
});
