/* Per-book progress. Chapter IDs survive catalog/chapter reordering. */
(function (root) {
  'use strict';
  const KEY = 'englishTrainerBookmarks_v1';
  const LAST_KEY = 'englishTrainerLastBook_v1';
  const validId = id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
  function normalizeLast(last) {
    return {
      id: validId(last?.id) ? last.id : '',
      updatedAt: typeof last?.updatedAt === 'string' && Number.isFinite(Date.parse(last.updatedAt))
        ? last.updatedAt : '1970-01-01T00:00:00.000Z',
    };
  }
  function normalize(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (!validId(record.chapterId) && !Number.isInteger(record.chapterIndex)) return null;
    return {
      chapterId: validId(record.chapterId) ? record.chapterId : '',
      chapterIndex: Number.isInteger(record.chapterIndex) ? Math.max(0, record.chapterIndex) : 0,
      scrollRatio: Number.isFinite(record.scrollRatio) ? Math.max(0, Math.min(1, record.scrollRatio)) : 0,
      characterOffset: Number.isInteger(record.characterOffset) && record.characterOffset >= 0 ? record.characterOffset : null,
      anchor: typeof record.anchor === 'string' ? record.anchor.slice(0, 100) : '',
      chapterVersion: typeof record.chapterVersion === 'string' ? record.chapterVersion.slice(0, 64) : '',
      updatedAt: typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : '1970-01-01T00:00:00.000Z',
    };
  }
  function validateSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 2 || !snapshot.bookmarks || typeof snapshot.bookmarks !== 'object'
      || Array.isArray(snapshot.bookmarks) || !snapshot.lastBook || typeof snapshot.lastBook !== 'object'
      || Array.isArray(snapshot.lastBook)) {
      throw new Error('Invalid reading-progress backup');
    }
    const bookmarks = Object.create(null);
    for (const [id, record] of Object.entries(snapshot.bookmarks)) {
      if (!validId(id) || !normalize(record)) throw new Error('Invalid book bookmark in backup');
      bookmarks[id] = normalize(record);
    }
    const last = snapshot.lastBook;
    if (last.id && !validId(last.id)) throw new Error('Invalid last book in backup');
    return { version: 2, bookmarks, lastBook: normalizeLast(last) };
  }
  function createStore(storage) {
    const read = key => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
    function bookmarks() {
      const saved = read(KEY);
      const result = Object.create(null);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, record] of Object.entries(saved)) if (validId(id) && normalize(record)) result[id] = normalize(record);
      }
      return result;
    }
    function lastBook() {
      return normalizeLast(read(LAST_KEY));
    }
    function get(book) {
      const saved = bookmarks()[book.id] || {};
      let index = book.chapters.findIndex(chapter => chapter.id === saved.chapterId);
      if (index < 0 && saved.chapterId) return { chapterIndex: 0, chapterId: book.chapters[0].id, scrollRatio: 0 };
      if (index < 0) index = saved.chapterId ? 0 : Math.min(book.chapters.length - 1, saved.chapterIndex || 0);
      return { ...saved, chapterIndex: index, chapterId: book.chapters[index].id, scrollRatio: saved.scrollRatio || 0 };
    }
    function write(id, record) {
      if (!validId(id) || !normalize(record)) return false;
      try { const saved = bookmarks(); saved[id] = normalize(record); storage.setItem(KEY, JSON.stringify(saved)); return true; }
      catch (error) { console.warn('Book bookmark not saved', error); return false; }
    }
    function remember(id) {
      if (!validId(id)) return;
      try { storage.setItem(LAST_KEY, JSON.stringify({ id, updatedAt: new Date().toISOString() })); } catch {}
    }
    function snapshot() { return { version: 2, bookmarks: bookmarks(), lastBook: lastBook() }; }
    function merge(input) {
      const incoming = validateSnapshot(input);
      const saved = bookmarks();
      for (const [id, record] of Object.entries(incoming.bookmarks)) {
        if (!saved[id] || Date.parse(record.updatedAt) > Date.parse(saved[id].updatedAt)) saved[id] = record;
      }
      const previous = [storage.getItem(KEY), storage.getItem(LAST_KEY)];
      const updateLast = Date.parse(incoming.lastBook.updatedAt) > Date.parse(lastBook().updatedAt);
      try {
        storage.setItem(KEY, JSON.stringify(saved));
        if (updateLast) storage.setItem(LAST_KEY, JSON.stringify(incoming.lastBook));
      } catch (error) {
        // Both records belong to one import. Restore the previous values if the
        // second write fails (for example, because browser storage is full).
        try {
          [KEY, LAST_KEY].forEach((key, index) => {
            if (previous[index] == null) storage.removeItem(key);
            else storage.setItem(key, previous[index]);
          });
        } catch (rollbackError) { console.warn('Could not roll back reading-progress import', rollbackError); }
        throw error;
      }
    }
    return { bookmarks, lastBook, get, write, remember, snapshot, merge };
  }
  const api = { createStore, validateSnapshot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReaderProgress = api;
})(typeof window !== 'undefined' ? window : globalThis);
