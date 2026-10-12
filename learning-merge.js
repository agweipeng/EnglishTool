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

  // Words from a backup, a Sync Code or another device are data, not trusted: numbers must be numbers, text
  // must be text and lists must hold text, so nothing odd can reach the page or break it. A word that is
  // already clean is returned as it is.
  const NUMBER_FIELDS = ['level', 'interval', 'ease', 'rightCount', 'wrongCount', 'nextReview'];
  const TEXT_FIELDS = ['phonetic', 'defEN', 'defCN', 'createdAt', 'updatedAt'];
  const LIST_FIELDS = ['tags', 'synonyms', 'antonyms', 'family', 'collocations'];
  const asText = value => (typeof value === 'string' ? value : '');
  const isTextList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  function cleanWord(word) {
    const badKeys = [
      ...NUMBER_FIELDS.filter(key => key in word && !Number.isFinite(word[key])),
      ...TEXT_FIELDS.filter(key => key in word && typeof word[key] !== 'string'),
      ...('archivedAt' in word && word.archivedAt !== null && typeof word.archivedAt !== 'string' ? ['archivedAt'] : []),
    ];
    const badLists = LIST_FIELDS.filter(key => key in word && !isTextList(word[key]));
    const badExamples = 'examples' in word && !(Array.isArray(word.examples)
      && word.examples.every(ex => ex && typeof ex === 'object' && typeof ex.en === 'string' && typeof ex.cn === 'string'));
    if (!badKeys.length && !badLists.length && !badExamples) return word;
    const clean = Object.fromEntries(Object.entries(word).filter(([key]) => !badKeys.includes(key)));
    badLists.forEach(key => { clean[key] = list(word[key]).filter(item => typeof item === 'string'); });
    if (badExamples) {
      clean.examples = list(word.examples).filter(ex => ex && typeof ex === 'object')
        .map(ex => ({ ...ex, en: asText(ex.en), cn: asText(ex.cn) }));
    }
    return clean;
  }
  const cleanWords = words => list(words).filter(isWord).map(cleanWord);

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

  // Keeps the best word of each key (`isBetter(a, b)`: a beats b); `losers` collects the others
  function bestBy(words, keyOf, isBetter, losers = []) {
    const byKey = new Map();
    for (const word of words) {
      const key = keyOf(word);
      const current = byKey.get(key);
      if (!current) byKey.set(key, word);
      else if (isBetter(word, current)) { losers.push(current); byKey.set(key, word); }
      else losers.push(word);
    }
    return [...byKey.values()];
  }
  const isNewer = (a, b) => wordEditTs(a) > wordEditTs(b);
  // Between two copies of the same word: more reviews (progress) first, then the newer edit, then the id,
  // so every device picks the same one
  const reviews = word => (word.rightCount || 0) + (word.wrongCount || 0);
  const isBetterCopy = (a, b) => (reviews(a) !== reviews(b) ? reviews(a) > reviews(b)
    : wordEditTs(a) !== wordEditTs(b) ? isNewer(a, b) : String(a.id) < String(b.id));
  const textKey = word => word.text.trim().toLowerCase();
  const laterTs = (a, b) => (a > b ? a : b);

  // { words, deletedWords }: the newer edit of each word wins, and a word deleted after its last edit stays deleted.
  // The same word added on two devices has two ids; one copy is kept (see isBetterCopy) and the other
  // recorded as deleted, so every device ends up with the same one.
  function mergeWords(local, remote) {
    const deletions = mergeDeletions(local.deletedWords, remote.deletedWords);
    const isDeleted = word => isId(word.id) && own(deletions, word.id) && deletions[word.id] >= wordEditTs(word);
    const live = bestBy(cleanWords([...list(local.words), ...list(remote.words)]), wordKey, isNewer).filter(word => !isDeleted(word));
    const duplicates = [];
    const words = bestBy(live, textKey, isBetterCopy, duplicates);
    const winners = new Map(words.map(word => [textKey(word), word]));
    const extra = duplicates.filter(word => isId(word.id))
      .map(word => [word.id, laterTs(wordEditTs(word), wordEditTs(winners.get(textKey(word))))]);
    return { words, deletedWords: mergeDeletions(deletions, Object.fromEntries(extra)) };
  }

  // Review counts per day and the streak. The bigger count of each day and the newest streak win. After a
  // Reset All (`resetAt`) only progress from the reset day on counts, on this device and every other one.
  const isStreak = streak => !!streak && typeof streak === 'object' && Number.isInteger(streak.current) && streak.current >= 0
    && (streak.lastDay === null || (typeof streak.lastDay === 'string' && DATE_KEY.test(streak.lastDay)));
  function mergeProgress(local, remote) {
    const resetOf = data => (isTimestamp(data.resetAt) ? data.resetAt : '');
    const resetAt = laterTs(resetOf(local), resetOf(remote));
    // Review days are local dates, so the reset day is too
    const reset = new Date(resetAt);
    const resetDay = resetAt ? [reset.getFullYear(), reset.getMonth() + 1, reset.getDate()]
      .map((part, i) => String(part).padStart(i ? 2 : 4, '0')).join('-') : '';
    const counts = side => (resetOf(side) === resetAt ? true : (date => date >= resetDay));
    const activity = {};
    for (const side of [local, remote]) {
      const keep = counts(side);
      for (const [date, count] of entries(side.activity)) {
        if (DATE_KEY.test(date) && Number.isFinite(count) && (keep === true || keep(date))) activity[date] = Math.max(activity[date] || 0, count);
      }
    }
    const streaks = [local, remote].filter(side => isStreak(side.streak)
      && (resetOf(side) === resetAt || (side.streak.lastDay || '') >= resetDay)).map(side => side.streak);
    const streak = streaks.reduce((best, next) => ((next.lastDay || '') > (best.lastDay || '') ? next : best),
      streaks[0] || { current: 0, lastDay: null });
    return { activity, streak: { current: streak.current, lastDay: streak.lastDay }, resetAt };
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

  const api = { mergeWords, mergeProgress, deleteWords, restoreWords, mergeJournal, setJournalEntry, cleanWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LearningMerge = api;
})(typeof window !== 'undefined' ? window : globalThis);
