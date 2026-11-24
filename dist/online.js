import { projectUrl, publishableKey } from './config.js';
import { escapeHTML } from './core.js';
import { connectAccount } from './account.js';

const browserState = 'dicta:online:guest';
const app = document.querySelector('#app');
const auth = await connectAccount(projectUrl, publishableKey);
const { client, key } = auth;
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
let persistVersion = Date.now();
function statePayload(value) {
  persistVersion = Math.max(persistVersion + 1, Date.now());
  return { p_value: value, p_revision: persistVersion };
}
function getGuestState() {
  try { return JSON.parse(localStorage.getItem(browserState) || '{}'); }
  catch { return {}; }
}
function requireData(response) {
  if (response.error) throw new Error('Chưa đọc hoặc lưu được dữ liệu Supabase. Kiểm tra kết nối và schema Dicta Online.');
  return response.data;
}

async function api(route, { method = 'GET', body } = {}) {
  if (route === '/api/status') return { online: true, ai: false, translation: false, models: {} };
  if (route === '/api/storage') return { mode: session ? 'supabase' : 'browser' };
  if (route === '/api/library') {
    const base = await samples;
    if (!session) return base;
    const own = [];
    const limit = 100;
    for (let offset = 0; ; offset += limit) {
      const rows = requireData(await client.from('dicta_online_lessons')
        .select('lesson_id,lesson,audio_path').eq('user_id', session.user.id)
        .order('lesson_id').range(offset, offset + limit - 1));
      for (const row of rows) {
        if (!row.lesson?.segments?.length) continue;
        const part = ['1','2','3','4'].includes(String(row.lesson.part)) ? String(row.lesson.part) : '3';
        const youtubeId = /^[\w-]{11}$/.test(row.lesson.youtubeId || '') ? row.lesson.youtubeId : undefined;
        own.push({ ...row.lesson, id: row.lesson_id, part, youtubeId, media: '', kind: row.audio_path ? 'audio' : row.lesson.kind, custom: true });
        lessonCache.set(row.lesson_id, row.audio_path || row.lesson.media);
      }
      if (rows.length < limit) break;
    }
    return [...base, ...own];
  }
  if (route === '/api/state' && method === 'GET') {
    if (!session) return getGuestState();
    const row = requireData(await client.from('dicta_online_state').select('value,revision')
      .eq('user_id', session.user.id).maybeSingle());
    persistVersion = Math.max(persistVersion, Number(row?.revision || 0));
    return row?.value || {};
  }
  if (route === '/api/state' && method === 'PUT') {
    if (session) requireData(await client.rpc('dicta_online_save_state', statePayload(JSON.parse(body))));
    else localStorage.setItem(browserState, body);
    return { ok: true };
  }
  throw new Error('Tạo và sửa bài nghe trong Dicta trên PC.');
}

const audioCache = new Map();
async function prepareMedia(lesson) {
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
    if (!session || !path.startsWith(ownerPrefix) || !/^[\w-]+\/[a-f0-9]{64}\.m4a$/.test(path)) {
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

function flushState(value) {
  if (!session) {
    localStorage.setItem(browserState, JSON.stringify(value));
    return;
  }
  const body = JSON.stringify(statePayload(value));
  if (new TextEncoder().encode(body).length > 60000) return;
  fetch(projectUrl + '/rest/v1/rpc/dicta_online_save_state', {
    method: 'POST', keepalive: true,
    headers: { apikey: key, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
    body,
  }).catch(() => {});
}

globalThis.dictaOnline = {
  api, accountPanel, showAccount: () => auth.show(), prepareMedia, flushState,
  accountLabel: session ? 'Tài khoản' : 'Đăng nhập',
  storageLabel: session ? 'Online · Đã đăng nhập' : 'Online · Luyện bài mẫu',
};
app.classList.add('online-mode');
await import('./app.js');
auth.finishCallback();
