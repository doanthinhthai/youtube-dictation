import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/auth.mjs';

const origin = 'https://dicta.example';
const id = 'bcd00000-0000-4000-8000-000000000003';
const owner = 'bcd00000-0000-4000-8000-000000000001';
const guest = 'bcd00000-0000-4000-8000-000000000002';
const lease = 'bcd00000-0000-4000-8000-000000000004';
const path = owner + '/' + 'a'.repeat(64) + '.mp3';
const env = {
  SUPABASE_URL: 'https://dicta-test.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  ASSETS: { fetch: async () => new Response('asset', { status: 404 }) },
};
const draft = {
  id, title: 'A practice lesson', transcript: 'Good morning.',
  segments: [{ text: 'Good morning.', start: null, end: null }],
};
const json = (value, init) => new Request(origin + '/api/lessons' + (init.path ?? ''), {
  method: init.method ?? 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
  body: value === undefined ? undefined : JSON.stringify(value),
});
const upload = body => new Request(origin + '/api/lessons/' + id + '/audio', {
  method: 'PUT', body: Uint8Array.from(body), headers: { Origin: origin, 'Content-Type': 'audio/mpeg',
    'Content-Length': String(body.length), Authorization: 'Bearer owner-token' },
});

function supabase(t, respond) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/auth/v1/user') {
      return Response.json({ id: init.headers.Authorization === 'Bearer owner-token' ? owner : guest });
    }
    return respond(route, init);
  });
}

test('guest requests cannot reach privileged lesson operations', async t => {
  supabase(t, () => { throw new Error('Unexpected privileged call'); });
  const response = await worker.fetch(json({ ...draft, youtubeId: 'M7lc1UVf-VE' }, {}), env);
  assert.equal(response.status, 401);
});

test('YouTube creates a private lesson without reserving audio bytes', async t => {
  let called = false;
  supabase(t, (route, init) => {
    assert.equal(route, '/rest/v1/rpc/dicta_online_create_lesson');
    const data = JSON.parse(init.body);
    assert.equal(data.p_user, owner);
    assert.equal(data.p_bytes, 0);
    assert.equal(data.p_lesson.youtubeId, 'M7lc1UVf-VE');
    called = true;
    return Response.json({ id, pending: false });
  });
  const response = await worker.fetch(json({ ...draft, youtubeId: 'M7lc1UVf-VE', user_id: guest }, { token: 'owner-token' }), env);
  assert.equal(response.status, 201);
  assert.equal(called, true);
});

test('file larger than account quota and quota errors have distinct outcomes', async t => {
  let calls = 0;
  supabase(t, (route, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).p_bytes, 30000000);
    return Response.json({ code: 'P0001', message: 'PROJECT_AUDIO_QUOTA' }, { status: 400 });
  });
  const tooLarge = await worker.fetch(json({ ...draft, audio: { bytes: 30000001, mime: 'audio/mpeg' } }, { token: 'owner-token' }), env);
  assert.equal(tooLarge.status, 413);
  const full = await worker.fetch(json({ ...draft, audio: { bytes: 30000000, mime: 'audio/mpeg' } }, { token: 'owner-token' }), env);
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'PROJECT_AUDIO_QUOTA');
  assert.equal(calls, 1);
});

test('audio is streamed only at the reserved size and the verified upload is finalized', async t => {
  const seen = [];
  supabase(t, async (route, init) => {
    seen.push(route);
    if (route.endsWith('dicta_online_begin_upload')) return Response.json({ audioPath: path, bytes: 4, lease });
    if (route.startsWith('/storage/v1/object/')) {
      const read = new Response(init.body);
      assert.deepEqual(new Uint8Array(await read.arrayBuffer()), Uint8Array.from([73, 68, 51, 0]));
      return Response.json({ Key: path });
    }
    if (route.endsWith('dicta_online_finish_upload')) {
      assert.equal(JSON.parse(init.body).p_lease, lease);
      return Response.json({ id, pending: false });
    }
    throw new Error('Unexpected call ' + route);
  });
  assert.equal((await worker.fetch(upload([73, 68, 51, 0]), env)).status, 200);
  assert.equal(seen.length, 3);
});

test('incorrect upload size releases its reservation and never writes audio', async t => {
  const seen = [];
  supabase(t, route => {
    seen.push(route);
    if (route.endsWith('dicta_online_begin_upload')) return Response.json({ audioPath: path, bytes: 4, lease });
    if (route.endsWith('dicta_online_abort_upload')) return Response.json(true);
    throw new Error('Unexpected call ' + route);
  });
  assert.equal((await worker.fetch(upload([73, 68, 51]), env)).status, 422);
  assert.equal(seen.length, 2);
});

test('a lost upload response never deletes audio that Storage already committed', async t => {
  let verified = false;
  supabase(t, async (route, init) => {
    if (route.endsWith('dicta_online_begin_upload')) return Response.json({ audioPath: path, bytes: 4, lease });
    if (route.startsWith('/storage/v1/object/') && init.method === 'POST') {
      await new Response(init.body).arrayBuffer();
      return new Response(null, { status: 503 });
    }
    if (route.endsWith('dicta_online_finish_upload')) {
      verified = true;
      return Response.json({ id, pending: false });
    }
    throw new Error('Unexpected call ' + route);
  });
  assert.equal((await worker.fetch(upload([73, 68, 51, 0]), env)).status, 200);
  assert.equal(verified, true);
});

test('a 30 MB request reaches the Storage boundary with every reserved byte', async t => {
  const bytes = 30000000;
  let forwarded = 0;
  supabase(t, async (route, init) => {
    if (route.endsWith('dicta_online_begin_upload')) return Response.json({ audioPath: path, bytes, lease });
    if (route.startsWith('/storage/v1/object/')) {
      for await (const chunk of init.body) forwarded += chunk.byteLength;
      return Response.json({ Key: path });
    }
    if (route.endsWith('dicta_online_finish_upload')) return Response.json({ id, pending: false });
    throw new Error('Unexpected call ' + route);
  });
  const request = new Request(origin + '/api/lessons/' + id + '/audio', {
    method: 'PUT', body: new Uint8Array(bytes), headers: { 'Content-Type': 'audio/mpeg',
      'Content-Length': String(bytes), Authorization: 'Bearer owner-token' },
  });
  assert.equal((await worker.fetch(request, env)).status, 200);
  assert.equal(forwarded, bytes);
});

test('deletion identifies the actor from the session and does not delete another account audio', async t => {
  let checked = false;
  supabase(t, (route, init) => {
    assert.equal(route, '/rest/v1/rpc/dicta_online_begin_delete');
    assert.equal(JSON.parse(init.body).p_user, guest);
    checked = true;
    return Response.json({ code: 'P0001', message: 'LESSON_NOT_FOUND' }, { status: 400 });
  });
  const response = await worker.fetch(json(undefined, { token: 'guest-token', method: 'DELETE', path: '/' + id }), env);
  assert.equal(response.status, 404);
  assert.equal(checked, true);
});
