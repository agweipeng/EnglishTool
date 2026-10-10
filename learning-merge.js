/* Merge rules for words and journal entries across devices (Gist sync, JSON import).
   Deleting a word or a journal entry leaves its time, so a sync with another device never brings it back;
   for each word or day the newest edit (or deletion) wins. Shared by the browser and the tests. */
(function (root) {
  'use strict';
  const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const isId = value => typeof value === 'string' && !!value && !UNSAFE_KEYS.has(value);
  const entries = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
  const list = value => (Array.isArray(value) ? value : []);
  const own = (object, key) => !!object && typeof object === 'object' && Object.hasOwn(object, key);

  const wordEditTs = word => word.updatedAt || word.createdAt || '';
  const isWord = word => !!word && typeof word === 'object' && typeof word.text === 'string';
  // Words from old backups may have no id; those are matched by their text
  const wordKey = word => (isId(word.id) ? `id:${word.id}` : `text:${word.text.toLowerCase()}`);

  // { id: deletedAt }, keeping the latest deletion of each word
  function mergeDeletions(...logs) {
    const latest = new Map();
    for (const log of logs) {
      for (const [id, at] of entries(log)) {
        if (isId(id) && isTimestamp(at) && !(latest.get(id) >= at)) latest.set(id, at);
      }
    }
    return Object.fromEntries(latest);
  }

  // { words, deletedWords }: the newer edit of each word wins, and a word deleted after its last edit stays deleted
  function mergeWords(local, remote) {
    const deletedWords = mergeDeletions(local.deletedWords, remote.deletedWords);
    const byKey = new Map();
    for (const word of [...list(local.words), ...list(remote.words)]) {
      if (!isWord(word)) continue;
      const key = wordKey(word);
      const current = byKey.get(key);
      if (!current || wordEditTs(word) > wordEditTs(current)) byKey.set(key, word);
    }
    const isDeleted = word => isId(word.id) && own(deletedWords, word.id) && deletedWords[word.id] >= wordEditTs(word);
    return { words: [...byKey.values()].filter(word => !isDeleted(word)), deletedWords };
  }

  // Removes words and remembers when, so other devices drop them too
  function deleteWords(data, ids, now) {
    const gone = new Set(ids);
    return {
      words: list(data.words).filter(word => !gone.has(word?.id)),
      deletedWords: mergeDeletions(data.deletedWords, Object.fromEntries([...gone].filter(isId).map(id => [id, now]))),
    };
  }

  // Words brought back on purpose (a backup import, a Sync Code) no longer count as deleted. A word that was
  // deleted gets a new edit time, so it also beats the deletion other devices (and the gist) still have.
  function restoreWords(data, ids, now) {
    const deleted = mergeDeletions(data.deletedWords);
    const back = new Set(ids);
    const wasDeleted = word => isWord(word) && isId(word.id) && back.has(word.id) && own(deleted, word.id);
    return {
      words: list(data.words).map(word => (wasDeleted(word) ? { ...word, updatedAt: now } : word)),
      deletedWords: Object.fromEntries(entries(deleted).filter(([id]) => !back.has(id))),
    };
  }

  function journalSide(data, date) {
    const text = own(data.journal, date) && typeof data.journal[date] === 'string' ? data.journal[date] : '';
    const at = own(data.journalLog, date) && isTimestamp(data.journalLog[date]) ? data.journalLog[date] : '';
    return { text, at };
  }

  // { journal, journalLog }: per day the newest edit or deletion wins. Entries saved by older versions of the
  // app have no time; between two of those the longer text wins, as before.
  function mergeJournal(local, remote) {
    const dates = new Set([local.journal, local.journalLog, remote.journal, remote.journalLog]
      .flatMap(log => entries(log).map(([date]) => date)).filter(date => DATE_KEY.test(date)));
    const journal = [];
    const journalLog = [];
    for (const date of [...dates].sort()) {
      const mine = journalSide(local, date);
      const theirs = journalSide(remote, date);
      const winner = mine.at || theirs.at ? (theirs.at > mine.at ? theirs : mine)
        : (theirs.text.length > mine.text.length ? theirs : mine);
      if (winner.text.trim()) journal.push([date, winner.text]);
      if (winner.at) journalLog.push([date, winner.at]);
    }
    return { journal: Object.fromEntries(journal), journalLog: Object.fromEntries(journalLog) };
  }

  // Days in date order, the same order mergeJournal gives, so an unchanged sync compares equal
  const byDate = pairs => Object.fromEntries(pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  // Saves (or, for blank text, deletes) one day's entry and records when
  function setJournalEntry(data, date, text, now) {
    const others = log => entries(log).filter(([day]) => day !== date);
    const saved = String(text || '').trim() ? [[date, text]] : [];
    return { journal: byDate([...others(data.journal), ...saved]), journalLog: byDate([...others(data.journalLog), [date, now]]) };
  }

  const api = { mergeWords, deleteWords, restoreWords, mergeJournal, setJournalEntry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LearningMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
