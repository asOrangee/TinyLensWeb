import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedImage, validateImage, readReportedImage, REMOTE_IMAGE_READER } from './agent-artifacts.mjs';
import { WORKSPACE } from './agent-state.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const state = path => ({ threadId: 'current', updates: [{ id: 'known', threadId: 'current', kind: 'artifact', path }] });

test('images require an explicit artifact report from the current conversation', () => {
  assert.equal(reportedImage(state(WORKSPACE + '/output/run/preflight.png'), 'known').type, 'image/png');
  const candidates = [WORKSPACE + '/.codex/secret.png', WORKSPACE + '/output/../secret.png', '/tmp/unreported.png', WORKSPACE + '/output/run/result.json', WORKSPACE + '/output/run/file.svg'];
  for (const path of candidates) assert.throws(() => reportedImage(state(path), 'known'));
  const s = state(WORKSPACE + '/output/a.png');
  assert.throws(() => reportedImage(s, 'unknown'));
  s.updates[0].threadId = 'other'; assert.throws(() => reportedImage(s, 'known'));
  s.updates[0].threadId = 'current'; s.updates[0].kind = 'note'; assert.throws(() => reportedImage(s, 'known'));
});

test('image payload signatures reject text, mismatched types and oversized transfers', () => {
  validateImage(png, 'image/png');
  assert.throws(() => validateImage(Buffer.from('<html>secret</html>'), 'image/png'));
  assert.throws(() => validateImage(png, 'image/jpeg'));
  assert.throws(() => validateImage(Buffer.alloc(13 * 1024 * 1024), 'image/png'));
});

test('remote reader confines resolved symlinks and enforces size before streaming', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tinylens-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'output')); await mkdir(join(root, 'tmp'));
  const valid = join(root, 'output', 'image.png'), outside = join(root, 'private.png');
  await writeFile(valid, png); await writeFile(outside, png);
  await symlink(outside, join(root, 'output', 'escape.png'));
  const run = (path, limit = 10000) => spawnSync('python3', ['-c', REMOTE_IMAGE_READER], { input: JSON.stringify({ root, path, limit }) + '\n' });
  assert.deepEqual(run(valid).stdout, png); assert.equal(run(valid).status, 0);
  assert.notEqual(run(outside).status, 0);
  assert.notEqual(run(join(root, 'output', 'escape.png')).status, 0);
  assert.notEqual(run(valid, 4).status, 0);
});

test('AI image paths travel as stdin data without entering the shell command', async () => {
  const path = WORKSPACE + '/output/a\'$(not-a-command).png';
  let received;
  const result = await readReportedImage(state(path), 'known', { spawnProcess(command, args) {
    assert.equal(command, 'ssh'); assert.ok(!args.at(-1).includes(path));
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
    proc.stdin = new Writable({ write(chunk, _encoding, done) { received = JSON.parse(chunk.toString()); done(); queueMicrotask(() => { proc.stdout.write(png); proc.emit('close', 0); }); } });
    return proc;
  } });
  assert.equal(received.path, path); assert.equal(received.root, WORKSPACE); assert.deepEqual(result.bytes, png);
});
