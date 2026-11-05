import test from 'node:test';
import assert from 'node:assert/strict';
import { isComposerSubmitKey } from '../src/lib/composer-keys.ts';

test('Enter sends and Shift+Enter remains a newline', () => {
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: false }), true);
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: true }), false);
  for (const key of ['a', 'Escape', 'Tab', 'Process']) assert.equal(isComposerSubmitKey({ key, shiftKey: false }), false);
});

test('IME confirmation never submits, including browsers with incomplete composition flags', () => {
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false }, true), false);
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }), false);
  assert.equal(isComposerSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 }), true);
});
