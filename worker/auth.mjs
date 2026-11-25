import { handleLessons } from './lessons.mjs';

const usernamePattern = /^[a-z0-9_]{3,24}$/;
const invalid = 'Tên đăng nhập hoặc mật khẩu chưa đúng.';
const unavailable = 'Đăng nhập bằng tên người dùng chưa sẵn sàng. Hãy thử đăng nhập bằng email.';

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function settings(env) {
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.SUPABASE_URL ?? '') ||
      !/^sb_publishable_[\w-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY ?? '')) return null;
  return {
    url: env.SUPABASE_URL,
    key: env.SUPABASE_PUBLISHABLE_KEY,
    hasUsername: /^sb_secret_[\w-]+$/.test(env.SUPABASE_SECRET_KEY ?? '') &&
      !!env.USERNAME_RATE_LIMIT && !!env.USERNAME_IP_LIMIT,
  };
}

async function readCredentials(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return null;
  if (!request.body || Number(request.headers.get('Content-Length')) > 4096) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    const username = typeof value?.username === 'string' ? value.username.trim().toLowerCase() : '';
    const password = value?.password;
    if (!usernamePattern.test(username) || typeof password !== 'string' || !password || password.length > 1024) return null;
    return { username, password };
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function post(url, key, body) {
  return fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Dicta-Worker/1.0' },
    body: JSON.stringify(body),
  });
}

async function usernameLogin(request, url, env, config) {
  if (request.method !== 'POST') return json({ error: 'Dùng phương thức POST.' }, 405);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Yêu cầu ngoài Dicta.' }, 403);
  if (!config?.hasUsername) return json({ error: unavailable }, 503);
  const credentials = await readCredentials(request);
  if (!credentials) return json({ error: invalid }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  try {
    const [address, account] = await Promise.all([
      env.USERNAME_IP_LIMIT.limit({ key: ip }),
      env.USERNAME_RATE_LIMIT.limit({ key: 'account:' + credentials.username }),
    ]);
    if (!address.success || !account.success) {
      return json({ error: 'Bạn đã thử quá nhiều lần. Hãy thử lại sau một phút.' }, 429);
    }
    const lookup = await post(config.url + '/rest/v1/rpc/dicta_login_email', env.SUPABASE_SECRET_KEY,
      { p_username: credentials.username });
    if (!lookup.ok) return json({ error: unavailable }, 503);
    const email = await lookup.json();
    if (typeof email !== 'string') return json({ error: invalid }, 401);
    // Password verification, token issuance and session policies stay with Supabase Auth.
    const auth = await post(config.url + '/auth/v1/token?grant_type=password', config.key, {
      email, password: credentials.password,
    });
    if (auth.status === 429) return json({ error: 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.' }, 429);
    if (auth.status >= 500 || !auth.ok && auth.status !== 400 && auth.status !== 401 && auth.status !== 422) {
      return json({ error: unavailable }, 503);
    }
    if (!auth.ok) return json({ error: invalid }, 401);
    const { access_token, refresh_token } = await auth.json();
    if (typeof access_token !== 'string' || typeof refresh_token !== 'string') return json({ error: unavailable }, 503);
    return json({ access_token, refresh_token });
  } catch {
    return json({ error: unavailable }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/auth/config') {
      if (request.method !== 'GET') return json({ error: 'Dùng phương thức GET.' }, 405);
      const config = settings(env);
      return config ? json(config) : json({ error: 'Đăng nhập chưa được cấu hình.' }, 503);
    }
    if (url.pathname === '/api/auth/username-login') return usernameLogin(request, url, env, settings(env));
    if (url.pathname === '/api/lessons' || url.pathname.startsWith('/api/lessons/')) {
      return handleLessons(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};
