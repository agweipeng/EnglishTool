'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../learning-merge.js');

const word = (id, updatedAt) => ({ id, text: id, updatedAt });

test('a deleted word stays deleted when the other device still has it', () => {
  const remote = { words: [word('w1', '2026-10-01T00:00:00Z'), word('w2', '2026-10-01T00:00:00Z')] };
  const local = M.deleteWords({ words: [word('w1', '2026-10-01T00:00:00Z'), word('w2', '2026-10-01T00:00:00Z')] }, ['w1'], '2026-10-05T00:00:00Z');
  assert.deepEqual(local.words.map(w => w.id), ['w2']);
  const merged = M.mergeWords(local, remote);
  assert.deepEqual(merged.words.map(w => w.id), ['w2']);
  assert.deepEqual(merged.deletedWords, { w1: '2026-10-05T00:00:00Z' });
  assert.deepEqual(M.mergeWords(remote, local).words.map(w => w.id), ['w2'], 'Either direction');
});

test('a word edited after it was deleted elsewhere comes back; the newer edit of a word wins', () => {
  const deleted = { words: [], deletedWords: { w1: '2026-10-05T00:00:00Z' } };
  const editedLater = { words: [word('w1', '2026-10-06T00:00:00Z')] };
  assert.deepEqual(M.mergeWords(deleted, editedLater).words.map(w => w.updatedAt), ['2026-10-06T00:00:00Z']);
  const older = { words: [{ ...word('w2', '2026-10-01T00:00:00Z'), defEN: 'old' }] };
  const newer = { words: [{ ...word('w2', '2026-10-02T00:00:00Z'), defEN: 'new' }] };
  assert.equal(M.mergeWords(older, newer).words[0].defEN, 'new');
  assert.equal(M.mergeWords(newer, older).words[0].defEN, 'new');
});

test('restored words beat their deletion on every device, not just this one', () => {
  const deletedWords = { w1: '2026-10-05T00:00:00Z', w2: '2026-10-05T00:00:00Z' };
  const restored = M.restoreWords({ words: [word('w1', '2026-10-01T00:00:00Z'), word('w3', '2026-10-01T00:00:00Z')], deletedWords }, ['w1', 'w3'], '2026-10-10T00:00:00Z');
  assert.deepEqual(restored.deletedWords, { w2: '2026-10-05T00:00:00Z' });
  assert.deepEqual(restored.words.map(w => w.updatedAt), ['2026-10-10T00:00:00Z', '2026-10-01T00:00:00Z'], 'Only a word that was deleted gets a new edit time');
  const gist = { words: [], deletedWords };
  assert.deepEqual(M.mergeWords(restored, gist).words.map(w => w.id), ['w1', 'w3'], 'A sync with the old deletion keeps it');
});

test('saving a journal entry keeps the days in order, so an unchanged sync is not seen as a change', () => {
  const saved = M.setJournalEntry({ journal: { '2026-10-01': 'a', '2026-10-02': 'b' }, journalLog: { '2026-10-01': '2026-10-01T00:00:00Z', '2026-10-02': '2026-10-02T00:00:00Z' } },
    '2026-10-01', 'a2', '2026-10-03T00:00:00Z');
  assert.equal(JSON.stringify(saved), JSON.stringify(M.mergeJournal(saved, saved)));
});

test('journal: the newest edit wins, so a shortened entry is not replaced by the older, longer one', () => {
  const long = M.setJournalEntry({}, '2026-10-09', 'A long first draft of the entry.', '2026-10-09T08:00:00Z');
  const short = M.setJournalEntry(long, '2026-10-09', 'Short.', '2026-10-09T09:00:00Z');
  assert.deepEqual(M.mergeJournal(short, long).journal, { '2026-10-09': 'Short.' });
  assert.deepEqual(M.mergeJournal(long, short).journal, { '2026-10-09': 'Short.' });
});

test('journal: a deleted entry stays deleted, and entries from older app versions keep the longer text', () => {
  const written = M.setJournalEntry({}, '2026-10-09', 'Hello.', '2026-10-09T08:00:00Z');
  const deleted = M.setJournalEntry(written, '2026-10-09', '   ', '2026-10-09T09:00:00Z');
  assert.deepEqual(deleted.journal, {});
  const merged = M.mergeJournal(written, deleted);
  assert.deepEqual(merged.journal, {});
  assert.deepEqual(merged.journalLog, { '2026-10-09': '2026-10-09T09:00:00Z' });
  const legacy = M.mergeJournal({ journal: { '2026-10-01': 'short' } }, { journal: { '2026-10-01': 'a longer entry' } });
  assert.deepEqual(legacy.journal, { '2026-10-01': 'a longer entry' });
});

test('damaged or hostile keys from another device are ignored', () => {
  const remote = JSON.parse('{"journal":{"__proto__":"x","not-a-date":"y","2026-10-01":5},"journalLog":{"2026-10-02":"never"},'
    + '"words":[null,{"text":"no id"}],"deletedWords":{"__proto__":"2026-10-01T00:00:00Z","w9":"never"}}');
  const journal = M.mergeJournal({}, remote);
  assert.deepEqual(journal, { journal: {}, journalLog: {} });
  assert.equal(Object.getPrototypeOf(journal.journal), Object.prototype);
  const words = M.mergeWords({ words: [] }, remote);
  assert.deepEqual(words, { words: [{ text: 'no id' }], deletedWords: {} }, 'A word without an id (old backups) is kept; null is dropped');
});

test('word fields from a backup, Sync Code or another device are cleaned, so they cannot carry HTML into the page', () => {
  const hostile = { id: 'w1', text: 'walk', level: '<img src=x onerror=alert(1)>', interval: 'x', ease: 2.5, rightCount: 3, wrongCount: null,
    nextReview: Infinity, tags: 'not a list', examples: [{ en: 'We walk.', cn: 5 }, 'junk'] };
  const [clean] = M.cleanWords([hostile]);
  assert.deepEqual(clean, { id: 'w1', text: 'walk', ease: 2.5, rightCount: 3, tags: [], examples: [{ en: 'We walk.', cn: '' }] });
  const fine = { ...word('w2', '2026-10-01T00:00:00Z'), level: 2, tags: ['IELTS'], examples: [{ en: 'Go.', cn: '走。' }] };
  assert.equal(M.cleanWords([fine])[0], fine, 'A clean word is kept as it is');
  assert.equal(M.mergeWords({ words: [] }, { words: [hostile] }).words[0].level, undefined, 'A sync cleans the words too');
});

test('text fields and word lists of the wrong type are cleaned, so one odd word cannot break the Words tab or a card', () => {
  const odd = { id: 'w1', text: 'walk', createdAt: 5, updatedAt: '2026-10-01T00:00:00Z', archivedAt: true, defEN: 7, defCN: '走',
    phonetic: null, synonyms: 'stroll', family: ['walker', 3], antonyms: ['run'], collocations: { a: 1 } };
  assert.deepEqual(M.cleanWords([odd])[0], { id: 'w1', text: 'walk', updatedAt: '2026-10-01T00:00:00Z', defCN: '走',
    synonyms: [], family: ['walker'], antonyms: ['run'], collocations: [] });
  const archived = { id: 'w2', text: 'go', archivedAt: '2026-10-01T00:00:00Z', phonetic: '/ɡəʊ/', synonyms: [] };
  assert.equal(M.cleanWords([archived])[0], archived, 'A clean word is kept as it is');
  assert.equal(M.cleanWords([{ id: 'w3', text: 'stop', archivedAt: null }])[0].archivedAt, null, 'Not archived is fine');
});

test('the same word added on two devices becomes one word, the newer edit winning, and stays one on every device', () => {
  const mac = { words: [{ id: 'm1', text: 'Walk', updatedAt: '2026-10-01T00:00:00Z' }] };
  const phone = { words: [{ id: 'p1', text: 'walk ', updatedAt: '2026-10-02T00:00:00Z', level: 2 }] };
  const merged = M.mergeWords(mac, phone);
  assert.deepEqual(merged.words.map(w => w.id), ['p1']);
  assert.deepEqual(merged.deletedWords, { m1: '2026-10-02T00:00:00Z' }, 'The other copy is recorded as deleted');
  assert.deepEqual(M.mergeWords(phone, mac).words.map(w => w.id), ['p1'], 'Either direction');
  assert.deepEqual(M.mergeWords(merged, mac).words.map(w => w.id), ['p1'], 'A later sync with the old copy keeps one word');
});

test('of two copies of the same word, the one with review progress is kept, and an exact tie keeps one copy, not none', () => {
  const learned = { words: [{ id: 'a1', text: 'bank', updatedAt: '2026-10-01T00:00:00Z', level: 5, rightCount: 9, wrongCount: 1 }] };
  const readded = { words: [{ id: 'b1', text: 'Bank', updatedAt: '2026-10-03T00:00:00Z', level: 0, rightCount: 0, wrongCount: 0 }] };
  assert.deepEqual(M.mergeWords(learned, readded).words.map(w => w.id), ['a1'], 'Re-adding a word elsewhere does not wipe its progress');
  const tieA = { words: [{ id: 'x1', text: 'walk', updatedAt: '2026-10-01T00:00:00Z' }] };
  const tieB = { words: [{ id: 'x2', text: 'walk', updatedAt: '2026-10-01T00:00:00Z' }] };
  const one = M.mergeWords(tieA, tieB);
  const other = M.mergeWords(tieB, tieA);
  assert.deepEqual([one.words.map(w => w.id), other.words.map(w => w.id)], [['x1'], ['x1']], 'Both devices pick the same copy');
  assert.deepEqual(M.mergeWords(one, other).words.map(w => w.id), ['x1']);
});

test('progress: the bigger count of each day and the newest streak win, and odd streaks are ignored', () => {
  const local = { activity: { '2026-10-01': 3, '2026-10-02': 1 }, streak: { current: 2, lastDay: '2026-10-02' } };
  const remote = { activity: { '2026-10-02': 5, '2026-10-03': 'x', '2026-10-04': 2 }, streak: { current: 3, lastDay: '2026-10-04' } };
  assert.deepEqual(M.mergeProgress(local, remote), {
    activity: { '2026-10-01': 3, '2026-10-02': 5, '2026-10-04': 2 }, streak: { current: 3, lastDay: '2026-10-04' }, resetAt: '' });
  for (const streak of [{ lastDay: '2026-12-01' }, { current: -1, lastDay: '2026-12-01' }, { current: 9, lastDay: 'soon' }, 'x']) {
    assert.deepEqual(M.mergeProgress(local, { activity: {}, streak }).streak, local.streak, JSON.stringify(streak));
  }
});

test('after Reset All, progress from before the reset does not come back from another device or the gist', () => {
  // Noon local time, so the reset day is 2026-10-05 wherever the test runs
  const reset = { activity: {}, streak: { current: 0, lastDay: null }, resetAt: new Date(2026, 9, 5, 12).toISOString() };
  const gist = { activity: { '2026-10-01': 9, '2026-10-06': 2 }, streak: { current: 6, lastDay: '2026-10-04' } };
  const merged = M.mergeProgress(reset, gist);
  assert.deepEqual(merged, { activity: { '2026-10-06': 2 }, streak: { current: 0, lastDay: null }, resetAt: reset.resetAt },
    'Only days from the reset on are kept');
  assert.deepEqual(M.mergeProgress(gist, reset), merged, 'The other device takes the reset too');
  const earlyMorning = { activity: {}, resetAt: new Date(2026, 9, 5, 1).toISOString() };
  assert.deepEqual(M.mergeProgress(earlyMorning, { activity: { '2026-10-04': 3 } }).activity, {},
    'The reset day is the local day (review days are local), not the UTC one');
  const later = { ...gist, streak: { current: 1, lastDay: '2026-10-06' } };
  assert.deepEqual(M.mergeProgress(reset, later).streak, { current: 1, lastDay: '2026-10-06' }, 'A streak started after the reset counts');
});
