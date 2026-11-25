import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineSession } from '../dist/online-session.js';

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: i => [...values.keys()][i] ?? null,
    setItem: (key, val) => values.set(key, val),
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key),
  };
}

const sample = { id: 'sample', title: 'Sample' };
const grade = { progress: { sample: { index: 0, answers: { 0: {
  text: 'hello', checkedText: 'hello', score: 100, checks: 1, gradedAt: 100,
} } } } };

function fixture(overrides = {}) {
  let account = 'a';
  const tabStorage = storage();
  const accountStorage = storage();
  const options = {
    tabStorage, accountStorage, getAccountId: () => account,
    readSamples: async () => [sample], readPrivateLessons: async () => [{ id: 'private' }],
    readRemoteState: async () => ({}),
    sendChanges: async changes => changes.map(change => change.id),
    ...overrides,
  };
  return { options, session: createOnlineSession(options), setAccount: next => { account = next; } };
}

test('failed private reads preserve access to samples and cached pending progress', async () => {
  const offline = () => Promise.reject(new Error('offline'));
  const f = fixture({ readPrivateLessons: offline, readRemoteState: offline, sendChanges: offline });
  assert.deepEqual(await f.session.loadOnlineSession(), { status: 'degraded', library: [sample], state: {} });
  f.session.setBaseline({});
  f.session.recordState(grade);
  assert.equal(await f.session.flushProgress(), false);
  const reopened = createOnlineSession(f.options);
  const data = await reopened.loadOnlineSession();
  assert.equal(data.state.progress.sample.answers['0'].score, 100);
  f.setAccount('b');
  assert.deepEqual((await createOnlineSession(f.options).loadOnlineSession()).state, {});
});

test('guest progress stays in one tab and importing retains it until cloud acknowledgement', async () => {
  let offline = true;
  const batches = [];
  const f = fixture({ sendChanges: async (changes, owner) => {
    assert.equal(owner, 'a');
    batches.push(changes.map(change => change.id));
    if (offline) throw new Error('offline');
    return changes.map(change => change.id);
  } });
  f.setAccount(null);
  await f.session.loadOnlineSession();
  f.session.setBaseline({});
  f.session.recordState(grade);
  assert.deepEqual((await createOnlineSession(f.options).loadOnlineSession()).state, grade);
  assert.deepEqual((await createOnlineSession({ ...f.options, tabStorage: storage() }).loadOnlineSession()).state, {});
  f.setAccount('a');
  const signedIn = createOnlineSession(f.options);
  assert.equal(await signedIn.importGuestProgress(), false);
  assert.equal(signedIn.hasGuestProgress(), true);
  offline = false;
  const reopened = createOnlineSession(f.options);
  assert.equal(await reopened.flushProgress(), true);
  assert.equal(reopened.hasGuestProgress(), false);
  assert.deepEqual(batches[0], batches[1]);
});

test('a previous account cannot acknowledge or send changes after the session switches', async () => {
  const sent = [];
  const f = fixture({ sendChanges: async (changes, owner) => {
    sent.push(owner);
    return changes.map(change => change.id);
  } });
  f.session.setBaseline({});
  f.session.recordState(grade);
  f.setAccount('b');
  assert.equal(await f.session.flushProgress(), false);
  assert.deepEqual(sent, []);
  f.setAccount('a');
  assert.equal(await f.session.flushProgress(), true);
  assert.deepEqual(sent, ['a']);
});

test('acknowledging a guest import cannot erase guest practice started after sign-out', async () => {
  let online = false;
  const f = fixture({ sendChanges: async changes => {
    if (!online) throw new Error('offline');
    return changes.map(change => change.id);
  } });
  f.setAccount(null);
  const firstGuest = createOnlineSession(f.options);
  firstGuest.recordState(grade);
  f.setAccount('a');
  assert.equal(await createOnlineSession(f.options).importGuestProgress(), false);
  f.setAccount(null);
  const newGuest = createOnlineSession(f.options);
  const later = { progress: { later: { index: 0, answers: { 0: {
    text: 'later', checkedText: 'later', score: 100, checks: 1, gradedAt: 200,
  } } } } };
  newGuest.recordState(later);
  f.setAccount('a');
  online = true;
  assert.equal(await createOnlineSession(f.options).flushProgress(), true);
  f.setAccount(null);
  assert.deepEqual((await createOnlineSession(f.options).loadOnlineSession()).state, later);
});
