import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const python = process.env.TINYLENS_RESULT_TEST_PYTHON || 'python3';
const available = spawnSync(python, ['-B', '-c', 'import fcntl']).status === 0;
const script = fileURLToPath(new URL('./remove-task-runs.py', import.meta.url));

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify(value);
  await writeFile(path, raw);
  return createHash('sha256').update(raw).digest('hex');
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tinylens-remove-test-')));
  const output = join(root, 'output'), batch = join(output, 'batch');
  await mkdir(batch, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  async function makeRun(lens, runId, path = join(batch, lens), runPath = path) {
    const input = join(output, 'inputs', lens);
    await mkdir(input, { recursive: true });
    await writeFile(join(input, lens + '.fits'), 'frozen observation');
    const manifest = { schema_version: 'lens_run_manifest.v1', lens_dir: input,
      pipeline_release_id: 'input-geometry.v1', ...(runId && { run_id: runId }) };
    const manifestSha = await json(join(path, 'run-manifest.json'), manifest);
    await json(join(path, 'preflight', 'inspection.json'), {
      schema_version: 'inspection_packet.v5', lens_dir: input, lens_id: lens,
    });
    return { manifest, manifestSha, candidate: { path, runPath, inputPath: input,
      runIds: runId ? [runId] : [], legacy: !runId, anchors: ['preflight/inspection.json'] } };
  }
  function call(mode, candidates, harness) {
    const argv = harness ? ['-B', '-c', harness, script] : ['-B', script];
    const process = spawnSync(python, argv, {
      input: JSON.stringify({ mode, root, candidates }), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(process.status, 0, process.stderr || process.error?.message);
    return JSON.parse(process.stdout);
  }
  return { root, output, batch, makeRun, call };
}

test('only the named run is removed after matching preview and absent retry is idempotent', { skip: !available }, async t => {
  const f = await fixture(t);
  const { candidate } = await f.makeRun('lens-a', 'run-a');
  const { candidate: sibling } = await f.makeRun('lens-b', 'run-b');
  const shown = f.call('preview', [candidate]);
  assert.equal(shown.runs[0].runId, 'run-a');
  assert.match(shown.runs[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(shown.retained, []);
  assert.deepEqual((await readdir(f.batch)).sort(), ['lens-a', 'lens-b']);
  const path = candidate.path;
  const expected = { ...candidate, fingerprint: shown.runs[0].fingerprint };
  assert.deepEqual(f.call('delete', [{ ...expected, fingerprint: '0'.repeat(64) }]).retained, [{ path, reason: 'changed' }]);
  assert.deepEqual(f.call('delete', [expected]), shown);
  await assert.rejects(access(path), { code: 'ENOENT' });
  await access(sibling.path);
  await access(join(candidate.inputPath, 'lens-a.fits'));
  assert.deepEqual(await readdir(f.batch), ['lens-b']);
  assert.deepEqual(f.call('delete', [expected]), { runs: [{ path, fingerprint: expected.fingerprint }], retained: [] });
  assert.deepEqual(f.call('preview', [expected]).retained, [{ path, reason: 'missing' }]);
});

test('archives must be declared exactly and a pinned legacy display binds the original version', { skip: !available }, async t => {
  const f = await fixture(t);
  const { candidate: live } = await f.makeRun('lens', 'new-run');
  const archive = join(f.batch, '_archive', 'lens_old_0');
  const { candidate, manifestSha } = await f.makeRun('lens', 'old-run', archive, live.path);
  const stale = { ...candidate, runIds: live.runIds };
  assert.equal(f.call('preview', [stale]).retained[0].reason, 'run_mismatch');
  assert.equal(f.call('preview', [{ ...candidate, runPath: archive }]).retained[0].reason, 'outside_scope');
  const relative = 'preflight/display-manifest.json';
  const display = { schema: 'tinylens.stage-display.v3', run: live.path, run_id: 'old-run', lens_id: 'lens',
    stage: 'preflight', attempt: null, run_manifest: { path: 'run-manifest.json', sha256: manifestSha } };
  const sha256 = await json(join(archive, relative), display);
  const legacy = { ...candidate, runIds: [], legacy: true, proofs: [{ path: relative, sha256 }] };
  const shown = f.call('preview', [legacy]);
  assert.equal(shown.runs[0].runId, 'old-run');
  const confirmed = { ...legacy, fingerprint: shown.runs[0].fingerprint };
  await json(join(archive, relative), { ...display, run_id: 'new-run' });
  assert.equal(f.call('delete', [confirmed]).retained[0].reason, 'run_mismatch');
  await json(join(archive, relative), display);
  assert.deepEqual(f.call('delete', [confirmed]), shown);
  await access(live.path);
  await access(dirname(archive));
});

test('legacy no-ID anchors, nested runs, input paths and symlinks fail closed when unsafe', { skip: !available }, async t => {
  const f = await fixture(t);
  const { candidate: legacy } = await f.makeRun('legacy', null);
  assert.equal(f.call('preview', [{ ...legacy, anchors: ['run-manifest.json'] }]).retained[0].reason, 'unverified_legacy');
  assert.equal(f.call('preview', [legacy]).runs.length, 1);
  assert.equal(f.call('preview', [{ ...legacy, inputPath: f.output }]).retained[0].reason, 'protected_path');
  assert.equal(f.call('preview', [{ ...legacy, path: legacy.inputPath, runPath: legacy.inputPath }]).retained[0].reason, 'protected_path');
  const { candidate } = await f.makeRun('outer', 'run-outer');
  const { candidate: child } = await f.makeRun('inner', 'run-inner', join(candidate.path, 'nested', 'inner'));
  assert.equal(f.call('preview', [child]).retained[0].reason, 'protected_path');
  assert.equal(f.call('preview', [candidate]).retained[0].reason, 'protected_path');
  const linked = join(f.batch, 'linked');
  await symlink(legacy.path, linked);
  assert.equal(f.call('preview', [{ ...legacy, path: linked, runPath: linked }]).retained[0].reason, 'unsafe_tree');
  const { candidate: linkedChild } = await f.makeRun('linked-child', 'run-linked');
  await symlink(legacy.inputPath, join(linkedChild.path, 'foreign-input'));
  assert.equal(f.call('preview', [linkedChild]).retained[0].reason, 'unsafe_tree');
  await access(join(legacy.inputPath, 'legacy.fits'));
});

test('an active stage lock prevents removal while a released stale lock does not', { skip: !available }, async t => {
  const f = await fixture(t);
  const { candidate } = await f.makeRun('locked', 'run-locked');
  const lock = join(candidate.path, '.operations', 'm1-0.lock');
  await mkdir(dirname(lock));
  await writeFile(lock, '');
  const shown = f.call('preview', [candidate]);
  const held = String.raw`
import fcntl, json, pathlib, runpy, sys
request = json.load(sys.stdin)
remove = runpy.run_path(sys.argv[1])["execute"]
with (pathlib.Path(request["candidates"][0]["path"]) / ".operations/m1-0.lock").open("rb+") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print(json.dumps(remove(request)))
`;
  const confirmed = { ...candidate, fingerprint: shown.runs[0].fingerprint };
  assert.deepEqual(f.call('delete', [confirmed], held).retained, [{ path: candidate.path, reason: 'active' }]);
  await access(candidate.path);
  assert.deepEqual(f.call('delete', [confirmed]), shown);
});

test('restart can retry a partly removed quarantine without touching a replacement live run', { skip: !available }, async t => {
  const f = await fixture(t);
  const { candidate } = await f.makeRun('lens', 'old-run');
  const shown = f.call('preview', [candidate]);
  const confirmed = { ...candidate, fingerprint: shown.runs[0].fingerprint };
  const interrupted = String.raw`
import json, pathlib, runpy, shutil, sys
remove = runpy.run_path(sys.argv[1])["execute"]
original = shutil.rmtree
def interrupted(path, *args, **kwargs):
    if pathlib.Path(path).name == "run":
        (pathlib.Path(path) / "run-manifest.json").unlink()
        raise OSError("simulated interrupted quarantine cleanup")
    return original(path, *args, **kwargs)
interrupted.avoids_symlink_attacks = original.avoids_symlink_attacks
shutil.rmtree = interrupted
print(json.dumps(remove(json.load(sys.stdin))))
`;
  assert.equal(f.call('delete', [confirmed], interrupted).retained[0].reason, 'delete_failed');
  await assert.rejects(access(candidate.path), { code: 'ENOENT' });
  assert.deepEqual(f.call('preview', [confirmed]), shown);
  const { candidate: replacement } = await f.makeRun('lens', 'new-run');
  assert.deepEqual(f.call('delete', [confirmed]), shown);
  assert.equal(f.call('preview', [replacement]).runs[0].runId, 'new-run');
  assert.deepEqual(await readdir(f.batch), ['lens']);
});
