/* Lists of entries that sync between devices through state (Gist sync, Sync Code, JSON backup).
   Each entry has an id and updatedAt; a deleted entry becomes a small tombstone so sync
   doesn't bring it back. Shared by saved analyses and saved reading materials. */
(function (root) {
  'use strict';
  const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

  // isLiveEntry checks the fields of a live (not deleted) entry
  function create(isLiveEntry) {
    const isValid = entry => !!entry && typeof entry === 'object' && typeof entry.id === 'string' && !!entry.id
      && isTimestamp(entry.updatedAt) && (entry.deleted === true || isLiveEntry(entry));
    // Anything malformed (e.g. from a damaged backup) is dropped
    const valid = list => (Array.isArray(list) ? list.filter(isValid) : []);

    // Replaces the live entry that isSame matches, keeping its id and createdAt, and puts it first
    function upsert(list, entry, isSame) {
      const current = valid(list);
      const existing = current.find(saved => !saved.deleted && isSame(saved, entry));
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

    // Live entries, newest first
    const live = list => valid(list).filter(entry => !entry.deleted)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    return { upsert, remove, merge, live };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncedList = api;
})(typeof window !== 'undefined' ? window : globalThis);
