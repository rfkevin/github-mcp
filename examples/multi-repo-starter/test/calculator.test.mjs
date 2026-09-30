import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/calculator.mjs';

test('adds positive and negative numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 3), 1);
});

test('keeps zero and decimals', () => {
  assert.equal(add(0, 0), 0);
  assert.equal(add(0.5, 0.25), 0.75);
});

test('rejects invalid values', () => {
  for (const value of ['2', undefined, NaN, Infinity]) {
    assert.throws(() => add(value, 1), TypeError);
  }
});
