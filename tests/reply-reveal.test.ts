import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_FADE_MS, plainReply, revealReply, settleReply } from '../src/lib/reply-reveal.ts';

const visible = (frame: ReturnType<typeof plainReply>) => frame.stable + frame.fragments.map(part => part.text).join('');

test('saved replies are immediate; appended text alone receives a fade', () => {
  const history = plainReply('已有的历史回复。');
  assert.equal(history.fragments.length, 0);
  const updated = revealReply(history, history.text + '\n新的片段保留 原始空格。', 1000);
  assert.equal(updated.stable, history.text);
  assert.equal(visible(updated), updated.text);
  assert.equal(revealReply(updated, updated.text, 1001), updated);
  const done = settleReply(updated, 2000);
  assert.equal(done.stable, updated.text);
  assert.equal(done.fragments.length, 0);
});

test('Chinese, formulas, whitespace and joined emoji remain exact and whole', () => {
  const unit = '👩🏽‍🔬';
  const text = `A–M2\n  θ_E = 1.40787\tarcsec  ${unit}e\u0301🇨🇳\n`;
  const frame = revealReply(plainReply(''), text, 0);
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.index + part.segment.length)]);
  let offset = 0;
  for (const fragment of frame.fragments) { offset += fragment.text.length; assert.ok(boundaries.has(offset)); }
  assert.equal(visible(frame), text);
});

test('corrections, truncation and reduced motion never replay or retain stale content', () => {
  const frame = revealReply(plainReply('原文'), '原文正在增长', 0);
  for (const text of ['更正后的内容', '原', '']) {
    const corrected = revealReply(frame, text, 1);
    assert.equal(corrected.stable, text);
    assert.equal(corrected.fragments.length, 0);
  }
  const noMotion = revealReply(frame, frame.text + '，即时显示', 1, false);
  assert.equal(noMotion.stable, noMotion.text);
  assert.equal(noMotion.fragments.length, 0);
});

test('long bursts and frequent updates keep the animation bounded without delaying text', () => {
  let frame = plainReply('');
  for (let index = 0; index < 100; index++) {
    frame = revealReply(frame, frame.text + '中文'.repeat(150), index);
    assert.equal(visible(frame), frame.text);
    assert.ok(frame.fragments.length <= 48);
    assert.ok(frame.fragments.every(part => part.until - index <= REPLY_FADE_MS + 72));
  }
  const done = settleReply(frame, 1000);
  assert.equal(done.stable.length, 30000);
  assert.equal(done.fragments.length, 0);
});
