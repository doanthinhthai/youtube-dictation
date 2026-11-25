import { projectUrl, publishableKey } from './config.js';
import { escapeHTML } from './core.js';
import { connectAccount } from './account.js';
import { createOnlineSession } from './online-session.js';
import { isWholeLesson } from './lesson-input.js';
import { showLessonForm } from './lesson-form.js';
import { showTimingEditor } from './lesson-timing.js';
import { createYouTubeMedia } from './youtube-player.js';
import { scoreWholeInBackground } from './whole-score.js';

const app = document.querySelector('#app');
const auth = await connectAccount(projectUrl, publishableKey);
const { client } = auth;
let session = auth.session;
auth.onSession = next => { session = next; };

const samples = fetch('/builtin.json').then(response => {
  if (!response.ok) throw new Error('Không tải được thư viện bài mẫu.');
  return response.json();
});

function accountPanel() {
  if (session) {
    const displayName = escapeHTML(auth.username || session.user.email || 'tài khoản Dicta');
    return '<section class="panel panel-pad"><h3>Tài khoản và đồng bộ</h3><p class="small muted">Đã đăng nhập với <b>' + displayName + '</b>. Tiến độ và bài cá nhân gắn với tài khoản của bạn.</p><button class="btn secondary" data-action="online-account">Quản lý tài khoản</button></section>';
  }
  return '<section class="panel panel-pad"><h3>Tài khoản và đồng bộ</h3><p class="small muted">Đăng nhập để mở bài cá nhân và đồng bộ tiến độ. Tiến độ khi luyện mẫu được lưu trên thiết bị này.</p><button class="btn primary" data-action="online-account">Đăng nhập</button></section>';
}

const lessonCache = new Map();
function requireData(response) {
  if (response.error) {
    const error = new Error('Chưa đồng bộ được dữ liệu.');
    error.code = response.error.code;
    throw error;
  }
  return response.data;
}

async function readPrivateLessons(owner) {
    const own = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const rows = requireData(await client.from('dicta_online_lessons')
        .select('lesson_id,lesson,audio_path,deleting').eq('user_id', owner)
        .order('lesson_id').range(offset, offset + limit - 1).abortSignal(AbortSignal.timeout(7000)));
      for (const row of rows) {
        if (!row.lesson?.segments?.length) continue;
        const part = ['1','2','3','4'].includes(String(row.lesson.part)) ? String(row.lesson.part) : '3';
        const youtubeId = /^[\w-]{11}$/.test(row.lesson.youtubeId || '') ? row.lesson.youtubeId : undefined;
        own.push({ ...row.lesson, id: row.lesson_id, part, youtubeId, media: '', deleting: row.deleting,
          kind: row.audio_path ? 'audio' : row.lesson.kind, custom: true });
        lessonCache.set(row.lesson_id, row.audio_path || row.lesson.media);
      }
      if (rows.length < limit) break;
    }
    return own;
}

const account = createOnlineSession({
  accountStorage: localStorage, tabStorage: sessionStorage,
  getAccountId: () => session?.user.id ?? null,
  readSamples: () => samples, readPrivateLessons,
  readRemoteState: async owner => requireData(await client.from('dicta_online_state').select('value')
    .eq('user_id', owner).abortSignal(AbortSignal.timeout(7000)).maybeSingle())?.value || {},
  sendChanges: async (changes, owner) => {
    if (owner !== session?.user.id) return [];
    const accessToken = session.access_token;
    const response = await fetch(projectUrl + '/rest/v1/rpc/dicta_online_apply_progress', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { apikey: auth.key, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_changes: changes }),
    });
    if (!response.ok) throw new Error('Chưa đồng bộ được tiến độ.');
    return response.json();
  },
});

let storageStatus = 'ready';
let readsDegraded = false;
let retryTimer;
function bannerHTML() {
  const sync = storageStatus === 'degraded'
    ? '<p class="notice" role="status">Đồng bộ đang gián đoạn. Tiến độ mới được giữ trên thiết bị. <button class="text-btn" data-action="retry-online">Thử lại</button></p>' : '';
  const guest = account.shouldOfferGuestImport()
    ? '<div class="notice"><p>Bạn muốn nhập tiến độ đã luyện trong tab này vào tài khoản?</p><button class="btn secondary" data-action="import-guest">Nhập tiến độ</button> <button class="text-btn" data-action="decline-guest">Bỏ qua</button></div>' : '';
  return sync + guest;
}

function renderStatus() {
  const target = document.querySelector('#online-status');
  if (target) target.innerHTML = bannerHTML();
}

async function flush() {
  clearTimeout(retryTimer);
  if (!session || !account.hasPending()) return;
  if (await account.flushProgress()) {
    storageStatus = readsDegraded ? 'degraded' : 'ready';
    renderStatus();
  } else {
    storageStatus = 'degraded';
    renderStatus();
  }
  if (account.hasPending()) retryTimer = setTimeout(flush, 10000);
}

function recordState(state, delay = 1500) {
  if (!account.recordState(state) || !session || !account.hasPending()) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flush, delay);
}

async function privateRequest(route, method, body, mime = 'application/json') {
  if (!session) throw new Error('Hãy đăng nhập để thêm hoặc quản lý bài riêng.');
  const owner = session.user.id;
  const result = await fetch(route, {
    method, body, headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': mime },
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.error || 'Chưa xử lý được bài luyện.');
  if (session?.user.id !== owner) throw new Error('Phiên đăng nhập vừa thay đổi.');
  return data;
}

async function createPrivateLesson(draft, file) {
  const result = await privateRequest('/api/lessons', 'POST', JSON.stringify(draft));
  if (result.pending && file) {
    await privateRequest('/api/lessons/' + encodeURIComponent(draft.id) + '/audio', 'PUT', file, draft.audio.mime);
  }
  return { id: draft.id };
}

async function api(route, { method = 'GET', body } = {}) {
  if (route === '/api/status') return { online: true, ai: false, translation: false, models: {} };
  if (route === '/api/storage') return { mode: session ? 'supabase' : 'browser' };
  if (route === '/api/library') return session ? [...await samples, ...await readPrivateLessons(session.user.id)] : samples;
  if (route.startsWith('/api/lessons/') && ['DELETE', 'PATCH'].includes(method)) {
    return privateRequest(route, method, body);
  }
  throw new Error('Thao tác này không có trong bản online.');
}

const audioCache = new Map();
function mountYouTube(target, videoId) {
  const container = target.parentElement;
  const media = createYouTubeMedia(target, videoId);
  media.addEventListener('error', () => {
    let notice = container.querySelector('.youtube-error');
    if (!notice) {
      notice = document.createElement('p');
      notice.className = 'notice youtube-error';
      notice.setAttribute('role', 'status');
      container.append(notice);
    }
    notice.textContent = media.error?.message || 'Chưa phát được video YouTube.';
  });
  media.addEventListener('play', () => container.querySelector('.youtube-error')?.remove());
  return media;
}

async function prepareMedia(lesson) {
  if (lesson.deleting) throw new Error('Bài đang chờ xóa. Hãy thử xóa lại từ thư viện.');
  if (lesson.kind === 'youtube') return '';
  const path = lesson.custom ? lessonCache.get(lesson.id) : (lesson.originalMedia ??= lesson.media);
  if (typeof path !== 'string') throw new Error('Bài chưa có audio trên web.');
  const old = audioCache.get(path);
  if (old && old.expires > Date.now()) return old.url;
  let url, expires = Infinity;
  if (/^\/media\/builtin\/[\w.-]+$/.test(path)) {
    // Sample files are small. One local Blob also supports seeking on hosts without Range.
    const response = await fetch(path);
    if (!response.ok) throw new Error('Chưa tải được audio bài mẫu.');
    url = URL.createObjectURL(await response.blob());
  } else {
    const ownerPrefix = session?.user.id + '/';
    if (!session || !path.startsWith(ownerPrefix) || !/^[\w-]+\/[a-f0-9]{64}\.(m4a|mp3)$/.test(path)) {
      throw new Error('Audio riêng tư chưa sẵn sàng cho tài khoản này.');
    }
    const seconds = 3600;
    const data = requireData(await client.storage.from('dicta-online-audio').createSignedUrl(path, seconds));
    url = data.signedUrl;
    expires = Date.now() + (seconds - 60) * 1000;
  }
  audioCache.set(path, { url, expires });
  return url;
}

globalThis.dictaOnline = {
  api, accountPanel, showAccount: () => auth.show(), prepareMedia, recordState, bannerHTML,
  isWholeLesson,
  scoreWhole: scoreWholeInBackground,
  mountYouTube,
  showTimingEditor(dialog, lesson, onSaved) {
    showTimingEditor(dialog, { lesson, onSaved, mountYouTube, save: timing =>
      api('/api/lessons/' + encodeURIComponent(lesson.id), { method: 'PATCH', body: JSON.stringify({ timing }) }),
    });
  },
  showLessonForm(dialog, onSaved) {
    if (!session) return auth.show();
    showLessonForm(dialog, { save: createPrivateLesson, onSaved });
  },
  setBaseline: account.setBaseline,
  async loadOnlineSession() {
    const data = await account.loadOnlineSession();
    readsDegraded = data.status === 'degraded';
    storageStatus = data.status;
    void flush();
    return data;
  },
  async importGuestProgress() {
    const saved = await account.importGuestProgress();
    if (saved) location.reload();
    else {
      storageStatus = 'degraded';
      renderStatus();
      retryTimer = setTimeout(flush, 10000);
    }
  },
  declineGuestImport() { account.declineGuestImport(); renderStatus(); },
  async retry() {
    await flush();
    location.reload();
  },
  accountLabel: session ? 'Tài khoản' : 'Đăng nhập',
  storageLabel: session ? 'Online · Đã đăng nhập' : 'Online · Luyện bài mẫu',
};
window.addEventListener('online', flush);
app.classList.add('online-mode');
await import('./app.js');
auth.finishCallback();
