import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLessonInput, isWholeLesson, parseYouTubeId, audioMime } from '../dist/lesson-input.js';

test('pasted text and BOM-prefixed TXT are readable immediately in whole-lesson mode', () => {
  const text = '\uFEFFGood afternoon.\r\nHẹn gặp lại!';
  const state = parseLessonInput({ format: 'txt', text });
  assert.equal(state.transcript, 'Good afternoon.\nHẹn gặp lại!');
  assert.deepEqual(state.segments, [
    { text: 'Good afternoon.', start: null, end: null },
    { text: 'Hẹn gặp lại!', start: null, end: null },
  ]);
  assert.equal(isWholeLesson(state), true);
});

test('SRT and VTT carry timing into sentence practice', () => {
  const srt = parseLessonInput({ format: 'srt', text: '1\n00:00:01,100 --> 00:00:02,250\nNice to meet you.' });
  const vtt = parseLessonInput({ format: 'vtt', text: 'WEBVTT\n\nNOTE English\n\n00:01.100 --> 00:02.250 align:start\nNice to meet you.' });
  const expected = [{ start: 1.1, end: 2.25, text: 'Nice to meet you.' }];
  assert.deepEqual(srt.segments, expected);
  assert.deepEqual(vtt.segments, expected);
  assert.equal(isWholeLesson(vtt), false);
});

test('a broken cue is reported instead of silently dropping valid surrounding text', () => {
  const text = '1\n00:00:01,100 --> 00:00:02,250\nFirst.\n\n2\n00:00:06,000 --> 00:00:05,000\nBroken.';
  assert.throws(() => parseLessonInput({ format: 'srt', text }), /mốc thời gian/i);
});

test('common YouTube links and familiar audio extensions resolve to supported sources', () => {
  const id = 'M7lc1UVf-VE';
  assert.equal(parseYouTubeId('https://youtu.be/M7lc1UVf-VE?t=15'), id);
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=M7lc1UVf-VE'), id);
  assert.equal(parseYouTubeId('https://m.youtube.com/shorts/M7lc1UVf-VE'), id);
  assert.throws(() => parseYouTubeId('https://youtube.com.example.invalid/watch?v=M7lc1UVf-VE'), /YouTube/);
  assert.equal(audioMime({ name: 'rec.MP3', type: '' }), 'audio/mpeg');
  assert.equal(audioMime({ name: 'rec.m4a', type: 'audio/x-m4a' }), 'audio/mp4');
  assert.throws(() => audioMime({ name: 'rec.txt', type: 'text/plain' }), /MP3 hoặc M4A/);
});
