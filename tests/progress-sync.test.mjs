import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProgress, diffProgress, createProgressQueue } from '../dist/progress-sync.js';

const grade = (id, index, when, checkedText, score) => ({
  id, at: when, kind: 'grade', key: ['office', index],
  value: { gradedAt: when, checkedText, score, checks: 1, firstScore: score },
});

test('an older grade cannot replace a later grade while another sentence is preserved', () => {
  const latest = grade('later', '0', 200, 'the office', 100);
  const older = grade('earlier', '0', 100, 'the', 50);
  const other = grade('other', '1', 150, 'next week', 100);
  const result = applyProgress({}, [latest, other, older]);
  assert.equal(result.progress.office.answers['0'].score, 100);
  assert.equal(result.progress.office.answers['0'].checkedText, 'the office');
  assert.equal(result.progress.office.answers['1'].checkedText, 'next week');
});

test('a draft cannot replace a saved grade and whole-lesson grading uses a separate key', () => {
  const snapshot = { progress: { office: { answers: { 0: { score: 80, checks: 1, checkedText: 'office' } } } } };
  const result = applyProgress(snapshot, [
    { id: 'draft', at: 110, kind: 'answer', key: ['office', '0'], value: { text: 'new draft' } },
    grade('whole', 'whole', 120, 'the whole answer', 90),
  ]);
  assert.equal(result.progress.office.answers['0'].score, 80);
  assert.equal(result.progress.office.answers['0'].text, 'new draft');
  assert.equal(result.progress.office.answers.whole.score, 90);
});

test('snapshot changes describe only changed fields and listening deltas', () => {
  const before = { settings: { goal: 15, repeat: 1 }, words: [{ id: 'w', word: 'old' }],
    days: { '2026-11-25': { seconds: 60, checks: 1 } } };
  const after = { ...before, settings: { goal: 20, repeat: 1 }, words: [],
    days: { '2026-11-25': { seconds: 63, checks: 2 } } };
  const changes = diffProgress(before, after, { now: () => 100, id: (() => { let i = 0; return () => String(++i); })() });
  assert.deepEqual(changes.map(({ kind, key, value }) => [kind, key, value]), [
    ['setting', ['goal'], 20], ['word', ['w'], null], ['day', ['2026-11-25'], { seconds: 3, checks: 1 }],
  ]);
});

test('progress queue keeps failed and unacknowledged changes isolated by account', async () => {
  const stored = new Map();
  const storage = { get length() { return stored.size; }, key: i => [...stored.keys()][i],
    setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key), removeItem: key => stored.delete(key) };
  const queue = createProgressQueue(storage);
  queue.recordChange('a', grade('one', '0', 100, 'one', 30));
  queue.recordChange('a', grade('two', '1', 200, 'two', 100));
  queue.recordChange('b', grade('three', '0', 200, 'three', 100));
  await assert.rejects(queue.flushProgress('a', async () => { throw new Error('offline'); }), /offline/);
  await queue.flushProgress('a', async changes => {
    assert.deepEqual(changes.map(change => change.id), ['one', 'two']);
    return ['one'];
  });
  assert.deepEqual(createProgressQueue(storage).pending('a').map(change => change.id), ['two']);
  assert.deepEqual(queue.pending('b').map(change => change.id), ['three']);
});
