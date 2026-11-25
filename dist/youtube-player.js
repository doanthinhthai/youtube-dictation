let apiPromise;

function loadPlayerAPI() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const previous = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => reject(new Error('Chưa tải được trình phát YouTube. Hãy thử lại.')), 10000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      try { previous?.(); } finally { resolve(window.YT); }
    };
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('Chưa tải được trình phát YouTube. Hãy thử lại.'));
    };
    document.head.append(script);
  }).catch(error => { apiPromise = null; throw error; });
  return apiPromise;
}

export function youtubeError(code) {
  if (code === 101 || code === 150) return new Error('Video này không cho nhúng. Hãy dùng link YouTube khác.');
  if (code === 100) return new Error('Video đã bị gỡ hoặc đặt riêng tư. Hãy dùng link khác.');
  if (code === 153) return new Error('Trình phát YouTube chưa nhận được thông tin của Dicta. Hãy tải lại trang.');
  return new Error('Chưa phát được video YouTube. Hãy kiểm tra link hoặc thử lại.');
}

export function createYouTubeMedia(target, videoId, { load = loadPlayerAPI, origin = globalThis.location?.origin } = {}) {
  const events = new EventTarget();
  let player;
  let disposed = false;
  let state = -1;
  let speed = 1;
  let seek = null;
  let polling;
  let readyTimer;
  let rejectReady;
  let playbackError;
  const emit = name => events.dispatchEvent(new Event(name));
  const stopPolling = () => { clearInterval(polling); polling = undefined; };
  const fail = error => {
    playbackError = error;
    stopPolling();
    rejectReady?.(error);
    emit('error');
  };

  const ready = load().then(sdk => new Promise((resolve, reject) => {
    if (disposed) { resolve(); return; }
    rejectReady = reject;
    readyTimer = setTimeout(() => fail(new Error('YouTube chưa sẵn sàng phát. Hãy thử lại.')), 12000);
    player = new sdk.Player(target, {
      videoId, playerVars: { origin, playsinline: 1 },
      events: {
        onReady() { clearTimeout(readyTimer); emit('loadedmetadata'); resolve(); },
        onError({ data }) { clearTimeout(readyTimer); fail(youtubeError(data)); },
        onAutoplayBlocked() { fail(new Error('Hãy bấm phát trực tiếp trong trình phát YouTube.')); },
        onStateChange({ data }) {
          state = data;
          if (data === 1) {
            playbackError = undefined;
            emit('play');
            stopPolling();
            polling = setInterval(() => emit('timeupdate'), 160);
          } else {
            stopPolling();
            if (data === 0 || data === 2) emit('pause');
          }
          emit('timeupdate');
        },
      },
    });
  }));
  ready.catch(error => { if (!playbackError && !disposed) fail(error); });
  Object.assign(events, {
    ready,
    async play() {
      await ready;
      if (!disposed) player?.playVideo();
    },
    pause() { player?.pauseVideo?.(); },
    destroy() {
      disposed = true;
      clearTimeout(readyTimer);
      stopPolling();
      rejectReady?.(new Error('Bài nghe đã đóng.'));
      player?.destroy?.();
    },
  });
  return Object.defineProperties(events, {
    duration: { get: () => player?.getDuration?.() || NaN },
    paused: { get: () => state !== 1 },
    ended: { get: () => state === 0 },
    error: { get: () => playbackError },
    currentTime: {
      get() {
        const actual = player?.getCurrentTime?.() || 0;
        if (seek && Date.now() < seek.until && Math.abs(actual - seek.position) > 0.5) return seek.position;
        seek = null;
        return actual;
      },
      set(position) {
        seek = { position, until: Date.now() + 900 };
        player?.seekTo?.(position, true);
      },
    },
    playbackRate: {
      get: () => speed,
      set(requested) {
        const rates = player?.getAvailablePlaybackRates?.() || [];
        speed = rates.reduce((best, rate) =>
          Math.abs(rate - requested) < Math.abs(best - requested) ? rate : best, rates[0] || 1);
        player?.setPlaybackRate?.(speed);
      },
    },
  });
}
