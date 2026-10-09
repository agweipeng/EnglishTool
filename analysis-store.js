/* Saved AI passage analyses (state.analyses): pure list logic shared by the browser and tests.
   A deleted analysis becomes a small tombstone so Gist sync doesn't bring it back. */
(function (root) {
  'use strict';
  const isText = value => typeof value === 'string';
  const isTimestamp = value => isText(value) && Number.isFinite(Date.parse(value));
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();

  function createEntry({ text, title = '', chapter = '', bookId = '', chapterId = '', model = '', result }, now, id) {
    return { id, createdAt: now, updatedAt: now, text: text.trim(), title, chapter, bookId, chapterId, model, result };
  }

  // A live entry or a tombstone; anything else (e.g. from a damaged backup) is dropped
  function isValid(entry) {
    if (!entry || typeof entry !== 'object' || !isText(entry.id) || !entry.id || !isTimestamp(entry.updatedAt)) return false;
    if (entry.deleted === true) return true;
    return isText(entry.text) && !!entry.text.trim()
      && !!entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result);
  }
  const valid = list => (Array.isArray(list) ? list.filter(isValid) : []);
  const samePassage = (a, b) => !a.deleted && (a.bookId || '') === (b.bookId || '') && normalize(a.text) === normalize(b.text);

  // Re-analysing the same passage replaces the earlier copy and keeps its id
  function upsert(list, entry) {
    const current = valid(list);
    const existing = current.find(saved => samePassage(saved, entry));
    const saved = existing ? { ...entry, id: existing.id, createdAt: existing.createdAt } : entry;
    return [saved, ...current.filter(other => other !== existing)];
  }

  function remove(list, id, now) {
    return valid(list).map(entry => (entry.id === id ? { id, updatedAt: now, deleted: true } : entry));
  }

  // Per entry, the newer edit (or deletion) wins
  function merge(local, remote) {
    const byId = new Map();
    for (const entry of [...valid(local), ...valid(remote)]) {
      const current = byId.get(entry.id);
      if (!current || Date.parse(entry.updatedAt) > Date.parse(current.updatedAt)) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  function searchText(entry) {
    const result = entry.result;
    return [entry.text, entry.title, entry.chapter, result.mainPoint?.en, result.mainPoint?.cn, result.simplified?.en,
      ...(Array.isArray(result.words) ? result.words.map(item => item?.text) : []),
      ...(Array.isArray(result.phrases) ? result.phrases.map(item => item?.text) : []),
    ].filter(isText).join(' ').toLowerCase();
  }

  // Live analyses, newest first, optionally filtered by a search phrase
  function visible(list, query = '') {
    const phrase = normalize(query).toLowerCase();
    return valid(list).filter(entry => !entry.deleted && (!phrase || searchText(entry).includes(phrase)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  const api = { createEntry, upsert, remove, merge, visible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnalysisStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
