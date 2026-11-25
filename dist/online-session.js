import { applyProgress, createProgressQueue, diffProgress } from './progress-sync.js';

const guestKey = 'dicta:online:guest';
const importKey = owner => 'dicta:online:guest-import:' + owner;

function json(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function createOnlineSession({ tabStorage, accountStorage, getAccountId,
  readSamples, readPrivateLessons, readRemoteState, sendChanges }) {
  const slotKey = 'dicta:online:tab';
  const slot = tabStorage.getItem(slotKey) || crypto.randomUUID();
  tabStorage.setItem(slotKey, slot);
  const queue = createProgressQueue(accountStorage, slot);
  const cacheKey = accountId => 'dicta:online:cache:' + accountId;
  let ownerId = getAccountId();
  let baseline = {};
  let inFlight = null;
  const legacyGuest = json(accountStorage, guestKey, null);
  if (legacyGuest) {
    if (!tabStorage.getItem(guestKey)) tabStorage.setItem(guestKey, JSON.stringify(legacyGuest));
    accountStorage.removeItem(guestKey);
  }

  function cache(owner, state) {
    try { accountStorage.setItem(cacheKey(owner), JSON.stringify(state)); } catch { /* the queue is the durable write */ }
  }

  function hasGuestDraft() {
    const guest = json(tabStorage, guestKey, {});
    return Object.keys(guest.progress ?? {}).length > 0 || Object.keys(guest.days ?? {}).length > 0;
  }

  return {
    hasGuestProgress() { return hasGuestDraft() || !!(ownerId && tabStorage.getItem(importKey(ownerId))); },
    shouldOfferGuestImport() {
      return !!ownerId && hasGuestDraft() && !tabStorage.getItem(importKey(ownerId)) &&
        !tabStorage.getItem(guestKey + ':declined:' + ownerId);
    },
    declineGuestImport() {
      if (ownerId) tabStorage.setItem(guestKey + ':declined:' + ownerId, 'true');
    },
    setBaseline(state) {
      baseline = structuredClone(state);
    },
    hasPending() {
      return !!ownerId && (queue.pending(ownerId).length > 0 || !!tabStorage.getItem(importKey(ownerId)));
    },
    async loadOnlineSession() {
      const owner = getAccountId();
      ownerId = owner;
      const samples = readSamples();
      if (!owner) return { status: 'ready', library: await samples, state: json(tabStorage, guestKey, {}) };
      const [lessons, remote] = await Promise.allSettled([readPrivateLessons(owner), readRemoteState(owner)]);
      if (getAccountId() !== owner) throw new Error('Phiên đăng nhập vừa thay đổi. Hãy tải lại trang.');
      const stored = remote.status === 'fulfilled' ? remote.value : json(accountStorage, cacheKey(owner), {});
      const state = applyProgress(stored, queue.pending(owner), { includeCounters: false });
      cache(owner, state);
      return {
        status: lessons.status === 'fulfilled' && remote.status === 'fulfilled' ? 'ready' : 'degraded',
        library: [...await samples, ...(lessons.status === 'fulfilled' ? lessons.value : [])],
        state,
      };
    },
    recordState(state) {
      if (getAccountId() !== ownerId) return false;
      if (ownerId) {
        queue.recordChanges(ownerId, diffProgress(baseline, state));
        cache(ownerId, state);
      } else {
        tabStorage.setItem(guestKey, JSON.stringify(state));
      }
      baseline = structuredClone(state);
      return true;
    },
    async flushProgress() {
      const owner = ownerId;
      if (!owner || owner !== getAccountId()) return false;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const importing = json(tabStorage, importKey(owner), null);
          if (importing) {
            queue.recordChanges(owner, importing.changes);
          }
          const flushed = await queue.flushProgress(owner, async changes => {
            if (getAccountId() !== owner) return [];
            const result = await sendChanges(changes, owner);
            return getAccountId() === owner ? result : [];
          });
          if (flushed && importing && getAccountId() === owner) {
            tabStorage.removeItem(importKey(owner));
          }
          return flushed;
        } catch {
          return false;
        }
      })();
      try { return await inFlight; }
      finally { inFlight = null; }
    },
    async importGuestProgress() {
      if (inFlight) await inFlight;
      if (!ownerId || getAccountId() !== ownerId || !this.hasGuestProgress()) return false;
      let importing = json(tabStorage, importKey(ownerId), null);
      if (!importing) {
        const { progress, days } = json(tabStorage, guestKey, {});
        importing = { changes: diffProgress({}, { progress, days }) };
        tabStorage.setItem(importKey(ownerId), JSON.stringify(importing));
        tabStorage.removeItem(guestKey);
      }
      return this.flushProgress();
    },
  };
}
