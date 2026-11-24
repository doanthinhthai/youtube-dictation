import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/auth.mjs';

const origin = 'https://youtube-dictation.example';
const env = {
  SUPABASE_URL: 'https://dicta-test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_value',
  SUPABASE_SECRET_KEY: 'sb_secret_test_value',
  USERNAME_RATE_LIMIT: { limit: async () => ({ success: true }) },
  USERNAME_IP_LIMIT: { limit: async () => ({ success: true }) },
  ASSETS: { fetch: async () => new Response('sample asset') },
};
const login = (body, requestOrigin = origin) => new Request(origin + '/api/auth/username-login', {
  method: 'POST',
  headers: { Origin: requestOrigin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
  body: JSON.stringify(body),
});

test('runtime config includes the public key and omits the service key', async () => {
  const response = await worker.fetch(new Request(origin + '/api/auth/config'), env);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { url: env.SUPABASE_URL, key: env.SUPABASE_PUBLISHABLE_KEY, hasUsername: true });
  const missing = await worker.fetch(new Request(origin + '/api/auth/config'), {});
  assert.equal(missing.status, 503);
  const asset = await worker.fetch(new Request(origin + '/builtin.json'), env);
  assert.equal(await asset.text(), 'sample asset');
});

test('invalid origin, input and rate limit are rejected before upstream auth', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected upstream call'); });
  const body = { username: 'my_name', password: 'example' };
  assert.equal((await worker.fetch(login(body, 'https://other.example'), env)).status, 403);
  assert.equal((await worker.fetch(login({ ...body, username: 'invalid email@example.com' }), env)).status, 400);
  assert.equal((await worker.fetch(login({ ...body, password: 'a'.repeat(4500) }), env)).status, 400);
  assert.equal((await worker.fetch(login(body), { ...env, SUPABASE_SECRET_KEY: '' })).status, 503);
  assert.equal((await worker.fetch(login(body), { ...env, USERNAME_RATE_LIMIT: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal(upstream.mock.callCount(), 0);
});

test('username sign-in delegates to Supabase and returns only session tokens', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, env.SUPABASE_URL);
    const body = JSON.parse(options.body);
    if (url.endsWith('/rpc/dicta_login_email')) {
      assert.deepEqual(body, { p_username: 'my_name' });
      assert.equal(options.headers.apikey, env.SUPABASE_SECRET_KEY);
      return Response.json('test@example.com');
    }
    assert.equal(options.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.deepEqual(body, { email: 'test@example.com', password: 'test-password' });
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', user: { email: 'test@example.com' } });
  });
  const response = await worker.fetch(login({ username: 'My_Name', password: 'test-password' }), env);
  assert.equal(upstream.mock.callCount(), 2);
  assert.deepEqual(await response.json(), { access_token: 'test-access', refresh_token: 'test-refresh' });
});

test('unknown usernames and incorrect passwords render the same response', async (t) => {
  let found = false;
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/rpc/dicta_login_email')
    ? Response.json(found ? 'test@example.com' : null)
    : Response.json({ msg: 'invalid credentials' }, { status: 400 }));
  const body = { username: 'my_name', password: 'wrong-password' };
  const missing = await worker.fetch(login(body), env);
  found = true;
  const wrong = await worker.fetch(login(body), env);
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await missing.json(), await wrong.json());
});
