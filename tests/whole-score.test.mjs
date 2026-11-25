import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreWhole } from '../dist/whole-score.js';

test('whole-lesson score reflects word edits using the usual normalization', () => {
  assert.equal(scoreWhole("We're leaving at noon.", 'We are leaving at two'), 80);
  assert.equal(scoreWhole('one two three', 'one extra two three'), 75);
  assert.equal(scoreWhole('one two three', 'one three'), 67);
});

test('an hour-sized transcript can be checked as a whole with a local substitution', () => {
  const beginning = 'one two three four five '.repeat(800);
  const ending = 'six seven eight nine ten '.repeat(800);
  assert.equal(scoreWhole(beginning + 'correct ' + ending, beginning + 'changed ' + ending), 100);
});
