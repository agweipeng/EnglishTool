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
