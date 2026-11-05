import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedInput, readReportedInput, serveReportedInput } from './agent-inputs.mjs';
import { WORKSPACE } from './agent-state.mjs';

const path = WORKSPACE + '/output/run/lens/input-provenance.json';
const state = { threadId: 'thread', updates: [{ id: 'input', threadId: 'thread', kind: 'artifact', stage: 'preflight', path }] };
const hash = value => createHash('sha256').update(value).digest('hex');
// Transport fixtures only; never used by the live viewer.
const fits = Buffer.from('transport FITS fixture'), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9x8AAAAASUVORK5CYII=', 'base64');
const variant = { src: 'data:image/png;base64,' + png.toString('base64'), vmin: 0, vmax: 1, sha256: hash(png) };
const envelope = () => ({ display: { schema: 'tinylens.input-display.v1', source: { provenance_path: path, fits_path: path.replace('input-provenance.json', 'input.fits'), fits_sha256: hash(fits) }, planes: ['data', 'noise', 'snr', 'psf'].map(id => ({ id, variants: { linear: variant, log: variant, zscale: variant } })) }, fits_base64: fits.toString('base64') });
function fakeSsh(payload, inspect = () => {}) {
  return (command, args) => {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    let input = ''; proc.stdin.on('data', chunk => { input += chunk; });
    proc.stdin.on('finish', () => { inspect(command, args, JSON.parse(input)); proc.stdout.end(JSON.stringify(payload)); proc.emit('close', 0); });
    return proc;
  };
}
test('input access requires an explicit preflight artifact owned by the current thread', () => {
  assert.equal(reportedInput(state, 'input').path, path);
  for (const update of [{ ...state.updates[0], threadId: 'other' }, { ...state.updates[0], kind: 'note' }, { ...state.updates[0], stage: 'm1' }, { ...state.updates[0], path: '/tmp/input-provenance.json' }, { ...state.updates[0], path: WORKSPACE + '/output/../../input-provenance.json' }]) assert.throws(() => reportedInput({ ...state, updates: [update] }, 'input'));
  assert.throws(() => reportedInput(state, 'missing'));
});
test('verified input bytes persist offline and corrupt FITS cache is never reused', async t => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'tinylens-input-'));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  let reads = 0;
  const spawnProcess = fakeSsh(envelope(), (command, args, input) => {
    reads++; assert.equal(command, 'ssh'); assert.ok(args.includes('tinylens-gpu')); assert.equal(input.path, path);
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
test('downloaded FITS and image checksums are both enforced before caching', async t => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'tinylens-input-'));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));
  const badFits = envelope(); badFits.fits_base64 = Buffer.from('different').toString('base64');
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: fakeSsh(badFits) }), /FITS checksum/);
  const badPng = structuredClone(envelope()); badPng.display.planes[0].variants.linear.sha256 = '0'.repeat(64);
  await assert.rejects(readReportedInput(state, 'input', { cacheDirectory, spawnProcess: fakeSsh(badPng) }), /preview checksum/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});
test('input route rejects arbitrary paths, duplicate reports and invalid refresh flags', async () => {
  for (const query of ['?path=/tmp/private.fits', '?updateId=input&updateId=input', '?updateId=input&refresh=0']) {
    let status, body;
    await serveReportedInput({ url: '/api/agent/input' + query }, { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } }, state, { spawnProcess() { assert.fail('must not read'); } });
    assert.equal(status, 404); assert.ok(body.error);
  }
});
