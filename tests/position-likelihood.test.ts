import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPositionDraft, mergePositionPrompt, pointFromImage, pointToImage, positionError, positionPrompt, positionRequest, validStoredPositionDraft, type PositionContext, type PositionDraft } from '../src/lib/position-likelihood.ts';
const frame = { shape: [151, 151] as [number, number], pixelScale: .05, xDirection: 'increasing' as const, yDirection: 'decreasing' as const };
const context: PositionContext = { target: 'test-lens', stage: 'preflight', synthetic: true, frame, image: '/demo/test.png' };
const valid = (): PositionDraft => ({ ...emptyPositionDraft(), points: [{ id: 'a', x: '1.2', y: '-.7' }, { id: 'b', x: '-1.1', y: '.6' }] });

test('zoom and pan are inverted when picking, and applied when positioning markers',()=>{
  const view={zoom:2,pan:{x:10,y:-5}},expected=pointFromImage(.62,.31,frame);
  const picked=pointFromImage(.84,.07,frame,view),marker=pointToImage(expected.x,expected.y,frame,view);
  assert.ok(Math.abs(picked.x-expected.x)<1e-10&&Math.abs(picked.y-expected.y)<1e-10);
  assert.ok(Math.abs(marker.u-.84)<1e-10&&Math.abs(marker.v-.07)<1e-10);
});
test('zoomed position round trips preserve physical coordinates for flipped and rectangular frames',()=>{
  const frames=[frame,{...frame,shape:[63,91] as [number,number],xDirection:'decreasing' as const,yDirection:'increasing' as const}];
  for(const current of frames)for(const view of [{zoom:1.25,pan:{x:7,y:-9}},{zoom:3,pan:{x:-42,y:36}}]){
    const point={x:.4,y:-.35},screen=pointToImage(point.x,point.y,current,view),picked=pointFromImage(screen.u,screen.v,current,view);
    assert.ok(Math.abs(point.x-picked.x)<1e-10&&Math.abs(point.y-picked.y)<1e-10);
  }
});

test('pixel edges, geometric centre, flipped axes and native pixel scales map correctly', () => {
  assert.deepEqual(pointFromImage(.5, .5, frame), { x: 0, y: 0 });
  assert.deepEqual(pointFromImage(0, 0, frame), { x: -3.75, y: 3.75 });
  assert.deepEqual(pointFromImage(1, 1, frame), { x: 3.75, y: -3.75 });
  assert.deepEqual(pointFromImage(0, 0, { ...frame, xDirection: 'decreasing', yDirection: 'increasing' }), { x: 3.75, y: -3.75 });
  assert.deepEqual(pointFromImage(.5, .5, { ...frame, shape: [512, 512] }), { x: 0, y: 0 });
  const p = pointFromImage(.31, .74, frame), q = pointToImage(p.x, p.y, frame);
  assert.ok(Math.abs(q.u - .31) < 1e-10 && Math.abs(q.v - .74) < 1e-10);
});
test('at least two distinct valid in-bounds points are required', () => {
  for (const points of [[], valid().points.slice(0, 1), [valid().points[0], { id: 'c', x: '1.2', y: '-.7' }], [valid().points[0], { id: 'c', x: '', y: '0' }], [valid().points[0], { id: 'c', x: 'Infinity', y: '0' }], [valid().points[0], { id: 'c', x: '3.751', y: '0' }]]) assert.ok(positionError({ ...valid(), points }, frame));
  assert.equal(positionError(valid(), frame), null);
  assert.throws(() => positionRequest(emptyPositionDraft(), context));
});
test('threshold is positive and penalty is finite and nonnegative, with the correct log-likelihood sign', () => {
  for (const threshold of ['', '0', '-1', 'NaN']) assert.ok(positionError({ ...valid(), threshold }));
  for (const strength of ['', '-1', 'Infinity']) assert.ok(positionError({ ...valid(), strength }));
  const request = positionRequest({ ...valid(), threshold: '.03', strength: '1e8' }, context);
  assert.deepEqual(request.position_likelihood, { positions: [[1.2, -.7], [-1.1, .6]], threshold_arcsec: .03, min_log_like: -1e8 });
  assert.equal(positionRequest({ ...valid(), strength: '0' }, context).position_likelihood.min_log_like, 0);
});
test('requests preserve explicit units, direction, target and synthetic provenance', () => {
  const r = positionRequest(valid(), context);
  assert.equal(r.synthetic, true); assert.equal(r.target, 'test-lens');
  assert.equal(positionRequest({ ...valid(), target: '/chosen/lens' }, context).target, '/chosen/lens');
  assert.ok(positionError({ ...valid(), target: '' }));
  assert.equal(r.coordinate_system.unit, 'arcsec'); assert.equal(r.coordinate_system.y_direction, 'decreasing');
  assert.deepEqual(r.coordinate_system.image_shape, [151, 151]);
  const live = positionRequest(valid(), { target: '/real/input', stage: 'preflight', synthetic: false });
  assert.equal(live.synthetic, false); assert.equal(live.coordinate_system.y_direction, 'increasing');
  assert.equal(live.coordinate_system.image_shape, undefined);
  assert.match(positionPrompt(valid(), context), /不可用于真实数据/);
  assert.match(positionPrompt(valid(), context, 'en'), /synthetic demo coordinates/);
});
test('automatic feedback updates preserve free text, never duplicate, and remove invalidated constraints', () => {
  const original = '请保留我的原有判断。';
  const first = positionPrompt(valid(), context), second = positionPrompt({ ...valid(), strength: '50' }, context);
  const a = mergePositionPrompt(original, '', first);
  const b = mergePositionPrompt(a.text, first, second);
  assert.ok(b.text.startsWith(original)); assert.equal(b.text.split('[TinyLens position likelihood]').length, 2);
  assert.ok(b.text.includes('"min_log_like": -50'));
  assert.equal(mergePositionPrompt(b.text, second, '').text.trim(), original);
});
test('manually edited generated text is retained until explicit replacement', () => {
  const first = positionPrompt(valid(), context), next = positionPrompt({ ...valid(), threshold: '.2' }, context);
  const edited = '前文\n' + first.replace('1.2', '1.3') + '\n后文';
  assert.deepEqual(mergePositionPrompt(edited, first, next), { text: edited, manual: true });
  const forced = mergePositionPrompt(edited, first, next, true);
  assert.ok(forced.text.startsWith('前文\n') && forced.text.endsWith('\n后文'));
  assert.ok(forced.text.includes(next)); assert.equal(forced.manual, false);
});
test('persisted drafts can retain unfinished inputs without accepting malformed objects', () => {
  assert.equal(validStoredPositionDraft({ ...valid(), points: [{ id: 'a', x: '', y: '-' }] }), true);
  for (const v of [null, {}, { ...valid(), points: [null] }, { ...valid(), strength: 1 }, { ...valid(), target: 42 }]) assert.equal(validStoredPositionDraft(v), false);
});
