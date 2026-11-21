import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { adaptDisplayEnvelope, DISPLAY_READER, DISPLAY_SCHEMA, reportedDisplay, serveReportedDisplay } from './agent-display.mjs';
import { WORKSPACE } from './agent-state.mjs';

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['--version']).status === 0;
const fixture = String.raw`
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
namespace = {"__name__": "inherited_configuration_reader"}
exec(compile(sys.argv[2], "read-stage-display.py", "exec"), namespace)
read_display = namespace["read_display"]
schema = sys.argv[3]
run = root / "output" / "new" / "lens"
source = root / "output" / "original" / "lens"
lens = root / "inputs" / "lens"
lens.mkdir(parents=True)
native = lens / "lens.fits"
native.write_bytes(b"deterministic frozen input")
source_id, run_id = "a" * 32, "b" * 32
old_release, release = "input-geometry.v1", "source-reconstruction.v1"
geometry = dict(pixel_scale_arcsec=.1, input_x_direction="increasing", input_y_direction="decreasing")

def write(path, packet):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(packet))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def ref(path, base):
    return {"path": path.relative_to(base).as_posix(), "sha256": digest(path)}

old_manifest = dict(schema_version="lens_run_manifest.v1", run_id=source_id, pipeline_release_id=old_release,
                    lens_dir=str(lens), input_geometry=geometry)
origin = run / "inherited-ab-source-manifest.json"
write(origin, old_manifest)
input_ref = dict(path=str(native), sha256=digest(native), pixel_scale_arcsec=.1)
inspection = run / "preflight/inspection.json"
write(inspection, dict(schema_version="inspection_packet.v5", lens_id="lens", lens_dir=str(lens),
                       input_geometry=geometry, image_shape=[10, 10]))
stages, upstream = {}, []
for stage, attempt in (("a", 0), ("b", 1)):
    relative = f"attempts/{stage}/{attempt}"
    folder = run / relative
    config = dict(schema_version="lens_pipeline_config.v5", pipeline_release_id=old_release,
                  parent_config=None if stage == "a" else "attempts/a/0/effective-config.json",
                  settings={**geometry, "stage_a_n_live": 240, "source_grid_level": 0})
    configuration = folder / "effective-config.json"
    write(configuration, config)
    summary = folder / "stage-result.json"
    write(summary, dict(lens_id="lens", stage=stage, attempt=attempt, status="success",
                        pipeline_release_id=old_release, eligible_for_review=True, gate_failures=[]))
    head = run / "accepted" / f"{stage}.json"
    write(head, dict(schema_version="accepted_stage_head.v1", stage=stage, accepted_attempt=attempt,
                     attempt_path=f"../{relative}", effective_config=f"../{relative}/effective-config.json"))
    decision = folder / "decision.json"
    write(decision, dict(schema_version="stage_decision.v1", stage=stage, attempt=attempt, decision="accept",
                         evidence_sha256={path.name: digest(path) for path in (configuration, summary)}))
    old_display = folder / "display-manifest.json"
    write(old_display, dict(schema=schema, run=str(source), run_id=source_id, stage=stage, attempt=attempt,
                            lens_id="lens", input=input_ref, configuration=ref(configuration, folder),
                            summary=ref(summary, folder), upstream=upstream[:],
                            run_manifest=dict(path="run-manifest.json", sha256=digest(origin))))
    stages[stage] = dict(attempt=attempt, head_sha256=digest(head), decision_sha256=digest(decision),
                         display_manifest_sha256=digest(old_display))
    upstream.append(dict(stage=stage, attempt=attempt, **ref(summary, run)))

receipt = run / "inherited-ab.json"
write(receipt, dict(schema_version="inherited_ab.v1", stages=stages,
                   source=dict(run=str(source), run_id=source_id, pipeline_release_id=old_release,
                               manifest_sha256=digest(origin)),
                   target=dict(run=str(run), run_id=run_id, pipeline_release_id=release),
                   input=dict(path=str(native), sha256=digest(native)), preflight={"inspection.json": digest(inspection)}))
manifest = {**old_manifest, "run_id": run_id, "pipeline_release_id": release,
            "inherited_ab": ref(receipt, run)}
manifest_path = run / "run-manifest.json"
m0 = run / "attempts/m0/0"
summary_m0 = m0 / "stage-result.json"
write(summary_m0, dict(lens_id="lens", stage="m0", attempt=0, status="success",
                       display=dict(schema=schema, path="display")))
configuration_m0 = m0 / "effective-config.json"
write(configuration_m0, dict(pipeline_release_id=release, settings=geometry))
display_path = m0 / "display-manifest.json"
display = dict(schema=schema, run=str(run), run_id=run_id, lens_id="lens", stage="m0", attempt=0,
               input=input_ref, upstream=upstream, summary=ref(summary_m0, m0),
               configuration=ref(configuration_m0, m0), planes={})

def publish(frozen, display_packet=display):
    write(manifest_path, frozen)
    write(display_path, {**display_packet, "run_manifest": ref(manifest_path, run)})

def read(**overrides):
    request = dict(root=str(root), run=str(run), runId=run_id, path=str(summary_m0),
                   stage="m0", attempt=0, view="inherited_configuration")
    return read_display({**request, **overrides})

def unavailable():
    result = read()
    assert result["summary"]["stage"] == "m0"
    assert "inherited_configuration" not in result

publish(manifest)
a_config = run / "attempts/a/0/effective-config.json"
inherited = read()["inherited_configuration"]
assert inherited["run_id"] == run_id
assert inherited["source_run_id"] == source_id
assert inherited["stage"] == "a" and inherited["attempt"] == 0
assert inherited["summary_sha256"] == upstream[0]["sha256"]
assert inherited["config"] == json.loads(a_config.read_bytes())
assert "inherited_configuration" not in read(view=None)

source_upstream = [dict(stage=stage, attempt=attempt, run_id=source_id, run_path=str(source))
                   for stage, attempt in (("preflight", None), ("a", 0), ("b", 1))]
assert read(view="history_lineage")["history_lineage"]["upstream"] == source_upstream
parent_paths = [run / "accepted/b.json", run / "attempts/b/1/decision.json", run / "attempts/b/1/display-manifest.json"]
for path in (*parent_paths, receipt, origin):
    prior = path.read_bytes()
    path.write_bytes(prior + b" ")
    assert read(view="history_lineage")["history_lineage"]["upstream"] == []
    path.write_bytes(prior)
prior = inspection.read_bytes()
inspection.write_bytes(prior + b" ")
assert read(view="history_lineage")["history_lineage"]["upstream"] == source_upstream[1:]
inspection.write_bytes(prior)

# Downstream stages belong to the new run; a corrupt A/B snapshot never relabels them.
m1 = run / "attempts/m1/0"
summary_m1 = m1 / "stage-result.json"
write(summary_m1, dict(lens_id="lens", stage="m1", attempt=0, status="success",
                       display=dict(schema=schema, path="display")))
write(m1 / "display-manifest.json", {**display, "stage": "m1", "summary": ref(summary_m1, m1),
      "run_manifest": ref(manifest_path, run), "upstream": upstream + [dict(stage="m0", attempt=0, **ref(summary_m0, run))]})
m1_params = dict(view="history_lineage", stage="m1", path=str(summary_m1))
own_m0 = dict(stage="m0", attempt=0, run_id=run_id, run_path=str(run))
assert read(**m1_params)["history_lineage"]["upstream"] == source_upstream + [own_m0]
prior = parent_paths[0].read_bytes()
parent_paths[0].write_bytes(prior + b" ")
assert read(**m1_params)["history_lineage"]["upstream"] == [own_m0]
parent_paths[0].write_bytes(prior)

# The explicitly archived target retains its original canonical identity in the graph.
archived = run.parent / "_archive/lens_old_0"
archived.parent.mkdir()
run.rename(archived)
assert read(storageRun=str(archived), **m1_params)["history_lineage"]["upstream"] == source_upstream + [own_m0]
archived.rename(run)

for overrides in (dict(runId=None), dict(runId=source_id), dict(path=str(a_config))):
    try:
        read(**overrides)
    except ValueError:
        pass
    else:
        raise AssertionError("Inheritance was exposed without a matching current display anchor")

publish({key: value for key, value in manifest.items() if key != "inherited_ab"})
unavailable()
publish(manifest)
for path in (receipt, a_config, origin):
    sealed = path.read_bytes()
    path.write_bytes(sealed + b" ")
    unavailable()
    path.write_bytes(sealed)

different_a = run / "attempts/a/1/stage-result.json"
write(different_a, dict(lens_id="lens", stage="a", attempt=1, status="success"))
other_upstream = [dict(stage="a", attempt=1, **ref(different_a, run)), upstream[1]]
publish(manifest, {**display, "upstream": other_upstream})
unavailable()
assert read(view="history_lineage")["history_lineage"]["upstream"] == []

# An ordinary, versioned run uses its own lineage. Preflight needs a sealed reference.
normal = {key: value for key, value in manifest.items() if key != "inherited_ab"}
normal_stages = []
for item in upstream:
    path = run / item["path"]
    write(path, {**json.loads(path.read_bytes()), "pipeline_release_id": release})
    normal_stages.append({**item, "sha256": digest(path)})
normal_display = {**display, "upstream": normal_stages}
publish(normal, normal_display)
same_run = [dict(stage=stage, attempt=attempt, run_id=run_id, run_path=str(run))
            for stage, attempt in (("preflight", None), ("a", 0), ("b", 1))]
assert read(view="history_lineage")["history_lineage"]["upstream"] == same_run[1:]
publish(normal, {**normal_display, "mask_sources": {"inspection.json": ref(inspection, run)}})
assert read(view="history_lineage")["history_lineage"]["upstream"] == same_run

# Old A/B displays have no mask-source index. Their run's unique P slot still
# supplies a predecessor when the two displays bind exactly the same inputs.
p_path = run / "preflight/display-manifest.json"
p_display = dict(schema=schema, run=str(run), run_id=run_id, lens_id="lens", stage="preflight", attempt=None,
                 input=input_ref, upstream=[], run_manifest=ref(manifest_path, run),
                 inspection=ref(inspection, inspection.parent), planes={})
write(p_path, p_display)
assert read(view="history_lineage")["history_lineage"]["upstream"] == same_run  # Explicit P reference still used by M0.

a_folder = run / "attempts/a/0"
a_summary = a_folder / "stage-result.json"
write(a_summary, {**json.loads(a_summary.read_bytes()), "display": dict(schema=schema, path="display")})
a_display = {**normal_display, "stage": "a", "upstream": [], "summary": ref(a_summary, a_folder),
             "run_manifest": ref(manifest_path, run)}
a_display_path = a_folder / "display-manifest.json"
write(a_display_path, a_display)
a_request = dict(view="history_lineage", stage="a", path=str(a_summary))
assert read(**a_request)["history_lineage"]["upstream"] == same_run[:1]

for wrong in (dict(run_id=source_id), dict(run=str(source)), dict(stage="a"), dict(lens_id="other"),
              dict(run_manifest=dict(path="run-manifest.json", sha256="0" * 64)),
              dict(input={**input_ref, "sha256": "0" * 64}), dict(input={**input_ref, "path": "/somewhere/lens.fits"}),
              dict(input={**input_ref, "pixel_scale_arcsec": .2}),
              dict(inspection=dict(path="inspection.json", sha256="0" * 64))):
    write(p_path, {**p_display, **wrong})
    assert read(**a_request)["history_lineage"]["upstream"] == []
write(p_path, p_display)
write(a_display_path, {**a_display, "mask_sources": {"inspection.json": {"path": "preflight/inspection.json", "sha256": "0" * 64}}})
assert read(**a_request)["history_lineage"]["upstream"] == []

for overrides in (dict(runId=None), dict(runId=source_id), dict(path=str(a_config)), dict(storageRun=str(source))):
    try:
        read(view="history_lineage", **overrides)
    except ValueError:
        pass
    else:
        raise AssertionError("History lineage was exposed outside a matching versioned display anchor")

valid = dict(root=str(root), run=str(run), runId=run_id, path=str(a_summary), stage="a", attempt=0,
             view="history_lineage")
write(a_display_path, a_display)
batch = namespace["read_history_batch"]([valid, {**valid, "runId": source_id}, {**valid, "view": "raw_artifacts"}, valid])
one, wrong, wrong_view, next_ok = batch["envelopes"]
assert wrong is None and wrong_view is None and one == next_ok
assert set(one) == {"manifest", "manifest_sha256", "history_lineage"}
assert "planes" not in one["manifest"] and one["history_lineage"]["upstream"] == same_run[:1]
`;

test('the display reader verifies inherited configuration and exact lineage from downstream anchors', {
  skip: !available && 'Python is required to run the display reader',
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tinylens-inherited-display-')));
  try {
    const result = spawnSync(python, ['-B', '-c', fixture, root, DISPLAY_READER, DISPLAY_SCHEMA], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only a versioned report can expose scoped history ancestor identities', () => {
  const run = WORKSPACE + '/output/child/lens';
  const source = WORKSPACE + '/output/source/lens';
  const path = run + '/attempts/m1/0/display-manifest.json';
  const report = { schema: 'tinylens.stage-report.v1', id: 'display-m1', threadId: 'thread', kind: 'artifact',
    run_path: run, run_id: 'child', lens_id: 'lens', stage: 'm1', attempt: 0, path };
  const state = { threadId: report.threadId, updates: [report] };
  const request = { ...reportedDisplay(state, report.id, 'history_lineage'), view: 'history_lineage' };
  const sha = 'a'.repeat(64);
  const upstream = [
    { stage: 'preflight', attempt: null, run_path: source, run_id: 'source' },
    { stage: 'a', attempt: 0, run_path: source, run_id: 'source' },
    { stage: 'b', attempt: 1, run_path: source, run_id: 'source' },
    { stage: 'm0', attempt: 0, run_path: run, run_id: 'child' },
  ];
  const manifest = { schema: DISPLAY_SCHEMA, run, run_id: 'child', stage: 'm1', attempt: 0,
    input: { path: '/fixture/lens.fits', sha256: sha, pixel_scale_arcsec: .1 }, upstream: upstream.slice(1) };
  const envelope = (entries) => ({ manifest, manifest_sha256: sha, history_lineage: { upstream: entries } });
  assert.deepEqual(adaptDisplayEnvelope(envelope(upstream), request), { schema: DISPLAY_SCHEMA, report_path: path,
    stage: 'm1', attempt: 0, run_id: 'child', history_lineage: { upstream } });
  const legacy = { id: report.id, threadId: report.threadId, kind: 'artifact', stage: 'm1', path };
  assert.throws(() => reportedDisplay({ ...state, updates: [legacy] }, report.id, 'history_lineage'));
  for (const forged of [
    [...upstream, upstream[3]], [...upstream].reverse(), upstream.slice(1, 2),
    [upstream[0], { ...upstream[1], run_path: '/other/source/lens' }, ...upstream.slice(2)],
    [{ ...upstream[0], attempt: 0 }, ...upstream.slice(1)],
    [upstream[0], upstream[1], { ...upstream[2], attempt: 2 }, upstream[3]],
    [...upstream.slice(0, 3), { ...upstream[3], run_path: source, run_id: 'source' }],
  ]) assert.throws(() => adaptDisplayEnvelope(envelope(forged), request));
});

test('a history batch uses one process, preserves archive scope and omits unavailable entries', async () => {
  const run = WORKSPACE + '/output/child/lens';
  const archived = WORKSPACE + '/output/child/_archive/lens_old_0';
  const threadId = 'history-batch-thread';
  const base = { schema: 'tinylens.stage-report.v1', threadId, kind: 'artifact', run_path: run,
    run_id: 'child', lens_id: 'lens', stage: 'm0', attempt: 0, path: run + '/attempts/m0/0/display-manifest.json' };
  const report = { ...base, id: 'valid' };
  const bad = { ...base, id: 'corrupt', stage: 'm1', path: run + '/attempts/m1/0/display-manifest.json' };
  const missing = { ...base, id: 'unavailable', stage: 'm2', path: run + '/attempts/m2/0/display-manifest.json' };
  const foreign = { ...base, id: 'foreign', threadId: 'another-thread' };
  const archive = { ...base, id: 'archive', stage: 'preflight', attempt: null, path: archived + '/run-manifest.json' };
  const state = { threadId, updates: [report, bad, missing, foreign, archive] };
  const sha = 'a'.repeat(64);
  const upstream = [{ stage: 'a', attempt: 0, run_id: 'child', run_path: run }];
  let processes = 0;
  let sent;
  let fail = false;
  const spawnProcess = () => {
    processes++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
    });
    child.stdin.once('data', data => {
      sent = JSON.parse(data);
      if (fail) { child.emit('close', 1); return; }
      const envelope = item => ({ manifest: { schema: DISPLAY_SCHEMA, run, run_id: 'child', stage: item.stage,
        attempt: item.attempt, input: { path: '/fixture/lens.fits', sha256: sha, pixel_scale_arcsec: .1 }, upstream },
      manifest_sha256: sha, history_lineage: { upstream } });
      const result = sent.historyLineageBatch
        ? { envelopes: [envelope(sent.historyLineageBatch[0]), envelope(sent.historyLineageBatch[0]), null] }
        : envelope(sent);
      child.stdout.end(JSON.stringify(result));
      child.emit('close', 0);
    });
    return child;
  };
  async function request(query) {
    let status, body;
    await serveReportedDisplay({ url: '/api/agent/display?' + query }, {
      writeHead(code) { status = code; }, end(data) { body = JSON.parse(data); },
    }, state, { spawnProcess });
    return { status, body };
  }
  const batchQuery = 'view=history_lineage&updateIds=valid,foreign,corrupt,unavailable,missing,%2Fpath,valid';
  const batch = await request(batchQuery);
  assert.equal(batch.status, 200);
  assert.deepEqual(Object.keys(batch.body.results), ['valid']);
  assert.equal(processes, 1);
  assert.deepEqual(sent.historyLineageBatch.map(({ stage, storageRun }) => [stage, storageRun]),
    [['m0', archived], ['m1', archived], ['m2', archived]]);
  const single = await request('view=history_lineage&updateId=valid');
  assert.deepEqual(single, { status: 200, body: batch.body.results.valid });
  assert.equal(processes, 2);
  assert.deepEqual(await request('view=history_lineage&updateIds=unknown,foreign'), { status: 200, body: { results: {} } });
  const tooMany = Array.from({ length: 33 }, (_, index) => 'id-' + index).join(',');
  for (const query of [
    `view=history_lineage&updateIds=${tooMany}`, 'view=history_lineage&updateIds=valid&updateId=valid',
    'view=history_lineage&updateIds=valid&x=gamma', 'view=joint_parameters&updateIds=valid',
  ]) assert.equal((await request(query)).status, 400);
  assert.equal(processes, 2);
  fail = true;
  assert.equal((await request(batchQuery)).status, 503);
  assert.equal(processes, 3);
});
