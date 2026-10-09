/* Saved reading materials (state.materials): transcripts and articles you paste, such as
   BBC Learning English episodes. They stay private to you but sync and back up with your
   learning data. Pure list logic shared by the browser and tests. */
(function (root) {
  'use strict';
  const SyncedList = typeof module !== 'undefined' && module.exports ? require('./synced-list.js') : root.SyncedList;
  const MAX_MATERIALS = 50;
  // Plenty for a transcript or article, and keeps Gist sync small
  const MAX_MATERIAL_CHARS = 60000;
  const TYPES = ['book', 'news', 'conversation', 'other'];
  const isText = value => typeof value === 'string';
  const titleKey = title => String(title || '').trim().toLocaleLowerCase();

  function createEntry({ title, type, sourceUrl = '', text }, now, id) {
    return { id, createdAt: now, updatedAt: now, title: title.trim(), type: TYPES.includes(type) ? type : 'other',
      sourceUrl, text: text.trim() };
  }

  const list = SyncedList.create(entry => isText(entry.title) && !!entry.title.trim()
    && isText(entry.text) && !!entry.text.trim() && entry.text.length <= MAX_MATERIAL_CHARS
    && TYPES.includes(entry.type) && isText(entry.sourceUrl) && (!entry.sourceUrl || /^https?:\/\//.test(entry.sourceUrl)));

  // Saving a title that is already on the shelf updates that material
  const upsert = (entries, entry) => list.upsert(entries, entry, (a, b) => titleKey(a.title) === titleKey(b.title));
  const { remove, merge } = list;
  const visible = entries => list.live(entries);
  // A full shelf still accepts updates to a title it already has
  const isFull = (entries, title) => {
    const current = visible(entries);
    return current.length >= MAX_MATERIALS && !current.some(entry => titleKey(entry.title) === titleKey(title));
  };

  const api = { MAX_MATERIALS, MAX_MATERIAL_CHARS, createEntry, upsert, remove, merge, visible, isFull };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MaterialStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
