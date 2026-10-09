'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../material-store.js');

const T1 = '2026-10-09T01:00:00.000Z';
const T2 = '2026-10-09T02:00:00.000Z';
const T3 = '2026-10-09T03:00:00.000Z';
const transcript = 'Neil: Hello. This is 6 Minute English from BBC Learning English. I’m Neil.\n\nBeth: And I’m Beth.';
const material = (id, now, overrides = {}) => store.createEntry({ title: '6 Minute English: Sleep', type: 'conversation',
  sourceUrl: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english', text: transcript, ...overrides }, now, id);

test('a saved transcript keeps its title, type, source link and text', () => {
  const saved = material('m1', T1, { title: '  6 Minute English: Sleep  ', text: `  ${transcript}  ` });
  assert.deepEqual(saved, { id: 'm1', createdAt: T1, updatedAt: T1, title: '6 Minute English: Sleep', type: 'conversation',
    sourceUrl: 'https://www.bbc.co.uk/learningenglish/english/features/6-minute-english', audioUrl: '', text: transcript });
  assert.equal(material('m2', T1, { type: 'podcast' }).type, 'other', 'Unknown types fall back to Other');
});

test('saving the same title again updates it in place, newest first', () => {
  const first = store.upsert([], material('m1', T1));
  const second = store.upsert(first, material('m2', T2, { title: 'The English We Speak' }));
  const updated = store.upsert(second, material('m3', T3, { title: '6 MINUTE ENGLISH: SLEEP', text: 'Corrected transcript.' }));
  assert.deepEqual(store.visible(updated).map(m => [m.id, m.text]), [['m1', 'Corrected transcript.'], ['m2', transcript]]);
  assert.equal(store.visible(updated)[0].createdAt, T1);
  assert.equal(first.length, 1, 'Earlier lists are not changed');
});

test('deleting leaves a tombstone, and merging devices honours the newer change', () => {
  const phone = store.remove(store.upsert([], material('m1', T1)), 'm1', T2);
  const mac = [material('m1', T1), material('m2', T3, { title: 'Only on the Mac' })];
  const merged = store.merge(phone, mac);
  assert.deepEqual(store.visible(merged).map(m => m.id), ['m2']);
  assert.ok(merged.some(m => m.id === 'm1' && m.deleted), 'The newer deletion wins');
});

test('damaged, unsafe or oversized materials are ignored instead of breaking the shelf', () => {
  const tooLong = { ...material('big', T1), text: 'x'.repeat(store.MAX_MATERIAL_CHARS + 1) };
  const unsafe = { ...material('js', T1), sourceUrl: 'javascript:alert(1)' };
  const merged = store.merge([material('ok', T1)], [null, 'x', { id: 'no-date' }, { ...material('t', T1), title: ' ' }, tooLong, unsafe]);
  assert.deepEqual(merged.map(m => m.id), ['ok']);
  assert.deepEqual(store.merge(undefined, undefined), []);
});

test('the shelf reports when it is full instead of silently dropping old materials', () => {
  let list = [];
  for (let i = 0; i < store.MAX_MATERIALS; i++) list = store.upsert(list, material(`m${i}`, T1, { title: `Episode ${i}` }));
  assert.equal(store.isFull(list, 'A new episode'), true);
  assert.equal(store.isFull(list, 'episode 3'), false, 'Updating an existing title is still allowed');
  assert.equal(store.isFull(store.remove(list, 'm0', T2), 'A new episode'), false);
});

test('a saved transcript can keep a link to its audio, which must be https', () => {
  const withAudio = material('m1', T1, { audioUrl: 'https://downloads.bbc.co.uk/learningenglish/features/6min/episode.mp3' });
  assert.equal(withAudio.audioUrl, 'https://downloads.bbc.co.uk/learningenglish/features/6min/episode.mp3');
  assert.equal(material('m2', T1).audioUrl, '', 'Audio is optional');
  const oldEntry = { ...material('old', T1) };
  delete oldEntry.audioUrl;
  const merged = store.merge([oldEntry], [{ ...material('bad', T1), audioUrl: 'http://example.com/a.mp3' }, { ...material('js', T1), audioUrl: 'javascript:alert(1)' }]);
  assert.deepEqual(merged.map(m => m.id), ['old'], 'Older materials without audio still load; unsafe audio links are ignored');
});
