'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../analysis-store.js');
const fixture = require('./fixtures/paragraph-analysis.json');

const T1 = '2026-10-09T01:00:00.000Z';
const T2 = '2026-10-09T02:00:00.000Z';
const T3 = '2026-10-09T03:00:00.000Z';
const context = { text: fixture.passage, title: 'The Golden Bird', chapter: 'Chapter 1', bookId: 'golden-bird', chapterId: 'chapter-1' };
const entry = (id, now, overrides = {}) => store.createEntry({ ...context, result: fixture.analysis, model: 'qwen3.5:4b', ...overrides }, now, id);

test('a new analysis keeps its passage, book position, model and result', () => {
  const saved = entry('a1', T1);
  assert.deepEqual(
    { id: saved.id, createdAt: saved.createdAt, updatedAt: saved.updatedAt, bookId: saved.bookId, chapterId: saved.chapterId, model: saved.model },
    { id: 'a1', createdAt: T1, updatedAt: T1, bookId: 'golden-bird', chapterId: 'chapter-1', model: 'qwen3.5:4b' });
  assert.equal(saved.text, fixture.passage);
  assert.deepEqual(saved.result, fixture.analysis);
});

test('saved analyses are listed newest first and re-analysing a passage replaces it', () => {
  const first = store.upsert([], entry('a1', T1));
  const second = store.upsert(first, entry('a2', T2, { text: 'A king had a garden.' }));
  assert.deepEqual(store.visible(second).map(e => e.id), ['a2', 'a1']);
  const redone = store.upsert(second, entry('a3', T3, { model: 'Gemma4:12b' }));
  const kept = store.visible(redone);
  assert.deepEqual(kept.map(e => e.id), ['a1', 'a2'], 'Same passage keeps its id and moves to the top');
  assert.equal(kept[0].model, 'Gemma4:12b');
  assert.equal(kept[0].createdAt, T1);
  assert.equal(kept[0].updatedAt, T3);
  assert.equal(first.length, 1, 'Earlier lists are not changed');
});

test('deleting leaves a small tombstone so sync does not bring the analysis back', () => {
  const list = store.remove(store.upsert([], entry('a1', T1)), 'a1', T2);
  assert.deepEqual(store.visible(list), []);
  assert.deepEqual(list, [{ id: 'a1', updatedAt: T2, deleted: true }]);
});

test('merging devices keeps every analysis, prefers newer edits and honours deletions', () => {
  const phone = [entry('a1', T1), entry('b1', T1, { text: 'Only on the phone.' })];
  const mac = [{ id: 'a1', updatedAt: T2, deleted: true }, entry('c1', T3, { text: 'Only on the Mac.' })];
  const merged = store.merge(phone, mac);
  assert.deepEqual(store.visible(merged).map(e => e.id).sort(), ['b1', 'c1']);
  assert.ok(merged.some(e => e.id === 'a1' && e.deleted), 'The newer deletion wins');
  const newer = entry('b1', T3, { text: 'Only on the phone.', model: 'newer' });
  assert.equal(store.visible(store.merge(merged, [newer])).find(e => e.id === 'b1').model, 'newer');
});

test('malformed saved data is ignored instead of breaking the list', () => {
  const merged = store.merge([entry('a1', T1)], [null, 'x', { id: 7 }, { id: 'b', updatedAt: T1 }, { id: 'c', updatedAt: T1, text: 'x', result: 'bad' }]);
  assert.deepEqual(merged.map(e => e.id), ['a1']);
  assert.deepEqual(store.merge(undefined, undefined), []);
});

test('search matches the passage, book, chapter or explanation', () => {
  const dogResult = { ...fixture.analysis, simplified: { en: 'Toto is a small dog.', cn: '托托是一只小狗。' },
    mainPoint: { en: 'Toto is small.', cn: '托托很小。' }, words: [], phrases: [] };
  const list = store.upsert(store.upsert([], entry('a1', T1)),
    entry('a2', T2, { text: 'Toto was a little black dog.', title: 'The Wonderful Wizard of Oz', result: dogResult }));
  assert.deepEqual(store.visible(list, 'wizard').map(e => e.id), ['a2']);
  assert.deepEqual(store.visible(list, 'GOLDEN APPLES').map(e => e.id), ['a1']);
  assert.deepEqual(store.visible(list, '').length, 2);
});
