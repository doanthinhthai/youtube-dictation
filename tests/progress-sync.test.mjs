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

test('editing or clearing a listening range leaves the last checked grade intact', () => {
  const previous = { progress: { office: { answers: { 0: {
    text: 'office', checkedText: 'office', score: 100, checks: 1, gradedAt: 300, range: { start: 1, end: 3 },
  } } } } };
  const next = structuredClone(previous);
  const answer = next.progress.office.answers[0];
  answer.text = 'draft';
  answer.checkedText = null;
  delete answer.range;
  const changes = diffProgress(previous, next);
  assert.deepEqual(changes.map(({ kind, value }) => [kind, value]), [['answer', { text: 'draft', range: null }]]);
  assert.equal(applyProgress(previous, changes).progress.office.answers[0].checkedText, 'office');
});

test('range edits with an older draft timestamp receive the time of the new edit', () => {
  const previous = { progress: { office: { answers: { 0: {
    text: 'office', editedAt: 100, range: { start: 1, end: 3 },
  } } } } };
  const next = structuredClone(previous);
  delete next.progress.office.answers[0].range;
  assert.equal(diffProgress(previous, next, { now: () => 400 })[0].at, 400);
  assert.equal(diffProgress({}, previous, { now: () => 400 })
    .find(change => change.kind === 'answer').at, 100, 'guest import preserves the original time');
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

test('restarting a lesson clears only that lesson and leaves other scores alone', () => {
  const before = applyProgress({}, [
    grade('one', '0', 100, 'hello', 100),
    { ...grade('two', '0', 150, 'other', 80), key: ['another', '0'] },
  ]);
  const after = structuredClone(before);
  delete after.progress.office;
  const changes = diffProgress(before, after, { now: () => 200 });
  assert.deepEqual(changes.map(({ kind, key }) => [kind, key]), [['clearLesson', ['office']]]);
  assert.equal(applyProgress(before, changes).progress.office, undefined);
  assert.equal(applyProgress(before, changes).progress.another.answers[0].score, 80);
});

test('offline typing compacts one large draft without dropping other progress', () => {
  const stored = new Map();
  const storage = { get length() { return stored.size; }, key: i => [...stored.keys()][i],
    setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key), removeItem: key => stored.delete(key) };
  const queue = createProgressQueue(storage);
  queue.recordChange('me', grade('one', '1', 100, 'unchanged', 100));
  for (let step = 1; step <= 100; step++) {
    queue.recordChange('me', { id: 'edit' + step, at: step, kind: 'answer', key: ['office', 'whole'],
      value: { text: 'a'.repeat(step * 200) } });
  }
  assert.deepEqual(queue.pending('me').map(change => change.id).sort(), ['edit100', 'one']);
  assert.ok([...stored.values()].reduce((total, value) => total + value.length, 0) < 25000);
});
