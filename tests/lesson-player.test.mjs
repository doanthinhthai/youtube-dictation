import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTiming } from '../dist/lesson-timing.js';
import { createYouTubeMedia, youtubeError } from '../dist/youtube-player.js';

test('manual timing stays ordered and within the actual audio duration', () => {
  const valid = [{ start: 0, end: 3.5 }, { start: 3.5, end: 9 }];
  assert.deepEqual(validateTiming(valid, 9), valid);
  assert.throws(() => validateTiming([{ start: null, end: 3 }], 9), /câu 1/i);
  assert.throws(() => validateTiming([{ start: 2, end: 3 }, { start: 1, end: 3 }], 9), /câu 2/i);
  assert.throws(() => validateTiming([{ start: 8, end: 11 }], 9), /câu 1/i);
});

test('a blocked embed error tells the learner to replace the video link', () => {
  assert.match(youtubeError(101).message, /nhúng.*link/i);
  assert.match(youtubeError(150).message, /nhúng.*link/i);
  assert.match(youtubeError(100).message, /riêng tư|gỡ/i);
});

test('the IFrame adapter exposes play, pause, seeking and playback clock for sentence repeat', async () => {
  let events;
  let time = 10;
  const calls = [];
  const sdk = {
    Player: class {
      constructor(target, options) {
        events = options.events;
        queueMicrotask(() => events.onReady());
      }
      getDuration() { return 100; }
      getCurrentTime() { return time; }
      getAvailablePlaybackRates() { return [0.75, 1, 1.25]; }
      playVideo() { calls.push('play'); events.onStateChange({ data: 1 }); }
      pauseVideo() { calls.push('pause'); events.onStateChange({ data: 2 }); }
      seekTo(next) { calls.push(['seek', next]); }
      setPlaybackRate(next) { calls.push(['rate', next]); }
      destroy() { calls.push('destroy'); }
    },
  };
  const media = createYouTubeMedia({}, 'M7lc1UVf-VE', {
    load: async () => sdk, origin: 'https://dicta.example',
  });
  await media.ready;
  assert.equal(media.duration, 100);
  media.currentTime = 3;
  assert.equal(media.currentTime, 3, 'a stale iframe position must not end the new repeat');
  time = 3;
  assert.equal(media.currentTime, 3);
  media.playbackRate = 1.1;
  await media.play();
  assert.equal(media.paused, false);
  media.pause();
  assert.equal(media.paused, true);
  media.destroy();
  assert.deepEqual(calls, [['seek', 3], ['rate', 1], 'play', 'pause', 'destroy']);
});
