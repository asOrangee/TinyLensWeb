import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from './agent-state.mjs';
import { DISPLAY_READER, DISPLAY_SCHEMA, readReportedDisplay, serveReportedDisplay } from './agent-display.mjs';

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['-B', '-c', 'import astropy,numpy,PIL']).status === 0;
const getDistAvailable = spawnSync(python, ['-B', '-c', 'import getdist,contourpy']).status === 0;
const pipeline = fileURLToPath(new URL('../pipeline/src/', import.meta.url));
const fixture = String.raw`
import base64, hashlib, importlib.util, json, pickle, sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from astropy.io import fits
from PIL import Image

from lens_agent.workbench_display import DISPLAY_REFERENCE, publish_display, record_prediction

root = Path(sys.argv[1])
run = root / "output" / "run" / "lens"
lens = root / "input" / "lens"
lens.mkdir(parents=True)
preflight = run / "preflight"
preflight.mkdir(parents=True)
native = lens / "lens.fits"
shape = (3, 5)
data_values = np.arange(1, 16, dtype=float).reshape(shape)
noise = np.ones(shape)
psf = np.ones((1, 1))
fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(data_values, name="VIS_FLUX"),
              fits.ImageHDU(noise, name="VIS_RMS"), fits.ImageHDU(psf, name="VIS_PSF")]).writeto(native)
data = SimpleNamespace(lens_id="lens", fits_path=native, pixel_scale_arcsec=.5,
                       image=data_values, noise=noise, psf=psf)
geometry = dict(pixel_scale_arcsec=.5, input_x_direction="increasing", input_y_direction="increasing")

def write(path, content):
    path.write_text(json.dumps(content))

def read(stage, view, anchor, *, expected_error=False, **overrides):
    folder = preflight if stage == "preflight" else run / "attempts" / stage / "0"
    request = dict(root=str(root), run=str(run), runId="run-id", stage=stage,
                   attempt=None if stage == "preflight" else 0, path=str(folder / anchor), view=view)
    request.update(overrides)
    out = subprocess.run([sys.executable, "-B", "-c", READER], input=json.dumps(request),
                         text=True, capture_output=True)
    if expected_error:
        assert out.returncode != 0
        return None
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)

def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def array(value):
    return np.frombuffer(base64.b64decode(value), dtype=np.uint8).reshape(shape)

write(run / "run-manifest.json", dict(schema_version="lens_run_manifest.v1", run_id="run-id",
    lens_dir=str(lens), input_geometry=geometry))
header = fits.Header(dict(CDELT1=.5, CDELT2=.5, CRPIX1=3, CRPIX2=2, CRVAL1=0, CRVAL2=0,
                          CUNIT1="arcsec", CUNIT2="arcsec", INPXDIR="increasing", INPYDIR="increasing"))
labels = np.zeros(shape, dtype=np.int32)
labels[0, 0] = labels[1, 2] = 7
fits.writeto(preflight / "segmentation.fits", labels, header=header)
raw_preflight = preflight / "preflight_6panel.png"
prompt_preflight = preflight / "preflight_2panel.png"
Image.new("RGB", (5, 3), "blue").save(raw_preflight)
Image.new("RGB", (5, 3), "green").save(prompt_preflight)
write(preflight / "inspection.json", dict(schema_version="inspection_packet.v5", lens_id="lens",
    lens_dir=str(lens), image_shape=shape, input_geometry=geometry, display=DISPLAY_REFERENCE,
    artifacts={"human_audit_png": str(raw_preflight), "inspector_prompt_png": str(prompt_preflight),
               "segmentation_fits": str(preflight / "segmentation.fits")}))
publish_display(run, preflight, "preflight", None, data)
write(preflight / "inspector.json", dict(lens_id="lens", disposition="model", contaminant_ids=[7]))
yy, xx = np.indices(shape)
aperture = np.hypot(xx - 2, yy - 1) <= 2
contamination = labels == 7
modeling = ~aperture | contamination
header["MODELRAD"] = 1.0
fits.writeto(preflight / "modeling_mask.fits", modeling.astype(np.uint8), header=header)

a = run / "attempts/a/0"
(a / "diagnostics").mkdir(parents=True)
(a / "artifacts").mkdir()
model_path = "diagnostics/stage_a_model.png"
sample_path = "artifacts/stage_a.pkl"
Image.new("RGB", (5, 3), "pink").save(a / model_path)
saved = dict(param_names=["theta_E", "gamma1"], samples=np.array([[.1, 8], [.2, 5], [.3, 4]]),
             weights=np.array([1, 2, 3]))
(a / sample_path).write_bytes(pickle.dumps(saved, protocol=5))
summary = dict(lens_id="lens", stage="a", attempt=0, status="success", display=DISPLAY_REFERENCE,
               metrics={}, artifacts=dict(stage_pickle=sample_path, model_png=model_path))
write(a / "stage-result.json", summary)
write(a / "effective-config.json", dict(settings=geometry))
capture = dict(planes={"source": np.ones((2, 2))}, source_bounds=[-.5, .5, -.5, .5])
record_prediction(capture, data_values, noise, noise, noise, valid=~modeling)
publish_display(run, a, "a", 0, data, capture=capture, domain_mask=modeling,
                result=summary, posterior_payload=saved)

b = run / "attempts/b/0"
(b / "artifacts").mkdir(parents=True)
arc = np.zeros(shape, dtype=bool)
arc[0, 2] = True
fits.writeto(b / "artifacts/feature_mask.fits", (~arc).astype(np.uint8), header=header)
summary_b = dict(lens_id="lens", stage="b", attempt=0, status="success", display=DISPLAY_REFERENCE,
                 metrics=dict(included_arc_pixels=1, masked_pixels=14),
                 artifacts={"feature_mask_fits": "artifacts/feature_mask.fits"})
write(b / "stage-result.json", summary_b)
write(b / "effective-config.json", dict(settings=geometry))
publish_display(run, b, "b", 0, data, upstream={"a": a / "artifacts"},
                domain_mask=modeling, result=summary_b)

pre = read("preflight", "raw_artifacts", "inspection.json")
assert [item["name"] for item in pre["raw_artifacts"]] == [raw_preflight.name, prompt_preflight.name]
assert base64.b64decode(pre["raw_artifacts"][0]["src"].split(",", 1)[1]) == raw_preflight.read_bytes()
assert "fits_files" not in pre
def raw_names(result):
    return [item["name"] for item in result.get("raw_artifacts", [])]

assert raw_names(read("preflight", "raw_artifacts", prompt_preflight.name, legacyRaw=True)) == [prompt_preflight.name]
pre_manifest_path = preflight / "display-manifest.json"
pre_manifest_bytes = pre_manifest_path.read_bytes()
pre_manifest = json.loads(pre_manifest_bytes)
unsigned_index = {key: value for key, value in pre_manifest.items() if key != "raw_artifacts"}
write(pre_manifest_path, unsigned_index)
assert read("preflight", "raw_artifacts", "inspection.json")["raw_artifacts"] == pre["raw_artifacts"]
pre_manifest_path.write_bytes(pre_manifest_bytes)
original_prompt = prompt_preflight.read_bytes()
Image.new("RGB", (5, 3), "red").save(prompt_preflight)
assert raw_names(read("preflight", "raw_artifacts", "inspection.json", legacyRaw=True)) == [raw_preflight.name]
prompt_preflight.write_bytes(original_prompt)
pre_manifest_path.unlink()
read("preflight", "raw_artifacts", "inspection.json", expected_error=True, legacyRaw=True)
pre_manifest_path.write_bytes(pre_manifest_bytes)

# Old reports and their declared PNGs can be inspected even when no display
# package was published. Each direct report grants access to only that image.
old_run = root / "output" / "old-preflight" / "lens"
old_pre = old_run / "preflight"
old_pre.mkdir(parents=True)
old_manifest = dict(schema_version="lens_run_manifest.v1", lens_dir=str(lens), input_geometry=geometry)
write(old_run / "run-manifest.json", old_manifest)
old_packet = dict(schema_version="inspection_packet.v5", lens_id="lens", lens_dir=str(lens), image_shape=shape,
                  input_geometry=geometry, artifacts={"human_audit_png": str(old_pre / raw_preflight.name),
                     "inspector_prompt_png": str(old_pre / prompt_preflight.name)})
write(old_pre / "inspection.json", old_packet)
(old_pre / raw_preflight.name).write_bytes(raw_preflight.read_bytes())
(old_pre / prompt_preflight.name).write_bytes(prompt_preflight.read_bytes())

def old_raw(anchor, expected_error=False, **options):
    scope = dict(run=str(old_run), runId=None, legacyRaw=True, path=str(old_pre / anchor))
    return read("preflight", "raw_artifacts", anchor, expected_error=expected_error, **{**scope, **options})

direct = old_raw(raw_preflight.name)
assert raw_names(direct) == [raw_preflight.name]
assert direct["legacy_raw_scope"]["run"] == str(old_run)
assert direct["legacy_raw_scope"]["inspection_sha256"] == file_hash(old_pre / "inspection.json")
assert direct["legacy_raw_scope"]["run_sha256"] == file_hash(old_run / "run-manifest.json")
assert raw_names(old_raw("inspection.json")) == [raw_preflight.name, prompt_preflight.name]
old_raw(raw_preflight.name, expected_error=True, legacyRaw=False)
old_raw(raw_preflight.name, expected_error=True, manifestSha256="a" * 64)
old_raw("inspector.json", expected_error=True)
old_prompt = old_pre / prompt_preflight.name
old_prompt.unlink()
old_prompt.symlink_to(prompt_preflight)
assert raw_names(old_raw(prompt_preflight.name)) == []
assert raw_names(old_raw("inspection.json")) == [raw_preflight.name]
old_prompt.unlink()
old_prompt.write_bytes(original_prompt)
write(old_pre / "inspection.json", {**old_packet, "input_geometry": {**geometry, "pixel_scale_arcsec": .25}})
old_raw(raw_preflight.name, expected_error=True)
write(old_pre / "inspection.json", old_packet)

write(old_run / "run-manifest.json", {**old_manifest, "run_id": "archived-run"})
archive = old_run.parent / "_archive/lens_old_0"
archive.parent.mkdir()
old_run.rename(archive)
archived = old_raw(prompt_preflight.name, runId="archived-run", storageRun=str(archive))
assert archived["legacy_raw_scope"]["run_id"] == "archived-run"
assert raw_names(archived) == [prompt_preflight.name]
old_raw(prompt_preflight.name, expected_error=True, runId="different", storageRun=str(archive))
old_raw(prompt_preflight.name, expected_error=True, runId="archived-run", run=str(archive),
        path=str(archive / "preflight" / prompt_preflight.name))

assert read("a", "raw_artifacts", "display-manifest.json")["raw_artifacts"][0]["name"] == "stage_a_model.png"
layers = read("b", "mask_layers", "stage-result.json")["mask_layers"]
assert layers["shape"] == list(shape) and layers["array_y_direction"] == "decreasing"
assert np.array_equal(array(layers["aperture"]), aperture[::-1])
assert np.array_equal(array(layers["contamination"]), contamination[::-1])
assert np.array_equal(array(layers["arc"]), arc[::-1])
layers_a = read("a", "mask_layers", "display")["mask_layers"]
assert set(layers_a) == {"shape", "bounds_arcsec", "array_y_direction", "aperture", "contamination"}
assert np.array_equal(array(layers_a["aperture"]), aperture[::-1])
assert np.array_equal(array(layers_a["contamination"]), contamination[::-1])

manifest_b_path = b / "display-manifest.json"
manifest_b = json.loads(manifest_b_path.read_bytes())
refs = manifest_b["mask_layers"]
assert set(refs) == {"aperture", "contamination", "arc"}
assert refs["arc"] == {key: manifest_b["planes"]["mask"][key] for key in ("path", "sha256")}
assert refs["aperture"]["path"] == "display/StageB_ApertureMask.fits"
assert refs["contamination"]["path"] == "display/StageB_ContaminationMask.fits"
for ref in refs.values():
    assert ref["sha256"] == file_hash(b / ref["path"])

# Historical packages had no named mask files; keep the explicit old sources
# in this fixture when testing that a failed fixed layer cannot fall back.
legacy_b = {key: value for key, value in manifest_b.items() if key != "mask_layers"}
legacy_b["mask_sources"] = {name: {"path": f"preflight/{name}", "sha256": file_hash(preflight / name)}
    for name in ("inspection.json", "inspector.json", "segmentation.fits", "modeling_mask.fits")}
write(manifest_b_path, legacy_b)
assert read("b", "mask_layers", "stage-result.json")["mask_layers"] == layers
with_both = {**legacy_b, "mask_layers": refs}
write(manifest_b_path, with_both)

fixed_contamination = b / refs["contamination"]["path"]
original_contamination = fixed_contamination.read_bytes()
fixed_contamination.write_bytes(b"invalid checksum")
assert read("b", "mask_layers", "stage-result.json")["mask_layers"] == {
    key: value for key, value in layers.items() if key != "contamination"}
fixed_contamination.write_bytes(original_contamination)

wrong_path = {**refs, "contamination": {"path": refs["aperture"]["path"], "sha256": refs["aperture"]["sha256"]}}
write(manifest_b_path, {**with_both, "mask_layers": wrong_path})
assert "contamination" not in read("b", "mask_layers", "stage-result.json")["mask_layers"]
write(manifest_b_path, {**with_both, "mask_layers": {}})
assert read("b", "mask_layers", "stage-result.json").get("mask_layers") is None

with fits.open(fixed_contamination) as hdus:
    layer_header = hdus[0].header.copy()
wrong_frame = layer_header.copy()
wrong_frame["CRVAL2"] += .5
fits.writeto(fixed_contamination, contamination.astype(np.uint8), header=wrong_frame, overwrite=True)
wrong_calibration = {**refs, "contamination": {**refs["contamination"], "sha256": file_hash(fixed_contamination)}}
write(manifest_b_path, {**with_both, "mask_layers": wrong_calibration})
assert read("b", "mask_layers", "stage-result.json")["mask_layers"] == {
    key: value for key, value in layers.items() if key != "contamination"}
fits.writeto(fixed_contamination, 2 * contamination.astype(np.uint8), header=layer_header, overwrite=True)
wrong_encoding = {**refs, "contamination": {**refs["contamination"], "sha256": file_hash(fixed_contamination)}}
write(manifest_b_path, {**with_both, "mask_layers": wrong_encoding})
assert "contamination" not in read("b", "mask_layers", "stage-result.json")["mask_layers"]
fixed_contamination.write_bytes(original_contamination)
write(manifest_b_path, manifest_b)

m0 = run / "attempts/m0/0"
m0.mkdir(parents=True)
summary_m0 = dict(lens_id="lens", stage="m0", attempt=0, status="success", display=DISPLAY_REFERENCE,
                  metrics={}, artifacts={})
write(m0 / "stage-result.json", summary_m0)
write(m0 / "effective-config.json", dict(settings=geometry))
record_prediction(capture, data_values, noise, noise, noise, valid=arc)
publish_display(run, m0, "m0", 0, data, upstream={"a": a / "artifacts", "b": b / "artifacts"},
                capture=capture, domain_mask=modeling, result=summary_m0)
manifest_m0 = json.loads((m0 / "display-manifest.json").read_bytes())
assert manifest_m0["mask_layers"]["arc"]["path"] == "display/StageM0_ArcMask.fits"
for obsolete in (preflight / "segmentation.fits", preflight / "inspector.json", preflight / "modeling_mask.fits",
                 b / "artifacts/feature_mask.fits"):
    obsolete.unlink()
assert read("m0", "mask_layers", "stage-result.json")["mask_layers"] == layers
m0_observation = m0 / manifest_m0["planes"]["observation"]["path"]
m0_observation.write_bytes(b"invalid observation checksum")
assert read("m0", "mask_layers", "stage-result.json").get("mask_layers") is None

assert "joint_posterior" not in read("b", "joint_posterior", "stage-result.json")
joint = read("a", "joint_posterior", "stage-result.json")["joint_posterior"]
assert joint["names"] == saved["param_names"] and joint["samples"] == saved["samples"].tolist()
np.testing.assert_allclose(joint["weights"], saved["weights"] / 6)
assert read("a", "joint_parameters", "stage-result.json")["joint_parameters"] == {"names": joint["names"], "sample_count": 3}
if importlib.util.find_spec("getdist") is None:
    assert "joint_density" not in read("a", "joint_density", "stage-result.json", x="theta_E", y="gamma1")

manifest_path = a / "display-manifest.json"
manifest = json.loads(manifest_path.read_bytes())
joint_path = a / "display/StageA_JointPosterior.json"
joint_file = json.loads(joint_path.read_bytes())
assert joint_file["schema"] == "tinylens.stage-joint-posterior.v1"
assert joint_file["run_id"] == "run-id" and joint_file["attempt"] == 0
assert joint_file["source_sha256"] == file_hash(a / sample_path)
assert manifest["joint_posterior"] == {"path": "display/StageA_JointPosterior.json", "sha256": file_hash(joint_path)}
joint_path.write_bytes(b"changed")
assert "joint_posterior" not in read("a", "joint_posterior", "stage-result.json")
manifest.pop("raw_artifacts")
manifest.pop("posterior_source")
manifest.pop("joint_posterior")
write(manifest_path, manifest)
assert read("a", "raw_artifacts", "stage-result.json")["raw_artifacts"] == []
assert "joint_posterior" not in read("a", "joint_posterior", "stage-result.json")
(a / sample_path).write_bytes(pickle.dumps(saved, protocol=4))
write(a / "decision.json", dict(schema_version="stage_decision.v1", stage="a", attempt=0, decision="accept",
    evidence_sha256={"stage-result.json": file_hash(a / "stage-result.json"),
                     "artifact:" + model_path: file_hash(a / model_path),
                     "artifact:" + sample_path: file_hash(a / sample_path)}))
assert read("a", "joint_posterior", "display")["joint_posterior"] == joint
assert read("a", "joint_parameters", "display")["joint_parameters"] == {"names": joint["names"], "sample_count": 3}
assert len(read("a", "raw_artifacts", "display-manifest.json")["raw_artifacts"]) == 1
(a / sample_path).write_bytes(b"changed")
(a / model_path).write_bytes(b"changed")
assert "joint_posterior" not in read("a", "joint_posterior", "stage-result.json")
assert read("a", "raw_artifacts", "stage-result.json")["raw_artifacts"] == []

# Older accepted runs may lack the entire display package. All three declared
# artifacts must still agree before the two contour views can read the PKL.
manifest_path.unlink()
write(run / "run-manifest.json", dict(schema_version="lens_run_manifest.v1", pipeline_release_id="input-geometry.v1",
    lens_dir=str(lens), input_geometry=geometry))
summary.pop("display")
summary.update(eligible_for_review=True, gate_failures=[])
write(a / "stage-result.json", summary)
(a / sample_path).write_bytes(pickle.dumps(saved, protocol=4))
write(a / "decision.json", dict(schema_version="stage_decision.v1", stage="a", attempt=0, decision="accept",
    evidence_sha256={"stage-result.json": file_hash(a / "stage-result.json"),
                     "artifact:" + sample_path: file_hash(a / sample_path)}))
head = run / "accepted/a.json"
head.parent.mkdir()
head_document = dict(schema_version="accepted_stage_head.v1", stage="a", accepted_attempt=0, attempt_path="../attempts/a/0")
write(head, head_document)
legacy = {"runId": None, "legacyJoint": True}
assert read("a", "joint_parameters", "stage-result.json", **legacy)["joint_parameters"] == {
    "names": joint["names"], "sample_count": 3}
read("a", "joint_posterior", "stage-result.json", expected_error=True, **legacy)
write(head, {**head_document, "accepted_attempt": 1, "attempt_path": "../attempts/a/1"})
read("a", "joint_parameters", "stage-result.json", expected_error=True, **legacy)
write(head, head_document)
large_names = [f"param_{i}" for i in range(19)]
large_shape = (61000, len(large_names))
(a / sample_path).write_bytes(pickle.dumps(dict(param_names=large_names,
    samples=np.arange(np.prod(large_shape), dtype=np.float32).reshape(large_shape),
    weights=np.ones(large_shape[0], dtype=np.float32)), protocol=4))
write(a / "decision.json", dict(schema_version="stage_decision.v1", stage="a", attempt=0, decision="accept",
    evidence_sha256={"stage-result.json": file_hash(a / "stage-result.json"),
                     "artifact:" + sample_path: file_hash(a / sample_path)}))
assert read("a", "joint_parameters", "stage-result.json", **legacy)["joint_parameters"] == {
    "names": large_names, "sample_count": large_shape[0]}
(a / sample_path).write_bytes(b"changed again")
assert "joint_parameters" not in read("a", "joint_parameters", "stage-result.json", **legacy)
print("ok")
`;

test('optional views preserve original bytes, independent masks, and same-row weighted samples', { skip: !available }, async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'tinylens-display-extras-'));
  try {
    const source = `import subprocess\nREADER = ${JSON.stringify(DISPLAY_READER)}\n${fixture}`;
    const run = spawnSync(python, ['-B', '-c', source, dir], {
      env: { ...process.env, PYTHONPATH: [pipeline, process.env.PYTHONPATH].filter(Boolean).join(':') },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'ok');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('GetDist uses paired weighted samples and sends its 68% and 95% regions as closed rings', { skip: !getDistAvailable }, () => {
  const densityTest = String.raw`
import json
from contextlib import redirect_stdout
import sys
import numpy as np

namespace = {"__name__": "stage_display"}
exec(compile(READER, "read-stage-display.py", "exec"), namespace)
rng = np.random.default_rng(37)
x = rng.normal(1.7, .1, size=8000)
y = 4 * (x - 1.7) + rng.normal(13, 3, size=len(x))
weights = rng.uniform(.1, 10, size=len(x))
weights /= weights.sum()
names = ["unused", "radius", "amplitude"]
samples = np.column_stack([rng.normal(size=len(x)), x, y])
result = namespace["joint_density"](names, samples, weights, "radius", "amplitude")

with redirect_stdout(sys.stderr):
    from getdist import MCSamples
    reference = MCSamples(samples=samples[:, [1, 2]], weights=weights, names=["x", "y"], sampler="nested",
                          settings={"ignore_rows": 0, "min_weight_ratio": 0})
    grid = reference.get2DDensity("x", "y", normalized=True)
assert result["parameters"] == ["radius", "amplitude"]
assert result["sample_count"] == len(weights)
assert result["bounds"] == [grid.x[0], grid.x[-1], grid.y[0], grid.y[-1]]
assert [item["probability"] for item in result["contours"]] == [.68, .95]
np.testing.assert_allclose([item["level"] for item in result["contours"]], grid.getContourLevels((.68, .95)))
for item in result["contours"]:
    for polygon in item["polygons"]:
        for ring in polygon:
            assert len(ring) >= 4 and ring[0] == ring[-1]
            px, py = np.asarray(ring).T
            assert np.all((grid.x[0] <= px) & (px <= grid.x[-1]))
            assert np.all((grid.y[0] <= py) & (py <= grid.y[-1]))
print(json.dumps(result, allow_nan=False, separators=(",", ":")))
`;
  const run = spawnSync(python, ['-B', '-c', `READER = ${JSON.stringify(DISPLAY_READER)}\n${densityTest}`], {
    encoding: 'utf8', env: { ...process.env, MPLBACKEND: 'Agg', OPENBLAS_NUM_THREADS: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).method, 'getdist');
  assert.ok(Buffer.byteLength(run.stdout) < 100_000);
});

test('the display endpoint scopes optional views to the same reported attempt', async () => {
  const run = WORKSPACE + '/output/run/lens';
  const path = run + '/attempts/m3/0/stage-result.json';
  const threadId = 'display-extra-test';
  const report = { id: 'reported', kind: 'artifact', threadId, stage: 'm3', path };
  const state = { threadId, updates: [report] };
  const sha = 'a'.repeat(64);
  const manifest = { schema: DISPLAY_SCHEMA, run, stage: 'm3', attempt: 0,
    input: { path: '/fixture/lens.fits', sha256: sha, pixel_scale_arcsec: .1 } };
  const posterior = { names: ['gamma'], samples: [[1.9], [2.1]], weights: [.25, .75] };
  let remoteCalls = 0;
  let replyWithLegacyScope = false;
  const spawnProcess = () => {
    remoteCalls++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
    });
    child.stdin.once('data', data => {
      const request = JSON.parse(data);
      assert.equal(request.path, path);
      const values = {
        joint_posterior: posterior,
        joint_parameters: { names: posterior.names, sample_count: posterior.samples.length },
        joint_density: { method: 'getdist', parameters: [request.x, request.y] },
      };
      const scope = replyWithLegacyScope ? { legacy_joint_scope: {
        run, stage: 'm3', attempt: 0, run_sha256: sha, summary_sha256: sha, posterior_sha256: sha,
      } } : { manifest, manifest_sha256: sha };
      child.stdout.write(JSON.stringify({ ...scope, [request.view]: values[request.view] }));
      child.emit('close', 0);
    });
    return child;
  };
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'tinylens-view-cache-'));
  try {
    async function request(query, currentState = state) {
      let status, body;
      await serveReportedDisplay({ url: '/api/agent/display?' + query }, {
        writeHead(code) { status = code; }, end(data) { body = JSON.parse(data); },
      }, currentState, { spawnProcess, cacheDirectory: directory });
      return { status, body };
    }
    const one = await request('updateId=reported&view=joint_posterior');
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, { schema: DISPLAY_SCHEMA, stage: 'm3', attempt: 0,
      report_path: path, joint_posterior: posterior });
    assert.equal((await request('updateId=elsewhere&view=joint_posterior')).status, 404);
    assert.equal((await request('updateId=reported&view=joint_posterior&view=raw_artifacts')).status, 404);
    assert.equal((await request('updateId=reported&view=unknown')).status, 404);
    assert.equal((await request('updateId=reported&view=joint_density&x=gamma')).status, 404);
    assert.equal((await request('updateId=reported&view=joint_density&x=gamma&y=gamma')).status, 404);
    assert.equal((await request('updateId=reported&view=joint_density&x=gamma&x=theta_E&y=gamma')).status, 404);
    assert.equal((await request('updateId=reported&view=joint_parameters&x=gamma')).status, 404);
    const parameters = await request('updateId=reported&view=joint_parameters');
    assert.deepEqual(parameters.body.joint_parameters, { names: ['gamma'], sample_count: 2 });
    const pair = await request('updateId=reported&view=joint_density&x=gamma&y=theta_E');
    const reverse = await request('updateId=reported&view=joint_density&x=theta_E&y=gamma');
    assert.deepEqual(pair.body.joint_density.parameters, ['gamma', 'theta_E']);
    assert.deepEqual(reverse.body.joint_density.parameters, ['theta_E', 'gamma']);
    assert.deepEqual(await request('updateId=reported&view=joint_density&x=gamma&y=theta_E'), pair);
    assert.equal(remoteCalls, 4);

    replyWithLegacyScope = true;
    const legacyReport = { ...report, id: 'legacy' };
    const legacyQuery = 'updateId=legacy&view=joint_parameters';
    const legacy = await request(legacyQuery, { ...state, updates: [legacyReport] });
    assert.equal(legacy.body.schema, 'tinylens.stage-display.v1');
    assert.deepEqual(legacy.body.joint_parameters, { names: ['gamma'], sample_count: 2 });
    for (const other of [
      { ...report, id: 'newer', run_id: 'newer-run', run_path: run },
      { ...report, id: 'archived', path: WORKSPACE + '/output/run/_archive/lens_old_0/run-manifest.json' },
    ]) {
      const blocked = await request(legacyQuery, { ...state, updates: [legacyReport, other] });
      assert.equal(blocked.status, 404);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy preflight originals remain scoped to their report and run, and are reverified on every read', async () => {
  const run = WORKSPACE + '/output/run/lens';
  const threadId = 'preflight-original-test';
  const six = 'preflight_6panel.png', two = 'preflight_2panel.png';
  const report = (id, file) => ({ id, kind: 'artifact', threadId, stage: 'preflight', path: `${run}/preflight/${file}` });
  const state = { threadId, updates: [report('six', six), report('two', two), report('arbitrary', 'other.png')] };
  const versioned = { ...report('inspection', 'inspection.json'), schema: 'tinylens.stage-report.v1',
    run_path: run, lens_id: 'lens', run_id: 'version-one', attempt: null };
  const sha = 'a'.repeat(64);
  let remoteCalls = 0;
  let replacement;
  const spawnProcess = () => {
    remoteCalls++;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
    });
    child.stdin.once('data', data => {
      const request = JSON.parse(data);
      assert.equal(request.legacyRaw, true);
      assert.equal(request.view, 'raw_artifacts');
      const names = request.path.endsWith('.png') ? [request.path.split('/').at(-1)] : [six, two];
      const scope = { run, run_id: request.runId, stage: 'preflight', attempt: null,
        run_sha256: sha, inspection_sha256: sha };
      child.stdout.write(JSON.stringify({
        legacy_raw_scope: { ...scope, ...replacement?.scope },
        raw_artifacts: (replacement?.names ?? names).map(name => ({ name, src: 'data:image/png;base64,iVBORw0KGgo=' })),
      }));
      child.emit('close', 0);
    });
    return child;
  };
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'tinylens-raw-view-cache-'));
  const read = (id, current = state, view = 'raw_artifacts') =>
    readReportedDisplay(current, id, { view, spawnProcess, cacheDirectory: directory });
  try {
    const original = await read('six');
    assert.equal(original.schema, 'tinylens.stage-display.v1');
    assert.deepEqual(original.raw_artifacts.map(artifact => artifact.name), [six]);
    assert.deepEqual(await read('six'), original);
    assert.equal(remoteCalls, 2);
    await assert.rejects(read('arbitrary'), /does not match its stage/);
    await assert.rejects(read('six', state, 'mask_layers'), /does not match its stage/);
    await assert.rejects(read('six', { ...state, threadId: 'other-thread' }), /explicit display manifest/);
    const mixed = { ...state, updates: [...state.updates, versioned] };
    await assert.rejects(read('six', mixed), /unambiguous run scope/);
    assert.equal(remoteCalls, 2);
    assert.deepEqual((await read('inspection', mixed)).raw_artifacts.map(artifact => artifact.name), [six, two]);
    replacement = { scope: { run_id: 'wrong-version' } };
    await assert.rejects(read('inspection', mixed), /identity mismatch/);
    replacement = { names: [two] };
    await assert.rejects(read('six'), /does not belong to the reported preflight scope/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
