import { applyProgress, createProgressQueue, diffProgress } from './progress-sync.js';

const guestKey = 'dicta:online:guest';
const importKey = 'dicta:online:guest-import';

function json(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function createOnlineSession({ tabStorage, accountStorage, getAccountId,
  readSamples, readPrivateLessons, readRemoteState, sendChanges }) {
  const queue = createProgressQueue(accountStorage);
  const cacheKey = accountId => 'dicta:online:cache:' + accountId;
  let ownerId = getAccountId();
  let baseline = {};
  let inFlight = null;

  function cache(owner, state) {
    try { accountStorage.setItem(cacheKey(owner), JSON.stringify(state)); } catch { /* the queue is the durable write */ }
  }

  function hasGuestProgress() {
    const guest = json(tabStorage, guestKey, {});
    return Object.keys(guest.progress ?? {}).length > 0 || Object.keys(guest.days ?? {}).length > 0;
  }

  return {
    hasGuestProgress,
    shouldOfferGuestImport() {
      return !!ownerId && hasGuestProgress() && !tabStorage.getItem(importKey) &&
        !tabStorage.getItem(guestKey + ':declined:' + ownerId);
    },
    declineGuestImport() {
      if (ownerId) tabStorage.setItem(guestKey + ':declined:' + ownerId, 'true');
    },
    setBaseline(state) {
      baseline = structuredClone(state);
    },
    hasPending() {
      return !!ownerId && queue.pending(ownerId).length > 0;
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
        for (const change of diffProgress(baseline, state)) queue.recordChange(ownerId, change);
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
          const importing = json(tabStorage, importKey, null);
          if (importing?.owner === owner && !queue.pending(owner).length) {
            for (const change of importing.changes) queue.recordChange(owner, change);
          }
          const flushed = await queue.flushProgress(owner, async changes => {
            if (getAccountId() !== owner) return [];
            const result = await sendChanges(changes, owner);
            return getAccountId() === owner ? result : [];
          });
          if (flushed && importing?.owner === owner && getAccountId() === owner) {
            tabStorage.removeItem(guestKey);
            tabStorage.removeItem(importKey);
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
      if (!ownerId || getAccountId() !== ownerId || !hasGuestProgress()) return false;
      let importing = json(tabStorage, importKey, null);
      if (importing && importing.owner !== ownerId) return false;
      if (!importing) {
        const { progress, days } = json(tabStorage, guestKey, {});
        importing = { owner: ownerId, changes: diffProgress({}, { progress, days }) };
        tabStorage.setItem(importKey, JSON.stringify(importing));
      }
      for (const change of importing.changes) queue.recordChange(ownerId, change);
      return this.flushProgress();
    },
  };
}
