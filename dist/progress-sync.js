const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const distinct = (a, b) => new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
const gradeFields = ['gradedAt', 'checkedText', 'score', 'checks', 'firstScore', 'firstAssisted'];
const answerFields = ['text', 'hints', 'revealed', 'range'];
const select = (value, keys) => Object.fromEntries(keys.filter(key => own(value, key)).map(key => [key, value[key]]));
const safeKey = key => typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key);

export function diffProgress(before, after, { now = Date.now, id = () => crypto.randomUUID() } = {}) {
  const changes = [];
  const put = (kind, key, value, at = now()) => changes.push({ kind, key, value, at, id: id() });
  for (const lesson of Object.keys(after.progress ?? {})) {
    const old = before.progress?.[lesson] ?? {};
    const next = after.progress[lesson];
    if (next.index !== undefined && old.index !== next.index) put('position', [lesson], next.index);
    for (const cue of Object.keys(next.answers ?? {})) {
      const answer = next.answers[cue];
      const previous = old.answers?.[cue] ?? {};
      const draft = select(answer, answerFields);
      const checked = select(answer, gradeFields);
      if (!same(draft, select(previous, answerFields))) put('answer', [lesson, cue], draft, answer.editedAt ?? answer.gradedAt ?? now());
      if (checked.checks && (!previous.checks || checked.gradedAt !== previous.gradedAt)) {
        put('grade', [lesson, cue], checked, checked.gradedAt || 1);
      }
    }
  }
  for (const key of Object.keys(after.settings ?? {})) {
    if (!same(before.settings?.[key], after.settings[key])) put('setting', [key], after.settings[key]);
  }
  const currentWords = new Map((before.words ?? []).map(word => [word.id, word]));
  for (const word of after.words ?? []) {
    if (!same(currentWords.get(word.id), word)) put('word', [word.id], word);
    currentWords.delete(word.id);
  }
  for (const key of currentWords.keys()) put('word', [key], null);
  for (const day of distinct(before.days, after.days)) {
    const old = before.days?.[day] ?? {};
    const next = after.days?.[day] ?? {};
    const seconds = Math.max(0, (next.seconds ?? 0) - (old.seconds ?? 0));
    const checks = Math.max(0, (next.checks ?? 0) - (old.checks ?? 0));
    if (seconds || checks) put('day', [day], { seconds, checks });
  }
  if (after.lastLesson && after.lastLesson !== before.lastLesson) put('lastLesson', [], after.lastLesson);
  return changes;
}

export function compareChanges(a, b) {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function applyProgress(snapshot, changes, { includeCounters = true } = {}) {
  const state = structuredClone(snapshot);
  const seen = new Set();
  for (const change of [...changes].sort(compareChanges)) {
    const { id, kind, key, value, at } = change;
    if (seen.has(id) || !key.every(safeKey)) continue;
    seen.add(id);
    const [first, second] = key;
    if (kind === 'setting') (state.settings ??= {})[first] = value;
    else if (kind === 'lastLesson') state.lastLesson = value;
    else if (kind === 'word') {
      state.words = (state.words ?? []).filter(word => word.id !== first);
      if (value !== null) state.words.push(value);
    } else if (kind === 'day' && includeCounters) {
      const day = (state.days ??= {})[first] ??= {};
      day.seconds = (day.seconds ?? 0) + value.seconds;
      day.checks = (day.checks ?? 0) + value.checks;
    } else if (kind === 'position' || kind === 'grade' || kind === 'answer') {
      const lesson = (state.progress ??= {})[first] ??= { index: 0, answers: {} };
      if (kind === 'position') lesson.index = value;
      else {
        const answer = (lesson.answers ??= {})[second] ??= { text: '', checks: 0, hints: 0, revealed: false };
        if (kind === 'grade' && (answer.gradedAt || 0) <= at) {
          Object.assign(answer, value, { gradedAt: at });
        }
        if (kind === 'answer') Object.assign(answer, value);
      }
    }
  }
  return state;
}

export function createProgressQueue(storage) {
  const prefix = accountId => 'dicta:progress:' + encodeURIComponent(accountId) + ':';
  const keyFor = (accountId, id) => prefix(accountId) + id;

  function pending(accountId) {
    const result = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix(accountId))) continue;
      try {
        const change = JSON.parse(storage.getItem(key));
        if (change?.id && Array.isArray(change.key)) result.push(change);
      } catch {
        // One corrupt record must not suppress another queued change.
      }
    }
    return result.sort(compareChanges);
  }

  return {
    pending,
    recordChange(accountId, change) {
      storage.setItem(keyFor(accountId, change.id), JSON.stringify(change));
    },
    async flushProgress(accountId, send) {
      const queue = pending(accountId);
      while (queue.length) {
        const batch = queue.splice(0, 25);
        const acknowledged = new Set(await send(batch));
        for (const change of batch) {
          if (acknowledged.has(change.id)) storage.removeItem(keyFor(accountId, change.id));
        }
        if (batch.some(change => !acknowledged.has(change.id))) return false;
      }
      return true;
    },
  };
}
