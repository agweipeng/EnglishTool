'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../journal-feedback-store.js');

const T1 = '2026-10-09T01:00:00.000Z';
const T2 = '2026-10-09T02:00:00.000Z';
const reply = '1. Grammar fixes: "I go to park" → "I went to the park".';

test('a pasted reply is saved for its day with its source, without changing the old map', () => {
  const empty = {};
  const saved = store.set(empty, '2026-10-09', { text: `  ${reply}  `, source: 'chatgpt' }, T1);
  assert.deepEqual(saved, { '2026-10-09': { text: reply, source: 'chatgpt', updatedAt: T1 } });
  assert.deepEqual(empty, {}, 'The earlier map is not changed');
  assert.equal(store.get(saved, '2026-10-09').text, reply);
  assert.equal(store.set({}, '2026-10-09', { text: reply, source: 'gemini' }, T1)['2026-10-09'].source, 'other');
});

test('clearing a reply keeps a dated marker so sync does not bring it back', () => {
  const saved = store.set({}, '2026-10-09', { text: reply, source: 'claude' }, T1);
  const cleared = store.set(saved, '2026-10-09', { text: '   ', source: 'claude' }, T2);
  assert.equal(store.get(cleared, '2026-10-09'), null);
  assert.deepEqual(store.merge(saved, cleared), cleared, 'The newer clear wins over the older reply');
  assert.deepEqual(store.merge(cleared, saved), cleared);
  assert.equal(store.count(cleared), 0);
  assert.equal(store.count(saved), 1);
});

test('bad dates and oversized replies are refused', () => {
  assert.throws(() => store.set({}, '9 Oct', { text: reply, source: 'claude' }, T1), /date/);
  assert.throws(() => store.set({}, '2026-10-09', { text: 'x'.repeat(store.MAX_FEEDBACK_CHARS + 1), source: 'claude' }, T1), /too long/);
});

test('merging keeps the newest reply for each day and ignores damaged synced data', () => {
  const mac = store.set({}, '2026-10-08', { text: 'Mac reply', source: 'claude' }, T1);
  const phone = {
    ...store.set({}, '2026-10-08', { text: 'Phone reply', source: 'chatgpt' }, T2),
    ...store.set({}, '2026-10-09', { text: 'Only on phone', source: 'claude' }, T1),
    'not-a-date': { text: 'x', source: 'claude', updatedAt: T2 },
    '2026-10-10': { text: 42, source: 'claude', updatedAt: T2 },
    '2026-10-11': { text: 'no time', source: 'claude' },
    '2026-10-12': { text: 'x'.repeat(store.MAX_FEEDBACK_CHARS + 1), source: 'claude', updatedAt: T2 },
  };
  const merged = store.merge(mac, phone);
  assert.deepEqual(Object.keys(merged).sort(), ['2026-10-08', '2026-10-09']);
  assert.equal(merged['2026-10-08'].text, 'Phone reply');
  assert.deepEqual(store.merge(mac, undefined), mac, 'Older data without replies changes nothing');
  assert.deepEqual(store.merge(undefined, ['bad']), {});
});

test('merging compares real times and keeps only the reply fields', () => {
  const plain = { '2026-10-09': { text: 'Without milliseconds', source: 'claude', updatedAt: '2026-10-09T01:00:00Z' } };
  const later = { '2026-10-09': { text: 'A second later', source: 'claude', updatedAt: '2026-10-09T01:00:01.000Z', extra: 'x'.repeat(10) } };
  const merged = store.merge(plain, later);
  assert.deepEqual(merged['2026-10-09'], { text: 'A second later', source: 'claude', updatedAt: '2026-10-09T01:00:01.000Z' });
  assert.equal(store.merge(later, plain)['2026-10-09'].text, 'A second later');
});
