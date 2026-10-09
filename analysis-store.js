/* Saved AI passage analyses (state.analyses): pure list logic shared by the browser and tests.
   A deleted analysis becomes a small tombstone so Gist sync doesn't bring it back. */
(function (root) {
  'use strict';
  const SyncedList = typeof module !== 'undefined' && module.exports ? require('./synced-list.js') : root.SyncedList;
  const isText = value => typeof value === 'string';
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();

  function createEntry({ text, title = '', chapter = '', bookId = '', chapterId = '', kind = 'book', model = '', result }, now, id) {
    return { id, createdAt: now, updatedAt: now, text: text.trim(), title, chapter, bookId, chapterId, kind, model, result };
  }

  // A live analysis needs its passage and a result object; tombstones and malformed entries are handled by SyncedList
  const list = SyncedList.create(entry => isText(entry.text) && !!entry.text.trim()
    && !!entry.result && typeof entry.result === 'object' && !Array.isArray(entry.result));
  const samePassage = (a, b) => (a.bookId || '') === (b.bookId || '') && normalize(a.text) === normalize(b.text);

  // Re-analysing the same passage replaces the earlier copy and keeps its id
  const upsert = (entries, entry) => list.upsert(entries, entry, samePassage);
  const { remove, merge } = list;

  function searchText(entry) {
    const result = entry.result;
    return [entry.text, entry.title, entry.chapter, result.mainPoint?.en, result.mainPoint?.cn, result.simplified?.en,
      ...(Array.isArray(result.words) ? result.words.map(item => item?.text) : []),
      ...(Array.isArray(result.phrases) ? result.phrases.map(item => item?.text) : []),
    ].filter(isText).join(' ').toLowerCase();
  }

  // Live analyses, newest first, optionally filtered by a search phrase
  function visible(entries, query = '') {
    const phrase = normalize(query).toLowerCase();
    return list.live(entries).filter(entry => !phrase || searchText(entry).includes(phrase));
  }

  const api = { createEntry, upsert, remove, merge, visible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnalysisStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
